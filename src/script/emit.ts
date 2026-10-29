/**
 * k6 script emission (SPEC-6).
 *
 * This is the emission stage between data generation (SPEC-4/5) and execution
 * (SPEC-7/8). Given the resolved {@link Config}, the SPEC-3 spec/catalog, and
 * the SPEC-4/5 generated request data, it produces:
 *
 * - a **dependency-free** k6 script ({@link SCRIPT_FILE_NAME}), and
 * - a companion JSON data file ({@link DATA_FILE_NAME}) the script loads at init.
 *
 * ## Why the emitted script is not Node
 *
 * k6 runs scripts in its own embedded JS runtime (goja), not Node. The emitted
 * script therefore imports only k6 built-ins (`k6`, `k6/http`) and standard
 * JavaScript — no `require`, `fs`, `path`, `process`, `Buffer`, npm packages, or
 * Node ESM resolution. All faker.js work happens here in the Node CLI; the
 * emitted script consumes the results as plain data (assumption A7).
 *
 * ## Locked decisions implemented here
 *
 * - **A1 / Base URL:** the request base URL is the config `baseUrl` override
 *   when present, otherwise the first usable `servers[].url` (server-variable
 *   defaults substituted; unusable entries are skipped). The optional `baseUrl`
 *   field now exists on the SPEC-2 `Config` (its validation was absorbed into
 *   SPEC-9 from the closed SPEC-10, 2026-10-18); this module only *consumes* it,
 *   applying the precedence above without re-validating the field.
 * - **A2 / Output location:** the script is `specweaver.generated.js` and its
 *   data is `specweaver.data.json`, written together in a unique per-run
 *   directory under `os.tmpdir()` created with
 *   `fs.mkdtempSync(join(os.tmpdir(), "specweaver-"))` — the SAME directory
 *   SPEC-7 executes from. `--out` and the config `output` field do **not** name
 *   these paths (they target only the SPEC-8 results JSON). **Temp-file posture
 *   (hardened, SPEC-11):** a fresh unpredictable directory per run avoids fixed
 *   names and collisions, and the files are created with `0o600` permissions
 *   where the platform supports it; SPEC-7 removes the whole directory after
 *   the run unless the keep-temp opt-out is set.
 * - **A3 / A5 / Checks:** each request is wrapped in one informational `check`
 *   asserting the response status is one of the operation's documented 2xx
 *   response(s), defaulting to `200` when the spec documents none. A wildcard
 *   response such as `2XX` means *any* 2xx status (a range check), not exactly
 *   `200`. No k6 `thresholds` are emitted.
 * - **Content-Type (2026-10-18, corrected):** k6 does **not** JSON-serialize
 *   object bodies — it form-encodes them (`application/x-www-form-urlencoded`),
 *   dropping nested objects/arrays. The emitter therefore serializes each JSON
 *   body to a string (`JSON.stringify`) and sets `Content-Type: application/json`
 *   explicitly. An existing `Content-Type` (from a header parameter, or injected
 *   as auth) wins, preserving the established collision precedence — auth was
 *   merged last by SPEC-5, case-insensitively, so auth still wins.
 * - **A4 / Pacing:** the `default` function sleeps `1s` between iterations.
 * - **A6 / Auth:** auth arrives as already-injected per-operation headers in the
 *   generated request data; the emitter serializes them unchanged.
 * - **A7 / Embedding:** the operation list and generated payloads are written to
 *   the companion JSON file, which the script loads at init via `open()` +
 *   `JSON.parse` (never inside `default`). The script is intentionally
 *   non-self-contained (two files).
 * - **A8 / File form:** emitted as `.js` using ESM `import` of k6 built-ins.
 *
 * ## Post-review product-owner decisions (2026-10-18)
 *
 * These close out the review thread that left SPEC-6 `in_progress`:
 *
 * 1. **Scope — module only.** SPEC-6 is and remains a pure emission module
 *    (this file). CLI wiring and orchestration (reading config, invoking
 *    SPEC-7/9) are explicitly owned by SPEC-7/9, not here. There is no CLI
 *    entry point in this ticket.
 * 2. **`baseUrl` field (absorbed into SPEC-9, 2026-10-18).** The precedence
 *    logic of A1 is unchanged; the `baseUrl` field and its validation now live
 *    in the SPEC-2 config schema, absorbed from the closed SPEC-10.
 * 3. **Wildcard `2XX`.** A documented `2XX`/`2xx` response is treated as *any*
 *    2xx status via a range check (`status >= 200 && status < 300`), rather
 *    than being normalized to exactly `200`. Literal codes are still matched
 *    exactly; a wildcard alongside literals simply accepts the whole 2xx range.
 * 4. **Content-Type (corrected 2026-10-18, supersedes the earlier decision).**
 *    k6 does not JSON-serialize object bodies: passing an object form-encodes it
 *    (`application/x-www-form-urlencoded`) and loses nested objects/arrays. The
 *    emitter now serializes JSON bodies to strings and emits an explicit
 *    `Content-Type: application/json` header, without overriding an existing one.
 * 5. **Temp-file posture (superseded by SPEC-11, 2026-10-20).** The original
 *    v1 posture accepted fixed file names and plaintext secrets in `$TMPDIR`.
 *    SPEC-11 hardens this: a unique per-run directory plus `0o600` files;
 *    plaintext secrets at runtime and SPEC-7's delete-after-run are unchanged.
 *
 * ## URL composition
 *
 * Path-parameter substitution and query-string serialization happen **here at
 * emission time** (Node), and the fully-composed URL is stored per operation in
 * the data file. This keeps the emitted k6 script minimal and its wiring
 * deterministic and unit-testable without requiring k6. {@link buildRequestUrl}
 * is exported for direct testing.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config, LoadConfig } from "../config.js";
import type { GeneratedRequestData, QueryValue } from "../request-data.js";
import type { JsonObject } from "../spec.js";

/** The default file name of the emitted k6 script (A2). */
export const SCRIPT_FILE_NAME = "specweaver.generated.js";

/** The default file name of the emitted companion data file (A2). */
export const DATA_FILE_NAME = "specweaver.data.json";

/**
 * Prefix of the per-run temp directory (e.g. `/tmp/specweaver-Ab3dEf`).
 * `mkdtempSync` appends a random suffix, so each run gets an unpredictable,
 * collision-free location (SPEC-11).
 */
export const TEMP_DIRECTORY_PREFIX = "specweaver-";

/**
 * Permission bits for the generated files (SPEC-11): owner-only read/write, so
 * the companion data file (which may contain plaintext auth headers) is not
 * world-readable. Applied on creation; platforms that do not support POSIX
 * modes ignore it.
 */
export const GENERATED_FILE_MODE = 0o600;

/** Status used when the spec documents no 2xx response for an operation (A5). */
export const DEFAULT_EXPECTED_STATUS = 200;

/**
 * The `Content-Type` emitted for JSON request bodies (corrected decision 4).
 *
 * k6 does not JSON-serialize object bodies, so the emitter serializes the body
 * itself and declares the media type explicitly.
 */
export const JSON_CONTENT_TYPE = "application/json";

/**
 * The minimal spec shape the emitter needs. SPEC-3's `LoadedSpec` satisfies it
 * structurally, so callers pass their loaded specs directly.
 */
export interface EmitSpec {
  /** The fully `$ref`-resolved OpenAPI document. */
  readonly document: JsonObject;
  /** The spec source path, when the caller has one (used in diagnostics). */
  readonly source?: string;
}

/** Inputs to {@link emitScript}. */
export interface EmitInput {
  /** The resolved config: supplies the load profile and the `baseUrl` override. */
  config: Config;
  /**
   * The SPEC-3 spec/catalog source(s), in order. Used for the fallback base URL
   * (the first usable `servers[].url`) and for each operation's documented 2xx
   * response(s). Optional; when absent, base URL comes from `config.baseUrl`
   * only and every check defaults to {@link DEFAULT_EXPECTED_STATUS}.
   */
  specs?: readonly EmitSpec[];
  /**
   * The SPEC-4/5 generated request data for the selected operations, in
   * emission order. Each entry becomes one `http.request` in the emitted script.
   */
  requests: readonly GeneratedRequestData[];
}

/** One operation as serialized into the companion data file. */
export interface EmittedOperation {
  /** Upper-cased HTTP method. */
  method: string;
  /** The OpenAPI path template, e.g. `/pets/{petId}`. */
  route: string;
  /** Base URL + path (params substituted) + query string, fully composed. */
  url: string;
  /** Path parameter name -> value (already used in {@link route}). */
  pathParams: Record<string, string>;
  /** Query parameter name -> wire value(s). */
  query: Record<string, QueryValue>;
  /** Header name -> value, including injected auth headers (A6). */
  headers: Record<string, string>;
  /**
   * The JSON request body as a serialized string, when the operation declares
   * one. Stored pre-serialized (rather than as the decoded object) because k6
   * does not JSON-serialize object bodies — it form-encodes them — so a nested
   * payload would otherwise be dropped (corrected decision 4).
   */
  body?: string;
  /**
   * The documented literal 2xx status codes the check accepts (A5), ascending.
   * Empty when the spec documents only a wildcard `2XX` response (A5 /
   * post-review decision 3).
   */
  expectedStatus: number[];
  /**
   * True when the spec documents a wildcard `2XX`/`2xx` response. When set, the
   * check accepts any 2xx status (`>= 200 && < 300`), superseding the exact
   * {@link expectedStatus} literals (post-review decision 3).
   */
  acceptAny2xx: boolean;
}

/** The companion data object serialized to {@link DATA_FILE_NAME}. */
export interface EmittedData {
  /** The resolved request base URL (possibly empty when none is available). */
  baseUrl: string;
  /** The selected operations, in emission order. */
  operations: EmittedOperation[];
}

/** The result of {@link emitScript}: the script text plus the data object. */
export interface EmittedScript {
  /** The generated k6 script text. */
  script: string;
  /** The companion data object (serialized to JSON by the writer). */
  data: EmittedData;
}

/** The result of {@link writeEmittedScript}: the artifacts plus their paths. */
export interface WrittenScript extends EmittedScript {
  /** Absolute path to the per-run directory holding both artifacts. */
  directory: string;
  /** Absolute path to the written k6 script. */
  scriptPath: string;
  /** Absolute path to the written companion data file. */
  dataPath: string;
}

/** Options for {@link writeEmittedScript}. */
export interface WriteOptions {
  /**
   * Exact directory to write into. When omitted, a unique per-run directory is
   * created under `os.tmpdir()` (prefix {@link TEMP_DIRECTORY_PREFIX}); this is
   * the production path (SPEC-11). The script's `open()` reference is a sibling
   * file name, so it resolves regardless of directory.
   */
  directory?: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the config `baseUrl` override, if present.
 *
 * `baseUrl` is a validated, optional field on the SPEC-2 `Config` (validation
 * absorbed into SPEC-9 from the closed SPEC-10, 2026-10-18); the emitter simply
 * consumes it and defers validation to the config loader.
 */
function configBaseUrl(config: Config): string | undefined {
  return config.baseUrl;
}

/** Substitute a server's `{var}` placeholders with their variable defaults. */
function serverUrl(server: unknown): string | undefined {
  if (!isObject(server) || typeof server.url !== "string") {
    return undefined;
  }
  const variables = isObject(server.variables) ? server.variables : {};
  return server.url.replace(/\{([^}]+)\}/g, (match, name: string): string => {
    const variable = variables[name];
    if (isObject(variable) && typeof variable.default === "string") {
      return variable.default;
    }
    return match;
  });
}

/** A resolved fallback `servers[].url` plus the spec source that supplied it. */
export interface FallbackBaseUrl {
  /**
   * The first usable `servers[].url` across the specs, variable defaults
   * applied. When no candidate is usable, this is the first string candidate
   * so the CLI can diagnose why the fallback failed.
   */
  url: string;
  /** The spec source that supplied {@link url}, when the spec carries one. */
  source?: string;
}

/**
 * Resolve the fallback base URL (A1): the first usable `servers[].url` across
 * the specs, in spec order, with server-variable defaults substituted.
 *
 * "Usable" is exactly {@link classifyBaseUrl}'s contract: absolute `http(s)`,
 * non-empty host, no whitespace/control characters, and no unresolved
 * `{variable}` placeholder. Entries whose `url` is not a string are skipped.
 * Scanning continues past unusable entries, so an earlier relative, empty,
 * non-`http(s)`, whitespace-bearing, or templated entry cannot block a later
 * usable one.
 *
 * When a usable entry is found, every skipped string entry is reported through
 * `warnings` (unprefixed; the CLI adds `warning:` and writes to stderr) so the
 * retargeting is visible. Values are redacted with
 * {@link redactBaseUrlForDiagnostics}. If no candidate is usable, the first
 * string candidate is returned with no skip warnings so the CLI can keep
 * producing its existing actionable error; the picked entry is returned with
 * its source so the diagnostic can name the right spec.
 */
export function resolveFallbackBaseUrl(
  specs: readonly EmitSpec[],
  warnings?: string[],
): FallbackBaseUrl | undefined {
  let firstCandidate: FallbackBaseUrl | undefined;
  const skipped: string[] = [];

  for (const spec of specs) {
    const servers = spec.document.servers;
    if (!Array.isArray(servers)) {
      continue;
    }
    for (const server of servers) {
      const url = serverUrl(server);
      if (url === undefined) {
        continue;
      }
      const candidate: FallbackBaseUrl =
        spec.source === undefined ? { url } : { url, source: spec.source };
      const problem = classifyBaseUrl(url);
      if (problem === undefined) {
        if (warnings !== undefined && skipped.length > 0) {
          warnings.push(...skipped);
        }
        return candidate;
      }
      if (firstCandidate === undefined) {
        firstCandidate = candidate;
      }
      skipped.push(formatSkippedFallbackWarning(url, spec.source, problem));
    }
  }

  return firstCandidate;
}

/** Human-readable reason for a rejected fallback candidate. */
function fallbackProblemReason(problem: BaseUrlProblem): string {
  switch (problem) {
    case "missing":
      return "no string value is defined";
    case "empty":
      return "it is empty";
    case "surrounding-whitespace":
      return "it has surrounding whitespace";
    case "embedded-whitespace":
      return "it contains embedded whitespace or control characters";
    case "relative":
      return "it is not an absolute URL";
    case "unsupported-protocol":
      return "it does not use the http or https protocol";
    case "missing-host":
      return "it has no host";
    case "unresolved-variable":
      return "it still contains an unresolved server-variable placeholder";
  }
}

/** Build a non-fatal warning for one skipped fallback candidate. */
function formatSkippedFallbackWarning(
  url: string,
  source: string | undefined,
  problem: BaseUrlProblem,
): string {
  const origin =
    source === undefined ? "the loaded specs" : `spec "${source}"`;
  const value = JSON.stringify(redactBaseUrlForDiagnostics(url));
  return `skipping unusable \`servers[].url\` ${value} from ${origin}: ${fallbackProblemReason(problem)}.`;
}

/**
 * Why a resolved fallback base URL cannot be used as a request base URL (A4).
 *
 * - `missing`: no string `servers[].url` was found at all.
 * - `empty`: the resolved value is empty (or whitespace only).
 * - `surrounding-whitespace`: the value would be emitted untrimmed.
 * - `embedded-whitespace`: the value contains internal whitespace or ASCII
 *   control characters (the WHATWG parser would silently strip some of them).
 * - `relative`: the value does not parse as an absolute URL.
 * - `unsupported-protocol`: it is absolute but not `http:`/`https:`.
 * - `missing-host`: it is http(s) but has no host.
 * - `unresolved-variable`: a missing/malformed `{variable}` placeholder survived
 *   substitution (including an empty `{}` name).
 */
export type BaseUrlProblem =
  | "missing"
  | "empty"
  | "surrounding-whitespace"
  | "embedded-whitespace"
  | "relative"
  | "unsupported-protocol"
  | "missing-host"
  | "unresolved-variable";

/**
 * The whole-value replacement used when a diagnostic value does not match the
 * strict allowlist below. Deliberately contains no fragment of the original
 * value: arbitrary malformed input is never partially parsed or echoed.
 */
export const REDACTED_BASE_URL_MARKER =
  "*** (value redacted: may contain credentials)";

/** Shape 2: a root-relative path such as `/v1`. */
const ROOT_RELATIVE_PATH = /^\/[A-Za-z0-9._~\-/]*$/;

/**
 * Shape 3: a relative host/path with no scheme, userinfo, query, fragment, or
 * `=`, such as `api.example.com/v1`.
 */
const RELATIVE_HOST_PATH = /^[A-Za-z0-9.-]+(\/[A-Za-z0-9._~\-/]*)?$/;

/**
 * Shape 4: an absolute `scheme://host/path` with no userinfo, query, fragment,
 * `=`, braces, or whitespace, such as `ftp://example.com` or
 * `https://api.example.com/v1/`.
 */
const ABSOLUTE_URL =
  /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^{}\s@?#=]+(\/[^{}\s@?#=]*)?$/;

/**
 * Shape 5: the absolute shape above when its braces are `{variable}`
 * placeholders, such as `https://{host}/api`. Brace contents are validated
 * separately by {@link hasOnlyNamedPlaceholders}, since this character class
 * cannot enforce a non-empty identifier.
 */
const ABSOLUTE_TEMPLATE_URL =
  /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9._~{}:\-/]*$/;

/** A placeholder name: a non-empty identifier with no braces. */
const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Structural authority check for shape 4. The shape's character class allows
 * `:`, so without this `ftp://user:secret` would look safe even though it is
 * userinfo. Accept only a bare host, `host:port` with a numeric port, or a
 * bracketed IPv6 literal with an optional numeric port.
 */
function hasSafeAuthority(value: string): boolean {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value);
  if (match === null) {
    return false;
  }
  const authority = match[1];
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) {
      return false;
    }
    const rest = authority.slice(close + 1);
    return rest === "" || /^:\d+$/.test(rest);
  }
  const parts = authority.split(":");
  if (parts.length === 1) {
    return true;
  }
  if (parts.length === 2) {
    return /^\d+$/.test(parts[1]);
  }
  return false;
}

/**
 * Whether every brace pair in `value` wraps a non-empty identifier and at least
 * one such placeholder exists. Stray or malformed braces fail.
 */
function hasOnlyNamedPlaceholders(value: string): boolean {
  let sawPlaceholder = false;
  let invalid = false;
  const stripped = value.replace(/\{([^{}]*)\}/g, (_match, name: string) => {
    sawPlaceholder = true;
    if (!PLACEHOLDER_NAME.test(name)) {
      invalid = true;
    }
    return "";
  });
  return sawPlaceholder && !invalid && !/[{}]/.test(stripped);
}

/**
 * Redact a base URL before quoting it in a diagnostic.
 *
 * Strict allowlist: the value is returned verbatim only when it matches one of
 * the safe shapes — empty, root-relative, relative host/path, absolute
 * `scheme://host/path`, or that absolute shape with well-formed `{variable}`
 * placeholders. Everything else, including any value containing `@`, `=`, `?`,
 * `#`, whitespace/control characters, userinfo-like authorities without `@`,
 * or malformed braces, is replaced wholesale with
 * {@link REDACTED_BASE_URL_MARKER}. There is no partial parsing and no
 * exception path, so no fragment of an unrecognised value can leak.
 *
 * String-based on purpose: the value is often *not* a valid URL (that is why it
 * is being reported), so `new URL` cannot be relied on. Redaction runs before
 * the value is JSON-quoted for the message.
 */
export function redactBaseUrlForDiagnostics(value: string): string {
  // Shape 1: the empty string.
  if (value === "") {
    return value;
  }

  // Control characters (including NUL and the ASCII whitespace controls) never
  // appear in a safe shape; mask before any shape can accidentally allow one.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return REDACTED_BASE_URL_MARKER;
  }

  // Shape 2: root-relative path.
  if (ROOT_RELATIVE_PATH.test(value)) {
    return value;
  }

  // Shape 3: relative host/path.
  if (RELATIVE_HOST_PATH.test(value)) {
    return value;
  }

  // Shape 4: absolute URL with a structurally safe authority.
  if (ABSOLUTE_URL.test(value) && hasSafeAuthority(value)) {
    return value;
  }

  // Shape 5: absolute URL whose only braces are named placeholders.
  if (ABSOLUTE_TEMPLATE_URL.test(value) && hasOnlyNamedPlaceholders(value)) {
    return value;
  }

  return REDACTED_BASE_URL_MARKER;
}

/**
 * Classify a resolved fallback base URL as usable or not (A4).
 *
 * "Usable" means it parses as an absolute URL whose protocol is `http:` or
 * `https:`, has a non-empty host, and contains no unresolved `{variable}`
 * placeholder. Returns `undefined` when usable, otherwise the problem.
 *
 * Server-variable defaults are substituted before this runs by
 * {@link resolveFallbackBaseUrl}; any placeholder still present here has no
 * default and is therefore unresolved.
 */
export function classifyBaseUrl(
  value: string | undefined,
): BaseUrlProblem | undefined {
  if (value === undefined) {
    return "missing";
  }
  if (value.trim() === "") {
    return "empty";
  }
  // Surrounding whitespace would be emitted verbatim into the request URL.
  // Require the resolved value to already be clean rather than trimming it
  // silently, so the diagnostic points at the spec (A4).
  if (value !== value.trim()) {
    return "surrounding-whitespace";
  }
  // Reject internal whitespace and ASCII control characters too. The WHATWG
  // parser silently strips tabs/newlines (and trims spaces), so accepting them
  // would emit a broken URL that only k6 rejects later. `\s` also catches
  // whitespace beyond ASCII; the explicit ranges catch other control bytes.
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    return "embedded-whitespace";
  }
  // Checked before parsing: the WHATWG URL parser accepts `{...}` in a host,
  // which would otherwise hide the real problem behind a downstream k6 error.
  // Match any remaining brace so a malformed placeholder (`{}`, `{host`, ...)
  // is treated as unresolved too, not just a well-formed `{name}`.
  if (/[{}]/.test(value)) {
    return "unresolved-variable";
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "relative";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "unsupported-protocol";
  }
  if (parsed.host === "") {
    return "missing-host";
  }
  return undefined;
}

/**
 * Resolve the request base URL (A1): the config `baseUrl` override wins, else
 * the first usable `servers[].url` (server-variable defaults substituted), else
 * the empty string.
 *
 * This pure behaviour is unchanged by the SPEC-24 CLI usability gate, which
 * judges the fallback value separately via {@link resolveFallbackBaseUrl} and
 * {@link classifyBaseUrl}.
 */
export function resolveBaseUrl(input: Pick<EmitInput, "config" | "specs">): string {
  return (
    configBaseUrl(input.config) ??
    resolveFallbackBaseUrl(input.specs ?? [])?.url ??
    ""
  );
}

/**
 * Compose the fully-qualified request URL for one operation: base URL + path
 * with path parameters substituted + query string.
 *
 * Path and query values are percent-encoded. A trailing slash on the base URL
 * is stripped so `https://host/` + `/pets` does not yield `https://host//pets`.
 */
export function buildRequestUrl(
  baseUrl: string,
  request: Pick<GeneratedRequestData, "path" | "pathParams" | "query">,
): string {
  let route = request.path;
  for (const [name, value] of Object.entries(request.pathParams ?? {})) {
    route = route.split(`{${name}}`).join(encodeURIComponent(value));
  }

  const pairs: string[] = [];
  for (const [name, value] of Object.entries(request.query ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(item)}`);
    }
  }
  const query = pairs.length > 0 ? `?${pairs.join("&")}` : "";

  return `${baseUrl.replace(/\/+$/, "")}${route}${query}`;
}

/** The documented 2xx responses for an operation (A5). */
interface DocumentedStatuses {
  /** Literal 2xx status codes, ascending. */
  statuses: number[];
  /** True when a wildcard `2XX`/`2xx` response is documented. */
  wildcard: boolean;
}

/**
 * The documented 2xx responses for an operation (A5), or empty when the spec
 * documents none. A literal code (`200`) is kept exact; a wildcard (`2XX`) is
 * reported via {@link DocumentedStatuses.wildcard} so the check can accept any
 * 2xx status (post-review product-owner decision 3).
 */
function documented2xx(
  specs: readonly EmitSpec[],
  method: string,
  route: string,
): DocumentedStatuses {
  for (const spec of specs) {
    const paths = spec.document.paths;
    if (!isObject(paths)) {
      continue;
    }
    const pathItem = paths[route];
    if (!isObject(pathItem)) {
      continue;
    }
    const operation = pathItem[method.toLowerCase()];
    if (!isObject(operation)) {
      continue;
    }
    const responses = operation.responses;
    if (!isObject(responses)) {
      return { statuses: [], wildcard: false };
    }
    const codes = Object.keys(responses);
    return {
      statuses: codes
        .filter((code) => /^2\d\d$/.test(code))
        .map(Number)
        .sort((a, b) => a - b),
      wildcard: codes.some((code) => /^2xx$/i.test(code)),
    };
  }
  return { statuses: [], wildcard: false };
}

/**
 * Return `headers` with a JSON `Content-Type` ensured, without overriding an
 * existing `Content-Type` (matched case-insensitively).
 *
 * k6 does not JSON-serialize object bodies — it form-encodes them — so the
 * emitter serializes JSON bodies to strings and declares the media type here
 * (corrected decision 4). An existing entry always wins: a header parameter
 * (`Content-Type`) or an auth header (SPEC-5 merges auth last, case-
 * insensitively) therefore keeps its value, consistent with the established
 * collision precedence where auth wins. When added, the header is appended
 * after the existing ones so the output stays deterministic.
 */
function withJsonContentType(headers: Record<string, string>): Record<string, string> {
  const hasContentType = Object.keys(headers).some(
    (name) => name.toLowerCase() === "content-type",
  );
  if (hasContentType) {
    return headers;
  }
  return { ...headers, "Content-Type": JSON_CONTENT_TYPE };
}

/** Build one emitted-operation record from its generated request data. */
function toEmittedOperation(
  request: GeneratedRequestData,
  baseUrl: string,
  specs: readonly EmitSpec[],
): EmittedOperation {
  const { statuses, wildcard } = documented2xx(
    specs,
    request.method,
    request.path,
  );
  // A wildcard response accepts any 2xx, so no `200` default is applied; only a
  // spec documenting no 2xx at all falls back to `200` (A5).
  const expectedStatus =
    statuses.length > 0
      ? statuses
      : wildcard
        ? []
        : [DEFAULT_EXPECTED_STATUS];

  // SPEC-4 only ever produces a body for an `application/json` media type, so a
  // present body is by construction a JSON body (corrected decision 4).
  const hasBody = request.body !== undefined;
  const baseHeaders = request.headers ?? {};

  const operation: EmittedOperation = {
    method: request.method,
    route: request.path,
    url: buildRequestUrl(baseUrl, request),
    pathParams: request.pathParams ?? {},
    query: request.query ?? {},
    headers: hasBody ? withJsonContentType(baseHeaders) : baseHeaders,
    expectedStatus,
    acceptAny2xx: wildcard,
  };
  if (hasBody) {
    operation.body = JSON.stringify(request.body);
  }
  return operation;
}

/** Render a `{ vus, duration }` options object from the resolved load profile. */
function renderOptions(load: LoadConfig): string {
  return JSON.stringify({ vus: load.vus, duration: load.duration });
}

/**
 * Render the dependency-free k6 script text.
 *
 * The script imports only k6 built-ins, loads the companion data with
 * `open()` + `JSON.parse` at init, exports `options` from the resolved load
 * profile, and exports a single `default` function that loops over
 * `DATA.operations` (one `http.request` + status `check` per operation), then
 * sleeps `1s` (A3–A5).
 */
function renderScript(load: LoadConfig, data: EmittedData): string {
  return `// Generated by SpecWeaver. Dependency-free k6 script: k6 built-in modules only.
import http from 'k6/http';
import { check, sleep } from 'k6';

const DATA = JSON.parse(open('${DATA_FILE_NAME}'));

export const options = ${renderOptions(load)};

// A wildcard response (e.g. 2XX) accepts any 2xx status; otherwise the exact
// documented status codes are matched (A5 / post-review decision 3).
function statusMatches(status, operation) {
  if (operation.acceptAny2xx) {
    return status >= 200 && status < 300;
  }
  return operation.expectedStatus.indexOf(status) !== -1;
}

function statusLabel(operation) {
  return operation.acceptAny2xx ? '2XX' : operation.expectedStatus.join('/');
}

export default function () {
  for (const operation of DATA.operations) {
    const params = { headers: operation.headers };
    const body = operation.body === undefined ? null : operation.body;
    const response = http.request(operation.method, operation.url, body, params);
    const checkName = 'status is ' + statusLabel(operation);
    check(response, {
      [checkName]: (r) => statusMatches(r.status, operation),
    });
  }
  sleep(1);
}
`;
}

/**
 * Emit the k6 script text plus its companion data object.
 *
 * Deterministic: the same config, specs, and request data produce byte-identical
 * output (no timestamps, randomness, or unstable key ordering).
 */
export function emitScript(input: EmitInput): EmittedScript {
  const baseUrl = resolveBaseUrl(input);
  const specs = input.specs ?? [];
  const operations = input.requests.map((request) =>
    toEmittedOperation(request, baseUrl, specs),
  );
  const data: EmittedData = { baseUrl, operations };
  return { script: renderScript(input.config.load, data), data };
}

/**
 * Emit and write both artifacts once: the script to {@link SCRIPT_FILE_NAME}
 * and the data to {@link DATA_FILE_NAME} inside a directory.
 *
 * Unless `options.directory` is supplied, a unique per-run directory is created
 * under `os.tmpdir()` (SPEC-11). File contents are unchanged by this: only the
 * location is random, and the script's `open()` reference is the sibling data
 * file name.
 *
 * SPEC-7 owns cleanup (delete-after-run) and the keep-for-inspection opt-out;
 * this function only writes the files and records their paths/directory.
 */
export function writeEmittedScript(
  input: EmitInput,
  options: WriteOptions = {},
): WrittenScript {
  const { script, data } = emitScript(input);
  const directory =
    options.directory ??
    mkdtempSync(join(tmpdir(), TEMP_DIRECTORY_PREFIX));
  const scriptPath = join(directory, SCRIPT_FILE_NAME);
  const dataPath = join(directory, DATA_FILE_NAME);

  writeFileSync(scriptPath, script, {
    encoding: "utf8",
    mode: GENERATED_FILE_MODE,
  });
  writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: GENERATED_FILE_MODE,
  });

  return { script, data, directory, scriptPath, dataPath };
}
