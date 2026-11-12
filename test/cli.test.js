import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../dist/args.js";
import { EXIT_SPECWEAVER_ERROR, EXIT_SUCCESS } from "../dist/results.js";
import { REDACTED_BASE_URL_MARKER } from "../dist/script/emit.js";

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

/** Write a fake `k6` that records invocation by creating `markerPath`. */
function writeTrackingK6(dir, markerPath, code = 0) {
  const file = join(dir, "k6");
  writeFileSync(file, `#!/bin/sh\n: > '${markerPath}'\nexit ${code}\n`);
  chmodSync(file, 0o755);
  return file;
}

/**
 * Write a minimal valid spec with `GET /pets` and the given `servers`.
 * `undefined` omits the `servers` member entirely.
 */
function writeServersSpec(dir, name, servers) {
  const specPath = join(dir, name);
  const document = {
    openapi: "3.0.3",
    info: { title: name, version: "1" },
    paths: { "/pets": { get: apiOperation() } },
  };
  if (servers !== undefined) {
    document.servers = servers;
  }
  writeFileSync(specPath, JSON.stringify(document));
  return specPath;
}

/**
 * Run the built CLI against `configText` with a fake k6 on PATH and a private
 * TMPDIR. Returns the run plus the paths/state needed to assert the SPEC-24
 * boundary: whether k6 was invoked and which artifacts (if any) were written.
 */
function runSandboxed(dir, configText, { k6Code = 0, keepTemp = false } = {}) {
  const binDir = mkdtempSync(join(tmpdir(), "specweaver-bin-"));
  const k6Marker = join(dir, "k6-invoked");
  writeTrackingK6(binDir, k6Marker, k6Code);
  const sandbox = mkdtempSync(join(tmpdir(), "specweaver-tmp-"));
  const configPath = join(dir, "specweaver.yaml");
  const resultsPath = join(dir, "results.json");
  writeFileSync(configPath, configText);
  const env = { ...process.env, PATH: binDir, TMPDIR: sandbox };
  if (keepTemp) {
    env.SPECWEAVER_KEEP_TEMP = "1";
  }
  const result = runCli(["--config", configPath, "--out", resultsPath], { env });
  return { result, resultsPath, sandbox, k6Marker };
}

/**
 * Assert the SPEC-24 pre-k6 failure contract: exit 2, an `error:` message, no
 * k6 invocation, no generated artifacts, and no results file.
 */
function assertBaseUrlGateFailure(run) {
  assert.equal(run.result.status, EXIT_SPECWEAVER_ERROR, run.result.stderr);
  assert.match(run.result.stderr, /^error: /m);
  assert.doesNotMatch(run.result.stdout, /k6 found:/);
  assert.equal(existsSync(run.k6Marker), false, "k6 must not be invoked");
  assert.deepEqual(readdirSync(run.sandbox), [], "no generated script/data");
  assert.equal(existsSync(run.resultsPath), false, "no results file");
  assert.doesNotMatch(run.result.stderr, /\bat .+:\d+:\d+/);
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
authOperations:
  - method: GET
    path: /admin
    token: admin-token
`,
  );

  // No `specs` => the run cannot execute anything. The overrides cannot be
  // applied, so they must still be reported rather than silently lost.
  const result = runCli(["--config", configPath, "--out", resultsPath]);
  assert.equal(result.status, EXIT_SPECWEAVER_ERROR, result.stderr);
  assert.match(
    result.stderr,
    /warning: payload override for "POST \/pets" does not match any selected operation/,
  );
  assert.match(
    result.stderr,
    /warning: auth override for "GET \/admin" does not match any selected operation/,
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
authOperations:
  - method: POST
    path: /pets
    token: admin-token
`,
  );

  const result = runCli(["--config", configPath, "--out", resultsPath]);
  assert.equal(result.status, EXIT_SPECWEAVER_ERROR, result.stderr);
  assert.match(result.stderr, /none of the configured operations were found/);
  assert.match(result.stderr, /- GET \/missing/);
  assert.match(result.stderr, /- POST \/also-missing/);
  // SPEC-13/SPEC-40 warnings still fire on the no-run path.
  assert.match(
    result.stderr,
    /warning: payload override for "POST \/pets" does not match any selected operation/,
  );
  assert.match(
    result.stderr,
    /warning: auth override for "POST \/pets" does not match any selected operation/,
  );
  assert.doesNotMatch(result.stdout, /No operations to run/);
  assert.doesNotMatch(result.stdout, /SpecWeaver run summary/);
  assert.equal(existsSync(resultsPath), false);
});

test("built CLI catalogues and runs a webhooks-only 3.1 spec", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeSpec31(dir, {
    openapi: "3.1.0",
    info: { title: "Hooks", version: "1" },
    servers: [{ url: "http://127.0.0.1:1" }],
    webhooks: {
      newPet: {
        post: { responses: { "200": { description: "ok" } } },
      },
    },
  });
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations:\n  - method: POST\n    path: /newPet\n`,
    { keepTemp: true },
  );

  assert.equal(run.result.status, EXIT_SUCCESS, run.result.stderr);
  assert.equal(existsSync(run.k6Marker), true, "k6 should have been invoked");
  assert.equal(existsSync(run.resultsPath), true, "results file should exist");
  assert.doesNotMatch(run.result.stderr, /contributes zero operations/);
  assert.doesNotMatch(run.result.stderr, /not catalogued/);

  const generated = run.result.stdout.match(/^Generated k6 script: (.+)$/m);
  assert.ok(generated, `expected a generated-script path:\n${run.result.stdout}`);
  const data = JSON.parse(
    readFileSync(join(dirname(generated[1].trim()), "specweaver.data.json"), "utf8"),
  );
  assert.deepEqual(
    data.operations.map((operation) => `${operation.method} ${operation.route}`),
    ["POST /newPet"],
  );
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
  assert.match(
    result.stderr,
    /only `paths` and `webhooks` operations are catalogued/,
  );
  assert.match(result.stderr, /components-only document yields none/);
  assert.doesNotMatch(result.stderr, /webhooks.*not catalogued/);
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

test("built CLI expands operationId, tags, and path-pattern selectors in config-entry order", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writePathsSpec(dir, "openapi.json", {
    "/pets": {
      get: { operationId: "listPets", tags: ["pets"], ...apiOperation() },
      post: {
        operationId: "createPet",
        tags: ["pets", "store"],
        ...apiOperation(),
      },
    },
    "/pets/{id}": {
      get: {
        operationId: "getPet",
        tags: ["pets"],
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        ...apiOperation(),
      },
    },
    "/store": {
      delete: {
        operationId: "clearStore",
        tags: ["store"],
        ...apiOperation(),
      },
    },
  });

  const run = runSandboxed(
    dir,
    `specs:
  - ${specPath}
operations:
  - operationId: getPet
  - tags: [store]
  - path: /pets/*
  - method: GET
    path: /pets
`,
  );

  assert.equal(run.result.status, EXIT_SUCCESS, run.result.stderr);
  assert.doesNotMatch(run.result.stderr, /not present in the loaded spec/);
  const results = JSON.parse(readFileSync(run.resultsPath, "utf8"));
  // Config-entry order, each expansion in catalog order, deduplicated.
  assert.deepEqual(Object.keys(results.checks), [
    "GET /pets/{id}",
    "POST /pets",
    "DELETE /store",
    "GET /pets",
  ]);
});

test("built CLI warns per unmatched selector form and keeps the matched operations", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeSpec(dir);

  const run = runSandboxed(
    dir,
    `specs:
  - ${specPath}
operations:
  - method: GET
    path: /pets
  - operationId: nope
  - tags: [nope]
  - path: /nope/**
`,
  );

  assert.equal(run.result.status, EXIT_SUCCESS, run.result.stderr);
  assert.match(
    run.result.stderr,
    /warning: operation selector operationId "nope" is not present in the loaded spec\(s\); skipping/,
  );
  assert.match(
    run.result.stderr,
    /warning: operation selector tags \["nope"\] is not present in the loaded spec\(s\); skipping/,
  );
  assert.match(
    run.result.stderr,
    /warning: operation selector path pattern "\/nope\/\*\*" is not present in the loaded spec\(s\); skipping/,
  );
  const results = JSON.parse(readFileSync(run.resultsPath, "utf8"));
  assert.deepEqual(Object.keys(results.checks), ["GET /pets"]);
});

test("built CLI exits 2 before k6 and lists unmatched selectors when none match", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeSpec(dir);

  const run = runSandboxed(
    dir,
    `specs:
  - ${specPath}
operations:
  - operationId: nope
  - tags: [nope]
  - path: /nope/**
`,
  );

  assert.equal(run.result.status, EXIT_SPECWEAVER_ERROR, run.result.stderr);
  assert.match(run.result.stderr, /none of the configured operations were found/);
  assert.match(run.result.stderr, /Unmatched selectors:/);
  assert.match(run.result.stderr, /- operationId "nope"/);
  assert.match(run.result.stderr, /- tags \["nope"\]/);
  assert.match(run.result.stderr, /- path pattern "\/nope\/\*\*"/);
  assert.equal(existsSync(run.k6Marker), false, "k6 must not be invoked");
  assert.equal(existsSync(run.resultsPath), false, "no results file");
});

test("built CLI exits 2 with an all-specific message when operations: all has an empty catalog", () => {
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
  // SPEC-50: the hint names both catalogued containers, not just `paths`.
  assert.match(
    result.stderr,
    /Only `paths` and OpenAPI 3\.1 `webhooks` operations are catalogued/,
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

// --- SPEC-24: base-URL usability gate -------------------------------------

test("built CLI exits 2 before k6 when no servers URL resolves a base URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeServersSpec(dir, "openapi.json", undefined);
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\n`,
  );

  assertBaseUrlGateFailure(run);
  assert.ok(run.result.stderr.includes(specPath), run.result.stderr);
  assert.match(
    run.result.stderr,
    /error: no request base URL was resolved from spec ".*openapi\.json": no string `servers\[\]\.url` is defined/,
  );
  assert.match(
    run.result.stderr,
    /Set `baseUrl` in the config, or add an absolute `http\(s\)` `servers\[\]\.url` to the spec\./,
  );
  assert.doesNotMatch(run.result.stdout, /SpecWeaver run summary/);
});

test("built CLI exits 2 when the resolved servers URL is empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeServersSpec(dir, "empty.json", [{ url: "" }]);
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\n`,
  );

  assertBaseUrlGateFailure(run);
  assert.ok(run.result.stderr.includes(specPath), run.result.stderr);
  assert.match(
    run.result.stderr,
    /error: request base URL from spec ".*empty\.json" is empty \(""\)/,
  );
});

test("built CLI exits 2 when the resolved servers URL is relative", () => {
  for (const value of ["/v1", "api.example.com/v1"]) {
    const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
    const specPath = writeServersSpec(dir, "relative.json", [{ url: value }]);
    const run = runSandboxed(
      dir,
      `specs:\n  - ${specPath}\noperations: all\n`,
    );

    assertBaseUrlGateFailure(run);
    assert.ok(run.result.stderr.includes(specPath), run.result.stderr);
    assert.ok(
      run.result.stderr.includes(
        `is not usable: ${JSON.stringify(value)} is not an absolute URL`,
      ),
      run.result.stderr,
    );
  }
});

test("built CLI exits 2 for non-http(s) and unresolved-variable servers URLs", () => {
  for (const [value, expected, quoted] of [
    ["ftp://example.com", /does not use the http or https protocol/, true],
    [
      "https://{host}/api",
      /still contains the unresolved server-variable placeholder/,
      true,
    ],
    [
      "https://{}/api",
      /still contains the unresolved server-variable placeholder/,
      false,
    ],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
    const specPath = writeServersSpec(dir, "unusable.json", [{ url: value }]);
    const run = runSandboxed(
      dir,
      `specs:\n  - ${specPath}\noperations: all\n`,
    );

    assertBaseUrlGateFailure(run);
    assert.ok(run.result.stderr.includes(specPath), run.result.stderr);
    assert.ok(
      run.result.stderr.includes(
        quoted
          ? `is not usable: ${JSON.stringify(value)}`
          : `is not usable: ${JSON.stringify(REDACTED_BASE_URL_MARKER)}`,
      ),
      run.result.stderr,
    );
    assert.match(run.result.stderr, expected);
  }
});

test("built CLI wholistically masks every secret-bearing servers URL form", () => {
  for (const value of [
    // The motivating bypasses.
    "https://api.example.com/v1?access_token =SUPERSECRET",
    "https://api.example.com/v1?access_token\n=SUPERSECRET",
    "user:SEKRIT",
    "api.example.com/v1?jwt=SUPERSECRET",
    // Previously covered forms.
    "api.example.com/v1?client_secret=SUPERSECRET",
    "api.example.com/v1?X-Amz-Signature=SUPERSECRET",
    "api.example.com/v1#access_token=SUPERSECRET",
    "ftp://user:SUPERSECRET/part@example.com",
    "ftp://user:SUPERSECRET part@example.com",
    "//user:SUPERSECRET@example.com",
    // Adversarial malformed forms: userinfo behind ?/#, whitespace tails, and
    // userinfo-like values without an authority `//`.
    "ftp://user:SEKRIT_P?x@example.com",
    "ftp://user:SEKRIT_Q#x@example.com",
    "ftp://user:SEKRIT/?x=y@example.com",
    "api.example.com/v1?access_token=abc SEKRIT_SUFFIX",
    "api.example.com/v1?access_token=abc\tSEKRIT_SUFFIX",
    "user:SEKRIT_R@example.com",
    "ftp://user:SEKRIT",
    "//user:SEKRIT",
    "https://:x",
    // Embedded whitespace/control characters.
    "https://api.example.com\t/v1",
    "https://api.example.com\n/v1",
    "https://api.example.com\r/v1",
    "https://api.example.com\f/v1",
    "https://api.example.com\v/v1",
    "https://api.example.com /v1",
    "https://api.example.com\u0000/v1",
    " https://api.example.com ",
    // Malformed or empty brace placeholders.
    "https://{}/api",
    "https://{host/api",
    "https://api.example.com/{version",
    "https://api.example.com/version}",
    "https://{{host}}/api",
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
    const specPath = writeServersSpec(dir, "secret.json", [{ url: value }]);
    const run = runSandboxed(
      dir,
      `specs:\n  - ${specPath}\noperations: all\n`,
    );

    assertBaseUrlGateFailure(run);
    assert.ok(run.result.stderr.includes(specPath), run.result.stderr);
    assert.ok(
      run.result.stderr.includes(
        `is not usable: ${JSON.stringify(REDACTED_BASE_URL_MARKER)}`,
      ),
      run.result.stderr,
    );
    // The diagnostic still names the failure class and both remedies.
    assert.match(
      run.result.stderr,
      /(is not an absolute URL|does not use the http or https protocol|contains embedded whitespace or control characters|has surrounding whitespace|still contains the unresolved server-variable placeholder)/,
    );
    assert.match(
      run.result.stderr,
      /Set `baseUrl` in the config, or add an absolute `http\(s\)` `servers\[\]\.url` to the spec\./,
    );
    // No secret marker and no raw value, including any fragment of it.
    assert.doesNotMatch(run.result.stderr, /SEKRIT|SUPERSECRET/i);
    assert.doesNotMatch(
      run.result.stderr,
      /user:|access_token|client_secret|Signature=|jwt=/,
    );
    assert.equal(
      run.result.stderr.includes(value),
      false,
      `raw value leaked: ${JSON.stringify(value)}`,
    );
  }
});

test("built CLI quotes benign servers URLs in the failure diagnostic", () => {
  for (const value of [
    "/v1",
    "api.example.com/v1",
    "ftp://example.com",
    "https://{host}/api",
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
    const specPath = writeServersSpec(dir, "benign.json", [{ url: value }]);
    const run = runSandboxed(
      dir,
      `specs:\n  - ${specPath}\noperations: all\n`,
    );

    assertBaseUrlGateFailure(run);
    assert.ok(run.result.stderr.includes(specPath), run.result.stderr);
    assert.ok(
      run.result.stderr.includes(
        `is not usable: ${JSON.stringify(value)}`,
      ),
      run.result.stderr,
    );
  }

  // The empty string is quoted too, in the dedicated "is empty" diagnostic.
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeServersSpec(dir, "benign-empty.json", [{ url: "" }]);
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\n`,
  );
  assertBaseUrlGateFailure(run);
  assert.match(run.result.stderr, /is empty \(""\)/);
  assert.doesNotMatch(run.result.stderr, /value redacted/);
});

test("built CLI quotes an unresolved placeholder by name, not as a redacted URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const value = "https://{host}/api";
  const specPath = writeServersSpec(dir, "placeholder.json", [{ url: value }]);
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\n`,
  );

  assertBaseUrlGateFailure(run);
  // The whole URL is benign, so the allowlist quotes it verbatim.
  assert.ok(
    run.result.stderr.includes(`is not usable: ${JSON.stringify(value)}`),
    run.result.stderr,
  );
  // The placeholder is a variable identifier, not a URL: no redaction.
  assert.ok(
    run.result.stderr.includes(
      `still contains the unresolved server-variable placeholder "{host}"`,
    ),
    run.result.stderr,
  );
  assert.doesNotMatch(run.result.stderr, /placeholder \*\*\* \(value redacted/);
});

test("built CLI still masks a credential-bearing URL with an unresolved placeholder", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const value = "https://{user:SEKRIT@example.com}/api";
  const specPath = writeServersSpec(dir, "credential-placeholder.json", [
    { url: value },
  ]);
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\n`,
  );

  assertBaseUrlGateFailure(run);
  assert.ok(
    run.result.stderr.includes(
      `is not usable: ${JSON.stringify(REDACTED_BASE_URL_MARKER)}`,
    ),
    run.result.stderr,
  );
  assert.match(
    run.result.stderr,
    /still contains the unresolved server-variable placeholder/,
  );
  assert.doesNotMatch(run.result.stderr, /SEKRIT/);
});

test("built CLI rejects embedded whitespace/control characters before k6", () => {
  for (const value of [
    "https://api.example.com\t/v1",
    "https://api.example.com\n/v1",
    "https://api.example.com\r/v1",
    "https://api.example.com\f/v1",
    "https://api.example.com\v/v1",
    "https://api.example.com /v1",
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
    const specPath = writeServersSpec(dir, "whitespace.json", [{ url: value }]);
    const run = runSandboxed(
      dir,
      `specs:\n  - ${specPath}\noperations: all\n`,
    );

    assertBaseUrlGateFailure(run);
    assert.ok(run.result.stderr.includes(specPath), run.result.stderr);
    assert.ok(
      run.result.stderr.includes(
        `is not usable: ${JSON.stringify(REDACTED_BASE_URL_MARKER)} contains embedded whitespace or control characters`,
      ),
      run.result.stderr,
    );
    assert.equal(run.result.stderr.includes(value), false);
  }
});

test("built CLI rejects surrounding whitespace before k6", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeServersSpec(dir, "whitespace.json", [
    { url: " https://api.example.com " },
  ]);
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\n`,
  );

  assertBaseUrlGateFailure(run);
  assert.ok(run.result.stderr.includes(specPath), run.result.stderr);
  assert.ok(
    run.result.stderr.includes(
      `is not usable: ${JSON.stringify(REDACTED_BASE_URL_MARKER)} has surrounding whitespace`,
    ),
    run.result.stderr,
  );
  assert.equal(run.result.stderr.includes(" https://api.example.com "), false);
});

test("built CLI explicit baseUrl bypasses the gate under operations: all", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeServersSpec(dir, "openapi.json", [{ url: "/v1" }]);
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\nbaseUrl: https://staging.example.com\n`,
    { keepTemp: true },
  );

  assert.equal(run.result.status, EXIT_SUCCESS, run.result.stderr);
  assert.equal(existsSync(run.k6Marker), true, "k6 should have been invoked");
  assert.match(run.result.stdout, /k6 found:/);
  assert.equal(existsSync(run.resultsPath), true);

  const generated = run.result.stdout.match(/^Generated k6 script: (.+)$/m);
  assert.ok(generated, `expected a generated-script path:\n${run.result.stdout}`);
  const dataPath = join(
    dirname(generated[1].trim()),
    "specweaver.data.json",
  );
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  assert.equal(data.baseUrl, "https://staging.example.com");
});

test("built CLI accepts a valid absolute servers URL with substituted variable defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeServersSpec(dir, "openapi.json", [
    {
      url: "https://{host}/api",
      variables: { host: { default: "api.example.com" } },
    },
  ]);
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\n`,
    { keepTemp: true },
  );

  assert.equal(run.result.status, EXIT_SUCCESS, run.result.stderr);
  assert.equal(existsSync(run.k6Marker), true, "k6 should have been invoked");
  assert.equal(existsSync(run.resultsPath), true);

  const generated = run.result.stdout.match(/^Generated k6 script: (.+)$/m);
  assert.ok(generated, `expected a generated-script path:\n${run.result.stdout}`);
  const dataPath = join(
    dirname(generated[1].trim()),
    "specweaver.data.json",
  );
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  assert.equal(data.baseUrl, "https://api.example.com/api");
});

test("built CLI skips unusable servers entries and uses the first usable fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeServersSpec(dir, "openapi.json", [
    { url: "/v1" },
    { url: "" },
    { url: "ftp://example.com" },
    { url: "https://api.example.com/v1" },
    { url: "https://later.example.com" },
  ]);
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\n`,
    { keepTemp: true },
  );

  assert.equal(run.result.status, EXIT_SUCCESS, run.result.stderr);
  assert.equal(existsSync(run.k6Marker), true, "k6 should have been invoked");
  assert.equal(existsSync(run.resultsPath), true);
  const warnings =
    run.result.stderr.match(/^warning: skipping unusable .*$/gm) ?? [];
  assert.equal(warnings.length, 3, run.result.stderr);
  assert.match(warnings[0], /"\/v1".*it is not an absolute URL\./);
  assert.match(warnings[1], /"".*it is empty\./);
  assert.match(
    warnings[2],
    /"ftp:\/\/example\.com".*it does not use the http or https protocol\./,
  );
  assert.doesNotMatch(run.result.stderr, /is not usable/);

  const generated = run.result.stdout.match(/^Generated k6 script: (.+)$/m);
  assert.ok(generated, `expected a generated-script path:\n${run.result.stdout}`);
  const dataPath = join(
    dirname(generated[1].trim()),
    "specweaver.data.json",
  );
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  assert.equal(data.baseUrl, "https://api.example.com/v1");
  assert.equal(
    data.operations[0].url,
    "https://api.example.com/v1/pets",
  );
});

test("built CLI redacts skipped fallback values in warnings", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeServersSpec(dir, "openapi.json", [
    { url: "/v1?access_token=SUPERSECRET" },
    { url: "https://api.example.com/v1" },
  ]);
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\n`,
    { keepTemp: true },
  );

  assert.equal(run.result.status, EXIT_SUCCESS, run.result.stderr);
  assert.match(
    run.result.stderr,
    /warning: skipping unusable `servers\[\]\.url` ".*redacted.*"/,
  );
  assert.doesNotMatch(run.result.stderr, /SUPERSECRET|access_token/);
});

test("built CLI applies the base-URL gate to explicit operation lists too", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeServersSpec(dir, "openapi.json", [{ url: "/v1" }]);
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations:\n  - method: GET\n    path: /pets\n`,
  );

  assertBaseUrlGateFailure(run);
  assert.ok(run.result.stderr.includes(specPath), run.result.stderr);
  assert.ok(
    run.result.stderr.includes(
      'is not usable: "/v1" is not an absolute URL',
    ),
    run.result.stderr,
  );
});

test("built CLI base-URL failure is deterministic across repeated runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeServersSpec(dir, "openapi.json", [{ url: "" }]);
  const config = `specs:\n  - ${specPath}\noperations: all\n`;

  const first = runSandboxed(dir, config);
  const second = runSandboxed(dir, config);

  assertBaseUrlGateFailure(first);
  assertBaseUrlGateFailure(second);
  assert.equal(first.result.status, second.result.status);
  assert.equal(first.result.stderr, second.result.stderr);
  // Leave no kept artifacts behind from the success-path tests.
  rmSync(dir, { recursive: true, force: true });
});

// --- SPEC-25: coverage-gap warnings ---------------------------------------

/** Paths exercising the remaining coverage gaps (body, security) and a cookie parameter that must not warn. */
function coverageGapPaths() {
  return {
    "/pets": {
      get: {
        ...apiOperation(),
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: "session", in: "cookie", schema: { type: "string" } },
        ],
      },
      post: {
        ...apiOperation(),
        requestBody: {
          required: true,
          content: { "text/csv": { schema: { type: "object" } } },
        },
      },
    },
  };
}

/** A full document around {@link coverageGapPaths} carrying the bearer scheme. */
function coverageGapDocument() {
  return {
    openapi: "3.0.3",
    info: { title: "coverage", version: "1" },
    servers: [{ url: "http://127.0.0.1:1" }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    paths: coverageGapPaths(),
  };
}

/** Write {@link coverageGapDocument} and return its path. */
function writeCoverageGapSpec(dir, name = "openapi.json") {
  const specPath = join(dir, name);
  writeFileSync(specPath, JSON.stringify(coverageGapDocument()));
  return specPath;
}

/** Only the SPEC-25/SPEC-39 warning lines, in stderr order. */
function coverageWarningLines(stderr) {
  return stderr
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("warning: operation ") &&
        /(requires a request body|scheme|security requirement)/.test(line),
    );
}

test("built CLI warns about every coverage gap once and still runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeCoverageGapSpec(dir);
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\n`,
    { keepTemp: true },
  );

  assert.equal(run.result.status, EXIT_SUCCESS, run.result.stderr);
  assert.equal(existsSync(run.k6Marker), true, "k6 should have been invoked");
  assert.equal(existsSync(run.resultsPath), true, "results file should exist");

  const lines = coverageWarningLines(run.result.stderr);
  assert.equal(lines.length, 2, run.result.stderr);
  assert.match(
    lines[0],
    /^warning: operation "GET \/pets" declares bearer scheme "bearerAuth" but no auth\.token is configured/,
  );
  assert.match(
    lines[1],
    /^warning: operation "POST \/pets" requires a request body but declares none of the supported media types.*\(declared: "text\/csv"\)/,
  );
  // Cookie parameters are generated (SPEC-35), so they produce no warning.
  assert.doesNotMatch(run.result.stderr, /cookie parameter/);

  // The generated cookie parameter rides exactly one Cookie header.
  const generated = run.result.stdout.match(/^Generated k6 script: (.+)$/m);
  assert.ok(generated, `expected a generated-script path:\n${run.result.stdout}`);
  const dataPath = join(
    dirname(generated[1].trim()),
    "specweaver.data.json",
  );
  const data = JSON.parse(readFileSync(dataPath, "utf8"));
  const pets = data.operations.find(
    (operation) => operation.method === "GET" && operation.route === "/pets",
  );
  assert.match(pets.headers.Cookie, /^session=[^;]+$/);

  // Non-fatal: the operations still ran and are recorded in the results JSON.
  const results = JSON.parse(readFileSync(run.resultsPath, "utf8"));
  assert.deepEqual(Object.keys(results.checks), ["GET /pets", "POST /pets"]);
});

test("coverage warnings are selector-independent and deterministic", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeCoverageGapSpec(dir);

  const allRun = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\n`,
  );
  const explicitRun = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations:\n  - method: GET\n    path: /pets\n  - method: POST\n    path: /pets\n`,
  );
  const repeatedRun = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\n`,
  );

  assert.equal(allRun.result.status, EXIT_SUCCESS, allRun.result.stderr);
  assert.equal(explicitRun.result.status, EXIT_SUCCESS, explicitRun.result.stderr);
  assert.equal(repeatedRun.result.status, EXIT_SUCCESS, repeatedRun.result.stderr);

  // The same selected operations report the same gaps, and repeated runs are
  // byte-identical on stderr.
  assert.deepEqual(
    coverageWarningLines(allRun.result.stderr),
    coverageWarningLines(explicitRun.result.stderr),
  );
  assert.equal(allRun.result.stderr, repeatedRun.result.stderr);
});

test("a configured token, including an empty one, suppresses only the auth warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = writeCoverageGapSpec(dir);
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\nauth:\n  token: ""\n`,
  );

  assert.equal(run.result.status, EXIT_SUCCESS, run.result.stderr);
  const lines = coverageWarningLines(run.result.stderr);
  assert.equal(lines.length, 1, run.result.stderr);
  assert.match(lines[0], /requires a request body/);
  assert.doesNotMatch(run.result.stderr, /bearer scheme/);
  assert.doesNotMatch(run.result.stderr, /cookie parameter/);
});

test("built CLI emits securitySchemes-derived headers and query parameters", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = join(dir, "secured.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "secured", version: "1" },
      servers: [{ url: "http://127.0.0.1:1" }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
          headerKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
          queryKey: { type: "apiKey", in: "query", name: "api_key" },
        },
      },
      paths: {
        "/secure": {
          get: {
            ...apiOperation(),
            security: [
              { bearerAuth: [], headerKey: [], queryKey: [] },
            ],
          },
        },
      },
    }),
  );
  const run = runSandboxed(
    dir,
    `specs:\n  - ${specPath}\noperations: all\nauth:\n  token: token-secret\n  headers:\n    x-api-key: explicit-secret\n  apiKeys:\n    headerKey: derived-header-secret\n    queryKey: derived-query-secret\n`,
    { keepTemp: true },
  );

  assert.equal(run.result.status, EXIT_SUCCESS, run.result.stderr);
  assert.doesNotMatch(run.result.stderr, /^warning: operation /m);

  const generated = run.result.stdout.match(/^Generated k6 script: (.+)$/m);
  assert.ok(generated, `expected a generated-script path:\n${run.result.stdout}`);
  const data = JSON.parse(
    readFileSync(join(dirname(generated[1].trim()), "specweaver.data.json"), "utf8"),
  );
  const [operation] = data.operations;
  assert.equal(operation.headers.Authorization, "Bearer token-secret");
  // Explicit `auth.headers` wins case-insensitively over the derived header.
  assert.equal(operation.headers["x-api-key"], "explicit-secret");
  assert.equal("X-Api-Key" in operation.headers, false);
  // The derived query apiKey is appended under the scheme's parameter name.
  assert.equal(operation.query.api_key, "derived-query-secret");

  // Credentials never reach diagnostics or the results file.
  const results = readFileSync(run.resultsPath, "utf8");
  for (const secret of [
    "token-secret",
    "explicit-secret",
    "derived-header-secret",
    "derived-query-secret",
  ]) {
    assert.ok(!run.result.stdout.includes(secret), `stdout leaked ${secret}`);
    assert.ok(!run.result.stderr.includes(secret), `stderr leaked ${secret}`);
    assert.ok(!results.includes(secret), `results leaked ${secret}`);
  }
});

test("built CLI applies per-operation auth overrides only to matching requests", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const specPath = join(dir, "overrides.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "overrides", version: "1" },
      servers: [{ url: "http://127.0.0.1:1" }],
      components: {
        securitySchemes: {
          headerKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
          queryKey: { type: "apiKey", in: "query", name: "api_key" },
        },
      },
      paths: {
        "/public": { get: apiOperation() },
        "/admin": {
          get: {
            ...apiOperation(),
            security: [{ headerKey: [], queryKey: [] }],
          },
        },
      },
    }),
  );
  const run = runSandboxed(
    dir,
    `specs:
  - ${specPath}
operations: all
auth:
  token: global-token
  headers:
    X-Global: global-header
  apiKeys:
    headerKey: global-header-key
    queryKey: global-query-key
authOperations:
  - method: get
    path: /admin
    token: admin-token
    apiKeys:
      headerKey: admin-header-key
      queryKey: admin-query-key
  - method: POST
    path: /missing
    token: unused-token
`,
    { keepTemp: true },
  );

  assert.equal(run.result.status, EXIT_SUCCESS, run.result.stderr);
  assert.match(
    run.result.stderr,
    /warning: auth override for "POST \/missing" does not match any selected operation/,
  );

  const generated = run.result.stdout.match(/^Generated k6 script: (.+)$/m);
  assert.ok(generated, `expected a generated-script path:\n${run.result.stdout}`);
  const data = JSON.parse(
    readFileSync(join(dirname(generated[1].trim()), "specweaver.data.json"), "utf8"),
  );
  const publicOp = data.operations.find((operation) => operation.route === "/public");
  const adminOp = data.operations.find((operation) => operation.route === "/admin");

  assert.equal(publicOp.headers.Authorization, "Bearer global-token");
  assert.equal(publicOp.headers["X-Global"], "global-header");

  // Whole-surface replacement: global headers/credentials are not merged into
  // the overridden operation, and derived auth uses the override's apiKeys.
  assert.equal(adminOp.headers.Authorization, "Bearer admin-token");
  assert.equal("X-Global" in adminOp.headers, false);
  assert.equal(adminOp.headers["X-Api-Key"], "admin-header-key");
  assert.equal(adminOp.query.api_key, "admin-query-key");

  const results = readFileSync(run.resultsPath, "utf8");
  for (const secret of [
    "global-token",
    "global-header",
    "global-header-key",
    "global-query-key",
    "admin-token",
    "admin-header-key",
    "admin-query-key",
    "unused-token",
  ]) {
    assert.ok(!run.result.stdout.includes(secret), `stdout leaked ${secret}`);
    assert.ok(!run.result.stderr.includes(secret), `stderr leaked ${secret}`);
    assert.ok(!results.includes(secret), `results leaked ${secret}`);
  }
});

test("built CLI scrubs derived query credentials from k6's streamed output", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  const binDir = mkdtempSync(join(tmpdir(), "specweaver-bin-"));
  const sandbox = mkdtempSync(join(tmpdir(), "specweaver-tmp-"));
  const k6 = join(binDir, "k6");
  writeFileSync(
    k6,
    [
      "#!/bin/sh",
      "printf 'Get \"http://127.0.0.1:1/f?api_key=derived-query-secret\": refused\\n' >&2",
      "printf 'url http://127.0.0.1:1/f?api_key=derived-query-secret\\n'",
      "exit 0",
    ].join("\n"),
  );
  chmodSync(k6, 0o755);

  const specPath = join(dir, "query-key.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "query-key", version: "1" },
      servers: [{ url: "http://127.0.0.1:1" }],
      components: {
        securitySchemes: {
          queryKey: { type: "apiKey", in: "query", name: "api_key" },
        },
      },
      paths: {
        "/f": {
          get: { ...apiOperation(), security: [{ queryKey: [] }] },
        },
      },
    }),
  );
  const configPath = join(dir, "specweaver.yaml");
  writeFileSync(
    configPath,
    `specs:\n  - ${specPath}\noperations: all\nauth:\n  apiKeys:\n    queryKey: derived-query-secret\n`,
  );
  const resultsPath = join(dir, "results.json");

  const result = runCli(["--config", configPath, "--out", resultsPath], {
    env: { ...process.env, PATH: binDir, TMPDIR: sandbox },
  });

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  assert.match(result.stdout, /api_key=\*\*\*/);
  assert.match(result.stderr, /api_key=\*\*\*/);
  assert.ok(
    !result.stdout.includes("derived-query-secret"),
    `stdout leaked the credential:\n${result.stdout}`,
  );
  assert.ok(
    !result.stderr.includes("derived-query-secret"),
    `stderr leaked the credential:\n${result.stderr}`,
  );
  assert.ok(
    !readFileSync(resultsPath, "utf8").includes("derived-query-secret"),
    "results leaked the credential",
  );
});

test("coverage warnings are printed before the base-URL gate aborts the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-cli-"));
  // No `servers` member: SPEC-24 rejects the run before k6, but SPEC-25 must
  // still report the gaps in the selected operations first.
  const specPath = join(dir, "no-servers.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "no-servers", version: "1" },
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
      paths: coverageGapPaths(),
    }),
  );
  const run = runSandboxed(dir, `specs:\n  - ${specPath}\noperations: all\n`);

  assert.equal(run.result.status, EXIT_SPECWEAVER_ERROR, run.result.stderr);
  assert.match(run.result.stderr, /error: no request base URL was resolved/);
  assert.equal(existsSync(run.k6Marker), false, "k6 must not be invoked");
  const lines = coverageWarningLines(run.result.stderr);
  assert.deepEqual(
    lines.map((line) => line.match(/operation "([^"]+)"/)?.[1]),
    ["GET /pets", "POST /pets"],
  );
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
