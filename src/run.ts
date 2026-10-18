/**
 * k6 preflight and execution (SPEC-7).
 *
 * This is the **execution** stage of SpecWeaver: after SPEC-6 writes the
 * generated k6 script (plus its companion data) to a specweaver-prefixed temp
 * location under `os.tmpdir()`, this module confirms k6 is available and runs
 * it, streaming k6's output live and capturing its exit code for hand-off to
 * SPEC-8's exit-code policy.
 *
 * ## Interface with SPEC-6 (writer) and SPEC-7 (reader)
 *
 * The generated-script/data temp location is shared, not duplicated here: this
 * module imports {@link SCRIPT_FILE_NAME} / {@link DATA_FILE_NAME} from the
 * SPEC-6 emitter so writer and reader can never drift. The script is
 * `os.tmpdir()/specweaver.generated.js` and its companion data is
 * `os.tmpdir()/specweaver.data.json`. `--out` / the config `output` field do
 * **not** name these paths — they target only the SPEC-8 results JSON.
 *
 * ## Locked decisions implemented here (product owner, 2026-10-18)
 *
 * 1. **Generated-script location:** specweaver-prefixed temp files under
 *    `os.tmpdir()`, executed from there (no repo-local default).
 * 2. **Temp-script lifecycle:** the temp script and data are removed after the
 *    run by default, with an opt-out to keep them for inspection
 *    ({@link KEEP_TEMP_ENV} or the programmatic `keepTemp` option).
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
 *    distinct {@link EXIT_PREFLIGHT_FAILURE}.
 *
 * ## What this module does NOT do
 *
 * - It never installs, downloads, or bundles k6 (assumed pre-installed).
 * - It does not generate the script (SPEC-6) or the payload data (SPEC-4).
 * - It does not produce the results summary / JSON results file or own the
 *   final SpecWeaver exit-code numbering — SPEC-8 owns that; the codes exported
 *   here are the provisional contract SPEC-7 forwards to.
 */
import { spawn, type SpawnOptions, type StdioOptions } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { DATA_FILE_NAME, SCRIPT_FILE_NAME } from "./script/emit.js";

/**
 * SpecWeaver exit code for a successful run (zero k6 exit).
 *
 * Provisional: SPEC-8 owns the final SpecWeaver exit-code namespace; SPEC-7
 * only forwards k6's outcome through {@link mapK6ExitCode}.
 */
export const EXIT_SUCCESS = 0;

/**
 * SpecWeaver exit code for a k6 run that finished but exited non-zero
 * (a script/run failure).
 *
 * Provisional: SPEC-8 owns the final SpecWeaver exit-code numbering.
 */
export const EXIT_K6_RUN_FAILURE = 3;

/**
 * SpecWeaver exit code for a SpecWeaver-level error around the run — k6 missing
 * on PATH, or a spawn-level failure (e.g. the binary is present but not
 * executable).
 *
 * Provisional: SPEC-8 owns the final SpecWeaver exit-code numbering.
 */
export const EXIT_PREFLIGHT_FAILURE = 4;

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
export function generatedScriptPath(directory: string = tmpdir()): string {
  return join(directory, SCRIPT_FILE_NAME);
}

/** Absolute path of the generated companion data file under `directory`. */
export function generatedDataPath(directory: string = tmpdir()): string {
  return join(directory, DATA_FILE_NAME);
}

/**
 * Map k6's exit outcome onto SpecWeaver's exit code (decision 7).
 *
 * Deliberately not a literal passthrough: a zero k6 exit is success, any other
 * k6 outcome (non-zero exit, or termination by a signal) is the
 * k6-run-failure code. SPEC-8 owns the final numbering and may refine this.
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
  /** Directory holding the generated script/data. Defaults to `os.tmpdir()`. */
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
}

/** Build the `k6 run` argument vector, passing the configured load profile. */
function buildK6Args(
  scriptPath: string,
  vus: number | undefined,
  duration: string | undefined,
): string[] {
  const args = ["run"];
  if (vus !== undefined) {
    args.push("--vus", String(vus));
  }
  if (duration !== undefined) {
    args.push("--duration", duration);
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

/** Best-effort removal of the generated temp artifacts (delete-after-run). */
function removeGeneratedArtifacts(directory: string): void {
  for (const path of [
    generatedScriptPath(directory),
    generatedDataPath(directory),
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
 * The generated temp script/data are removed afterwards unless the keep-temp
 * opt-out is set (decision 2). A missing k6 throws {@link K6NotFoundError}; a
 * spawn-level failure throws {@link K6SpawnError}; a non-zero k6 exit is a
 * normal result whose {@link K6RunResult.exitCode} is the k6-run-failure code.
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

  const args = buildK6Args(scriptPath, options.vus, options.duration);
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
    return {
      exitCode: mapK6ExitCode(code, signal),
      k6ExitCode: code,
      signal,
      k6Path: command,
      scriptPath,
    };
  } finally {
    if (!keepTemp) {
      removeGeneratedArtifacts(directory);
    }
  }
}
