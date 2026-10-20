import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  EXIT_K6_RUN_FAILURE,
  EXIT_PREFLIGHT_FAILURE,
  EXIT_SUCCESS,
  K6_INSTALL_URL,
  K6NotFoundError,
  K6SpawnError,
  KEEP_TEMP_ENV,
  generatedDataPath,
  generatedScriptPath,
  mapK6ExitCode,
  rawResultsPath,
  resolveK6,
  runGeneratedTest,
} from "../dist/run.js";
import { DATA_FILE_NAME, SCRIPT_FILE_NAME } from "../dist/script/emit.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** A temp directory containing an executable file named `name`. */
function dirWithExecutable(name = "k6", content = "#!/bin/sh\nexit 0\n") {
  const dir = mkdtempSync(join(tmpdir(), "sw-run-"));
  const file = join(dir, name);
  writeFileSync(file, content);
  chmodSync(file, 0o755);
  return { dir, file };
}

/** A spawn stub that records its calls and emits `close` with the given code. */
function spawnStub(code, signal = null) {
  const calls = [];
  const impl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    process.nextTick(() => child.emit("close", code, signal));
    return child;
  };
  return { impl, calls };
}

/** A spawn stub whose child emits an `error` event (spawn-level failure). */
function spawnErrorStub(error) {
  return () => {
    const child = new EventEmitter();
    process.nextTick(() => child.emit("error", error));
    return child;
  };
}

// --- PATH discovery (locked decisions 4 and 5) -----------------------------

test("resolveK6 finds `k6` in a PATH directory", () => {
  const { dir, file } = dirWithExecutable();
  assert.equal(resolveK6({ PATH: dir }, "linux"), file);
});

test("resolveK6 returns undefined when `k6` is not on PATH", () => {
  const empty = mkdtempSync(join(tmpdir(), "sw-run-"));
  assert.equal(resolveK6({ PATH: empty }, "linux"), undefined);
  assert.equal(resolveK6({}, "linux"), undefined);
  assert.equal(resolveK6({ PATH: "" }, "linux"), undefined);
});

test("resolveK6 resolves `k6.exe` on Windows", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-run-"));
  writeFileSync(join(dir, "k6.exe"), "");
  assert.equal(resolveK6({ Path: dir }, "win32"), join(dir, "k6.exe"));
});

test("resolveK6 reports presence for a non-executable file (spawn fails later)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-run-"));
  const file = join(dir, "k6"); // no exec bit
  writeFileSync(file, "not executable\n");
  assert.equal(resolveK6({ PATH: dir }, "linux"), file);
});

// --- Exit-code mapping (locked decision 7) ---------------------------------

test("mapK6ExitCode: zero maps to success, non-zero to the k6-run-failure code", () => {
  assert.equal(mapK6ExitCode(0, null), EXIT_SUCCESS);
  assert.equal(mapK6ExitCode(1, null), EXIT_K6_RUN_FAILURE);
  assert.equal(mapK6ExitCode(2, null), EXIT_K6_RUN_FAILURE);
  assert.equal(mapK6ExitCode(127, null), EXIT_K6_RUN_FAILURE);
});

test("mapK6ExitCode: termination by signal is a run failure", () => {
  assert.equal(mapK6ExitCode(null, "SIGINT"), EXIT_K6_RUN_FAILURE);
  assert.equal(mapK6ExitCode(null, "SIGKILL"), EXIT_K6_RUN_FAILURE);
});

// --- Generated-script temp location (locked decision 1, SPEC-11) -----------

test("generated script/data paths use the specweaver file names inside a run directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-run-"));
  assert.equal(generatedScriptPath(dir), join(dir, SCRIPT_FILE_NAME));
  assert.equal(generatedDataPath(dir), join(dir, DATA_FILE_NAME));
  assert.equal(rawResultsPath(dir), join(dir, "specweaver.k6-results.ndjson"));
  assert.equal(SCRIPT_FILE_NAME, "specweaver.generated.js");
  assert.equal(DATA_FILE_NAME, "specweaver.data.json");
});

// --- Spawning k6 (locked decisions 3, 5, 6) --------------------------------

test("runGeneratedTest spawns `k6 run` with --vus/--duration and inherits stdio", async () => {
  const { dir } = dirWithExecutable();
  const scriptPath = generatedScriptPath(dir);
  writeFileSync(scriptPath, "// generated\n");

  const { impl, calls } = spawnStub(0);
  const result = await runGeneratedTest({
    command: "/fake/k6",
    scriptPath,
    directory: dir,
    vus: 10,
    duration: "30s",
    spawn: impl,
  });

  assert.equal(result.exitCode, EXIT_SUCCESS);
  assert.equal(result.k6ExitCode, 0);
  assert.equal(result.k6Path, "/fake/k6");
  assert.equal(result.scriptPath, scriptPath);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/fake/k6");
  assert.deepEqual(calls[0].args, [
    "run",
    "--vus",
    "10",
    "--duration",
    "30s",
    scriptPath,
  ]);
  // stdio inheritance is what streams k6 output live (decision 3).
  assert.equal(calls[0].options.stdio, "inherit");
});

test("runGeneratedTest maps a non-zero k6 exit to the run-failure code without swallowing it", async () => {
  const { dir } = dirWithExecutable();
  const scriptPath = generatedScriptPath(dir);
  writeFileSync(scriptPath, "// generated\n");

  const { impl } = spawnStub(5);
  const result = await runGeneratedTest({
    command: "/fake/k6",
    scriptPath,
    directory: dir,
    vus: 1,
    duration: "1s",
    spawn: impl,
  });

  assert.equal(result.exitCode, EXIT_K6_RUN_FAILURE);
  assert.equal(result.k6ExitCode, 5);
  assert.notEqual(result.exitCode, EXIT_SUCCESS);
});

test("runGeneratedTest reports a spawn-level failure distinctly as K6SpawnError", async () => {
  const { dir } = dirWithExecutable();
  const scriptPath = generatedScriptPath(dir);
  writeFileSync(scriptPath, "// generated\n");

  const error = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
  await assert.rejects(
    () =>
      runGeneratedTest({
        command: "/fake/k6",
        scriptPath,
        directory: dir,
        spawn: spawnErrorStub(error),
      }),
    (thrown) => {
      assert.ok(thrown instanceof K6SpawnError);
      assert.match(thrown.message, /Failed to launch k6/);
      assert.match(thrown.message, /EACCES/);
      return true;
    },
  );
});

test("runGeneratedTest throws K6NotFoundError when k6 cannot be resolved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-run-"));
  await assert.rejects(
    () => runGeneratedTest({ env: { PATH: dir }, directory: dir }),
    K6NotFoundError,
  );
});

test("runGeneratedTest resolves k6 from the supplied PATH when no command is given", async () => {
  const { dir, file } = dirWithExecutable();
  const scriptPath = generatedScriptPath(dir);
  writeFileSync(scriptPath, "// generated\n");

  const { impl, calls } = spawnStub(0);
  await runGeneratedTest({
    env: { PATH: dir },
    scriptPath,
    directory: dir,
    spawn: impl,
  });
  assert.equal(calls[0].command, file);
});

// --- Result capture (SPEC-8, A3) -------------------------------------------

test("runGeneratedTest captures k6 metrics via --out json=<tempfile> when asked", async () => {
  const { dir } = dirWithExecutable();
  const scriptPath = generatedScriptPath(dir);
  writeFileSync(scriptPath, "// generated\n");

  const capturePath = rawResultsPath(dir);
  const ndjson = '{"type":"Point","metric":"iterations","data":{"value":1}}\n';
  writeFileSync(capturePath, ndjson);

  const { impl, calls } = spawnStub(0);
  const result = await runGeneratedTest({
    command: "/fake/k6",
    scriptPath,
    directory: dir,
    captureResults: true,
    spawn: impl,
  });

  assert.equal(result.rawResults, ndjson);
  assert.deepEqual(calls[0].args, [
    "run",
    "--out",
    `json=${capturePath}`,
    scriptPath,
  ]);
  // The capture file is cleaned up with the other temp artifacts.
  assert.equal(existsSync(capturePath), false);
});

test("runGeneratedTest does not add --out and returns no raw results by default", async () => {
  const { dir } = dirWithExecutable();
  const scriptPath = generatedScriptPath(dir);
  writeFileSync(scriptPath, "// generated\n");

  const { impl, calls } = spawnStub(0);
  const result = await runGeneratedTest({
    command: "/fake/k6",
    scriptPath,
    directory: dir,
    spawn: impl,
  });

  assert.equal(result.rawResults, undefined);
  assert.deepEqual(calls[0].args, ["run", scriptPath]);
});

// --- Temp-script lifecycle (locked decision 2) -----------------------------
test("runGeneratedTest removes the generated temp artifacts after the run by default", async () => {
  const { dir } = dirWithExecutable();
  const scriptPath = generatedScriptPath(dir);
  writeFileSync(scriptPath, "// generated\n");
  writeFileSync(generatedDataPath(dir), "{}\n");

  const { impl } = spawnStub(0);
  await runGeneratedTest({
    command: "/fake/k6",
    scriptPath,
    directory: dir,
    spawn: impl,
  });

  assert.equal(existsSync(scriptPath), false);
  assert.equal(existsSync(generatedDataPath(dir)), false);
});

test("runGeneratedTest removes the whole per-run directory when asked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-run-"));
  writeFileSync(generatedScriptPath(dir), "// generated\n");
  writeFileSync(generatedDataPath(dir), "{}\n");
  writeFileSync(rawResultsPath(dir), "{}\n");

  const { impl } = spawnStub(0);
  await runGeneratedTest({
    command: "/fake/k6",
    scriptPath: generatedScriptPath(dir),
    directory: dir,
    removeDirectory: true,
    spawn: impl,
  });

  assert.equal(existsSync(dir), false);
});

test("runGeneratedTest keeps the temp artifacts when the keep-temp opt-out is set", async () => {
  const { dir } = dirWithExecutable();
  const scriptPath = generatedScriptPath(dir);
  writeFileSync(scriptPath, "// generated\n");
  writeFileSync(generatedDataPath(dir), "{}\n");

  const { impl } = spawnStub(0);
  await runGeneratedTest({
    command: "/fake/k6",
    scriptPath,
    directory: dir,
    keepTemp: true,
    removeDirectory: true,
    spawn: impl,
  });

  assert.equal(existsSync(dir), true);
  assert.equal(existsSync(scriptPath), true);
  assert.equal(existsSync(generatedDataPath(dir)), true);
});

test("runGeneratedTest honours the keep-temp environment opt-out", async () => {
  const { dir } = dirWithExecutable();
  const scriptPath = generatedScriptPath(dir);
  writeFileSync(scriptPath, "// generated\n");

  const { impl } = spawnStub(0);
  await runGeneratedTest({
    command: "/fake/k6",
    scriptPath,
    directory: dir,
    removeDirectory: true,
    env: { PATH: dir, [KEEP_TEMP_ENV]: "1" },
    spawn: impl,
  });

  assert.equal(existsSync(dir), true);
  assert.equal(existsSync(scriptPath), true);
});

// --- Built-CLI integration (k6 stubbed/mocked so the suite runs without k6) -

/** Write a minimal valid OpenAPI 3.0 spec and return its path. */
function writeSpec(dir) {
  const specPath = join(dir, "openapi.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "t", version: "1" },
      servers: [{ url: "http://127.0.0.1:1" }],
      paths: { "/pets": { get: { responses: { "200": {} } } } },
    }),
  );
  return specPath;
}

/** Write a config selecting GET /pets and return its path. */
function writeConfig(dir) {
  const specPath = writeSpec(dir);
  const configPath = join(dir, "specweaver.yaml");
  writeFileSync(
    configPath,
    `specs:\n  - ${specPath}\noperations:\n  - method: GET\n    path: /pets\nload:\n  vus: 2\n  duration: 5s\n`,
  );
  return configPath;
}

/** Write a fake `k6` executable that prints and exits with `code`. */
function fakeK6(dir, { stdout = "", stderr = "", code = 0 } = {}) {
  const file = join(dir, "k6");
  writeFileSync(
    file,
    `#!/bin/sh\necho "${stdout}"\necho "${stderr}" >&2\nexit ${code}\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

/** Run the built CLI with a restricted PATH. */
function runCliWithPath(configPath, pathDir, extraArgs = []) {
  // Isolate each invocation's temp namespace: the CLI creates a unique per-run
  // directory under TMPDIR, and parallel test files must not share one.
  const sandbox = mkdtempSync(join(tmpdir(), "sw-tmp-"));
  const result = spawnSync(
    process.execPath,
    [cliPath, "--config", configPath, ...extraArgs],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: pathDir, TMPDIR: sandbox },
    },
  );
  // Expose the sandbox so tests can assert the CLI cleaned it out.
  return { ...result, tempSandbox: sandbox };
}

test("built CLI prints a single clear k6-missing error and exits non-zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-cli-run-"));
  const configPath = writeConfig(dir);
  const empty = mkdtempSync(join(tmpdir(), "sw-empty-"));

  const result = runCliWithPath(configPath, empty);

  assert.equal(result.status, EXIT_PREFLIGHT_FAILURE);
  assert.match(result.stderr, /k6 was not found on your PATH/);
  assert.ok(result.stderr.includes(K6_INSTALL_URL), "points at install instructions");
  // It must not attempt to run or "succeed" when k6 is missing.
  assert.doesNotMatch(result.stdout, /Generated k6 script/);
});

test("built CLI checks presence and forwards a zero k6 exit as success", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-cli-run-"));
  const configPath = writeConfig(dir);
  const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  fakeK6(binDir, { stdout: "FAKE_K6_STDOUT", code: 0 });

  const result = runCliWithPath(configPath, binDir, [
    "--out",
    join(dir, "results.json"),
  ]);

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  assert.match(result.stdout, /k6 found:/);
  // k6's own stdout is streamed through to the CLI's stdout in real time.
  assert.match(result.stdout, /FAKE_K6_STDOUT/);
});

test("built CLI removes its unique per-run temp directory after the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-cli-run-"));
  const configPath = writeConfig(dir);
  const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  fakeK6(binDir, { stdout: "FAKE_K6_STDOUT", code: 0 });

  const result = runCliWithPath(configPath, binDir, [
    "--out",
    join(dir, "results.json"),
  ]);

  assert.equal(result.status, EXIT_SUCCESS, result.stderr);
  // The per-run directory (script/data/raw metrics) is gone after the run.
  assert.deepEqual(readdirSync(result.tempSandbox), []);
});

test("built CLI maps a non-zero k6 exit and surfaces it without swallowing", () => {
  const dir = mkdtempSync(join(tmpdir(), "sw-cli-run-"));
  const configPath = writeConfig(dir);
  const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
  fakeK6(binDir, { stdout: "FAKE_K6_STDOUT", stderr: "FAKE_K6_STDERR", code: 5 });

  const result = runCliWithPath(configPath, binDir, [
    "--out",
    join(dir, "results.json"),
  ]);

  assert.equal(result.status, EXIT_K6_RUN_FAILURE);
  assert.match(result.stderr, /k6 run failed \(exit code 5\)/);
  // Both streams are passed through unmodified.
  assert.match(result.stdout, /FAKE_K6_STDOUT/);
  assert.match(result.stderr, /FAKE_K6_STDERR/);
});

test(
  "built CLI reports a spawn-level failure distinctly from a non-zero k6 exit",
  { skip: process.platform === "win32" ? "POSIX-only exec-bit semantics" : false },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-cli-run-"));
    const configPath = writeConfig(dir);
    const binDir = mkdtempSync(join(tmpdir(), "sw-bin-"));
    // Present on PATH but not executable -> a spawn-level failure.
    writeFileSync(join(binDir, "k6"), "not executable\n");

    const result = runCliWithPath(configPath, binDir, [
      "--out",
      join(dir, "results.json"),
    ]);

    assert.equal(result.status, EXIT_PREFLIGHT_FAILURE);
    assert.match(result.stderr, /Failed to launch k6/);
    assert.doesNotMatch(result.stderr, /was not found/);
  },
);
