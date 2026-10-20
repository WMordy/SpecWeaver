/**
 * k6 preflight and execution (SPEC-7).
 *
 * This is the **execution** stage of SpecWeaver: after SPEC-6 writes the
 * generated k6 script (plus its companion data) to a unique per-run temp
 * directory under `os.tmpdir()`, this module confirms k6 is available and runs
 * it, streaming k6's output live and capturing its exit code for hand-off to
 * SPEC-8's exit-code policy.
 *
 * ## Interface with SPEC-6 (writer) and SPEC-7 (reader)
 *
 * The generated-script/data location is shared, not duplicated here: this
 * module imports {@link SCRIPT_FILE_NAME} / {@link DATA_FILE_NAME} from the
 * SPEC-6 emitter so writer and reader can never drift. Since SPEC-11 the script
 * and its companion data live together in a unique per-run directory (e.g.
 * `os.tmpdir()/specweaver-Ab3dEf/specweaver.generated.js` and
 * `.../specweaver.data.json`), executed from there. `--out` / the config
 * `output` field do **not** name these paths — they target only the SPEC-8
 * results JSON.
 *
 * ## Locked decisions implemented here (product owner, 2026-10-18)
 *
 * 1. **Generated-script location:** specweaver-prefixed temp artifacts under
 *    `os.tmpdir()`, executed from there (no repo-local default). SPEC-11
 *    hardens this to a unique per-run directory with `0o600` files.
 * 2. **Temp-script lifecycle:** the per-run temp directory and its contents are
 *    removed after the run by default, with an opt-out to keep them for
 *    inspection ({@link KEEP_TEMP_ENV} or the programmatic `keepTemp` option).
 * 3. **Output mode:** streaming via `stdio: 'inherit'` so k6's stdout and
 *    stderr pass through unmodified and in real time (never buffered).
 * 4. **No `--k6-path` override:** discovery is PATH lookup only.
 * 5. **Cross-platform lookup:** PATH-based discovery that resolves `k6.exe` on
 *    Windows as well as `k6`.
 * 6. **SIGINT / Ctrl-C:** default Node child-process behaviour (k6 receives
 *    SIGINT, the CLI terminates); no custom signal handling.
 * 7. **Exit-code hand-off:** this module captures k6's exit code and maps it via
 *    {@link mapK6ExitCode} rather than passing it through literally. A zero k6
 *    exit maps to {@link EXIT_SUCCESS}; a non-zero k6 exit maps to the
 *    k6-run-failure code; a SpecWeaver-level preflight/spawn error carries the
 *    distinct {@link EXIT_SPECWEAVER_ERROR}.
 * 8. **Result capture (SPEC-8):** when `captureResults` is set, the extra k6
 *    flag `--out json=<tempfile>` is passed so k6 writes its raw NDJSON metrics
 *    to a sibling temp file, which is read back into
 *    {@link K6RunResult.rawResults} for SPEC-8 to summarise. Streaming
 *    (`stdio: 'inherit'`) is untouched, so the capture never buffers, replaces,
 *    or reorders the live console output.
 *
 * ## What this module does NOT do
 *
 * - It never installs, downloads, or bundles k6 (assumed pre-installed).
 * - It does not generate the script (SPEC-6) or the payload data (SPEC-4).
 * - It does not produce the results summary / JSON results file — SPEC-8 owns
 *   that; this module only captures k6's exit code and raw metrics. The exit
 *   codes are the SPEC-8 policy (A5: 0 / 1 / 2).
 */
import { spawn, type SpawnOptions, type StdioOptions } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  EXIT_K6_RUN_FAILURE,
  EXIT_SPECWEAVER_ERROR,
  EXIT_SUCCESS,
  K6_RAW_RESULTS_FILE_NAME,
} from "./results.js";
import { DATA_FILE_NAME, SCRIPT_FILE_NAME } from "./script/emit.js";

export { EXIT_K6_RUN_FAILURE, EXIT_SPECWEAVER_ERROR, EXIT_SUCCESS };

/**
 * SpecWeaver exit code for a SpecWeaver-level error around the run — k6 missing
 * on PATH, or a spawn-level failure (e.g. the binary is present but not
 * executable).
 *
 * @deprecated SPEC-8 (A5) folds preflight/spawn failures into the single
 * {@link EXIT_SPECWEAVER_ERROR} code; kept as an alias for existing callers.
 */
export const EXIT_PREFLIGHT_FAILURE = EXIT_SPECWEAVER_ERROR;

/** Official k6 installation instructions, surfaced when k6 cannot be found. */
export const K6_INSTALL_URL =
  "https://grafana.com/docs/k6/latest/set-up/install-k6/";

/**
 * Environment variable that opts out of delete-after-run: when set to a truthy
 * value, the generated temp script/data are kept for inspection.
 */
export const KEEP_TEMP_ENV = "SPECWEAVER_KEEP_TEMP";

/** Thrown when the `k6` binary cannot be resolved on PATH. */
export class K6NotFoundError extends Error {
  constructor(message: string = k6NotFoundMessage()) {
    super(message);
    this.name = "K6NotFoundError";
  }
}

/**
 * Thrown when k6 is present but could not be spawned (e.g. the file is not
 * executable). Distinct from a non-zero k6 exit: this is a SpecWeaver-level
 * failure that happens before k6 itself ever runs.
 */
export class K6SpawnError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "K6SpawnError";
  }
}

/**
 * The single clear error shown when `k6` is missing: it names the binary and
 * points at the official installation instructions. SpecWeaver never
 * auto-installs k6.
 */
export function k6NotFoundMessage(): string {
  return [
    "k6 was not found on your PATH.",
    "SpecWeaver needs the k6 binary to run generated load tests and will not install it for you.",
    `Install k6 from ${K6_INSTALL_URL} and make sure it is available on your PATH.`,
  ].join("\n");
}

/** True when `path` exists and is a regular file (or symlink to one). */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the `k6` binary on PATH (locked decisions 4 and 5).
 *
 * PATH lookup only — there is no config/flag override in v1. On Windows the
 * `k6.exe` name is resolved as well as a bare `k6`. A match is any regular file
 * named accordingly in a PATH directory; executability is *not* verified here
 * (a present-but-non-executable k6 is reported later as a distinct
 * {@link K6SpawnError}, per decision 7 / AC 9).
 */
export function resolveK6(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const pathValue = platform === "win32" ? (env.Path ?? env.PATH) : env.PATH;
  if (pathValue === undefined || pathValue === "") {
    return undefined;
  }

  const names = platform === "win32" ? ["k6.exe", "k6"] : ["k6"];
  for (const directory of pathValue.split(delimiter)) {
    if (directory === "") {
      continue;
    }
    for (const name of names) {
      const candidate = join(directory, name);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/** Absolute path of the generated k6 script under `directory` (SPEC-6's A2). */
export function generatedScriptPath(directory: string): string {
  return join(directory, SCRIPT_FILE_NAME);
}

/** Absolute path of the generated companion data file under `directory`. */
export function generatedDataPath(directory: string): string {
  return join(directory, DATA_FILE_NAME);
}

/**
 * Absolute path of the raw k6 metrics file under `directory` (SPEC-8, A3). k6
 * writes its NDJSON here via `--out json=<file>`; SPEC-8 reads it after the run.
 * It lives in the same per-run directory as the script/data (SPEC-11).
 */
export function rawResultsPath(directory: string): string {
  return join(directory, K6_RAW_RESULTS_FILE_NAME);
}

/**
 * Map k6's exit outcome onto SpecWeaver's exit code (decision 7).
 *
 * Deliberately not a literal passthrough: a zero k6 exit is success, any other
 * k6 outcome (non-zero exit, or termination by a signal) is the
 * k6-run-failure code. SPEC-8 owns the final numbering (A5: 0 / 1 / 2).
 */
export function mapK6ExitCode(
  k6ExitCode: number | null,
  signal: NodeJS.Signals | null = null,
): number {
  if (signal !== null) {
    return EXIT_K6_RUN_FAILURE;
  }
  return k6ExitCode === 0 ? EXIT_SUCCESS : EXIT_K6_RUN_FAILURE;
}

/** Options for {@link runGeneratedTest}. */
export interface K6RunOptions {
  /**
   * The resolved k6 binary to execute. When omitted, {@link resolveK6} is
   * called and a missing binary throws {@link K6NotFoundError}.
   */
  command?: string;
  /**
   * Path of the generated script to run. Defaults to
   * {@link generatedScriptPath}`(directory)`.
   */
  scriptPath?: string;
  /**
   * Directory holding the generated script/data (the per-run temp directory).
   * Defaults to `os.tmpdir()`; the CLI passes the unique directory created by
   * the SPEC-6 emitter (SPEC-11).
   */
  directory?: string;
  /** Value passed through as `--vus`. */
  vus?: number;
  /** Value passed through as `--duration`. */
  duration?: string;
  /** Child stdio mode. Defaults to `'inherit'` (real-time streaming, decision 3). */
  stdio?: StdioOptions;
  /** Working directory for the child process. */
  cwd?: string;
  /** Environment for the child and PATH lookup. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Keep the temp script/data after the run (opt-out of delete-after-run). */
  keepTemp?: boolean;
  /**
   * Remove the whole `directory` (not just the known generated files) during
   * delete-after-run. The CLI sets this for the unique per-run directory
   * created by SPEC-6 (SPEC-11). Defaults to `false`, which only removes the
   * generated script/data/raw-metrics files — never a caller-owned parent
   * directory.
   */
  removeDirectory?: boolean;
  /**
   * Capture k6's raw NDJSON metrics via `--out json=<tempfile>` (SPEC-8, A3).
   * Defaults to `false`. When enabled, the file is read into
   * {@link K6RunResult.rawResults} after k6 exits and then cleaned up with the
   * other temp artifacts.
   */
  captureResults?: boolean;
  /** Injectable spawn implementation (production uses `node:child_process`). */
  spawn?: typeof spawn;
}

/** The outcome of a k6 run, including the SPEC-8-mapped SpecWeaver exit code. */
export interface K6RunResult {
  /** SpecWeaver exit code, derived from k6's outcome via {@link mapK6ExitCode}. */
  exitCode: number;
  /** k6's raw exit code (`null` when k6 was terminated by a signal). */
  k6ExitCode: number | null;
  /** The signal that terminated k6, if any. */
  signal: NodeJS.Signals | null;
  /** The k6 binary that was executed. */
  k6Path: string;
  /** The generated script that was executed. */
  scriptPath: string;
  /**
   * The raw NDJSON k6 wrote to its `--out json=<file>` capture, when
   * {@link K6RunOptions.captureResults} was set. `undefined` otherwise, or when
   * k6 produced no capture file.
   */
  rawResults?: string;
}

/** Build the `k6 run` argument vector, passing the configured load profile. */
function buildK6Args(
  scriptPath: string,
  vus: number | undefined,
  duration: string | undefined,
  resultsPath: string | undefined,
): string[] {
  const args = ["run"];
  if (vus !== undefined) {
    args.push("--vus", String(vus));
  }
  if (duration !== undefined) {
    args.push("--duration", duration);
  }
  if (resultsPath !== undefined) {
    // SPEC-8 (A3): capture raw NDJSON metrics alongside the live stream.
    args.push("--out", `json=${resultsPath}`);
  }
  args.push(scriptPath);
  return args;
}

/** True when the keep-temp opt-out is enabled in `env`. */
function isKeepTemp(env: NodeJS.ProcessEnv): boolean {
  const value = env[KEEP_TEMP_ENV];
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * Best-effort removal of the generated temp artifacts (delete-after-run).
 *
 * By default only the known generated files are removed, so a caller-supplied
 * parent directory is never deleted wholesale. With `removeDirectory` the whole
 * per-run directory is removed recursively (SPEC-11); cleanup never masks the
 * run outcome.
 */
function removeGeneratedArtifacts(
  directory: string,
  removeDirectory: boolean,
): void {
  if (removeDirectory) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort: never mask the run outcome.
    }
    return;
  }
  for (const path of [
    generatedScriptPath(directory),
    generatedDataPath(directory),
    rawResultsPath(directory),
  ]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Cleanup is best-effort: never mask the run outcome.
    }
  }
}

/** Spawn k6 and resolve with its raw exit code/signal; reject on spawn failure. */
function spawnAndWait(
  spawnImpl: typeof spawn,
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, options);
    } catch (error) {
      reject(new K6SpawnError(spawnErrorMessage(command, error), { cause: error }));
      return;
    }

    child.on("error", (error: Error) => {
      reject(new K6SpawnError(spawnErrorMessage(command, error), { cause: error }));
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({ code, signal });
    });
  });
}

/** The distinct message shown when k6 could not be launched at all. */
export function spawnErrorMessage(command: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Failed to launch k6 at "${command}": ${reason}`;
}

/**
 * Execute the generated k6 script, streaming k6's output live and mapping its
 * exit code onto SpecWeaver's policy.
 *
 * The generated temp directory (script/data, plus the raw metrics capture when
 * requested) is removed afterwards unless the keep-temp opt-out is set
 * (decision 2). A missing k6 throws {@link K6NotFoundError}; a spawn-level
 * failure throws {@link K6SpawnError}; a non-zero k6 exit is a normal result
 * whose {@link K6RunResult.exitCode} is the k6-run-failure code.
 *
 * When {@link K6RunOptions.captureResults} is set, `--out json=<tempfile>` is
 * added to the k6 invocation and the file is read into
 * {@link K6RunResult.rawResults} before cleanup (SPEC-8, A3). The live
 * `stdio: 'inherit'` stream is unaffected.
 */
export async function runGeneratedTest(
  options: K6RunOptions = {},
): Promise<K6RunResult> {
  const directory = options.directory ?? tmpdir();
  const scriptPath = options.scriptPath ?? generatedScriptPath(directory);
  const command = options.command ?? resolveK6(options.env);
  if (command === undefined) {
    throw new K6NotFoundError();
  }

  const capturePath = options.captureResults
    ? rawResultsPath(directory)
    : undefined;
  const args = buildK6Args(scriptPath, options.vus, options.duration, capturePath);
  const spawnImpl = options.spawn ?? spawn;
  const spawnOptions: SpawnOptions = {
    stdio: options.stdio ?? "inherit",
    cwd: options.cwd,
    env: options.env,
  };
  const keepTemp = options.keepTemp ?? isKeepTemp(options.env ?? process.env);

  try {
    const { code, signal } = await spawnAndWait(
      spawnImpl,
      command,
      args,
      spawnOptions,
    );
    const result: K6RunResult = {
      exitCode: mapK6ExitCode(code, signal),
      k6ExitCode: code,
      signal,
      k6Path: command,
      scriptPath,
    };
    if (capturePath !== undefined) {
      // Read before the finally-block cleanup removes the temp artifacts.
      result.rawResults = readRawResults(capturePath);
    }
    return result;
  } finally {
    if (!keepTemp) {
      removeGeneratedArtifacts(
        directory,
        options.removeDirectory ?? false,
      );
    }
  }
}

/** Read the raw k6 capture file, tolerating a missing/unreadable file. */
function readRawResults(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
