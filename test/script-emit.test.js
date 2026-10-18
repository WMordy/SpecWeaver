import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseConfig } from "../dist/config.js";
import {
  DATA_FILE_NAME,
  DEFAULT_EXPECTED_STATUS,
  JSON_CONTENT_TYPE,
  SCRIPT_FILE_NAME,
  buildRequestUrl,
  emitScript,
  resolveBaseUrl,
  writeEmittedScript,
} from "../dist/script/emit.js";

/** Build one generated request-data object (the SPEC-4/5 output shape). */
function request(overrides = {}) {
  return {
    method: "GET",
    path: "/pets",
    pathParams: {},
    query: {},
    headers: {},
    ...overrides,
  };
}

/** Wrap an OpenAPI document in the minimal SPEC-3 `LoadedSpec` shape. */
function spec(document) {
  return { source: "spec", document, operations: [] };
}

/** Build a resolved config with a default load profile. */
function config(overrides = {}) {
  return {
    operations: [],
    load: { vus: 1, duration: "30s" },
    ...overrides,
  };
}

/** Build a minimal OpenAPI 3.0 document with the given servers and paths. */
function document(servers = [], paths = {}) {
  return {
    openapi: "3.0.3",
    info: { title: "t", version: "1" },
    servers,
    paths,
  };
}

// --- Emission wiring -------------------------------------------------------

test("emits one operation per request, preserving order", () => {
  const { data } = emitScript({
    config: config(),
    requests: [
      request({ method: "GET", path: "/pets" }),
      request({ method: "POST", path: "/pets" }),
    ],
  });

  assert.equal(data.operations.length, 2);
  assert.deepEqual(
    data.operations.map((op) => [op.method, op.route]),
    [
      ["GET", "/pets"],
      ["POST", "/pets"],
    ],
  );
});

test("composes the request URL from base URL, path params, and query", () => {
  const built = buildRequestUrl("http://api.example.com/", {
    path: "/pets/{petId}",
    pathParams: { petId: "a b" },
    query: { limit: "10", tag: ["x", "y"] },
  });
  assert.equal(built, "http://api.example.com/pets/a%20b?limit=10&tag=x&tag=y");

  const { data } = emitScript({
    config: config(),
    specs: [spec(document([{ url: "http://api.example.com" }]))],
    requests: [
      request({
        path: "/pets/{petId}",
        pathParams: { petId: "42" },
        query: { limit: "5" },
      }),
    ],
  });
  assert.equal(data.operations[0].url, "http://api.example.com/pets/42?limit=5");
  assert.deepEqual(data.operations[0].pathParams, { petId: "42" });
  assert.deepEqual(data.operations[0].query, { limit: "5" });
});

test("serializes headers, including injected auth headers, unchanged", () => {
  const { script, data } = emitScript({
    config: config(),
    requests: [
      request({
        headers: { "X-Request-Id": "abc", Authorization: "Bearer secret" },
      }),
    ],
  });

  assert.deepEqual(data.operations[0].headers, {
    "X-Request-Id": "abc",
    Authorization: "Bearer secret",
  });
  // The script wires the header map straight into the request params.
  assert.match(script, /const params = \{ headers: operation\.headers \};/);
  assert.match(
    script,
    /http\.request\(operation\.method, operation\.url, body, params\)/,
  );
});

test("serializes a JSON body when present and omits it otherwise", () => {
  const withBody = emitScript({
    config: config(),
    requests: [request({ method: "POST", body: { name: "Fido" } })],
  });

  // The body is stored pre-serialized as a string (k6 does not JSON-serialize
  // object bodies) and the JSON Content-Type is emitted explicitly.
  assert.equal(typeof withBody.data.operations[0].body, "string");
  assert.equal(withBody.data.operations[0].body, JSON.stringify({ name: "Fido" }));
  assert.equal(
    withBody.data.operations[0].headers["Content-Type"],
    JSON_CONTENT_TYPE,
  );

  const withoutBody = emitScript({
    config: config(),
    requests: [request({ method: "GET" })],
  });
  assert.equal("body" in withoutBody.data.operations[0], false);
  assert.equal(withoutBody.data.operations[0].body, undefined);
  // A body-less operation gets no inferred Content-Type.
  assert.equal("Content-Type" in withoutBody.data.operations[0].headers, false);
  // The script passes a null body when the operation has none.
  assert.match(withoutBody.script, /operation\.body === undefined \? null : operation\.body/);
});

test("nested arrays/objects round-trip through the serialized body", () => {
  const body = {
    name: "Fido",
    tags: ["a", "b"],
    owner: { id: 7, address: { city: "Springfield", zip: "12345" } },
    nested: [{ x: [1, 2] }, { y: { z: true } }],
  };

  const { data } = emitScript({
    config: config(),
    requests: [request({ method: "POST", path: "/pets", body })],
  });

  const emitted = data.operations[0].body;
  assert.equal(typeof emitted, "string");
  // The serialized string parses back to the exact nested structure.
  assert.deepEqual(JSON.parse(emitted), body);
  assert.equal(data.operations[0].headers["Content-Type"], JSON_CONTENT_TYPE);
});

test("an existing Content-Type (generated or auth) is not overridden", () => {
  // A generated header parameter wins over the inferred JSON Content-Type.
  const generated = emitScript({
    config: config(),
    requests: [
      request({
        method: "POST",
        body: { name: "Fido" },
        headers: { "content-type": "application/vnd.api+json" },
      }),
    ],
  });
  assert.equal(
    generated.data.operations[0].headers["content-type"],
    "application/vnd.api+json",
  );
  assert.equal("Content-Type" in generated.data.operations[0].headers, false);

  // Auth headers are merged last by SPEC-5, so an auth Content-Type wins too.
  const authHeaders = { "Content-Type": "application/merge-patch+json" };
  const auth = emitScript({
    config: config(),
    requests: [
      request({ method: "POST", body: { name: "Fido" }, headers: authHeaders }),
    ],
  });
  assert.equal(
    auth.data.operations[0].headers["Content-Type"],
    "application/merge-patch+json",
  );
});

test("declares options from the resolved load profile and CLI overrides", () => {
  const overrideConfig = config({ load: { vus: 7, duration: "45s" } });
  const { script } = emitScript({
    config: overrideConfig,
    requests: [request()],
  });
  assert.match(script, /export const options = \{"vus":7,"duration":"45s"\};/);

  // The same values flow through the real config parser with CLI overrides.
  const { config: parsed } = parseConfig(
    "operations:\n  - method: GET\n    path: /pets\nload:\n  vus: 3\n  duration: 10s\n",
    { vus: 7, duration: "45s" },
  );
  const { script: fromCli } = emitScript({ config: parsed, requests: [request()] });
  assert.match(fromCli, /export const options = \{"vus":7,"duration":"45s"\};/);
});

test("exports exactly one default function", () => {
  const { script } = emitScript({ config: config(), requests: [request()] });
  assert.equal((script.match(/export default function/g) ?? []).length, 1);
});

// --- Checks / expected status ---------------------------------------------

test("uses the operation's documented 2xx status for the check", () => {
  const specWithResponses = spec(
    document([{ url: "http://h" }], {
      "/pets": { get: { responses: { "200": {}, "201": {}, "404": {} } } },
    }),
  );
  const { data } = emitScript({
    config: config(),
    specs: [specWithResponses],
    requests: [request({ path: "/pets" })],
  });
  assert.deepEqual(data.operations[0].expectedStatus, [200, 201]);
  assert.equal(data.operations[0].acceptAny2xx, false);
});

test("defaults the expected status to 200 when none is documented", () => {
  const { data, script } = emitScript({
    config: config(),
    specs: [spec(document([], { "/pets": { get: { responses: { "404": {} } } } }))],
    requests: [request({ path: "/pets" })],
  });
  assert.deepEqual(data.operations[0].expectedStatus, [DEFAULT_EXPECTED_STATUS]);
  assert.equal(data.operations[0].acceptAny2xx, false);
  assert.match(script, /const checkName = 'status is ' \+ statusLabel\(operation\)/);
  assert.match(script, /operation\.expectedStatus\.indexOf\(status\) !== -1/);
});

// --- Wildcard 2XX (post-review decision 3) ---------------------------------

test("treats a documented 2XX wildcard as any 2xx status", () => {
  const { data, script } = emitScript({
    config: config(),
    specs: [spec(document([], { "/pets": { get: { responses: { "2XX": {} } } } }))],
    requests: [request({ path: "/pets" })],
  });

  // A wildcard does NOT fall back to exactly 200...
  assert.deepEqual(data.operations[0].expectedStatus, []);
  assert.equal(data.operations[0].acceptAny2xx, true);

  // ...the emitted check accepts the whole 2xx range.
  assert.match(script, /return status >= 200 && status < 300;/);
  assert.match(script, /function statusMatches\(status, operation\)/);
  assert.match(script, /\[checkName\]: \(r\) => statusMatches\(r\.status, operation\)/);
  assert.match(script, /return operation\.acceptAny2xx \? '2XX'/);
});

test("wildcard detection is case-insensitive (2xx)", () => {
  const { data } = emitScript({
    config: config(),
    specs: [spec(document([], { "/pets": { get: { responses: { "2xx": {} } } } }))],
    requests: [request({ path: "/pets" })],
  });
  assert.equal(data.operations[0].acceptAny2xx, true);
  assert.deepEqual(data.operations[0].expectedStatus, []);
});

test("mixed literal + wildcard documents accept the whole 2xx range", () => {
  const { data } = emitScript({
    config: config(),
    specs: [
      spec(document([], { "/pets": { get: { responses: { "200": {}, "2XX": {} } } } })),
    ],
    requests: [request({ path: "/pets" })],
  });

  // The literal code is preserved for information, but the wildcard supersedes
  // it (every documented literal 2xx is inside the range anyway).
  assert.deepEqual(data.operations[0].expectedStatus, [200]);
  assert.equal(data.operations[0].acceptAny2xx, true);
});

test("emits no k6 thresholds", () => {
  const { script } = emitScript({ config: config(), requests: [request()] });
  assert.doesNotMatch(script, /thresholds/);
});

test("paces iterations with a 1s sleep (A4)", () => {
  const { script } = emitScript({ config: config(), requests: [request()] });
  assert.match(script, /sleep\(1\);/);
});

// --- Base URL (A1) ---------------------------------------------------------

test("config baseUrl override wins over the spec's servers[].url", () => {
  const specs = [spec(document([{ url: "https://from-spec.example.com/v1" }]))];

  assert.equal(
    resolveBaseUrl({ config: config({ baseUrl: "https://override.example.com" }), specs }),
    "https://override.example.com",
  );

  const { data } = emitScript({
    config: config({ baseUrl: "https://override.example.com" }),
    specs,
    requests: [request({ path: "/pets" })],
  });
  assert.equal(data.baseUrl, "https://override.example.com");
  assert.equal(data.operations[0].url, "https://override.example.com/pets");
});

test("falls back to the spec's first servers[].url with variable defaults", () => {
  const specs = [
    spec(
      document([
        {
          url: "https://{host}/api",
          variables: { host: { default: "api.example.com" } },
        },
        { url: "https://second.example.com" },
      ]),
    ),
  ];

  assert.equal(
    resolveBaseUrl({ config: config(), specs }),
    "https://api.example.com/api",
  );

  const { data } = emitScript({
    config: config(),
    specs,
    requests: [request({ path: "/pets" })],
  });
  assert.equal(data.baseUrl, "https://api.example.com/api");
  assert.equal(data.operations[0].url, "https://api.example.com/api/pets");
});

// --- Determinism -----------------------------------------------------------

test("emission is deterministic for the same inputs", () => {
  const input = {
    config: config({ baseUrl: "http://host" }),
    specs: [spec(document([], { "/pets": { get: { responses: { "200": {} } } } }))],
    requests: [
      request({ path: "/pets", headers: { "X-A": "1" }, query: { q: ["a", "b"] } }),
      request({ method: "POST", path: "/pets", body: { name: "Fido" } }),
    ],
  };

  const first = emitScript(input);
  const second = emitScript(input);
  assert.equal(first.script, second.script);
  assert.equal(JSON.stringify(first.data), JSON.stringify(second.data));
});

test("writeEmittedScript writes byte-identical files on repeated runs", () => {
  const input = {
    config: config({ baseUrl: "http://host" }),
    requests: [request({ path: "/pets" })],
  };
  const dirA = mkdtempSync(join(tmpdir(), "sw-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "sw-b-"));

  const a = writeEmittedScript(input, { directory: dirA });
  const b = writeEmittedScript(input, { directory: dirB });

  assert.equal(readFileSync(a.scriptPath, "utf8"), readFileSync(b.scriptPath, "utf8"));
  assert.equal(readFileSync(a.dataPath, "utf8"), readFileSync(b.dataPath, "utf8"));
});

// --- Output location (A2) --------------------------------------------------

test("writes specweaver.generated.js and specweaver.data.json under os.tmpdir()", () => {
  const written = writeEmittedScript({
    config: config({ baseUrl: "http://host", output: "results.json" }),
    requests: [request()],
  });

  assert.equal(written.scriptPath, join(tmpdir(), SCRIPT_FILE_NAME));
  assert.equal(written.dataPath, join(tmpdir(), DATA_FILE_NAME));
  assert.ok(written.scriptPath.startsWith(tmpdir()));

  // The config `output` field does NOT name the generated artifacts.
  assert.notEqual(written.scriptPath, join(tmpdir(), "results.json"));
  assert.notEqual(written.dataPath, join(tmpdir(), "results.json"));

  // The script's open() reference resolves to the sibling data file.
  assert.match(written.script, new RegExp(`open\\('${DATA_FILE_NAME}'\\)`));
  const onDisk = readdirSync(tmpdir());
  assert.ok(onDisk.includes(SCRIPT_FILE_NAME));
  assert.ok(onDisk.includes(DATA_FILE_NAME));
});

// --- Dependency-free guard -------------------------------------------------

test("emitted script is dependency-free and parses as valid JavaScript", () => {
  const { script, data } = emitScript({
    config: config({ baseUrl: "http://host" }),
    specs: [spec(document([], { "/pets": { get: { responses: { "200": {} } } } }))],
    requests: [request({ path: "/pets", headers: { Authorization: "Bearer x" } })],
  });

  // Only k6 built-in modules may be imported.
  const specifiers = [...script.matchAll(/import\s+[^'"]+from\s+['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
  assert.ok(specifiers.length > 0);
  for (const specifier of specifiers) {
    assert.ok(
      specifier === "k6" || specifier.startsWith("k6/"),
      `unexpected import specifier: ${specifier}`,
    );
  }

  // No Node builtins, CommonJS require, or bare Node globals.
  assert.doesNotMatch(script, /\brequire\s*\(/);
  assert.doesNotMatch(script, /\bnode:/);
  assert.doesNotMatch(script, /\bprocess\b/);
  assert.doesNotMatch(script, /\bBuffer\b/);
  assert.doesNotMatch(script, /\b__dirname\b/);
  assert.doesNotMatch(script, /\b__filename\b/);
  assert.doesNotMatch(script, /\bfs\b/);
  assert.doesNotMatch(script, /\bpath\b/);

  // open() + JSON.parse run only in the init context, never inside default.
  const defaultBody = script.slice(script.indexOf("export default function"));
  assert.doesNotMatch(defaultBody, /\bopen\(/);
  assert.doesNotMatch(defaultBody, /JSON\.parse/);
  assert.match(script, /const DATA = JSON\.parse\(open\('specweaver\.data\.json'\)\);/);

  // Parses as valid ESM. `node --check` accepts .mjs without executing it.
  const dir = mkdtempSync(join(tmpdir(), "sw-check-"));
  const mjsPath = join(dir, "check.mjs");
  writeFileSync(mjsPath, script, "utf8");
  const checked = spawnSync(process.execPath, ["--check", mjsPath], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  assert.ok(data.operations.length > 0);
});

// --- k6 runtime (AC #10) ---------------------------------------------------

const k6Available =
  spawnSync("k6", ["version"], { encoding: "utf8" }).status === 0;

/**
 * Run a command asynchronously (so the in-test mock server can serve requests
 * while the child runs) and resolve with its exit code and captured output.
 */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test(
  "the emitted script runs under k6 for one iteration",
  { skip: k6Available ? false : "k6 binary not found on PATH" },
  async () => {
    const nestedBody = {
      name: "Fido",
      tags: ["a", "b"],
      owner: { id: 7, address: { city: "Springfield", zip: "12345" } },
      nested: [{ x: [1, 2] }, { y: { z: true } }],
    };

    const received = [];
    const server = http.createServer((req, res) => {
      let rawBody = "";
      req.on("data", (chunk) => {
        rawBody += chunk;
      });
      req.on("end", () => {
        received.push({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          contentType: req.headers["content-type"],
          rawBody,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    try {
      const dir = mkdtempSync(join(tmpdir(), "sw-k6-"));
      const written = writeEmittedScript(
        {
          config: config({ baseUrl: `http://127.0.0.1:${port}` }),
          specs: [
            spec(
              document([{ url: `http://127.0.0.1:${port}` }], {
                "/pets/{petId}": { get: { responses: { "200": {} } } },
                "/pets": { post: { responses: { "200": {} } } },
              }),
            ),
          ],
          requests: [
            request({
              path: "/pets/{petId}",
              pathParams: { petId: "42" },
              query: { limit: "5" },
              headers: { Authorization: "Bearer secret" },
            }),
            request({ method: "POST", path: "/pets", body: nestedBody }),
          ],
        },
        { directory: dir },
      );

      const result = await run(
        "k6",
        ["run", "--iterations", "1", "--vus", "1", written.scriptPath],
        { cwd: dir },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /GoError|ERRO/);
      assert.equal(received.length, 2);

      const getReq = received.find((entry) => entry.method === "GET");
      assert.equal(getReq.url, "/pets/42?limit=5");
      assert.equal(getReq.auth, "Bearer secret");
      assert.equal(getReq.rawBody, "");

      // The JSON body is sent intact (k6 does not re-serialize objects) with the
      // explicit JSON Content-Type emitted by the emitter.
      const postReq = received.find((entry) => entry.method === "POST");
      assert.equal(postReq.url, "/pets");
      assert.equal(postReq.contentType, "application/json");
      assert.deepEqual(JSON.parse(postReq.rawBody), nestedBody);

      assert.match(result.stdout, /checks_succeeded\.+: 100\.00%/);
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
