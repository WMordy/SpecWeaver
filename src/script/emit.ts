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
 *   when present, otherwise the spec's first `servers[].url` (server-variable
 *   defaults substituted). The config field itself is owned by SPEC-2 / the
 *   follow-up SPEC-10; this module only *consumes* it (read defensively so it
 *   works the moment SPEC-10 exposes it on `Config`). **Deferred (2026-10-18):**
 *   the `baseUrl` config field and its validation remain owned entirely by
 *   SPEC-10 — SPEC-6 keeps this precedence logic exactly as-is and adds no
 *   validation for the field.
 * - **A2 / Output location:** the script is `specweaver.generated.js` and its
 *   data is `specweaver.data.json`, both written under `os.tmpdir()` with a
 *   `specweaver` prefix — the SAME location SPEC-7 reads and executes. `--out`
 *   and the config `output` field do **not** name these paths (they target only
 *   the SPEC-8 results JSON). **Temp-file posture (v1, 2026-10-18):** fixed
 *   file names are accepted (single-run semantics — one run at a time), and the
 *   data file may contain plaintext auth secrets in `$TMPDIR`; SPEC-7 owns
 *   delete-after-run and any hardened/unique-name opt-out.
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
 * 2. **`baseUrl` field deferral.** The precedence logic of A1 is unchanged;
 *    the config field and its validation are deferred to SPEC-10.
 * 3. **Wildcard `2XX`.** A documented `2XX`/`2xx` response is treated as *any*
 *    2xx status via a range check (`status >= 200 && status < 300`), rather
 *    than being normalized to exactly `200`. Literal codes are still matched
 *    exactly; a wildcard alongside literals simply accepts the whole 2xx range.
 * 4. **Content-Type (corrected 2026-10-18, supersedes the earlier decision).**
 *    k6 does not JSON-serialize object bodies: passing an object form-encodes it
 *    (`application/x-www-form-urlencoded`) and loses nested objects/arrays. The
 *    emitter now serializes JSON bodies to strings and emits an explicit
 *    `Content-Type: application/json` header, without overriding an existing one.
 * 5. **Temp-file posture (v1).** Fixed file names and plaintext secrets in
 *    `$TMPDIR` are accepted for v1; SPEC-7 owns delete-after-run.
 *
 * ## URL composition
 *
 * Path-parameter substitution and query-string serialization happen **here at
 * emission time** (Node), and the fully-composed URL is stored per operation in
 * the data file. This keeps the emitted k6 script minimal and its wiring
 * deterministic and unit-testable without requiring k6. {@link buildRequestUrl}
 * is exported for direct testing.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config, LoadConfig } from "../config.js";
import type { GeneratedRequestData, QueryValue } from "../request-data.js";
import type { JsonObject } from "../spec.js";

/** The default file name of the emitted k6 script (A2). */
export const SCRIPT_FILE_NAME = "specweaver.generated.js";

/** The default file name of the emitted companion data file (A2). */
export const DATA_FILE_NAME = "specweaver.data.json";

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
}

/** Inputs to {@link emitScript}. */
export interface EmitInput {
  /** The resolved config: supplies the load profile and the `baseUrl` override. */
  config: Config;
  /**
   * The SPEC-3 spec/catalog source(s), in order. Used for the fallback base URL
   * (the first `servers[].url`) and for each operation's documented 2xx
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
  /** Absolute path to the written k6 script. */
  scriptPath: string;
  /** Absolute path to the written companion data file. */
  dataPath: string;
}

/** Options for {@link writeEmittedScript}. */
export interface WriteOptions {
  /**
   * Directory to write into. Defaults to `os.tmpdir()`. The script's `open()`
   * reference is a sibling file name, so it resolves regardless of directory.
   */
  directory?: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the config `baseUrl` override, if present.
 *
 * `baseUrl` is owned by the SPEC-2 config schema (validation tracked by the
 * follow-up SPEC-10); it is read defensively here so emission works the moment
 * the field is exposed on `Config`, without this module validating it.
 */
function configBaseUrl(config: Config): string | undefined {
  const value = (config as { baseUrl?: unknown }).baseUrl;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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

/** The first `servers[].url` across the specs, with variable defaults applied. */
function firstServerUrl(specs: readonly EmitSpec[]): string | undefined {
  for (const spec of specs) {
    const servers = spec.document.servers;
    if (!Array.isArray(servers)) {
      continue;
    }
    for (const server of servers) {
      const url = serverUrl(server);
      if (url !== undefined) {
        return url;
      }
    }
  }
  return undefined;
}

/**
 * Resolve the request base URL (A1): the config `baseUrl` override wins, else
 * the spec's first `servers[].url` (server-variable defaults substituted), else
 * the empty string.
 */
export function resolveBaseUrl(input: Pick<EmitInput, "config" | "specs">): string {
  return configBaseUrl(input.config) ?? firstServerUrl(input.specs ?? []) ?? "";
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
 * and the data to {@link DATA_FILE_NAME}, under `os.tmpdir()` by default (A2).
 *
 * SPEC-7 owns cleanup (delete-after-run) and any keep-for-inspection opt-out;
 * this function only writes the files and records their paths.
 */
export function writeEmittedScript(
  input: EmitInput,
  options: WriteOptions = {},
): WrittenScript {
  const { script, data } = emitScript(input);
  const directory = options.directory ?? tmpdir();
  const scriptPath = join(directory, SCRIPT_FILE_NAME);
  const dataPath = join(directory, DATA_FILE_NAME);

  writeFileSync(scriptPath, script, "utf8");
  writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  return { script, data, scriptPath, dataPath };
}
