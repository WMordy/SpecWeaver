/**
 * Argument parsing for the SpecWeaver CLI.
 *
 * This module owns the parsing of the four core flags (`--config`, `--vus`,
 * `--duration`, `--out`) plus `--help`/`--version`, and nothing else. The
 * requiredness/defaults of `--config`/`--out` are enforced by later tickets
 * (SPEC-2/SPEC-7/SPEC-8), not here.
 */

/** Structured options produced by {@link parseArgs}, ready for the command handler. */
export interface CliOptions {
  /** Path to the YAML config file (`--config`). */
  config?: string;
  /** Number of virtual users (`--vus`), a positive integer. */
  vus?: number;
  /** k6-style load duration (`--duration`), e.g. `30s` or `1m30s`. */
  duration?: string;
  /** Results output file path (`--out`). */
  out?: string;
  /** `--help` was requested. */
  help: boolean;
  /** `--version` was requested. */
  version: boolean;
}

/** Error thrown when the command line cannot be parsed. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** Usage text printed for `--help` and on usage errors. */
export const USAGE = `specweaver - turn OpenAPI definitions + a YAML config into k6 load tests

Usage:
  specweaver --config <path> [options]

Options:
  --config <path>     Path to the YAML config file
  --vus <n>           Number of virtual users (positive integer)
  --duration <time>   k6-style load duration, e.g. 30s or 1m30s
  --out <path>        Path to write the results file
  --help              Print this usage information
  --version           Print the version number`;

/** k6-style duration: one or more <number><unit> segments, unit in ms|s|m|h. */
const DURATION_PATTERN = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/;

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) {
    throw new CliUsageError(`Missing value for ${flag}`);
  }
  return value;
}

/**
 * Parse CLI arguments (typically `process.argv.slice(2)`) into {@link CliOptions}.
 *
 * @throws {CliUsageError} on an unknown flag, a missing value, or an invalid value.
 */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false, version: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    switch (arg) {
      case "--help":
        options.help = true;
        break;

      case "--version":
        options.version = true;
        break;

      case "--config":
        options.config = requireValue(arg, argv[i + 1]);
        i += 1;
        break;

      case "--out":
        options.out = requireValue(arg, argv[i + 1]);
        i += 1;
        break;

      case "--vus": {
        const raw = requireValue(arg, argv[i + 1]);
        i += 1;
        const vus = Number(raw);
        if (!Number.isInteger(vus) || vus <= 0) {
          throw new CliUsageError(
            `--vus must be a positive integer (received "${raw}")`,
          );
        }
        options.vus = vus;
        break;
      }

      case "--duration": {
        const raw = requireValue(arg, argv[i + 1]);
        i += 1;
        if (!DURATION_PATTERN.test(raw)) {
          throw new CliUsageError(
            `--duration must be a k6-style duration such as "30s" or "1m30s" (received "${raw}")`,
          );
        }
        options.duration = raw;
        break;
      }

      default:
        if (arg.startsWith("-")) {
          throw new CliUsageError(`Unknown flag: ${arg}`);
        }
        throw new CliUsageError(`Unexpected argument: ${arg}`);
    }
  }

  return options;
}
