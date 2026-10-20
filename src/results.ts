/**
 * Results summary, JSON results file, and exit-code policy (SPEC-8).
 *
 * This is the **final results stage** of SpecWeaver: after SPEC-7 has executed
 * the generated k6 script and handed back k6's raw exit code (plus the raw k6
 * metrics it captured with `k6 run --out json=<tempfile>`), this module
 *
 * 1. derives per-operation check pass/fail counts plus a small k6-style metric
 *    summary from the captured NDJSON,
 * 2. builds the documented machine-readable results object,
 * 3. writes it to the resolved results path, and
 * 4. formats the human-readable console summary.
 *
 * It also owns the two pieces earlier tickets deferred here:
 * - the **concrete default results path** — {@link RESULTS_FILE_NAME}
 *   (`specweaver-results.json`) in the current working directory (A1), and
 * - the **SpecWeaver exit-code policy** — {@link EXIT_SUCCESS} /
 *   {@link EXIT_K6_RUN_FAILURE} / {@link EXIT_SPECWEAVER_ERROR} (A5), plus the
 *   `warning:`-prefixed destination for unresolved-`${ENV_VAR}` warnings (A6).
 *
 * ## Result-capture mechanism (A3)
 *
 * k6 is asked to emit its raw NDJSON metrics with `--out json=<tempfile>`; this
 * runs *alongside* SPEC-7's `stdio: 'inherit'` streaming, so the live console
 * output is never buffered, replaced, or reordered. The temp file is read once
 * after k6 exits and then deleted by SPEC-7's cleanup.
 *
 * ## Per-operation check results (A4 / A7)
 *
 * The emitted script wraps each request in one informational `check` asserting
 * the response status is one of the operation's documented 2xx status(es). k6's
 * `checks` metric is tagged only by check *name*, which does not identify the
 * operation. SpecWeaver therefore derives the per-operation pass/fail counts
 * from the captured `http_reqs` points instead, whose `method` + `url` + `status`
 * tags identify the request and its response: a request whose response status is
 * accepted by the operation is a pass, otherwise a fail. This mirrors the emitted
 * check and yields a genuine per-operation breakdown.
 *
 * ## What this module does NOT do
 *
 * - It does not run k6 or stream its output (SPEC-7).
 * - It does not apply SLA thresholds or gate on metrics (deferred project-wide).
 *   The only gate is the opt-in {@link resolveRunExitCode} check-failure switch.
 * - It does not parse arbitrary raw k6 timeseries beyond the handful of metrics
 *   the summary and results JSON need.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { REDACTED } from "./auth.js";

/**
 * SpecWeaver exit code for a successful run: k6 exited `0` (A5).
 */
export const EXIT_SUCCESS = 0;

/**
 * SpecWeaver exit code for a k6 run/script failure: k6 ran but exited non-zero
 * (or was terminated by a signal) (A5).
 */
export const EXIT_K6_RUN_FAILURE = 1;

/**
 * SpecWeaver exit code for a SpecWeaver-level error: invalid/missing config, a
 * spec/validation failure, a preflight failure (e.g. k6 not found), or an
 * internal error. Distinct from a k6 run failure (A5).
 */
export const EXIT_SPECWEAVER_ERROR = 2;

/**
 * Environment-variable names whose values are treated as secrets when redacting
 * diagnostics. Used defensively by {@link redactSecrets}: internal errors are
 * secret-free by construction, but the catch-all must never echo credentials.
 */
const SENSITIVE_ENV_PATTERN = /(token|secret|password|passwd|credential|api[-_]?key|auth)/i;

/**
 * Mask any value of a secret-looking environment variable that appears in
 * `text`, replacing it with {@link REDACTED}.
 *
 * This is a defensive net for the AC10 catch-all: an unexpected error's message
 * is normally secret-free, but this guarantees a resolved credential held in a
 * conventionally-named env var (e.g. `API_TOKEN`) is never printed. Values
 * shorter than four characters are ignored to avoid mangling ordinary text.
 */
export function redactSecrets(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let redacted = text;
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.length < 4) {
      continue;
    }
    if (!SENSITIVE_ENV_PATTERN.test(name)) {
      continue;
    }
    redacted = redacted.split(value).join(REDACTED);
  }
  return redacted;
}

/** The first non-empty line of an error's message, or its string form. */
function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    const firstLine = error.message.split("\n")[0]?.trim() ?? "";
    if (firstLine !== "") {
      return firstLine;
    }
    return error.name;
  }
  return String(error);
}

/**
 * Format an unexpected internal error into a clean, actionable message (AC10).
 *
 * The catch-all around `main`/`run` uses this so an uncaught internal error
 * surfaces a single human-readable explanation and the
 * {@link EXIT_SPECWEAVER_ERROR} code — never a raw Node stack trace, and never a
 * secret value (see {@link redactSecrets}). Only the error's first message line
 * is included; the stack is deliberately discarded.
 */
export function formatUnexpectedError(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const detail = redactSecrets(errorDetail(error), env);
  return [
    `SpecWeaver encountered an unexpected internal error: ${detail}`,
    "This is a bug in SpecWeaver rather than a problem with your config or OpenAPI spec.",
    "Re-run the same command; if it persists, please report this message.",
  ].join("\n");
}

/**
 * The documented default results-file name (A1): written to the current working
 * directory when neither `--out` nor the config `output` supplies a path.
 */
export const RESULTS_FILE_NAME = "specweaver-results.json";

/**
 * The specweaver-prefixed temp file that k6 writes its raw NDJSON metrics to
 * (`--out json=<file>`), a sibling of SPEC-6's generated script/data (A3).
 */
export const K6_RAW_RESULTS_FILE_NAME = "specweaver.k6-results.ndjson";

/**
 * Prefix applied to every non-fatal warning on stderr (A6).
 */
export const WARNING_PREFIX = "warning:";

/** The `tool` value recorded in the results JSON. */
export const TOOL_NAME = "specweaver";

/** The run outcome recorded in the results JSON (A4). */
export type RunOutcome = "success" | "run_failure" | "specweaver_error";

/** A pass/fail count pair. */
export interface CheckCounts {
  /** Number of passing checks/requests. */
  pass: number;
  /** Number of failing checks/requests. */
  fail: number;
}

/**
 * The minimal shape of an emitted operation this module needs to attribute
 * captured HTTP points back to an operation. SPEC-6's `EmittedOperation`
 * satisfies it structurally, so callers pass their written data directly.
 */
export interface ResultsOperation {
  /** Upper-cased HTTP method, e.g. `GET`. */
  readonly method: string;
  /** The OpenAPI path template, e.g. `/pets`. */
  readonly route: string;
  /** The fully-composed request URL, matching k6's `url` tag. */
  readonly url: string;
  /** Documented literal 2xx status codes accepted by the check. */
  readonly expectedStatus: readonly number[];
  /** True when a wildcard `2XX` response means *any* 2xx status is accepted. */
  readonly acceptAny2xx: boolean;
}

/** Aggregated latency statistics (milliseconds) for `http_req_duration`. */
export interface DurationStats {
  avg: number;
  min: number;
  max: number;
  p90: number;
  p95: number;
}

/** The k6-derived metric summary recorded under the `summary` key (A4). */
export interface ResultsSummary {
  /** Aggregate check pass/fail counts plus the pass rate (`0..1`). */
  checks: CheckCounts & { rate: number };
  /** Total HTTP requests observed in the captured metrics. */
  httpReqs: number;
  /** Total iterations observed in the captured metrics. */
  iterations: number;
  /** `http_req_duration` statistics, or `null` when no points were captured. */
  httpReqDurationMs: DurationStats | null;
}

/**
 * The documented JSON results schema (A4).
 *
 * Top-level keys: `tool`, `version`, `timestamp`, `config` (`vus`/`duration`),
 * `k6ExitCode`, `outcome` (`success` | `run_failure` | `specweaver_error`),
 * `checks` (per-operation pass/fail counts), `summary` (the k6 summary), and
 * `resultsFile` (the path the JSON was written to).
 */
export interface ResultsFile {
  /** The tool that produced the file, always {@link TOOL_NAME}. */
  tool: string;
  /** The SpecWeaver version. */
  version: string;
  /** ISO-8601 timestamp of when the results were produced. */
  timestamp: string;
  /** The resolved load profile the run used. */
  config: { vus: number; duration: string };
  /** k6's raw exit code (`null` when k6 was terminated by a signal). */
  k6ExitCode: number | null;
  /** The run outcome. */
  outcome: RunOutcome;
  /** Per-operation check pass/fail counts, keyed by `"METHOD path"`. */
  checks: Record<string, CheckCounts>;
  /** The k6-derived metric summary. */
  summary: ResultsSummary;
  /** The path the results JSON was written to. */
  resultsFile: string;
}

/** Inputs to {@link buildResultsFile}. */
export interface BuildResultsInput {
  /** The SpecWeaver version. */
  version: string;
  /** Resolved virtual users. */
  vus: number;
  /** Resolved duration. */
  duration: string;
  /** k6's raw exit code (`null` on signal). */
  k6ExitCode: number | null;
  /** The run outcome. */
  outcome: RunOutcome;
  /** The emitted operations, in emission order. */
  operations: readonly ResultsOperation[];
  /** The raw NDJSON captured from `k6 run --out json=<file>`, if any. */
  rawK6Results?: string;
  /** The path the results JSON will be written to. */
  resultsFile: string;
  /** Override the timestamp (tests); defaults to now. */
  timestamp?: string;
}

/** One parsed k6 data point we care about. */
interface K6Sample {
  metric: string;
  value: number | undefined;
  tags: Record<string, unknown>;
}

/** What {@link observeK6Results} extracted from the raw NDJSON. */
export interface K6Observation {
  /** Total HTTP requests (sum of `http_reqs` counter values). */
  httpReqs: number;
  /** Total iterations (sum of `iterations` counter values). */
  iterations: number;
  /** Every `http_req_duration` value, in capture order. */
  durations: number[];
  /** Every `http_reqs` point's method/url/status, for per-operation attribution. */
  requests: Array<{ method: string; url: string; status: number }>;
}

/**
 * Resolve the results-file path (A1/A2): `--out` wins, then the config `output`
 * field, then {@link RESULTS_FILE_NAME} in the current working directory.
 */
export function resolveResultsPath(paths: {
  out?: string;
  output?: string;
}): string {
  return paths.out ?? paths.output ?? RESULTS_FILE_NAME;
}

/** Map k6's raw exit code onto the run outcome (A4). */
export function outcomeForK6ExitCode(k6ExitCode: number | null): RunOutcome {
  return k6ExitCode === 0 ? "success" : "run_failure";
}

/** Inputs to {@link resolveRunExitCode}. */
export interface RunExitCodeInput {
  /** k6's raw exit code (`null` when k6 was terminated by a signal). */
  k6ExitCode: number | null;
  /** The aggregate recorded check counts (`summary.checks`). */
  checks: CheckCounts;
  /** Whether `--fail-on-check-failure` was set. */
  failOnCheckFailure: boolean;
}

/**
 * Resolve SpecWeaver's process exit code from k6's outcome and the recorded
 * check counts (SPEC-19).
 *
 * This is the opt-in bridge that promotes recorded check failures into the
 * k6-run-failure code:
 *
 * - any non-zero k6 exit (including a signal, `null`) stays
 *   {@link EXIT_K6_RUN_FAILURE} — the gate never upgrades or masks it;
 * - with `failOnCheckFailure` set, at least one failing check out of a non-zero
 *   number of executed checks yields {@link EXIT_K6_RUN_FAILURE};
 * - with the flag absent, or zero checks executed, a successful k6 run yields
 *   {@link EXIT_SUCCESS} exactly as before.
 *
 * Pure and side-effect free, so the full matrix is unit-testable without
 * spawning k6.
 */
export function resolveRunExitCode(input: RunExitCodeInput): number {
  if (input.k6ExitCode !== EXIT_SUCCESS) {
    return EXIT_K6_RUN_FAILURE;
  }
  const totalChecks = input.checks.pass + input.checks.fail;
  if (
    input.failOnCheckFailure &&
    totalChecks > 0 &&
    input.checks.fail > 0
  ) {
    return EXIT_K6_RUN_FAILURE;
  }
  return EXIT_SUCCESS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringTag(tags: Record<string, unknown>, name: string): string | undefined {
  const value = tags[name];
  return typeof value === "string" ? value : undefined;
}

function parseSample(line: string): K6Sample | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // k6 writes complete NDJSON lines; skip anything malformed rather than fail.
    return undefined;
  }
  if (!isRecord(parsed) || parsed.type !== "Point") {
    return undefined;
  }
  const metric = parsed.metric;
  const data = isRecord(parsed.data) ? parsed.data : undefined;
  if (typeof metric !== "string" || data === undefined) {
    return undefined;
  }
  const value = typeof data.value === "number" ? data.value : undefined;
  const tags = isRecord(data.tags) ? data.tags : {};
  return { metric, value, tags };
}

/**
 * Parse the raw NDJSON emitted by `k6 run --out json=<file>` into the handful of
 * observations the summary and per-operation counts need.
 *
 * Malformed lines are skipped. A missing/empty input yields empty observations,
 * so callers can always build a (checkless) results object.
 */
export function observeK6Results(raw: string | undefined): K6Observation {
  const observation: K6Observation = {
    httpReqs: 0,
    iterations: 0,
    durations: [],
    requests: [],
  };
  if (raw === undefined || raw.trim() === "") {
    return observation;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const sample = parseSample(trimmed);
    if (sample === undefined) {
      continue;
    }

    switch (sample.metric) {
      case "http_reqs": {
        observation.httpReqs += sample.value ?? 1;
        const method = stringTag(sample.tags, "method") ?? "";
        const url =
          stringTag(sample.tags, "url") ?? stringTag(sample.tags, "name") ?? "";
        const status = Number(stringTag(sample.tags, "status") ?? "0");
        observation.requests.push({
          method: method.toUpperCase(),
          url,
          status: Number.isFinite(status) ? status : 0,
        });
        break;
      }
      case "http_req_duration":
        if (sample.value !== undefined) {
          observation.durations.push(sample.value);
        }
        break;
      case "iterations":
        observation.iterations += sample.value ?? 1;
        break;
      default:
        break;
    }
  }

  return observation;
}

/** True when `status` is accepted by the operation's documented 2xx set. */
function statusAccepted(operation: ResultsOperation, status: number): boolean {
  if (operation.acceptAny2xx) {
    return status >= 200 && status < 300;
  }
  return operation.expectedStatus.includes(status);
}

/**
 * Attribute captured HTTP points back to each emitted operation and count its
 * check passes/fails (A4/A7).
 *
 * An operation's counts are the captured requests whose `method` + `url` match
 * it, split by whether the response `status` is accepted. Requests that do not
 * match any operation are ignored.
 */
export function countOperationChecks(
  operations: readonly ResultsOperation[],
  observation: K6Observation,
): { perOperation: Record<string, CheckCounts>; aggregate: CheckCounts } {
  const perOperation: Record<string, CheckCounts> = {};
  const aggregate: CheckCounts = { pass: 0, fail: 0 };

  for (const operation of operations) {
    const counts: CheckCounts = { pass: 0, fail: 0 };
    const method = operation.method.toUpperCase();
    for (const request of observation.requests) {
      if (request.method !== method || request.url !== operation.url) {
        continue;
      }
      if (statusAccepted(operation, request.status)) {
        counts.pass += 1;
      } else {
        counts.fail += 1;
      }
    }
    perOperation[`${operation.method} ${operation.route}`] = counts;
    aggregate.pass += counts.pass;
    aggregate.fail += counts.fail;
  }

  return { perOperation, aggregate };
}

/** Nearest-rank percentile of an ascending-sorted, non-empty list. */
function percentile(sorted: readonly number[], fraction: number): number {
  const rank = Math.ceil(fraction * sorted.length) - 1;
  const index = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[index] ?? 0;
}

/** Aggregate latency statistics, or `null` for an empty sample. */
function durationStats(values: readonly number[]): DurationStats | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    avg: sum / sorted.length,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
  };
}

/**
 * Build the documented results object (A4) from the run outcome and the raw k6
 * NDJSON. Pure and deterministic for a fixed `timestamp`.
 */
export function buildResultsFile(input: BuildResultsInput): ResultsFile {
  const observation = observeK6Results(input.rawK6Results);
  const { perOperation, aggregate } = countOperationChecks(
    input.operations,
    observation,
  );
  const total = aggregate.pass + aggregate.fail;
  const rate = total === 0 ? 1 : aggregate.pass / total;

  return {
    tool: TOOL_NAME,
    version: input.version,
    timestamp: input.timestamp ?? new Date().toISOString(),
    config: { vus: input.vus, duration: input.duration },
    k6ExitCode: input.k6ExitCode,
    outcome: input.outcome,
    checks: perOperation,
    summary: {
      checks: { pass: aggregate.pass, fail: aggregate.fail, rate },
      httpReqs: observation.httpReqs,
      iterations: observation.iterations,
      httpReqDurationMs: durationStats(observation.durations),
    },
    resultsFile: input.resultsFile,
  };
}

/**
 * Write the results JSON to {@link ResultsFile.resultsFile} (creating parent
 * directories as needed) and return the absolute path written.
 */
export function writeResultsFile(resultsFile: ResultsFile): string {
  const absolute = resolve(resultsFile.resultsFile);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(resultsFile, null, 2)}\n`, "utf8");
  return absolute;
}

/** Format a latency stat value to two decimals for the console. */
function ms(value: number): string {
  return value.toFixed(2);
}

/**
 * Render the human-readable console summary (A7): run outcome, resolved load,
 * one line per operation with its check pass/fail counts, the aggregate check
 * result, key metrics, and the path of the written results file.
 *
 * Emitted once, after k6 exits, so it never interleaves with SPEC-7's
 * live-streamed k6 output.
 */
export function formatSummary(resultsFile: ResultsFile): string {
  const { checks, summary } = resultsFile;
  const lines: string[] = [];

  lines.push("SpecWeaver run summary");
  lines.push(`Outcome: ${resultsFile.outcome}`);
  lines.push(`k6 exit code: ${resultsFile.k6ExitCode ?? "signal"}`);
  lines.push(
    `Load: ${resultsFile.config.vus} virtual user(s) for ${resultsFile.config.duration}`,
  );

  const operationIds = Object.keys(checks);
  if (operationIds.length > 0) {
    lines.push("Checks (per operation):");
    const width = Math.max(...operationIds.map((id) => id.length));
    for (const id of operationIds) {
      const counts = checks[id] ?? { pass: 0, fail: 0 };
      lines.push(
        `  ${id.padEnd(width)}  pass ${counts.pass}  fail ${counts.fail}`,
      );
    }
  } else {
    lines.push("Checks: none captured");
  }

  const { pass, fail, rate } = summary.checks;
  lines.push(
    `Checks total: ${pass} passed, ${fail} failed (${(rate * 100).toFixed(1)}%)`,
  );
  lines.push(`HTTP requests: ${summary.httpReqs}`);
  lines.push(`Iterations: ${summary.iterations}`);
  if (summary.httpReqDurationMs !== null) {
    const d = summary.httpReqDurationMs;
    lines.push(
      `http_req_duration (ms): avg ${ms(d.avg)}, min ${ms(d.min)}, max ${ms(d.max)}, p(90) ${ms(d.p90)}, p(95) ${ms(d.p95)}`,
    );
  }
  lines.push(`Results file: ${resultsFile.resultsFile}`);

  return `${lines.join("\n")}\n`;
}

/**
 * Format unresolved-`${ENV_VAR}` warnings for stderr (A6): each is prefixed
 * with {@link WARNING_PREFIX}.
 *
 * De-duplication is **per unresolved variable name** (A6), not per full message:
 * the same variable left unresolved in several fields (e.g. both `auth.token`
 * and an auth header) warns once. The first occurrence is kept as the stable
 * representative message for that variable.
 *
 * Pass a shared `seen` set to de-duplicate across multiple calls (the CLI emits
 * config-load warnings and auth-injection warnings separately, yet a variable
 * is only reported once for the whole run). Non-fatal and never written into the
 * results JSON.
 */
const UNRESOLVED_ENV_PATTERN = /unresolved environment variable "([^"]+)"/;

export function formatWarnings(
  warnings: readonly string[],
  seen: Set<string> = new Set<string>(),
): string {
  const lines: string[] = [];
  for (const warning of warnings) {
    const match = UNRESOLVED_ENV_PATTERN.exec(warning);
    const key = match ? `env:${match[1]}` : `msg:${warning}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    lines.push(`${WARNING_PREFIX} ${warning}`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
