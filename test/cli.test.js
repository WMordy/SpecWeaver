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

/** One minimal OpenAPI operation object (a 200 response is all v1 needs). */
function apiOperation() {
  return { responses: { "200": { description: "ok" } } };
}

/** Write a valid OpenAPI 3.0 document with the given `paths` under `name`. */
function writePathsSpec(dir, name, paths) {
  const specPath = join(dir, name);
  writeFileSync(
    specPath,
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: name, version: "1" },
      servers: [{ url: "http://127.0.0.1:1" }],
      paths,
    }),
  );
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
  for (const flag of [
    "--config",
    "--vus",
    "--duration",
    "--out",
    "--fail-on-check-failure",
  ]) {
    assert.ok(result.stdout.includes(flag), `usage should list ${flag}`);
  }
  assert.match(
    result.stdout,
    /--fail-on-check-failure[\s\S]*Exit non-zero when any recorded check fails/,
  );
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
    failOnCheckFailure: false,
    help: false,
    version: false,
  });
});

test("parseArgs recognizes --fail-on-check-failure as a valueless boolean flag", () => {
  assert.equal(
    parseArgs(["--config", "specweaver.yaml"]).failOnCheckFailure,
    false,
  );
  const options = parseArgs(["--config", "specweaver.yaml", "--fail-on-check-failure"]);
  assert.equal(options.failOnCheckFailure, true);
  assert.equal(options.config, "specweaver.yaml");
  // It takes no value: a following token is an ordinary argument, not its value.
  assert.throws(
    () => parseArgs(["--fail-on-check-failure", "true"]),
    /Unexpected argument: true/,
  );
  // No `=true|false` form: absence is how the gate is disabled.
  assert.throws(
    () => parseArgs(["--fail-on-check-failure=true"]),
    /Unknown flag: --fail-on-check-failure=true/,
  );
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

test("built CLI warns and exits 2 when a webhooks-only 3.1 spec yields zero operations", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeSpec31(dir, {
    openapi: "3.1.0",
    info: { title: "Hooks", version: "1" },
    webhooks: {
      newPet: {
        post: { responses: { "200": { description: "ok" } } },
      },
    },
  });
  const configPath = join(dir, "specweaver.yaml");
  const resultsPath = join(dir, "results.json");
  writeFileSync(
    configPath,
    `specs:\n  - ${specPath}\noperations:\n  - method: GET\n    path: /pets\n`,
  );

  const result = runCli(["--config", configPath, "--out", resultsPath]);

  assert.equal(result.status, EXIT_SPECWEAVER_ERROR, result.stderr);
  assert.ok(result.stderr.includes(specPath), result.stderr);
  assert.match(
    result.stderr,
    /warning: spec ".*openapi31\.json" contributes zero operations/,
  );
  assert.match(result.stderr, /only `paths` operations are supported/);
  assert.match(
    result.stderr,
    /OpenAPI 3\.1 `webhooks` and components-only documents are not catalogued in v1/,
  );
  // SPEC-14's no-run path still fails the run and writes no results file.
  assert.match(result.stderr, /none of the configured operations were found/);
  assert.doesNotMatch(result.stdout, /SpecWeaver run summary/);
  assert.equal(existsSync(resultsPath), false);
});

test("built CLI warns and exits 2 when a components-only 3.1 spec yields zero operations", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeSpec31(dir, {
    openapi: "3.1.0",
    info: { title: "Components", version: "1" },
    components: { schemas: { Pet: { type: "object" } } },
  });
  const configPath = join(dir, "specweaver.yaml");
  const resultsPath = join(dir, "results.json");
  writeFileSync(
    configPath,
    `specs:\n  - ${specPath}\noperations:\n  - method: GET\n    path: /pets\n`,
  );

  const result = runCli(["--config", configPath, "--out", resultsPath]);

  assert.equal(result.status, EXIT_SPECWEAVER_ERROR, result.stderr);
  assert.ok(result.stderr.includes(specPath), result.stderr);
  assert.match(
    result.stderr,
    /warning: spec ".*openapi31\.json" contributes zero operations/,
  );
  assert.match(result.stderr, /only `paths` operations are supported/);
  assert.match(
    result.stderr,
    /OpenAPI 3\.1 `webhooks` and components-only documents are not catalogued in v1/,
  );
  assert.match(result.stderr, /none of the configured operations were found/);
  assert.doesNotMatch(result.stdout, /SpecWeaver run summary/);
  assert.equal(existsSync(resultsPath), false);
});

test("built CLI emits no zero-operation warning for a normal paths spec", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeSpec(dir);
  const configPath = join(dir, "specweaver.yaml");
  const resultsPath = join(dir, "results.json");
  writeFileSync(
    configPath,
    `specs:\n  - ${specPath}\noperations:\n  - method: GET\n    path: /pets\n`,
  );

  const binDir = mkdtempSync(join(tmpdir(), "specweaver-bin-"));
  writeFakeK6(binDir, 0);
  const sandbox = mkdtempSync(join(tmpdir(), "specweaver-tmp-"));
  const result = runCli(["--config", configPath, "--out", resultsPath], {
    env: { ...process.env, PATH: binDir, TMPDIR: sandbox },
  });

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  assert.doesNotMatch(result.stderr, /contributes zero operations/);
  assert.match(result.stdout, /SpecWeaver run summary/);
  assert.equal(existsSync(resultsPath), true);
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
  // The explicit-list startup summary keeps its count-based line (SPEC-23).
  assert.match(
    result.stdout,
    /Loaded config: 2 operation\(s\), 1 spec source\(s\)\./,
  );
  assert.doesNotMatch(result.stdout, /operations = all/);
  assert.match(result.stdout, /SpecWeaver run summary/);
  assert.equal(existsSync(resultsPath), true);
  const results = JSON.parse(readFileSync(resultsPath, "utf8"));
  assert.equal(results.outcome, "success");
  assert.ok(results.checks["GET /pets"], JSON.stringify(results.checks));
});

test("built CLI selects the whole catalog for operations: all in catalog order", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  // Path keys are deliberately not alphabetical and the methods within `/z`
  // are out of canonical order: selection must follow document path order,
  // then canonical method order (get, post, put, ...).
  const specPath = writePathsSpec(dir, "openapi.json", {
    "/z": { post: apiOperation(), get: apiOperation() },
    "/a": { delete: apiOperation() },
  });
  const configPath = join(dir, "specweaver.yaml");
  const resultsPath = join(dir, "results.json");
  writeFileSync(configPath, `specs:\n  - ${specPath}\noperations: all\n`);

  const binDir = mkdtempSync(join(tmpdir(), "specweaver-bin-"));
  writeFakeK6(binDir, 0);
  const sandbox = mkdtempSync(join(tmpdir(), "specweaver-tmp-"));
  const result = runCli(["--config", configPath, "--out", resultsPath], {
    env: { ...process.env, PATH: binDir, TMPDIR: sandbox },
  });

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  // Selector-aware summary line, not an operation count (SPEC-23).
  assert.match(result.stdout, /Loaded config: operations = all, 1 spec source\(s\)\./);
  assert.doesNotMatch(result.stderr, /none of the configured operations were found/);
  assert.equal(existsSync(resultsPath), true);
  const results = JSON.parse(readFileSync(resultsPath, "utf8"));
  assert.deepEqual(Object.keys(results.checks), [
    "GET /z",
    "POST /z",
    "DELETE /a",
  ]);
});

test("built CLI selects all operations across two specs in specs-then-catalog order", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const firstSpec = writePathsSpec(dir, "first.json", {
    "/z": { post: apiOperation(), get: apiOperation() },
    "/a": { delete: apiOperation() },
  });
  const secondSpec = writePathsSpec(dir, "second.json", {
    "/m": { put: apiOperation() },
    "/b": { patch: apiOperation(), get: apiOperation() },
  });
  const configPath = join(dir, "specweaver.yaml");
  const resultsPath = join(dir, "results.json");
  writeFileSync(
    configPath,
    `specs:\n  - ${firstSpec}\n  - ${secondSpec}\noperations: all\n`,
  );

  const binDir = mkdtempSync(join(tmpdir(), "specweaver-bin-"));
  writeFakeK6(binDir, 0);
  const sandbox = mkdtempSync(join(tmpdir(), "specweaver-tmp-"));
  const result = runCli(["--config", configPath, "--out", resultsPath], {
    env: { ...process.env, PATH: binDir, TMPDIR: sandbox },
  });

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  assert.match(result.stdout, /Resolved specs: 6 operation\(s\) in the catalog\./);
  assert.equal(existsSync(resultsPath), true);
  const results = JSON.parse(readFileSync(resultsPath, "utf8"));
  // Exactly the union, first spec's catalog entirely before the second's.
  assert.deepEqual(Object.keys(results.checks), [
    "GET /z",
    "POST /z",
    "DELETE /a",
    "PUT /m",
    "GET /b",
    "PATCH /b",
  ]);
});

test("built CLI collapses cross-spec duplicates under operations: all and warns once", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const firstSpec = writePathsSpec(dir, "first.json", {
    "/pets": { get: apiOperation(), post: apiOperation() },
  });
  const secondSpec = writePathsSpec(dir, "second.json", {
    "/pets": { get: apiOperation() },
    "/other": { delete: apiOperation() },
  });
  const configPath = join(dir, "specweaver.yaml");
  const binDir = mkdtempSync(join(tmpdir(), "specweaver-bin-"));
  writeFakeK6(binDir, 0);
  const sandbox = mkdtempSync(join(tmpdir(), "specweaver-tmp-"));
  const duplicateWarning = `warning: operation "GET /pets" is defined in both "${firstSpec}" and "${secondSpec}"; keeping the first occurrence and skipping the duplicate.`;

  function runOnce(resultsPath) {
    return runCli(["--config", configPath, "--out", resultsPath], {
      env: { ...process.env, PATH: binDir, TMPDIR: sandbox },
    });
  }

  writeFileSync(
    configPath,
    `specs:\n  - ${firstSpec}\n  - ${secondSpec}\noperations: all\n`,
  );
  const firstResultsPath = join(dir, "results-1.json");
  const firstRun = runOnce(firstResultsPath);
  const secondResultsPath = join(dir, "results-2.json");
  const secondRun = runOnce(secondResultsPath);

  for (const run of [firstRun, secondRun]) {
    assert.equal(run.status, EXIT_SUCCESS, run.stderr);
    assert.equal(
      run.stderr.split(duplicateWarning).length - 1,
      1,
      `exactly one duplicate warning expected:\n${run.stderr}`,
    );
  }
  const firstKeys = Object.keys(
    JSON.parse(readFileSync(firstResultsPath, "utf8")).checks,
  );
  const secondKeys = Object.keys(
    JSON.parse(readFileSync(secondResultsPath, "utf8")).checks,
  );
  // First catalog occurrence wins; the duplicate is not emitted twice.
  assert.deepEqual(firstKeys, ["GET /pets", "POST /pets", "DELETE /other"]);
  assert.deepEqual(firstKeys, secondKeys);
});

test("built CLI exits 2 with an all-specific message when operations: all has an empty catalog", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeSpec31(dir, {
    openapi: "3.1.0",
    info: { title: "Hooks", version: "1" },
    webhooks: {
      newPet: {
        post: { responses: { "200": { description: "ok" } } },
      },
    },
  });
  const configPath = join(dir, "specweaver.yaml");
  const resultsPath = join(dir, "results.json");
  writeFileSync(
    configPath,
    `specs:
  - ${specPath}
operations: all
payloads:
  - method: POST
    path: /pets
    body:
      name: Rex
`,
  );

  const result = runCli(["--config", configPath, "--out", resultsPath]);

  assert.equal(result.status, EXIT_SPECWEAVER_ERROR, result.stderr);
  // SPEC-15 still explains the zero-operation spec.
  assert.match(
    result.stderr,
    /warning: spec ".*openapi31\.json" contributes zero operations/,
  );
  // SPEC-23's own zero-selection message, not SPEC-14's explicit-list wording.
  assert.match(
    result.stderr,
    /error: `operations: all` selected no operations: the loaded spec\(s\) contribute no catalogued operations/,
  );
  assert.doesNotMatch(result.stderr, /none of the configured operations were found/);
  assert.doesNotMatch(result.stderr, /Unmatched operations:/);
  // SPEC-13 still reports overrides that can never be applied.
  assert.match(
    result.stderr,
    /warning: payload override for "POST \/pets" does not match any selected operation/,
  );
  assert.doesNotMatch(result.stdout, /SpecWeaver run summary/);
  assert.equal(existsSync(resultsPath), false);
});

test("built CLI with operations: all and no specs still exits 2 on the specs requirement", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const configPath = join(dir, "specweaver.yaml");
  const resultsPath = join(dir, "results.json");
  writeFileSync(configPath, "operations: all\n");

  const result = runCli(["--config", configPath, "--out", resultsPath]);

  assert.equal(result.status, EXIT_SPECWEAVER_ERROR, result.stderr);
  assert.match(result.stderr, /`specs` is required to execute operations/);
  assert.match(result.stderr, /no spec source is configured/);
  // No catalog expansion was attempted: the all-specific message never appears.
  assert.doesNotMatch(result.stderr, /selected no operations/);
  assert.doesNotMatch(result.stdout, /SpecWeaver run summary/);
  assert.equal(existsSync(resultsPath), false);
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
