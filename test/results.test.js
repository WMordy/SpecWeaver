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
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXIT_K6_RUN_FAILURE,
  EXIT_SPECWEAVER_ERROR,
  EXIT_SUCCESS,
  RESULTS_FILE_NAME,
  WARNING_PREFIX,
  buildResultsFile,
  countOperationChecks,
  formatSummary,
  formatUnexpectedError,
  formatWarnings,
  observeK6Results,
  outcomeForK6ExitCode,
  redactSecrets,
  resolveResultsPath,
  writeResultsFile,
} from "../dist/results.js";
import { EXIT_PREFLIGHT_FAILURE } from "../dist/run.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// --- Fixtures ---------------------------------------------------------------

const SERVER_URL = "http://127.0.0.1:1";
const PETS_URL = `${SERVER_URL}/pets`;

/** An `http_reqs` point. */
function httpReq(method, url, status) {
  return JSON.stringify({
    type: "Point",
    metric: "http_reqs",
    data: { value: 1, tags: { method, url, status: String(status) } },
  });
}

/** An `http_req_duration` point. */
function duration(value) {
  return JSON.stringify({
    type: "Point",
    metric: "http_req_duration",
    data: { value, tags: { method: "GET", url: PETS_URL, status: "200" } },
  });
}

/** An `iterations` point. */
function iteration() {
  return JSON.stringify({
    type: "Point",
    metric: "iterations",
    data: { value: 1 },
  });
}

/** An `checks` point (not used for per-operation attribution, but realistic). */
function check(value, name) {
  return JSON.stringify({
    type: "Point",
    metric: "checks",
    data: { value, tags: { check: name } },
  });
}

/** A realistic k6 NDJSON capture: 2x GET 200, 1x POST 201, 1x POST 500. */
function sampleNdjson() {
  return [
    JSON.stringify({
      type: "Metric",
      metric: "http_reqs",
      data: { name: "http_reqs", type: "counter", contains: "default" },
    }),
    httpReq("GET", PETS_URL, 200),
    httpReq("GET", PETS_URL, 200),
    httpReq("POST", PETS_URL, 201),
    httpReq("POST", PETS_URL, 500),
    duration(10.5),
    duration(20.5),
    iteration(),
    check(1, "status is 200"),
    check(0, "status is 200/201"),
  ].join("\n") + "\n";
}

const OPERATIONS = [
  {
    method: "GET",
    route: "/pets",
    url: PETS_URL,
    expectedStatus: [200],
    acceptAny2xx: false,
  },
  {
    method: "POST",
    route: "/pets",
    url: PETS_URL,
    expectedStatus: [201],
    acceptAny2xx: false,
  },
];

// --- Pure functions ---------------------------------------------------------

test("resolveResultsPath prefers --out, then config output, then the default", () => {
  assert.equal(
    resolveResultsPath({ out: "cli.json", output: "config.json" }),
    "cli.json",
  );
  assert.equal(resolveResultsPath({ output: "config.json" }), "config.json");
  assert.equal(resolveResultsPath({}), RESULTS_FILE_NAME);
  assert.equal(RESULTS_FILE_NAME, "specweaver-results.json");
});

test("outcomeForK6ExitCode maps zero to success and everything else to run_failure", () => {
  assert.equal(outcomeForK6ExitCode(0), "success");
  assert.equal(outcomeForK6ExitCode(1), "run_failure");
  assert.equal(outcomeForK6ExitCode(2), "run_failure");
  assert.equal(outcomeForK6ExitCode(null), "run_failure");
});

test("observeK6Results parses only the metrics the summary needs", () => {
  const observation = observeK6Results(sampleNdjson());
  assert.equal(observation.httpReqs, 4);
  assert.equal(observation.iterations, 1);
  assert.deepEqual(observation.durations, [10.5, 20.5]);
  assert.equal(observation.requests.length, 4);
  assert.deepEqual(observation.requests[0], {
    method: "GET",
    url: PETS_URL,
    status: 200,
  });
});

test("observeK6Results tolerates empty/malformed input", () => {
  const observation = observeK6Results("not json\n\n{\"type\":\"Point\"}\n");
  assert.equal(observation.httpReqs, 0);
  assert.deepEqual(observation.requests, []);
});

test("countOperationChecks attributes requests to operations by method + url", () => {
  const observation = observeK6Results(sampleNdjson());
  const { perOperation, aggregate } = countOperationChecks(
    OPERATIONS,
    observation,
  );
  assert.deepEqual(perOperation["GET /pets"], { pass: 2, fail: 0 });
  assert.deepEqual(perOperation["POST /pets"], { pass: 1, fail: 1 });
  assert.deepEqual(aggregate, { pass: 3, fail: 1 });
});

test("countOperationChecks accepts a wildcard 2XX operation", () => {
  const wildcard = [
    {
      method: "GET",
      route: "/pets",
      url: PETS_URL,
      expectedStatus: [],
      acceptAny2xx: true,
    },
  ];
  const raw = [httpReq("GET", PETS_URL, 204), httpReq("GET", PETS_URL, 301)].join(
    "\n",
  );
  const { perOperation } = countOperationChecks(
    wildcard,
    observeK6Results(raw),
  );
  assert.deepEqual(perOperation["GET /pets"], { pass: 1, fail: 1 });
});

test("buildResultsFile produces the documented schema", () => {
  const results = buildResultsFile({
    version: "9.9.9",
    vus: 2,
    duration: "5s",
    k6ExitCode: 0,
    outcome: "success",
    operations: OPERATIONS,
    rawK6Results: sampleNdjson(),
    resultsFile: "/tmp/specweaver-results.json",
    timestamp: "2026-10-18T00:00:00.000Z",
  });

  assert.deepEqual(Object.keys(results).sort(), [
    "checks",
    "config",
    "k6ExitCode",
    "outcome",
    "resultsFile",
    "summary",
    "timestamp",
    "tool",
    "version",
  ]);
  assert.equal(results.tool, "specweaver");
  assert.equal(results.version, "9.9.9");
  assert.equal(results.timestamp, "2026-10-18T00:00:00.000Z");
  assert.deepEqual(results.config, { vus: 2, duration: "5s" });
  assert.equal(results.k6ExitCode, 0);
  assert.equal(results.outcome, "success");
  assert.deepEqual(results.checks["GET /pets"], { pass: 2, fail: 0 });
  assert.deepEqual(results.checks["POST /pets"], { pass: 1, fail: 1 });
  assert.deepEqual(results.summary.checks, { pass: 3, fail: 1, rate: 0.75 });
  assert.equal(results.summary.httpReqs, 4);
  assert.equal(results.summary.iterations, 1);
  assert.equal(results.summary.httpReqDurationMs.avg, 15.5);
  assert.equal(results.summary.httpReqDurationMs.min, 10.5);
  assert.equal(results.summary.httpReqDurationMs.max, 20.5);
  assert.equal(results.resultsFile, "/tmp/specweaver-results.json");
});

test("buildResultsFile yields no checks and a null duration for no captured results", () => {
  const results = buildResultsFile({
    version: "1",
    vus: 1,
    duration: "1s",
    k6ExitCode: 2,
    outcome: "run_failure",
    operations: OPERATIONS,
    resultsFile: "results.json",
    timestamp: "2026-10-18T00:00:00.000Z",
  });
  assert.deepEqual(results.checks["GET /pets"], { pass: 0, fail: 0 });
  assert.deepEqual(results.summary.checks, { pass: 0, fail: 0, rate: 1 });
  assert.equal(results.summary.httpReqDurationMs, null);
});

test("writeResultsFile writes valid JSON, creates parent dirs, returns the absolute path", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-results-"));
  const target = join(dir, "nested", "results.json");
  const results = buildResultsFile({
    version: "1",
    vus: 1,
    duration: "1s",
    k6ExitCode: 0,
    outcome: "success",
    operations: OPERATIONS,
    rawK6Results: sampleNdjson(),
    resultsFile: target,
    timestamp: "2026-10-18T00:00:00.000Z",
  });

  const written = writeResultsFile(results);
  assert.equal(written, resolve(target));
  const parsed = JSON.parse(readFileSync(written, "utf8"));
  assert.equal(parsed.outcome, "success");
  assert.equal(parsed.resultsFile, resolve(target));
});

test("formatSummary covers the outcome, per-operation checks, and the results path", () => {
  const results = buildResultsFile({
    version: "1",
    vus: 2,
    duration: "5s",
    k6ExitCode: 0,
    outcome: "success",
    operations: OPERATIONS,
    rawK6Results: sampleNdjson(),
    resultsFile: "/tmp/specweaver-results.json",
    timestamp: "2026-10-18T00:00:00.000Z",
  });
  const summary = formatSummary(results);
  assert.match(summary, /Outcome: success/);
  assert.match(summary, /GET \/pets {2,}pass 2 {2}fail 0/);
  assert.match(summary, /POST \/pets {2,}pass 1 {2}fail 1/);
  assert.match(summary, /Checks total: 3 passed, 1 failed/);
  assert.match(summary, /Results file: \/tmp\/specweaver-results\.json/);
});

test("formatWarnings prefixes each message with `warning:` and de-duplicates", () => {
  const text = formatWarnings(["unresolved X", "unresolved X", "unresolved Y"]);
  assert.equal(text, "warning: unresolved X\nwarning: unresolved Y\n");
  assert.equal(formatWarnings([]), "");
});

test("formatWarnings de-duplicates by unresolved variable name (A6)", () => {
  // The same variable unresolved in two fields must warn once, keeping the first
  // (stable) representative message rather than one line per location.
  const warnings = [
    'unresolved environment variable "FOO" referenced in `auth.token`',
    'unresolved environment variable "FOO" referenced in `auth.headers.X-Api-Key`',
    'unresolved environment variable "BAR" referenced in `auth.headers.Y`',
  ];
  assert.equal(
    formatWarnings(warnings),
    "warning: unresolved environment variable \"FOO\" referenced in `auth.token`\n" +
      "warning: unresolved environment variable \"BAR\" referenced in `auth.headers.Y`\n",
  );
  assert.equal(WARNING_PREFIX, "warning:");

  // A shared `seen` set suppresses a variable already reported by an earlier
  // call (config load vs. auth injection are separate calls in the CLI).
  const seen = new Set();
  assert.notEqual(
    formatWarnings(
      ['unresolved environment variable "FOO" referenced in `auth.token`'],
      seen,
    ),
    "",
  );
  assert.equal(
    formatWarnings(
      ['unresolved environment variable "FOO" referenced in `auth.headers.X`'],
      seen,
    ),
    "",
  );
});

test("formatUnexpectedError yields a clean, stack-free, actionable message (AC10)", () => {
  const error = new Error("boom");
  error.stack = "Error: boom\n    at secret (/x/y.js:1:1)";
  const message = formatUnexpectedError(error, {});
  assert.match(message, /unexpected internal error/i);
  assert.match(message, /boom/);
  // No raw stack frames.
  assert.doesNotMatch(message, /\n\s+at\s/);
  assert.doesNotMatch(message, /\/x\/y\.js/);
});

test("formatUnexpectedError redacts secret-looking env values (AC10)", () => {
  const message = formatUnexpectedError(
    new Error("request failed with token ABCDEFSECRET"),
    { API_TOKEN: "ABCDEFSECRET" },
  );
  assert.doesNotMatch(message, /ABCDEFSECRET/);
  assert.match(message, /\*\*\*/);
});

test("redactSecrets ignores short or non-sensitive env values", () => {
  assert.equal(redactSecrets("hello world", { API_TOKEN: "hi" }), "hello world");
  assert.equal(redactSecrets("hello", { UNRELATED: "goodbye" }), "hello");
});

// --- Built-CLI integration (k6 mocked so the suite runs without k6) ---------

/** Write a valid OpenAPI 3.0 spec (GET /pets -> 200, POST /pets -> 201). */
function writeSpec(dir) {
  const specPath = join(dir, "openapi.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: SERVER_URL }],
      paths: {
        "/pets": {
          get: { responses: { "200": {} } },
          post: { responses: { "201": {} } },
        },
      },
    }),
  );
  return specPath;
}

/** Write a config selecting GET /pets and POST /pets. */
function writeConfig(dir, extra = "") {
  const specPath = writeSpec(dir);
  const configPath = join(dir, "specweaver.yaml");
  writeFileSync(
    configPath,
    `specs:\n  - ${specPath}\noperations:\n  - method: GET\n    path: /pets\n  - method: POST\n    path: /pets\nload:\n  vus: 2\n  duration: 5s\n${extra}`,
  );
  return configPath;
}

/**
 * Write a fake `k6` that copies a fixture NDJSON file to the `--out json=<file>`
 * path when asked, prints to both streams, and exits with `code`.
 */
function fakeK6(binDir, { fixture, code = 0 } = {}) {
  const file = join(binDir, "k6");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      'capture=""',
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    json=*) capture="${arg#json=}" ;;',
      "  esac",
      "done",
      'if [ -n "$capture" ] && [ -n "$K6_FIXTURE" ] && [ -f "$K6_FIXTURE" ]; then',
      '  /bin/cp "$K6_FIXTURE" "$capture"',
      "fi",
      'echo "FAKE_K6_STDOUT"',
      `exit ${code}`,
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
  return fixture;
}

/** Run the built CLI with k6 mocked; returns the spawnSync result. */
function runCli(
  configPath,
  { binDir, fixture, cwd, args = [], env = {}, unset = [] } = {},
) {
  // Isolate each invocation's temp namespace: the CLI creates a unique per-run
  // directory (and k6 raw capture) under TMPDIR, so parallel test files must
  // not share one.
  const sandbox = mkdtempSync(join(tmpdir(), "sw-tmp-"));
  const childEnv = {
    ...process.env,
    PATH: binDir,
    K6_FIXTURE: fixture ?? "",
    TMPDIR: sandbox,
    ...env,
  };
  for (const key of unset) {
    delete childEnv[key];
  }
  return spawnSync(process.execPath, [cliPath, "--config", configPath, ...args], {
    encoding: "utf8",
    cwd,
    env: childEnv,
  });
}

test("built CLI writes the results file to --out and exits 0 on success", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-res-"));
  const specDir = mkdtempSync(join(tmpdir(), "sw-res-"));
  const configPath = writeConfig(dir);
  const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  const fixture = join(dir, "fixture.ndjson");
  writeFileSync(fixture, sampleNdjson());
  fakeK6(binDir, { fixture });
  const outPath = join(specDir, "results.json");

  const result = runCli(configPath, {
    binDir,
    fixture,
    args: ["--out", outPath],
  });

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  assert.ok(existsSync(outPath), "results file should be written");
  const parsed = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(parsed.outcome, "success");
  assert.equal(parsed.k6ExitCode, 0);
  assert.deepEqual(parsed.config, { vus: 2, duration: "5s" });
  assert.deepEqual(parsed.checks["GET /pets"], { pass: 2, fail: 0 });
  assert.deepEqual(parsed.checks["POST /pets"], { pass: 1, fail: 1 });
  assert.equal(parsed.resultsFile, resolve(outPath));
  // One console summary, covering the outcome and the results path.
  assert.match(result.stdout, /SpecWeaver run summary/);
  assert.match(result.stdout, /Outcome: success/);
  assert.match(result.stdout, new RegExp(`Results file: .*results\\.json`));
});

test("built CLI uses the config `output` field when --out is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-res-"));
  const configPath = writeConfig(dir, "output: config-results.json\n");
  const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  const fixture = join(dir, "fixture.ndjson");
  writeFileSync(fixture, sampleNdjson());
  fakeK6(binDir, { fixture });

  const result = runCli(configPath, { binDir, fixture, cwd: dir });

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  assert.ok(existsSync(join(dir, "config-results.json")));
});

test("built CLI --out takes precedence over the config `output` field", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-res-"));
  const configPath = writeConfig(dir, "output: config-results.json\n");
  const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  const fixture = join(dir, "fixture.ndjson");
  writeFileSync(fixture, sampleNdjson());
  fakeK6(binDir, { fixture });
  const cliOut = join(dir, "cli-results.json");

  const result = runCli(configPath, {
    binDir,
    fixture,
    cwd: dir,
    args: ["--out", cliOut],
  });

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  assert.ok(existsSync(cliOut), "the --out path should win");
  assert.equal(existsSync(join(dir, "config-results.json")), false);
});

test("built CLI defaults the results file to specweaver-results.json in the cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-res-"));
  const configPath = writeConfig(dir);
  const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  const fixture = join(dir, "fixture.ndjson");
  writeFileSync(fixture, sampleNdjson());
  fakeK6(binDir, { fixture });

  const result = runCli(configPath, { binDir, fixture, cwd: dir });

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  const defaultPath = join(dir, RESULTS_FILE_NAME);
  assert.ok(existsSync(defaultPath), "default results file should exist in cwd");
  const parsed = JSON.parse(readFileSync(defaultPath, "utf8"));
  assert.equal(parsed.resultsFile, resolve(defaultPath));
});

test("built CLI exits 1 on a k6 run failure and still writes a run_failure results file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-res-"));
  const configPath = writeConfig(dir);
  const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  const fixture = join(dir, "fixture.ndjson");
  writeFileSync(fixture, sampleNdjson());
  fakeK6(binDir, { fixture, code: 2 });
  const outPath = join(dir, "results.json");

  const result = runCli(configPath, {
    binDir,
    fixture,
    args: ["--out", outPath],
  });

  assert.equal(result.status, EXIT_K6_RUN_FAILURE);
  assert.notEqual(result.status, EXIT_SUCCESS);
  assert.match(result.stderr, /k6 run failed \(exit code 2\)/);
  const parsed = JSON.parse(readFileSync(outPath, "utf8"));
  assert.equal(parsed.outcome, "run_failure");
  assert.equal(parsed.k6ExitCode, 2);
});

test("built CLI exits 2 on a SpecWeaver-level error and writes no results file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-res-"));
  const configPath = join(dir, "specweaver.yaml");
  writeFileSync(configPath, "operations: []\n");
  const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  fakeK6(binDir, { code: 0 });
  const outPath = join(dir, "results.json");

  const result = runCli(configPath, {
    binDir,
    args: ["--out", outPath],
  });

  assert.equal(result.status, EXIT_SPECWEAVER_ERROR);
  assert.notEqual(result.status, EXIT_K6_RUN_FAILURE);
  assert.equal(existsSync(outPath), false);
});

test("built CLI reports k6-missing as a SpecWeaver error (code 2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-res-"));
  const configPath = writeConfig(dir);
  const emptyBin = mkdtempSync(join(tmpdir(), "sw-empty-"));
  const outPath = join(dir, "results.json");

  const result = runCli(configPath, {
    binDir: emptyBin,
    args: ["--out", outPath],
  });

  assert.equal(result.status, EXIT_SPECWEAVER_ERROR);
  assert.equal(result.status, EXIT_PREFLIGHT_FAILURE);
  assert.match(result.stderr, /k6 was not found on your PATH/);
  assert.equal(existsSync(outPath), false);
});

test("built CLI warns on stderr for an unresolved env var, non-fatally, without leaking it into results", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-res-"));
  const configPath = writeConfig(
    dir,
    "auth:\n  token: \"${SPECWEAVER_TEST_UNSET_VAR}\"\n",
  );
  const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  const fixture = join(dir, "fixture.ndjson");
  writeFileSync(fixture, sampleNdjson());
  fakeK6(binDir, { fixture });
  const outPath = join(dir, "results.json");

  const result = runCli(configPath, {
    binDir,
    fixture,
    args: ["--out", outPath],
    unset: ["SPECWEAVER_TEST_UNSET_VAR"],
  });

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  assert.match(
    result.stderr,
    /warning: unresolved environment variable "SPECWEAVER_TEST_UNSET_VAR"/,
  );
  const contents = readFileSync(outPath, "utf8");
  assert.doesNotMatch(contents, /SPECWEAVER_TEST_UNSET_VAR/);
});

test("built CLI warns once per unresolved variable across fields (A6)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-res-"));
  const configPath = writeConfig(
    dir,
    'auth:\n  token: "${SW_DUP_UNSET}"\n  headers:\n    X-Api-Key: "${SW_DUP_UNSET}"\n',
  );
  const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  const fixture = join(dir, "fixture.ndjson");
  writeFileSync(fixture, sampleNdjson());
  fakeK6(binDir, { fixture });
  const outPath = join(dir, "results.json");

  const result = runCli(configPath, {
    binDir,
    fixture,
    args: ["--out", outPath],
    unset: ["SW_DUP_UNSET"],
  });

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  // The one variable is unresolved in two fields, so it warns exactly once.
  const occurrences = result.stderr.split("SW_DUP_UNSET").length - 1;
  assert.equal(occurrences, 1, result.stderr);
});

test("built CLI reports an unexpected internal error cleanly as exit 2, not 1 (AC10)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-res-"));
  const configPath = writeConfig(dir);
  const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  fakeK6(binDir, { code: 0 });
  const outPath = join(dir, "results.json");

  // Force an unexpected failure inside script emission: TMPDIR is a *regular
  // file*, so writing the generated script fails (ENOTDIR) before k6 is run.
  const notADirectory = join(dir, "not-a-dir");
  writeFileSync(notADirectory, "x");

  const result = runCli(configPath, {
    binDir,
    args: ["--out", outPath],
    env: { TMPDIR: notADirectory },
  });

  assert.equal(result.status, EXIT_SPECWEAVER_ERROR, result.stderr);
  assert.notEqual(result.status, EXIT_K6_RUN_FAILURE);
  // A clean, actionable message rather than a raw Node stack trace.
  assert.match(result.stderr, /unexpected internal error/i);
  assert.doesNotMatch(result.stderr, /\n\s+at\s/);
  // The SpecWeaver-level error means k6 was never executed.
  assert.doesNotMatch(result.stdout, /Generated k6 script/);
  assert.equal(existsSync(outPath), false);
});

test("built CLI uses the lowercase `warning:` prefix for an unknown operation", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-res-"));
  const specPath = writeSpec(dir);
  const configPath = join(dir, "specweaver.yaml");
  writeFileSync(
    configPath,
    `specs:\n  - ${specPath}\noperations:\n  - method: GET\n    path: /pets\n  - method: GET\n    path: /missing\nload:\n  vus: 1\n  duration: 1s\n`,
  );
  const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  const fixture = join(dir, "fixture.ndjson");
  writeFileSync(fixture, sampleNdjson());
  fakeK6(binDir, { fixture });

  const result = runCli(configPath, {
    binDir,
    fixture,
    args: ["--out", join(dir, "results.json")],
  });

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  assert.match(
    result.stderr,
    /warning: operation "GET \/missing" is not present/,
  );
  assert.doesNotMatch(result.stderr, /Warning:/);
});
