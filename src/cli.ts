#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { CliUsageError, USAGE, parseArgs, type CliOptions } from "./args.js";
import { injectAuth } from "./auth.js";
import { ConfigError, loadConfig, type ConfigResult } from "./config.js";
import { generateAllRequestData } from "./request-data.js";
import {
  EXIT_PREFLIGHT_FAILURE,
  EXIT_SUCCESS,
  K6SpawnError,
  k6NotFoundMessage,
  resolveK6,
  runGeneratedTest,
} from "./run.js";
import { writeEmittedScript } from "./script/emit.js";
import {
  SpecError,
  loadSpecs,
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
 * Select the config's opt-in operations from the loaded spec catalog, matching
 * on method + path. Operations listed in the config but absent from the
 * spec(s) are reported and skipped (they can never be built).
 */
function selectOperations(
  operations: readonly { method: string; path: string }[],
  specs: readonly LoadedSpec[],
): OperationEntry[] {
  const catalog = new Map<string, OperationEntry>();
  for (const spec of specs) {
    for (const operation of spec.operations) {
      catalog.set(`${operation.method} ${operation.path}`, operation);
    }
  }

  const selected: OperationEntry[] = [];
  for (const { method, path } of operations) {
    const operation = catalog.get(`${method} ${path}`);
    if (operation === undefined) {
      process.stderr.write(
        `Warning: operation "${method} ${path}" is not present in the loaded spec(s); skipping.\n`,
      );
      continue;
    }
    selected.push(operation);
  }
  return selected;
}

/**
 * Command handler.
 *
 * Loads and validates the config named by `--config`, resolves the spec(s),
 * then runs the SPEC-7 execution stage: preflight k6, generate + emit the k6
 * script (SPEC-4/5/6), and execute it (SPEC-7). The results summary, JSON
 * results file, and final exit-code policy are owned by SPEC-8.
 */
async function run(options: CliOptions): Promise<number> {
  if (options.config === undefined) {
    process.stderr.write(`Missing required --config <path>\n\n${USAGE}\n`);
    return 1;
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
      return 1;
    }
    throw error;
  }

  const { config } = result;
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
        return 1;
      }
      throw error;
    }
    const catalogSize = loadedSpecs.reduce(
      (total, spec) => total + spec.operations.length,
      0,
    );
    process.stdout.write(
      `Resolved specs: ${catalogSize} operation(s) in the catalog.\n`,
    );
  }

  // Without a spec there is no operation catalog to build requests from, so
  // there is nothing to execute (the no-specs case is deferred to SPEC-3).
  if (config.specs === undefined) {
    return EXIT_SUCCESS;
  }

  const selected = selectOperations(config.operations, loadedSpecs);
  if (selected.length === 0) {
    process.stdout.write("No operations to run; nothing to execute.\n");
    return EXIT_SUCCESS;
  }

  // SPEC-7 preflight: k6 must resolve on PATH before we execute anything. It is
  // assumed pre-installed; SpecWeaver never auto-installs it.
  const k6Path = resolveK6();
  if (k6Path === undefined) {
    process.stderr.write(`${k6NotFoundMessage()}\n`);
    return EXIT_PREFLIGHT_FAILURE;
  }
  process.stdout.write(`k6 found: ${k6Path}\n`);

  // Generate the request data (SPEC-4), inject static auth (SPEC-5), and write
  // the generated k6 script + data to the shared specweaver temp location
  // (SPEC-6). SPEC-7 then executes that script.
  const { requests } = injectAuth(config, generateAllRequestData(selected));
  const written = writeEmittedScript({
    config,
    specs: loadedSpecs,
    requests,
  });
  process.stdout.write(`Generated k6 script: ${written.scriptPath}\n`);

  try {
    const runResult = await runGeneratedTest({
      command: k6Path,
      scriptPath: written.scriptPath,
      vus: config.load.vus,
      duration: config.load.duration,
    });
    if (runResult.exitCode !== EXIT_SUCCESS) {
      const reason =
        runResult.k6ExitCode === null
          ? `signal ${runResult.signal}`
          : `exit code ${runResult.k6ExitCode}`;
      process.stderr.write(`k6 run failed (${reason}).\n`);
    }
    return runResult.exitCode;
  } catch (error) {
    if (error instanceof K6SpawnError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_PREFLIGHT_FAILURE;
    }
    throw error;
  }
}

/** Parse `argv`, handle `--help`/`--version`/usage errors, and dispatch to `run`. */
export async function main(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      return 1;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (options.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  if (argv.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  return run(options);
}

process.exitCode = await main(process.argv.slice(2));
