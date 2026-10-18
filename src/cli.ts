#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { CliUsageError, USAGE, parseArgs, type CliOptions } from "./args.js";

/** Read the version string from the package manifest. */
function readVersion(): string {
  const manifestUrl = new URL("../package.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as {
    version: string;
  };
  return manifest.version;
}

/**
 * Command handler.
 *
 * SPEC-1 only provides the CLI shell; no SpecWeaver behaviour (config loading,
 * payload generation, k6 execution) is implemented here yet. Later tickets
 * consume `options` from this entry point.
 */
function run(_options: CliOptions): number {
  process.stdout.write(
    "SpecWeaver CLI scaffold: no command behaviour is implemented yet.\n",
  );
  return 0;
}

/** Parse `argv`, handle `--help`/`--version`/usage errors, and dispatch to `run`. */
export function main(argv: string[]): number {
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

process.exitCode = main(process.argv.slice(2));
