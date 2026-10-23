/**
 * Live end-to-end test with real k6 (SPEC-29).
 *
 * This suite proves the shipped pipeline against the checked-in POC API
 * (`examples/poc-api/`) rather than an in-test mock:
 *
 *   spawn `node examples/poc-api/server.js` with PORT=0
 *     -> wait for the readiness line + a bounded HTTP probe of a real route
 *     -> write a temp SpecWeaver config derived from the committed POC config
 *        (baseUrl overridden to the ephemeral port, GET /admin/stats added, and
 *        the auth token expressed as `${POC_API_TOKEN}`)
 *     -> run the built CLI from the repo root with REAL k6 from PATH
 *     -> assert the exit code, the results JSON, and the POC server's own
 *        request log
 *     -> always stop the server and remove both temp directories.
 *
 * Why `e2e/live-e2e.mjs` and not a `*.test.*` file: bare `node --test` / the
 * existing `npm test` discovers `test/**` and `*.test.*` files. A file at
 * `e2e/live-e2e.mjs` is outside that discovery, so `npm test` stays unchanged;
 * it runs only through the explicit `npm run test:live-e2e` script.
 *
 * Real-k6 proof (no stub): the child environment's PATH is exactly
 * `process.env.PATH` (nothing is prepended), `k6 version` must look like real
 * k6 (`/^k6 v\d+\.\d+/`), the resolved binary's realpath must be outside this
 * test's temp/stub directories, and the CLI's own `k6 found:` line must name
 * that same realpath. The POC request log records method/path/status/auth/body
 * only (no User-Agent), so the suite does not assert a `k6/` User-Agent: doing
 * so would require changing the POC, which is out of scope (SPEC-27).
 *
 * Content-Type note: the POC request log also omits request headers. The
 * payload override itself is asserted from the server's logged body; the JSON
 * `Content-Type` is additionally asserted from the generated request data
 * (kept via SPECWEAVER_KEEP_TEMP=1) because the server cannot observe it.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parse as parseYaml,
  stringify as stringifyYaml,
} from "yaml";

import {
  isK6Required,
  isTruthyEnvValue,
  K6_INSTALL_HINT,
} from "../test/support/k6-requirement.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "dist", "cli.js");
const pocServerPath = join(repoRoot, "examples", "poc-api", "server.js");
const pocSpecPath = join(repoRoot, "examples", "poc-api", "openapi.yaml");
const pocConfigPath = join(
  repoRoot,
  "examples",
  "poc-api",
  "specweaver.config.yaml",
);

/** Env var the temp config references; its value is resolved by SpecWeaver. */
const POC_TOKEN_ENV = "POC_API_TOKEN";
/**
 * A real, non-selected POC route used only to prove readiness. Because the CLI
 * config never selects it, its request-log lines are unambiguously from the
 * readiness probe and are excluded from the CLI-run request count.
 */
const READINESS_PATH = "/recommendations";
const missingPocFiles = [pocServerPath, pocSpecPath, pocConfigPath].filter(
  (path) => !existsSync(path),
);

const skipRequested =
  isTruthyEnvValue(process.env.SPECWEAVER_SKIP_LIVE_E2E) &&
  !isK6Required(process.env);

if (
  isTruthyEnvValue(process.env.SPECWEAVER_SKIP_LIVE_E2E) &&
  isK6Required(process.env)
) {
  console.log(
    "SPECWEAVER_SKIP_LIVE_E2E=1 is ignored because CI or SPECWEAVER_REQUIRE_K6 is truthy; prerequisites must be met.",
  );
}

if (skipRequested && missingPocFiles.length > 0) {
  console.log(
    "SPECWEAVER_SKIP_LIVE_E2E=1 was set, but the live suite still fails because committed POC files are missing.",
  );
}

// Missing POC files always fail, even when the local opt-out is set.
const skipReason =
  skipRequested && missingPocFiles.length === 0
    ? "SPECWEAVER_SKIP_LIVE_E2E=1 (explicit local opt-out; ignored when CI or SPECWEAVER_REQUIRE_K6 is truthy)"
    : false;

if (skipReason) {
  console.log(`Skipping live k6 end-to-end test: ${skipReason}`);
}

/** Resolve an executable by walking PATH exactly as the process sees it. */
function resolveExecutableOnPath(name) {
  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (directory === "") {
      continue;
    }
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        if (!statSync(candidate).isFile()) {
          continue;
        }
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Not a usable candidate; keep looking.
      }
    }
  }
  return undefined;
}

/** True when `candidate` is `parent` or lives beneath it. */
function isInside(candidate, parent) {
  if (parent === undefined) {
    return false;
  }
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** A short polling delay; this is a poll interval, not a fixed startup sleep. */
function delay(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/** One bounded GET against a real POC route, with its own non-pooled socket. */
function httpGet(port, pathname) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method: "GET",
        agent: false,
        headers: { Connection: "close" },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolvePromise(response.statusCode ?? 0));
        response.on("error", rejectPromise);
        response.on("aborted", () => {
          rejectPromise(new Error("readiness HTTP response aborted"));
        });
      },
    );
    request.on("error", rejectPromise);
    request.setTimeout(2000, () => {
      request.destroy(new Error("readiness HTTP probe timed out"));
    });
    request.end();
  });
}

function hasExited(child) {
  return child !== undefined && (child.exitCode !== null || child.signalCode !== null);
}

/** Wait for a child's exit event, bounded. */
function waitForExit(child, timeoutMs) {
  if (hasExited(child)) {
    return Promise.resolve({ timedOut: false });
  }
  return new Promise((resolvePromise) => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      resolvePromise({ timedOut: false });
    };
    child.once("exit", done);
    timer = setTimeout(() => {
      child.removeListener("exit", done);
      resolvePromise({ timedOut: true });
    }, timeoutMs);
  });
}

/** Kill a detached CLI/k6 process group (POSIX) or the child directly. */
function killChildTree(child) {
  if (child === undefined || child.pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child is already gone.
    }
  }
}

/** Match a concrete POC request path against an OpenAPI path template. */
function routeMatches(route, pathname) {
  const pattern = route
    .split("/")
    .map((segment) => {
      if (/^\{[^}]+\}$/.test(segment)) {
        return "[^/]+";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${pattern}$`).test(pathname);
}

/**
 * Resolve a literal token or a single `${VAR}` reference from the committed
 * config. The live suite sets the referenced env var for the child.
 */
function resolveConfiguredToken(token, env) {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(token);
  if (match === null) {
    return token;
  }
  const value = env[match[1]];
  assert.ok(
    value !== undefined && value !== "",
    `committed POC config references ${token}, but ${match[1]} is not set`,
  );
  return value;
}

/**
 * Derive the temp config from the committed POC config:
 * - set the ephemeral `baseUrl`;
 * - add the auth-protected `GET /admin/stats` operation if absent;
 * - replace the token with a `${POC_API_TOKEN}` reference.
 */
function buildTempConfig(canonical, baseUrl) {
  const operations = Array.isArray(canonical.operations)
    ? [...canonical.operations]
    : [];
  if (
    !operations.some(
      (operation) =>
        String(operation.method).toUpperCase() === "GET" &&
        operation.path === "/admin/stats",
    )
  ) {
    operations.push({ method: "GET", path: "/admin/stats" });
  }
  return stringifyYaml({
    ...canonical,
    baseUrl,
    operations,
    auth: { ...(canonical.auth ?? {}), token: `\${${POC_TOKEN_ENV}}` },
  });
}

test(
  "live end-to-end: POC API + built CLI + real k6 from PATH",
  { skip: skipReason, timeout: 120_000 },
  async () => {
    // Missing POC files always fail, even with the local opt-out. The skip
    // decision above is disabled in this case so the test reports the failure.
    if (missingPocFiles.length > 0) {
      assert.fail(
        [
          "The live k6 end-to-end test requires the committed POC API files.",
          "Missing:",
          ...missingPocFiles.map((path) => `  - ${path}`),
        ].join("\n"),
      );
    }

    // Missing k6 fails locally (an explicit script invocation signals intent)
    // with the existing install hint. Under CI / SPECWEAVER_REQUIRE_K6 the
    // opt-out is already ignored, so this same failure applies.
    const k6Probe = spawnSync("k6", ["version"], {
      encoding: "utf8",
      env: process.env,
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    if (k6Probe.error || k6Probe.status !== 0) {
      assert.fail(
        [
          "The live k6 end-to-end test requires real k6 on PATH.",
          K6_INSTALL_HINT,
          `\`k6 version\` probe: status=${k6Probe.status} signal=${k6Probe.signal} error=${k6Probe.error?.message ?? "none"}`,
          `probe stdout: ${k6Probe.stdout?.trim() || "<empty>"}`,
          `probe stderr: ${k6Probe.stderr?.trim() || "<empty>"}`,
        ].join("\n"),
      );
    }
    assert.match(
      k6Probe.stdout,
      /^k6 v\d+\.\d+/m,
      `expected real k6 version output, received: ${JSON.stringify(k6Probe.stdout)}`,
    );

    const resolvedK6 = resolveExecutableOnPath("k6");
    assert.ok(resolvedK6, "could not resolve k6 on the unmodified PATH");
    const realK6 = realpathSync(resolvedK6);
    const realK6Version = spawnSync(realK6, ["version"], {
      encoding: "utf8",
      env: process.env,
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    assert.equal(
      realK6Version.status,
      0,
      `resolved k6 could not run:\n${realK6Version.stdout}\n${realK6Version.stderr}`,
    );
    assert.match(
      realK6Version.stdout,
      /^k6 v\d+\.\d+/m,
      `resolved k6 is not real k6: ${JSON.stringify(realK6Version.stdout)}`,
    );
    assert.equal(
      /^k6 v\d+\.\d+/m.exec(realK6Version.stdout)?.[0],
      /^k6 v\d+\.\d+/m.exec(k6Probe.stdout)?.[0],
      "the resolved k6 binary must be the same version as the PATH probe",
    );

    // The committed config is the source of truth for both the auth token and
    // the POST /pets override; the temp config only rewrites the token to an
    // env reference so the live run proves env resolution.
    const canonicalConfig = parseYaml(readFileSync(pocConfigPath, "utf8"));
    const configuredToken = canonicalConfig.auth?.token;
    assert.equal(
      typeof configuredToken,
      "string",
      "committed POC config must define a string auth.token",
    );
    assert.ok(
      configuredToken.length > 0,
      "committed POC config auth.token must not be empty",
    );
    const pocToken = resolveConfiguredToken(configuredToken, process.env);
    const committedPostOverride = Array.isArray(canonicalConfig.payloads)
      ? canonicalConfig.payloads.find(
          (payload) =>
            String(payload.method).toUpperCase() === "POST" &&
            payload.path === "/pets",
        )
      : undefined;
    assert.ok(
      committedPostOverride?.body !== undefined,
      "committed POC config must define the POST /pets payload override",
    );
    const expectedPostBody = committedPostOverride.body;

    let workDir;
    let artifactDir;
    let server;
    let cliChild;
    let cliResult;
    let resultsPath;
    let primaryError;
    let capturedDiagnostics;
    const cliStdio = { stdout: "", stderr: "" };

    // Captured POC output and request log (one JSON line per request).
    let serverStdout = "";
    let serverStderr = "";
    let serverExit = null;
    const serverRequests = [];

    const diagnostics = (extra = {}) => {
      const parts = [
        "--- live e2e diagnostics ---",
        `repo root: ${repoRoot}`,
        `POC command: node examples/poc-api/server.js (env PORT=0)`,
        `POC exit: ${
          serverExit === null
            ? "still running"
            : `code=${serverExit.code} signal=${serverExit.signal}`
        }`,
        `--- POC stdout ---\n${serverStdout || "<empty>"}`,
        `--- POC stderr ---\n${serverStderr || "<empty>"}`,
      ];
      const cli =
        extra.cli ?? cliResult ?? (cliChild === undefined ? undefined : cliStdio);
      if (cli !== undefined) {
        parts.push(`--- CLI stdout ---\n${cli.stdout || "<empty>"}`);
        parts.push(`--- CLI stderr ---\n${cli.stderr || "<empty>"}`);
      }
      if (resultsPath !== undefined) {
        try {
          parts.push(
            `--- results JSON ---\n${readFileSync(resultsPath, "utf8")}`,
          );
        } catch {
          parts.push("--- results JSON ---\n<not written>");
        }
      }
      return parts.join("\n");
    };

    const cleanup = async () => {
      const problems = [];

      if (cliChild !== undefined && !hasExited(cliChild)) {
        killChildTree(cliChild);
        const cliExit = await waitForExit(cliChild, 5000);
        if (cliExit.timedOut) {
          problems.push("CLI/k6 child did not exit within 5s after SIGKILL");
        }
      }

      if (server !== undefined && !hasExited(server)) {
        server.kill("SIGTERM");
        const first = await waitForExit(server, 5000);
        if (first.timedOut) {
          server.kill("SIGKILL");
          const second = await waitForExit(server, 2000);
          if (second.timedOut) {
            problems.push(
              "POC API server did not exit within 2s after SIGKILL",
            );
          }
        }
      }
      if (server !== undefined && !hasExited(server)) {
        problems.push("POC API server process is still running after cleanup");
      }

      for (const directory of [workDir, artifactDir]) {
        if (directory === undefined) {
          continue;
        }
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch (error) {
          problems.push(
            `failed to remove temp directory ${directory}: ${error.message}`,
          );
        }
        if (existsSync(directory)) {
          problems.push(`temp directory still exists: ${directory}`);
        }
      }

      return problems;
    };

    try {
      workDir = mkdtempSync(join(tmpdir(), "specweaver-live-e2e-"));
      artifactDir = mkdtempSync(
        join(tmpdir(), "specweaver-live-e2e-artifacts-"),
      );

      server = spawn(process.execPath, [pocServerPath], {
        cwd: repoRoot,
        env: { ...process.env, PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutBuffer = "";
      let readinessPort;
      server.stdout.setEncoding("utf8");
      server.stdout.on("data", (chunk) => {
        serverStdout += chunk;
        stdoutBuffer += chunk;
        let newlineIndex;
        while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line.startsWith("poc-api listening on ")) {
            const match = /^poc-api listening on http:\/\/127\.0\.0\.1:(\d+)$/.exec(
              line,
            );
            if (match) {
              readinessPort = Number(match[1]);
            }
          } else if (line.startsWith("{")) {
            try {
              serverRequests.push(JSON.parse(line));
            } catch {
              // Ignore any non-JSON line (e.g. the shutdown notice).
            }
          }
        }
      });
      server.stderr.setEncoding("utf8");
      server.stderr.on("data", (chunk) => {
        serverStderr += chunk;
      });
      server.on("exit", (code, signal) => {
        serverExit = { code, signal };
      });
      server.on("error", (error) => {
        serverExit = { code: null, signal: null };
        serverStderr += `\nPOC spawn error: ${error.message}`;
      });

      // Bounded readiness: first the readiness line, then a real HTTP route.
      // No fixed sleep is used; the poll interval only paces retries.
      const readinessDeadline = Date.now() + 10_000;
      while (readinessPort === undefined) {
        if (serverExit !== null) {
          assert.fail(
            `live e2e phase failed: POC API exited before becoming ready\n${diagnostics()}`,
          );
        }
        if (Date.now() >= readinessDeadline) {
          assert.fail(
            `live e2e phase timed out after 10s: POC API readiness line\n${diagnostics()}`,
          );
        }
        await delay(20);
      }
      assert.ok(
        readinessPort > 0,
        `expected the POC API to bind an ephemeral port > 0, received ${readinessPort}`,
      );

      let readyStatus;
      while (Date.now() < readinessDeadline) {
        if (serverExit !== null) {
          assert.fail(
            `live e2e phase failed: POC API exited during the readiness HTTP poll\n${diagnostics()}`,
          );
        }
        try {
          readyStatus = await httpGet(readinessPort, READINESS_PATH);
        } catch {
          readyStatus = undefined;
        }
        if (readyStatus !== undefined && readyStatus >= 200 && readyStatus < 300) {
          break;
        }
        await delay(25);
      }
      assert.ok(
        readyStatus !== undefined && readyStatus >= 200 && readyStatus < 300,
        `live e2e phase timed out after 10s: POC API readiness HTTP poll against ${READINESS_PATH} (last status: ${readyStatus ?? "<no response>"})\n${diagnostics()}`,
      );

      const baseUrl = `http://127.0.0.1:${readinessPort}`;

      // Temp config derived from the committed POC config.
      const tempConfigText = buildTempConfig(canonicalConfig, baseUrl);
      const configPath = join(workDir, "specweaver.config.yaml");
      writeFileSync(configPath, tempConfigText, "utf8");
      resultsPath = join(workDir, "results.json");

      const parsedConfig = parseYaml(tempConfigText);
      assert.equal(
        parsedConfig.baseUrl,
        baseUrl,
        "temp config baseUrl must be the ephemeral POC URL",
      );
      assert.equal(
        new URL(parsedConfig.baseUrl).port,
        String(readinessPort),
        "temp config baseUrl port must match the POC's bound port",
      );
      assert.equal(
        parsedConfig.auth?.token,
        `\${${POC_TOKEN_ENV}}`,
        "temp config auth token must be a ${ENV_VAR} reference",
      );
      assert.ok(
        parsedConfig.operations.some(
          (operation) =>
            String(operation.method).toUpperCase() === "GET" &&
            operation.path === "/admin/stats",
        ),
        "temp config must select the auth-protected GET /admin/stats",
      );

      const expectedOperations = parsedConfig.operations.map(
        (operation) =>
          `${String(operation.method).toUpperCase()} ${operation.path}`,
      );

      // Real-k6 proof: PATH is byte-for-byte the parent PATH (no stub dir).
      const childEnv = {
        ...process.env,
        [POC_TOKEN_ENV]: pocToken,
        // Keep generated data so the JSON Content-Type can be asserted (the
        // POC request log does not record headers).
        SPECWEAVER_KEEP_TEMP: "1",
        // Isolate the CLI's generated artifacts from every other suite.
        TMPDIR: artifactDir,
        TEMP: artifactDir,
        TMP: artifactDir,
      };
      assert.equal(
        childEnv.PATH,
        process.env.PATH,
        "the CLI/k6 child PATH must be process.env.PATH unmodified",
      );

      cliResult = await new Promise((resolvePromise, rejectPromise) => {
        cliChild = spawn(
          process.execPath,
          [
            cliPath,
            "--config",
            configPath,
            "--vus",
            "1",
            "--duration",
            "1s",
            "--out",
            resultsPath,
            "--fail-on-check-failure",
          ],
          {
            cwd: repoRoot,
            env: childEnv,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
          },
        );

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let timer;
        let fallbackTimer;
        const timeoutMessage = () =>
          "live e2e phase timed out after 60s: CLI/k6 run did not finish";
        const finish = (settle, value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          clearTimeout(fallbackTimer);
          settle(value);
        };
        const rejectTimedOut = (detail) => {
          finish(
            rejectPromise,
            new Error(
              `${timeoutMessage()}${detail === undefined ? "" : ` (${detail})`}`,
            ),
          );
        };

        cliChild.stdout.setEncoding("utf8");
        cliChild.stderr.setEncoding("utf8");
        cliChild.stdout.on("data", (chunk) => {
          stdout += chunk;
          cliStdio.stdout += chunk;
        });
        cliChild.stderr.on("data", (chunk) => {
          stderr += chunk;
          cliStdio.stderr += chunk;
        });
        cliChild.on("error", (error) => {
          if (timedOut) {
            rejectTimedOut(`child error after SIGKILL: ${error.message}`);
            return;
          }
          finish(rejectPromise, error);
        });
        cliChild.on("close", (code, signal) => {
          if (timedOut) {
            rejectTimedOut(`child exit code=${code} signal=${signal}`);
            return;
          }
          finish(resolvePromise, { code, signal, stdout, stderr });
        });

        timer = setTimeout(() => {
          timedOut = true;
          clearTimeout(timer);
          killChildTree(cliChild);
          fallbackTimer = setTimeout(() => {
            rejectTimedOut("child did not exit after SIGKILL");
          }, 2000);
        }, 60_000);
      });

      const cliDiagnostics = diagnostics({ cli: cliResult });

      assert.equal(
        cliResult.signal,
        null,
        `CLI was terminated by signal ${cliResult.signal}\n${cliDiagnostics}`,
      );
      assert.equal(
        cliResult.code,
        0,
        `CLI exited with code ${cliResult.code}\n${cliDiagnostics}`,
      );

      // Real-k6 proof: the CLI must have resolved the same real binary.
      const k6Found = /^k6 found: (.+)$/m.exec(cliResult.stdout);
      assert.ok(
        k6Found,
        `CLI did not report its resolved k6 binary\n${cliDiagnostics}`,
      );
      assert.equal(
        realpathSync(k6Found[1].trim()),
        realK6,
        `CLI resolved a different k6 binary than the unmodified PATH probe\n${cliDiagnostics}`,
      );

      // Results file at the --out path.
      assert.ok(
        existsSync(resultsPath),
        `results file was not written to --out path ${resultsPath}\n${cliDiagnostics}`,
      );
      const results = JSON.parse(readFileSync(resultsPath, "utf8"));
      assert.equal(results.tool, "specweaver");
      assert.ok(results.config, "results config must be present");
      assert.equal(results.config.vus, 1);
      assert.equal(results.config.duration, "1s");
      assert.equal(results.outcome, "success");
      assert.equal(results.k6ExitCode, 0);
      assert.equal(
        results.resultsFile,
        resultsPath,
        "resultsFile must be the --out path",
      );

      const recordedKeys = Object.keys(results.checks).sort();
      const expectedKeys = [...new Set(expectedOperations)].sort();
      assert.deepEqual(
        recordedKeys,
        expectedKeys,
        `checks keys do not match the temp config operations; recorded keys: ${recordedKeys.join(", ")}`,
      );
      for (const key of expectedKeys) {
        const counts = results.checks[key];
        assert.ok(counts, `missing checks entry for ${key}`);
        assert.ok(
          counts.pass >= 1,
          `expected at least one passing check for ${key}, received ${JSON.stringify(counts)}`,
        );
        assert.equal(
          counts.fail,
          0,
          `expected no failing checks for ${key}, received ${JSON.stringify(counts)}`,
        );
      }
      assert.equal(
        results.summary.checks.fail,
        0,
        `summary.checks.fail must be 0, received ${JSON.stringify(results.summary.checks)}`,
      );
      assert.ok(
        results.summary.iterations >= 1,
        `expected at least one iteration, received ${results.summary.iterations}`,
      );

      // Wait briefly for the POC log to drain, then cross-check counts. The
      // only excluded lines are the readiness probes against READINESS_PATH,
      // which the CLI config never selects; there is no other tolerance.
      const observedCount = () =>
        serverRequests.filter((request) => request.path !== READINESS_PATH)
          .length;
      const observationDeadline = Date.now() + 5000;
      while (
        observedCount() < results.summary.httpReqs &&
        Date.now() < observationDeadline
      ) {
        await delay(20);
      }

      const observed = serverRequests.filter(
        (request) => request.path !== READINESS_PATH,
      );
      assert.equal(
        results.summary.httpReqs,
        observed.length,
        `summary.httpReqs (${results.summary.httpReqs}) must equal the POC-observed CLI request count (${observed.length}); observed: ${JSON.stringify(observed)}`,
      );

      for (const operation of parsedConfig.operations) {
        const method = String(operation.method).toUpperCase();
        const route = operation.path;
        const matches = observed.filter(
          (request) =>
            request.method === method && routeMatches(route, request.path),
        );
        assert.ok(
          matches.length >= 1,
          `POC API did not observe ${method} ${route}; observed: ${observed
            .map((request) => `${request.method} ${request.path}`)
            .join(", ")}`,
        );
      }

      const adminRequests = observed.filter(
        (request) =>
          request.method === "GET" && request.path === "/admin/stats",
      );
      assert.ok(
        adminRequests.length >= 1,
        "POC API did not observe GET /admin/stats",
      );
      for (const request of adminRequests) {
        // The POC only logs auth=ok when the exact configured header
        // (`Authorization: Bearer <POC_TOKEN>`) reached it; the token came from
        // ${POC_API_TOKEN}, not a literal in the temp config.
        assert.equal(
          request.auth,
          "ok",
          `expected the resolved auth header on GET /admin/stats; POC logged: ${JSON.stringify(request)}`,
        );
        assert.equal(
          request.status,
          200,
          `expected GET /admin/stats to be authorized; POC logged: ${JSON.stringify(request)}`,
        );
      }

      const createRequests = observed.filter(
        (request) => request.method === "POST" && request.path === "/pets",
      );
      assert.ok(
        createRequests.length >= 1,
        "POC API did not observe POST /pets",
      );
      for (const request of createRequests) {
        assert.deepEqual(
          request.body,
          expectedPostBody,
          `POST /pets body must be the committed payload override; POC logged: ${JSON.stringify(request)}`,
        );
      }

      // The POC log omits Content-Type, so assert the generated request data
      // (kept via SPECWEAVER_KEEP_TEMP=1) for JSON content type.
      const generated = /^Generated k6 script: (.+)$/m.exec(cliResult.stdout);
      assert.ok(
        generated,
        `CLI did not report the generated script path\n${cliDiagnostics}`,
      );
      const scriptPath = generated[1].trim();
      assert.ok(
        isInside(scriptPath, artifactDir),
        `generated artifacts must stay in the private temp dir; received ${scriptPath}`,
      );
      const dataPath = join(dirname(scriptPath), "specweaver.data.json");
      assert.ok(
        existsSync(dataPath),
        `generated data file is missing: ${dataPath}\n${cliDiagnostics}`,
      );
      const generatedData = JSON.parse(readFileSync(dataPath, "utf8"));
      const generatedPost = generatedData.operations.find(
        (operation) =>
          operation.method === "POST" && operation.route === "/pets",
      );
      assert.ok(
        generatedPost,
        `generated data has no POST /pets operation: ${JSON.stringify(generatedData.operations)}`,
      );
      assert.equal(
        generatedPost.headers?.["Content-Type"],
        "application/json",
        `generated POST /pets must use JSON content type, received ${JSON.stringify(generatedPost.headers)}`,
      );

      // Real-k6 proof continued: realpath outside this test's temp/stub dirs.
      assert.ok(
        !isInside(realK6, workDir) && !isInside(realK6, artifactDir),
        `resolved k6 must be outside the live suite temp dirs; received ${realK6}`,
      );
      assert.doesNotMatch(
        realK6,
        /(^|[\\/])stubs?([\\/]|$)/i,
        `resolved k6 must not come from a stub directory; received ${realK6}`,
      );
    } catch (error) {
      primaryError = error;
      // Capture results JSON and all diagnostics while the temp dirs and
      // child state still exist; cleanup must not erase the evidence.
      capturedDiagnostics = diagnostics({ cli: cliResult });
    } finally {
      const cleanupProblems = await cleanup();
      if (primaryError !== undefined) {
        if (
          capturedDiagnostics !== undefined &&
          !primaryError.message.includes("--- live e2e diagnostics ---")
        ) {
          primaryError.message += `\n\n${capturedDiagnostics}`;
        }
        if (cleanupProblems.length > 0) {
          primaryError.message += `\n\ncleanup problems:\n- ${cleanupProblems.join(
            "\n- ",
          )}`;
        }
        throw primaryError;
      }
      assert.deepEqual(
        cleanupProblems,
        [],
        `cleanup problems:\n- ${cleanupProblems.join("\n- ")}`,
      );
    }
  },
);
