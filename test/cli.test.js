import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../dist/args.js";
import { EXIT_SPECWEAVER_ERROR, EXIT_SUCCESS } from "../dist/results.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    ...options,
  });
}

/** Write a minimal valid OpenAPI spec with a GET /pets operation. */
function writeSpec(dir) {
  const specPath = join(dir, "openapi.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: "http://127.0.0.1:1" }],
      paths: {
        "/pets": { get: { responses: { "200": { description: "ok" } } } },
      },
    }),
  );
  return specPath;
}

/** Write a valid OpenAPI 3.1 document to `dir` and return its path. */
function writeSpec31(dir, document) {
  const specPath = join(dir, "openapi31.json");
  writeFileSync(specPath, JSON.stringify(document));
  return specPath;
}

/** Write a fake `k6` executable that exits with `code`. */
function writeFakeK6(dir, code = 0) {
  const file = join(dir, "k6");
  writeFileSync(file, `#!/bin/sh\nexit ${code}\n`);
  chmodSync(file, 0o755);
  return file;
}

test("built CLI --help exits 0 and lists the core flags", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  for (const flag of ["--config", "--vus", "--duration", "--out"]) {
    assert.ok(result.stdout.includes(flag), `usage should list ${flag}`);
  }
});

test("built CLI --version exits 0 and prints the package version", () => {
  const result = runCli(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("built CLI with no arguments exits non-zero and prints usage", () => {
  const result = runCli([]);
  assert.equal(result.status, EXIT_SPECWEAVER_ERROR);
  assert.ok(result.stderr.includes("Usage:"));
});

test("built CLI with an unknown flag exits non-zero", () => {
  const result = runCli(["--nope"]);
  assert.equal(result.status, EXIT_SPECWEAVER_ERROR);
  assert.ok(result.stderr.includes("--nope"));
});

test("parseArgs produces a structured options object", () => {
  const options = parseArgs([
    "--config",
    "specweaver.yaml",
    "--vus",
    "10",
    "--duration",
    "1m30s",
    "--out",
    "results.json",
  ]);
  assert.deepEqual(options, {
    config: "specweaver.yaml",
    vus: 10,
    duration: "1m30s",
    out: "results.json",
    help: false,
    version: false,
  });
});

test("parseArgs rejects a non-positive-integer --vus", () => {
  assert.throws(() => parseArgs(["--vus", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--vus", "abc"]), /positive integer/);
});

test("parseArgs rejects a malformed --duration", () => {
  assert.throws(() => parseArgs(["--duration", "soon"]), /duration/);
});

test("built CLI without --config exits non-zero", () => {
  const result = runCli(["--vus", "5"]);
  assert.equal(result.status, EXIT_SPECWEAVER_ERROR);
  assert.match(result.stderr, /--config/);
});

test("built CLI exits 2 with an actionable message when operations have no specs", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const configPath = join(dir, "specweaver.yaml");
  const resultsPath = join(dir, "results.json");
  writeFileSync(configPath, "operations:\n  - method: GET\n    path: /pets\n");

  const result = runCli(["--config", configPath, "--out", resultsPath]);
  assert.equal(result.status, EXIT_SPECWEAVER_ERROR, result.stderr);
  assert.match(result.stderr, /`specs` is required to execute operations/);
  assert.match(result.stderr, /no spec source is configured/);
  assert.doesNotMatch(result.stdout, /SpecWeaver run summary/);
  assert.equal(existsSync(resultsPath), false);
});

test("built CLI warns about payload overrides when no specs are configured", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const configPath = join(dir, "specweaver.yaml");
  const resultsPath = join(dir, "results.json");
  writeFileSync(
    configPath,
    `operations:
  - method: GET
    path: /pets
payloads:
  - method: POST
    path: /pets
    body:
      name: Rex
`,
  );

  // No `specs` => the run cannot execute anything. The override cannot be
  // applied, so it must still be reported rather than silently lost.
  const result = runCli(["--config", configPath, "--out", resultsPath]);
  assert.equal(result.status, EXIT_SPECWEAVER_ERROR, result.stderr);
  assert.match(
    result.stderr,
    /warning: payload override for "POST \/pets" does not match any selected operation/,
  );
  assert.equal(existsSync(resultsPath), false);
});

test("built CLI exits 2 and lists every unmatched operation when none match", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeSpec(dir);
  const configPath = join(dir, "specweaver.yaml");
  const resultsPath = join(dir, "results.json");
  writeFileSync(
    configPath,
    `specs:
  - ${specPath}
operations:
  - method: GET
    path: /missing
  - method: POST
    path: /also-missing
payloads:
  - method: POST
    path: /pets
    body:
      name: Rex
`,
  );

  const result = runCli(["--config", configPath, "--out", resultsPath]);
  assert.equal(result.status, EXIT_SPECWEAVER_ERROR, result.stderr);
  assert.match(result.stderr, /none of the configured operations were found/);
  assert.match(result.stderr, /- GET \/missing/);
  assert.match(result.stderr, /- POST \/also-missing/);
  // SPEC-13 payload warnings still fire on the no-run path.
  assert.match(
    result.stderr,
    /warning: payload override for "POST \/pets" does not match any selected operation/,
  );
  assert.doesNotMatch(result.stdout, /No operations to run/);
  assert.doesNotMatch(result.stdout, /SpecWeaver run summary/);
  assert.equal(existsSync(resultsPath), false);
});

test("built CLI runs a partial match, warns about unmatched entries, and returns k6's exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeSpec(dir);
  const configPath = join(dir, "specweaver.yaml");
  const resultsPath = join(dir, "results.json");
  writeFileSync(
    configPath,
    `specs:
  - ${specPath}
operations:
  - method: GET
    path: /pets
  - method: GET
    path: /missing
`,
  );

  const binDir = mkdtempSync(join(tmpdir(), "specweaver-bin-"));
  writeFakeK6(binDir, 0);
  const sandbox = mkdtempSync(join(tmpdir(), "specweaver-tmp-"));
  const result = runCli(["--config", configPath, "--out", resultsPath], {
    env: { ...process.env, PATH: binDir, TMPDIR: sandbox },
  });

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  assert.match(
    result.stderr,
    /warning: operation "GET \/missing" is not present in the loaded spec\(s\); skipping/,
  );
  assert.match(result.stdout, /SpecWeaver run summary/);
  assert.equal(existsSync(resultsPath), true);
  const results = JSON.parse(readFileSync(resultsPath, "utf8"));
  assert.equal(results.outcome, "success");
  assert.ok(results.checks["GET /pets"], JSON.stringify(results.checks));
});

test("built CLI with an invalid config exits non-zero and names the field", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const configPath = join(dir, "specweaver.yaml");
  writeFileSync(configPath, "operations: []\n");

  const result = runCli(["--config", configPath]);
  assert.equal(result.status, EXIT_SPECWEAVER_ERROR);
  assert.match(result.stderr, /operations/);
});

test("built CLI with an invalid spec in the config exits non-zero and reports the spec error", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = join(dir, "openapi.yaml");
  // Structurally invalid: carries a version but no `info`/`paths`.
  writeFileSync(specPath, "openapi: 3.0.3\n");

  const configPath = join(dir, "specweaver.yaml");
  writeFileSync(
    configPath,
    `specs:\n  - ${specPath}\noperations:\n  - method: GET\n    path: /pets\n`,
  );

  const result = runCli(["--config", configPath]);
  assert.equal(result.status, EXIT_SPECWEAVER_ERROR);
  assert.match(result.stderr, /not a valid OpenAPI/);
  assert.doesNotMatch(result.stderr, /RangeError/);
});
