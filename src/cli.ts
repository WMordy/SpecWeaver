#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CliUsageError, USAGE, parseArgs, type CliOptions } from "./args.js";
import { injectAuth } from "./auth.js";
import { ConfigError, loadConfig, type Config, type ConfigResult } from "./config.js";
import { generateAllRequestData, applyPayloadOverrides } from "./request-data.js";
import {
  EXIT_SPECWEAVER_ERROR,
  EXIT_SUCCESS,
  K6SpawnError,
  k6NotFoundMessage,
  resolveK6,
  runGeneratedTest,
} from "./run.js";
import {
  buildResultsFile,
  EXIT_K6_RUN_FAILURE,
  formatSummary,
  formatUnexpectedError,
  formatWarnings,
  outcomeForK6ExitCode,
  resolveResultsPath,
  resolveRunExitCode,
  WARNING_PREFIX,
  writeResultsFile,
} from "./results.js";
import { writeEmittedScript } from "./script/emit.js";
import {
  SpecError,
  loadSpecs,
  zeroOperationWarnings,
  type LoadedSpec,
  type OperationEntry,
} from "./spec.js";

/** Read the version string from the package manifest. */
function readVersion(): string {
  const manifestUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as {
    version: string;
  };
  return manifest.version;
}

/**
 * Emit non-fatal warnings to stderr, prefixed `warning:` (SPEC-8, A6). These are
 * unresolved-`${ENV_VAR}` references collected by config loading and auth
 * injection; they never fail validation or change a successful exit code, and
 * they are never written into the results JSON.
 *
 * A single shared `seen` set spans every call, so a variable left unresolved by
 * both the config loader and the auth injector is reported exactly once.
 */
const seenWarnings = new Set<string>();

function writeWarnings(warnings: readonly string[]): void {
  const text = formatWarnings(warnings, seenWarnings);
  if (text !== "") {
    process.stderr.write(text);
  }
}

/**
 * Report payload overrides on a path where no operation will be built (SPEC-13).
 *
 * Both the no-`specs` and zero-selected early returns happen before request-data
 * generation, so no generated request can match an override. Running the normal
 * override matcher with an empty request list makes every configured override
 * "unmatched", which is the truth for that run: the override cannot be applied.
 * This keeps the "never silently drop an override" contract on those paths too,
 * without changing their exit code.
 */
function writeUnappliedPayloadWarnings(payloads: Config["payloads"]): void {
  writeWarnings(applyPayloadOverrides([], payloads).warnings);
}

/** The result of matching configured operations against the loaded catalog. */
interface OperationSelection {
  /** Operations present in the catalog; the ones that will be executed. */
  selected: OperationEntry[];
  /** Configured operations absent from the catalog, in config order. */
  unmatched: { method: string; path: string }[];
}

/**
 * Select the config's opt-in operations from the loaded spec catalog, matching
 * on method + path. Operations listed in the config but absent from the
 * spec(s) are returned as `unmatched` so the caller can warn (partial match) or
 * fail (no match at all) without losing the list.
 */
function selectOperations(
  operations: readonly { method: string; path: string }[],
  specs: readonly LoadedSpec[],
): OperationSelection {
  const catalog = new Map<string, OperationEntry>();
  for (const spec of specs) {
    for (const operation of spec.operations) {
      catalog.set(`${operation.method} ${operation.path}`, operation);
    }
  }

  const selected: OperationEntry[] = [];
  const unmatched: { method: string; path: string }[] = [];
  for (const { method, path } of operations) {
    const operation = catalog.get(`${method} ${path}`);
    if (operation === undefined) {
      unmatched.push({ method, path });
      continue;
    }
    selected.push(operation);
  }
  return { selected, unmatched };
}

/**
 * Command handler.
 *
 * Loads and validates the config named by `--config`, resolves the spec(s),
 * then runs the SPEC-7 execution stage: preflight k6, generate + emit the k6
 * script (SPEC-4/5/6), and execute it (SPEC-7). Afterwards it owns the SPEC-8
 * results stage: build + write the JSON results file, print the console
 * summary, and return the documented exit code (0 success / 1 k6 run failure /
 * 2 SpecWeaver error).
 */
async function run(options: CliOptions): Promise<number> {
  if (options.config === undefined) {
    process.stderr.write(`Missing required --config <path>\n\n${USAGE}\n`);
    return EXIT_SPECWEAVER_ERROR;
  }

  let result: ConfigResult;
  try {
    result = loadConfig(options.config, {
      vus: options.vus,
      duration: options.duration,
      out: options.out,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_SPECWEAVER_ERROR;
    }
    throw error;
  }

  const { config } = result;
  // A6: unresolved-`${ENV_VAR}` warnings are non-fatal and go to stderr.
  writeWarnings(result.warnings);

  const specCount = config.specs?.length ?? 0;
  process.stdout.write(
    `Loaded config: ${config.operations.length} operation(s), ${specCount} spec source(s).\n`,
  );
  process.stdout.write(
    `Load profile: ${config.load.vus} virtual user(s) for ${config.load.duration}.\n`,
  );

  // Load and resolve every spec so downstream stages (payload generation,
  // script emission) have a normalized operation catalog. A missing/invalid
  // spec is a hard error and exits non-zero.
  let loadedSpecs: LoadedSpec[] = [];
  if (config.specs !== undefined) {
    try {
      loadedSpecs = loadSpecs(config.specs);
    } catch (error) {
      if (error instanceof SpecError) {
        process.stderr.write(`${error.message}\n`);
        return EXIT_SPECWEAVER_ERROR;
      }
      throw error;
    }
    // SPEC-15: a spec that loads but contributes no operations (e.g. an
    // OpenAPI 3.1 document with only `webhooks` or only `components`) is
    // surfaced immediately. It stays a warning here; if the overall catalog is
    // empty, the SPEC-14 no-operations path below fails the run instead.
    writeWarnings(zeroOperationWarnings(loadedSpecs));
    const catalogSize = loadedSpecs.reduce(
      (total, spec) => total + spec.operations.length,
      0,
    );
    process.stdout.write(
      `Resolved specs: ${catalogSize} operation(s) in the catalog.\n`,
    );
  }

  // A spec source is required to build an operation catalog. `operations` is
  // always non-empty, so omitting `specs` can never execute anything: fail
  // loudly (SPEC-14, reversing SPEC-2's optional decision) instead of exiting
  // `0` without running k6 or writing results. Payload overrides are still
  // reported before the early return (SPEC-13).
  if (config.specs === undefined) {
    writeUnappliedPayloadWarnings(config.payloads);
    process.stderr.write(
      [
        "error: `specs` is required to execute operations, but no spec source is configured.",
        "Add at least one OpenAPI file under `specs` in the config; operations cannot be matched or run without a loaded spec.",
      ].join("\n") + "\n",
    );
    return EXIT_SPECWEAVER_ERROR;
  }

  const { selected, unmatched } = selectOperations(
    config.operations,
    loadedSpecs,
  );
  if (selected.length === 0) {
    writeUnappliedPayloadWarnings(config.payloads);
    process.stderr.write(
      [
        "error: none of the configured operations were found in the loaded spec(s); nothing to execute.",
        "Unmatched operations:",
        ...unmatched.map(({ method, path }) => `  - ${method} ${path}`),
        "Add the missing operations to the spec(s) or correct the `operations` entries in the config.",
      ].join("\n") + "\n",
    );
    return EXIT_SPECWEAVER_ERROR;
  }

  // A partial match still runs: report each operation that could not be built,
  // then continue with the ones that were selected.
  for (const { method, path } of unmatched) {
    process.stderr.write(
      `${WARNING_PREFIX} operation "${method} ${path}" is not present in the loaded spec(s); skipping.\n`,
    );
  }

  // SPEC-7 preflight: k6 must resolve on PATH before we execute anything. It is
  // assumed pre-installed; SpecWeaver never auto-installs it. A missing k6 is a
  // SpecWeaver-level error (SPEC-8 A5: folded into code 2).
  const k6Path = resolveK6();
  if (k6Path === undefined) {
    process.stderr.write(`${k6NotFoundMessage()}\n`);
    return EXIT_SPECWEAVER_ERROR;
  }
  process.stdout.write(`k6 found: ${k6Path}\n`);

  // Generate the request data (SPEC-4), replace matching JSON bodies with
  // configured `payloads` overrides (SPEC-13), inject static auth (SPEC-5), and
  // write the generated k6 script + data to a unique per-run temp directory
  // (SPEC-6, hardened by SPEC-11). SPEC-7 then executes that script from the
  // same directory and cleans up the whole directory afterwards.
  const generated = generateAllRequestData(selected);
  const {
    requests: overriddenRequests,
    warnings: payloadWarnings,
  } = applyPayloadOverrides(generated, config.payloads);
  writeWarnings(payloadWarnings);

  const { requests, warnings: authWarnings } = injectAuth(
    config,
    overriddenRequests,
  );
  writeWarnings(authWarnings);

  const written = writeEmittedScript({
    config,
    specs: loadedSpecs,
    requests,
  });
  process.stdout.write(`Generated k6 script: ${written.scriptPath}\n`);

  // SPEC-8 A1/A2: `--out` wins, then the config `output` field, then the
  // documented default (`specweaver-results.json` in the cwd).
  const resultsPath = resolve(
    resolveResultsPath({ out: options.out, output: config.output }),
  );

  try {
    const runResult = await runGeneratedTest({
      command: k6Path,
      scriptPath: written.scriptPath,
      directory: written.directory,
      // SPEC-11: remove the unique per-run directory and its contents.
      removeDirectory: true,
      vus: config.load.vus,
      duration: config.load.duration,
      // A3: capture k6's raw NDJSON alongside SPEC-7's live streaming.
      captureResults: true,
    });

    // A results file is produced for both successful and k6-failed runs, as
    // long as k6 actually ran.
    const resultsFile = buildResultsFile({
      version: readVersion(),
      vus: config.load.vus,
      duration: config.load.duration,
      k6ExitCode: runResult.k6ExitCode,
      outcome: outcomeForK6ExitCode(runResult.k6ExitCode),
      operations: written.data.operations,
      rawK6Results: runResult.rawResults,
      resultsFile: resultsPath,
    });

    try {
      writeResultsFile(resultsFile);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `error: failed to write results file "${resultsPath}": ${reason}\n`,
      );
      return EXIT_SPECWEAVER_ERROR;
    }

    if (runResult.exitCode !== EXIT_SUCCESS) {
      const reason =
        runResult.k6ExitCode === null
          ? `signal ${runResult.signal}`
          : `exit code ${runResult.k6ExitCode}`;
      process.stderr.write(`k6 run failed (${reason}).\n`);
    }

    // A7: printed once, after k6 exits, so it never interleaves with the
    // live-streamed k6 output.
    process.stdout.write(formatSummary(resultsFile));

    // SPEC-19: the opt-in check gate runs last, after the results file has been
    // written and the summary printed. A genuine non-zero k6 outcome is kept
    // as-is; only a k6-success run can be promoted to the failure code.
    const exitCode =
      runResult.exitCode === EXIT_SUCCESS
        ? resolveRunExitCode({
            k6ExitCode: runResult.k6ExitCode,
            checks: resultsFile.summary.checks,
            failOnCheckFailure: options.failOnCheckFailure,
          })
        : runResult.exitCode;

    if (exitCode !== EXIT_SUCCESS && runResult.exitCode === EXIT_SUCCESS) {
      const { fail } = resultsFile.summary.checks;
      const noun = fail === 1 ? "check" : "checks";
      process.stderr.write(
        `error: --fail-on-check-failure: ${fail} failing ${noun} recorded; exiting with code ${EXIT_K6_RUN_FAILURE}.\n`,
      );
    }

    return exitCode;
  } catch (error) {
    if (error instanceof K6SpawnError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_SPECWEAVER_ERROR;
    }
    throw error;
  }
}

/**
 * Parse `argv`, handle `--help`/`--version`/usage errors, and dispatch to
 * `run`.
 *
 * This is the AC10 catch-all: any error that is not one of the deliberately
 * handled SpecWeaver errors (config/spec/preflight/spawn) is an unexpected
 * internal error. Rather than let it escape as an unhandled rejection (which
 * would print a raw Node stack trace and exit `1`, colliding with
 * {@link EXIT_K6_RUN_FAILURE}), it is reported cleanly and mapped to
 * {@link EXIT_SPECWEAVER_ERROR}. The dedicated 0/1/2 paths are unchanged.
 */
export async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (error) {
    process.stderr.write(`${formatUnexpectedError(error)}\n`);
    return EXIT_SPECWEAVER_ERROR;
  }
}

/** The parsed/flags dispatch step; unexpected errors propagate to {@link main}. */
async function dispatch(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      return EXIT_SPECWEAVER_ERROR;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_SUCCESS;
  }

  if (options.version) {
    process.stdout.write(`${readVersion()}\n`);
    return EXIT_SUCCESS;
  }

  if (argv.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT_SPECWEAVER_ERROR;
  }

  return run(options);
}

process.exitCode = await main(process.argv.slice(2));
