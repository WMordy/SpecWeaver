#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { CliUsageError, USAGE, parseArgs, type CliOptions } from "./args.js";
import { ConfigError, loadConfig, type ConfigResult } from "./config.js";

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
 * Loads and validates the config named by `--config`, merging the CLI
 * overrides. Later tickets (SPEC-3 onwards) consume the resulting `Config`.
 */
function run(options: CliOptions): number {
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
  // `result.warnings` holds any unresolved-`${ENV_VAR}` warnings collected
  // while loading; where they are surfaced is owned by SPEC-8.
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
