/**
 * End-to-end test (SPEC-9).
 *
 * This is the integrative quality gate: it drives the **built** `dist` CLI
 * through the whole pipeline (load config + spec -> generate request data ->
 * emit the k6 script/data -> execute) against a local `node:http` mock server
 * started in-test, then asserts a successful run and that the emitted artifacts
 * describe the expected operation requests.
 *
 * Conventions follow the rest of the suite: authored in plain JS (not
 * TypeScript) and run by `node --test` from the built `dist/` output. The suite
 * is built by `npm test` (`npm run build && node --test`) before the tests run;
 * for standalone runs this file builds the CLI only if `dist/cli.js` is missing,
 * so it never races a concurrent rebuild in the normal `npm test` flow.
 *
 * Per SPEC-9 decision 3 the test is conditional on the `k6` binary. The
 * decision itself is made by the pure helper in `support/k6-requirement.js`
 * (SPEC-18):
 *
 * - k6 available -> run the test as usual, regardless of environment.
 * - k6 absent + k6 optional -> SKIP gracefully (via the `node:test` skip
 *   mechanism, reported by `node --test`) with the SPEC-9 message, so a
 *   k6-less local suite stays green.
 * - k6 absent + k6 REQUIRED -> do not skip; the test FAILS with a message
 *   naming k6 as required, reporting that the `k6 version` probe failed, and
 *   explaining how to install k6. That makes `npm test` and the CI job exit
 *   non-zero instead of reporting a false green.
 *
 * k6 is required when either environment variable is truthy (anything other
 * than unset/empty, `0`, or `false`, case-insensitive):
 *
 * - `CI` — GitHub Actions sets `CI=true` automatically (SPEC-17 workflow);
 * - `SPECWEAVER_REQUIRE_K6=1` — explicit override for use outside CI.
 *
 * The generated script/data live in a unique per-run directory under
 * `os.tmpdir()` (SPEC-6 A2, hardened by SPEC-11), and `node --test` runs test
 * files concurrently. The e2e therefore gives its child process a private
 * `TMPDIR` so its artifacts cannot collide with the other suites that also
 * touch `os.tmpdir()`.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../dist/config.js";
import { loadSpec } from "../dist/spec.js";
import { k6Requirement } from "./support/k6-requirement.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "dist", "cli.js");
const sampleSpecPath = join(repoRoot, "samples", "petstore.openapi.json");
const sampleConfigPath = join(repoRoot, "samples", "specweaver.config.yaml");

const SCRIPT_FILE_NAME = "specweaver.generated.js";
const DATA_FILE_NAME = "specweaver.data.json";

/**
 * The e2e builds the CLI (AC 3). `npm test` already builds before `node --test`;
 * build here only if the artifact is absent (e.g. a standalone test run), so it
 * never races the normal build.
 */
if (!existsSync(cliPath)) {
  const built = spawnSync("npm", ["run", "build"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(
    built.status,
    0,
    `npm run build failed:\n${built.stdout}\n${built.stderr}`,
  );
}

const k6Available =
  spawnSync("k6", ["version"], { encoding: "utf8" }).status === 0;
const k6Decision = k6Requirement(k6Available, process.env);

/** Run the built CLI asynchronously (so the in-test server can serve while it runs). */
function runCli(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], options);
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

/** Recursively collect every `$ref` string still present in a document. */
function collectRefs(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRefs(item, found);
    }
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        found.push(value);
      } else {
        collectRefs(value, found);
      }
    }
  }
  return found;
}

test("the committed sample spec loads and resolves all $refs (SPEC-9 AC 1)", () => {
  const loaded = loadSpec(sampleSpecPath);
  const routes = loaded.operations.map((op) => `${op.method} ${op.path}`);
  assert.ok(routes.includes("GET /pets"), routes.join(", "));
  assert.ok(routes.includes("POST /pets"), routes.join(", "));
  assert.ok(routes.includes("GET /pets/{petId}"), routes.join(", "));
  // A path parameter, a query parameter, and a JSON request body are all present.
  const createPet = loaded.operations.find(
    (op) => op.method === "POST" && op.path === "/pets",
  );
  assert.ok(createPet?.requestBody, "POST /pets should declare a request body");
  // Every internal `$ref` was inlined.
  assert.deepEqual(collectRefs(loaded.document), []);
});

test("the committed sample config passes --config validation (SPEC-9 AC 2)", () => {
  const { config, warnings } = loadConfig(sampleConfigPath);
  assert.ok(config.operations.length >= 2, "should select at least two operations");
  assert.deepEqual(config.specs, ["samples/petstore.openapi.json"]);
  assert.equal(config.auth?.token, "POC-TOKEN");
  assert.equal(config.load.vus, 2);
  assert.equal(config.output, "specweaver-results.json");
  assert.deepEqual(warnings, []);
});

test(
  "end-to-end: built CLI loads the sample spec, generates, emits, and runs k6 against a local mock server",
  {
    skip: k6Decision.action === "skip" ? k6Decision.reason : false,
  },
  async () => {
    // Absent + required (CI or SPECWEAVER_REQUIRE_K6): fail loudly instead of
    // skipping, so a k6-less CI job cannot report green (SPEC-18).
    if (k6Decision.action === "fail") {
      assert.fail(k6Decision.reason);
    }

    const received = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        received.push({ method: req.method, url: req.url, body });
        res.writeHead(req.method === "POST" ? 201 : 200, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const workDir = mkdtempSync(join(tmpdir(), "specweaver-e2e-"));
    // A private temp dir for the CLI's generated artifacts, so this test cannot
    // collide with other suites that write into os.tmpdir() concurrently.
    const artifactDir = mkdtempSync(join(tmpdir(), "specweaver-e2e-artifacts-"));
    const configPath = join(workDir, "specweaver.config.yaml");
    const resultsPath = join(workDir, "results.json");

    // Reuse the committed sample config verbatim, overriding only the base URL
    // so the run hits the in-test mock server (SPEC-9 decision 4). `specs` paths
    // resolve against the working directory, so we run the CLI from the repo root.
    writeFileSync(
      configPath,
      `baseUrl: ${baseUrl}\n${readFileSync(sampleConfigPath, "utf8")}`,
    );

    try {
      const result = await runCli(
        [
          "--config",
          configPath,
          "--vus",
          "1",
          "--duration",
          "1s",
          "--out",
          resultsPath,
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            // Keep the generated artifacts (SPEC-7 opt-out) so we can inspect them.
            SPECWEAVER_KEEP_TEMP: "1",
            // Point os.tmpdir() at our private directory (POSIX + Windows vars).
            TMPDIR: artifactDir,
            TEMP: artifactDir,
            TMP: artifactDir,
          },
        },
      );

      // The pipeline ran to completion and exited 0.
      assert.equal(result.status, 0, result.stderr);

      // SPEC-11: the artifacts live in a unique per-run directory under TMPDIR.
      const generated = result.stdout.match(/^Generated k6 script: (.+)$/m);
      assert.ok(generated, `expected a generated-script path:\n${result.stdout}`);
      const scriptPath = generated[1].trim();
      const runDir = dirname(scriptPath);
      const dataPath = join(runDir, DATA_FILE_NAME);
      assert.ok(runDir.startsWith(artifactDir), `unexpected temp dir: ${runDir}`);
      assert.ok(
        basename(runDir).startsWith("specweaver-"),
        `unexpected temp dir name: ${runDir}`,
      );
      assert.equal(basename(scriptPath), SCRIPT_FILE_NAME);

      // Execution actually reached the mock server for both sample operations.
      assert.ok(
        received.some((r) => r.method === "GET" && r.url.startsWith("/pets")),
        `expected a GET /pets request, received: ${JSON.stringify(received)}`,
      );
      assert.ok(
        received.some((r) => r.method === "POST" && r.url === "/pets"),
        `expected a POST /pets request, received: ${JSON.stringify(received)}`,
      );

      // The emitted artifacts contain the expected operation requests.
      assert.ok(existsSync(scriptPath), "emitted k6 script should exist");
      assert.ok(existsSync(dataPath), "emitted data file should exist");
      const data = JSON.parse(readFileSync(dataPath, "utf8"));
      assert.equal(data.baseUrl, baseUrl);
      const routes = data.operations.map((op) => `${op.method} ${op.route}`);
      assert.ok(routes.includes("GET /pets"), routes.join(", "));
      assert.ok(routes.includes("POST /pets"), routes.join(", "));
      assert.ok(routes.includes("GET /pets/{petId}"), routes.join(", "));

      const post = data.operations.find(
        (op) => op.method === "POST" && op.route === "/pets",
      );
      assert.equal(post.url, `${baseUrl}/pets`);
      assert.equal(post.headers["Content-Type"], "application/json");

      // A machine-readable results JSON was written to the --out path, with a
      // per-operation check count for each executed request.
      const results = JSON.parse(readFileSync(resultsPath, "utf8"));
      assert.equal(results.outcome, "success");
      assert.equal(results.k6ExitCode, 0);
      assert.ok(results.checks["GET /pets"], JSON.stringify(results.checks));
      assert.ok(results.checks["POST /pets"], JSON.stringify(results.checks));
      assert.ok(
        results.checks["GET /pets/{petId}"],
        JSON.stringify(results.checks),
      );
    } finally {
      // KEEP_TEMP left the per-run directory behind; remove the whole TMPDIR.
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      rmSync(workDir, { recursive: true, force: true });
      rmSync(artifactDir, { recursive: true, force: true });
    }
  },
);
