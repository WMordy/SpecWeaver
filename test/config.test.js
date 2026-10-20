import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ConfigError,
  DEFAULT_LOAD,
  HTTP_METHODS,
  loadConfig,
  parseConfig,
} from "../dist/config.js";

const VALID_CONFIG = `specs:
  - ./openapi.yaml
operations:
  - method: GET
    path: /pets
  - method: POST
    path: /pets
auth:
  token: token-123
  headers:
    X-Api-Key: key-456
output: results.json
load:
  vus: 5
  duration: 1m
`;

test("valid config parses into a typed Config object", () => {
  const { config, warnings } = parseConfig(VALID_CONFIG);

  assert.deepEqual(warnings, []);
  assert.deepEqual(config.specs, ["./openapi.yaml"]);
  assert.deepEqual(config.operations, [
    { method: "GET", path: "/pets" },
    { method: "POST", path: "/pets" },
  ]);
  assert.deepEqual(config.auth, {
    token: "token-123",
    headers: { "X-Api-Key": "key-456" },
  });
  assert.equal(config.output, "results.json");
  assert.deepEqual(config.load, { vus: 5, duration: "1m" });
});

test("operations entries are normalized to the pinned { method, path } shape", () => {
  const { config } = parseConfig(
    "operations:\n  - method: get\n    path: /pets\n",
  );
  assert.deepEqual(config.operations, [{ method: "GET", path: "/pets" }]);
  // No stray properties leak into the operation object.
  assert.deepEqual(Object.keys(config.operations[0]), ["method", "path"]);
});

test("specs parses as optional; the CLI requires a spec source before executing operations", () => {
  // SPEC-14 deliberately reverses SPEC-2's optionality at the CLI boundary:
  // parsing keeps `specs` optional so the CLI can report a dedicated no-run
  // error (with SPEC-13 payload warnings), but `operations` without `specs`
  // exits 2 instead of running. See test/cli.test.js.
  const { config } = parseConfig("operations:\n  - method: GET\n    path: /pets\n");
  assert.equal(config.specs, undefined);
  assert.deepEqual(config.operations, [{ method: "GET", path: "/pets" }]);
});

test("specs accepts a single string as well as a list", () => {
  const single = parseConfig(
    "specs: ./openapi.yaml\noperations:\n  - method: GET\n    path: /pets\n",
  );
  assert.deepEqual(single.config.specs, ["./openapi.yaml"]);
});

test("baseUrl is exposed on the typed Config when present and valid", () => {
  const { config } = parseConfig(
    "operations:\n  - method: GET\n    path: /pets\nbaseUrl: https://api.example.com\n",
  );
  assert.equal(config.baseUrl, "https://api.example.com");
});

test("baseUrl is optional and stays undefined when absent", () => {
  const { config } = parseConfig("operations:\n  - method: GET\n    path: /pets\n");
  assert.equal(config.baseUrl, undefined);
});

test("a non-string or empty baseUrl fails validation, naming the field", () => {
  const message = /`baseUrl` must be a non-empty string/;
  assert.throws(
    () => parseConfig("operations:\n  - method: GET\n    path: /pets\nbaseUrl: 42\n"),
    message,
  );
  assert.throws(
    () => parseConfig('operations:\n  - method: GET\n    path: /pets\nbaseUrl: ""\n'),
    message,
  );
  assert.throws(
    () => parseConfig('operations:\n  - method: GET\n    path: /pets\nbaseUrl: "   "\n'),
    message,
  );
});

test("baseUrl errors are aggregated with the other schema violations", () => {
  const yaml = `baseUrl: ""
operations:
  - method: GET
    path: /pets
load:
  vus: 0
`;
  assert.throws(
    () => parseConfig(yaml),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.errors.length >= 2, "expected aggregated errors");
      assert.match(error.message, /`baseUrl` must be a non-empty string/);
      assert.match(error.message, /`load\.vus` must be a positive integer/);
      return true;
    },
  );
});

test("payload overrides parse into typed method + path + body entries", () => {
  const { config } = parseConfig(
    `operations:
  - method: POST
    path: /pets
payloads:
  - method: post
    path: /pets
    body:
      name: Rex
      tag: override
`,
  );
  assert.deepEqual(config.payloads, [
    { method: "POST", path: "/pets", body: { name: "Rex", tag: "override" } },
  ]);
});

test("payload overrides reject unsupported keys instead of silently ignoring them", () => {
  const yaml = `operations:
  - method: POST
    path: /pets
payloads:
  - method: POST
    path: /pets
    query:
      limit: 5
    body:
      name: Rex
`;
  assert.throws(
    () => parseConfig(yaml),
    /unknown field `payloads\[0\]\.query`.*only `method`, `path`, and `body`/,
  );
});

test("payload overrides require a body to replace", () => {
  const yaml = `operations:
  - method: POST
    path: /pets
payloads:
  - method: POST
    path: /pets
`;
  assert.throws(
    () => parseConfig(yaml),
    /payloads\[0\].*must define a `body`/,
  );
});

test("a duplicate payload override key fails validation", () => {
  const yaml = `operations:
  - method: POST
    path: /pets
payloads:
  - method: POST
    path: /pets
    body: { name: A }
  - method: post
    path: /pets
    body: { name: B }
`;
  assert.throws(() => parseConfig(yaml), /duplicate payload override `POST \/pets`/);
});

test("missing operations fails validation with a clear error", () => {
  assert.throws(
    () => parseConfig("specs: ./openapi.yaml\n"),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /`operations` is required/);
      return true;
    },
  );
});

test("empty operations list fails validation", () => {
  assert.throws(() => parseConfig("operations: []\n"), /at least one operation/);
});

test("operations entry that is not the pinned object shape fails validation", () => {
  assert.throws(
    () => parseConfig("operations:\n  - GET /pets\n"),
    /operations\[0\].*must be a mapping/,
  );
  assert.throws(
    () => parseConfig("operations:\n  - method: GET\n"),
    /operations\[0\]\.path.*non-empty string/,
  );
  assert.throws(
    () => parseConfig("operations:\n  - method: GET\n    path: /pets\n    extra: nope\n"),
    /unknown field `operations\[0\]\.extra`/,
  );
});

test("an operation method outside the allowed set fails validation", () => {
  assert.throws(
    () => parseConfig("operations:\n  - method: FETCH\n    path: /pets\n"),
    /operations\[0\]\.method.*must be one of/,
  );
});

test("a duplicate operation (same method + path) fails validation", () => {
  const yaml = `operations:
  - method: GET
    path: /pets
  - method: get
    path: /pets
`;
  assert.throws(() => parseConfig(yaml), /duplicate operation `GET \/pets`/);
});

test("invalid YAML produces a human-readable ConfigError", () => {
  assert.throws(
    () => parseConfig("operations: [\n", {}, "specweaver.yaml"),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /Invalid YAML in "specweaver.yaml"/);
      return true;
    },
  );
});

test("a non-mapping root document fails validation", () => {
  assert.throws(() => parseConfig("just a string\n"), /YAML mapping/);
  assert.throws(() => parseConfig("- one\n- two\n"), /YAML mapping/);
});

test("all validation errors are aggregated, not reported one at a time", () => {
  const yaml = `load:
  vus: 0
operations:
  - method: NOPE
    path: ""
`;
  assert.throws(
    () => parseConfig(yaml),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.ok(error.errors.length >= 3, "expected multiple aggregated errors");
      assert.match(error.message, /`load\.vus` must be a positive integer/);
      assert.match(error.message, /operations\[0\]\.method/);
      assert.match(error.message, /operations\[0\]\.path/);
      return true;
    },
  );
});

test("documented defaults are applied when optional fields are omitted", () => {
  const { config } = parseConfig("operations:\n  - method: GET\n    path: /pets\n");
  assert.deepEqual(config.load, DEFAULT_LOAD);
  // The default output path is deliberately not pinned here (owned by SPEC-7).
  assert.equal(config.output, undefined);
  assert.equal(config.auth, undefined);
  assert.equal(config.payloads, undefined);
});

test("partial load overrides only the omitted default field", () => {
  const { config } = parseConfig(
    "operations:\n  - method: GET\n    path: /pets\nload:\n  vus: 7\n",
  );
  assert.deepEqual(config.load, { vus: 7, duration: DEFAULT_LOAD.duration });
});

test("CLI overrides take precedence over YAML values", () => {
  const { config } = parseConfig(VALID_CONFIG, {
    vus: 42,
    duration: "2m",
    out: "cli-results.json",
  });
  assert.deepEqual(config.load, { vus: 42, duration: "2m" });
  assert.equal(config.output, "cli-results.json");
});

test("absent CLI overrides leave YAML values intact", () => {
  const { config } = parseConfig(VALID_CONFIG, {});
  assert.deepEqual(config.load, { vus: 5, duration: "1m" });
  assert.equal(config.output, "results.json");
});

test("absent CLI overrides leave defaults intact", () => {
  const { config } = parseConfig(
    "operations:\n  - method: GET\n    path: /pets\n",
    {},
  );
  assert.deepEqual(config.load, DEFAULT_LOAD);
});

test("invalid load values fail validation", () => {
  assert.throws(
    () => parseConfig("operations:\n  - method: GET\n    path: /pets\nload:\n  duration: soon\n"),
    /`load\.duration`/,
  );
  assert.throws(
    () => parseConfig("operations:\n  - method: GET\n    path: /pets\nload:\n  vus: -1\n"),
    /`load\.vus`/,
  );
});

test("unknown fields are rejected", () => {
  assert.throws(
    () => parseConfig("operations:\n  - method: GET\n    path: /pets\nbogus: true\n"),
    /unknown field `bogus`/,
  );
});

test("failOnCheckFailure is CLI-only and rejected as an unknown config field", () => {
  assert.throws(
    () =>
      parseConfig(
        "operations:\n  - method: GET\n    path: /pets\nfailOnCheckFailure: true\n",
      ),
    /unknown field `failOnCheckFailure`/,
  );
});

test("auth ${ENV_VAR} references are resolved from the process environment", () => {
  const previous = process.env.SPECWEAVER_TEST_TOKEN;
  process.env.SPECWEAVER_TEST_TOKEN = "super-secret";
  try {
    const { config, warnings } = parseConfig(
      `operations:
  - method: GET
    path: /pets
auth:
  token: "\${SPECWEAVER_TEST_TOKEN}"
  headers:
    Authorization: "Bearer \${SPECWEAVER_TEST_TOKEN}"
`,
    );
    assert.deepEqual(warnings, []);
    assert.equal(config.auth.token, "super-secret");
    assert.equal(config.auth.headers.Authorization, "Bearer super-secret");
  } finally {
    if (previous === undefined) {
      delete process.env.SPECWEAVER_TEST_TOKEN;
    } else {
      process.env.SPECWEAVER_TEST_TOKEN = previous;
    }
  }
});

test("an unresolved ${ENV_VAR} emits a warning without failing validation", () => {
  delete process.env.SPECWEAVER_MISSING_TOKEN;
  const { config, warnings } = parseConfig(
    `operations:
  - method: GET
    path: /pets
auth:
  token: "\${SPECWEAVER_MISSING_TOKEN}"
`,
  );

  assert.equal(config.auth.token, "${SPECWEAVER_MISSING_TOKEN}");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unresolved environment variable "SPECWEAVER_MISSING_TOKEN"/);
  assert.match(warnings[0], /auth\.token/);
});

test("HTTP method allow-list matches the documented set", () => {
  for (const method of HTTP_METHODS) {
    const { config } = parseConfig(`operations:\n  - method: ${method}\n    path: /x\n`);
    assert.equal(config.operations[0].method, method);
  }
});

test("loadConfig reads and parses a YAML file from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-config-"));
  const path = join(dir, "specweaver.yaml");
  writeFileSync(path, "operations:\n  - method: GET\n    path: /pets\n");

  const { config } = loadConfig(path, { vus: 3 });
  assert.deepEqual(config.operations, [{ method: "GET", path: "/pets" }]);
  assert.equal(config.load.vus, 3);
});

test("loadConfig reports a missing file as a ConfigError", () => {
  const missing = join(tmpdir(), "specweaver-does-not-exist.yaml");
  assert.throws(
    () => loadConfig(missing),
    (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /Cannot read config file/);
      return true;
    },
  );
});

test("schema violations reported by loadConfig name the config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-config-"));
  const path = join(dir, "bad.yaml");
  writeFileSync(path, "operations: []\n");
  assert.throws(() => loadConfig(path), new RegExp(`Invalid config in "${path}"`));
});
