/**
 * SpecWeaver config loading and validation (SPEC-2).
 *
 * Reads the YAML file named by `--config <path>`, validates it against the
 * SpecWeaver schema, applies documented defaults, merges CLI overrides, and
 * resolves `${ENV_VAR}` references in auth fields. The single validated
 * {@link Config} object it produces is consumed by every downstream ticket
 * (SPEC-3 spec loading, SPEC-4 request-data generation, SPEC-5 auth, SPEC-6
 * script emission, SPEC-7/8 execution and results). `payloads` entries carry a
 * whole-value JSON `body` replacement for the matching operation.
 *
 * Config input is YAML only. JSON/TOML input and config-file discovery are
 * intentionally not supported. `specs` entries are local filesystem paths only:
 * remote `http(s)://` URLs are not fetched.
 *
 * `specs` is required to execute: because `operations` is always required
 * (SPEC-2), a config that omits `specs` can never run anything. This
 * deliberately reverses SPEC-2's "specs is optional" decision (SPEC-14). The
 * parser keeps `specs` optional so the CLI can emit its dedicated no-run error
 * (and SPEC-13 payload warnings) instead of a generic schema error; the CLI
 * exits `2` before running k6 or writing results.
 *
 * Schema:
 *
 * ```yaml
 * specs:                      # REQUIRED to execute, local path(s) or list (no URLs)
 *   - ./openapi.yaml
 * operations:                 # REQUIRED: non-empty list of { method, path }, or the literal `all`
 *   - method: GET
 *     path: /pets
 * # operations: all          # selects every operation in the loaded catalog
 * baseUrl: https://api.example.com  # OPTIONAL, request base URL (overrides the spec's first usable servers[].url; consumed by SPEC-6)
 * auth:                       # OPTIONAL, static token/headers (env-referenceable)
 *   token: "${API_TOKEN}"
 *   headers:
 *     X-Api-Key: "${API_KEY}"
 * payloads:                   # OPTIONAL, per-operation JSON body overrides
 *   - method: POST
 *     path: /pets
 *     body: { name: "Fido" }
 * output: results.json        # OPTIONAL, results file path (default owned by SPEC-8: specweaver-results.json in the cwd)
 * load:                       # OPTIONAL, default vus/duration
 *   vus: 10
 *   duration: 30s
 * ```
 */
import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

/** A single opt-in operation. `method` + `path` jointly key the operation. */
export interface OperationConfig {
  /** Upper-cased HTTP method, e.g. `GET`. */
  method: string;
  /** OpenAPI path, e.g. `/pets`. */
  path: string;
}

/**
 * The `operations` selector from the config.
 *
 * Either an explicit non-empty list of {@link OperationConfig} entries, or the
 * exact literal `"all"`. `"all"` selects every operation in the loaded spec
 * catalog; the CLI expands it into concrete operations at run time (SPEC-23),
 * so the config layer only validates and exposes the selector here.
 */
export type OperationsSelector = OperationConfig[] | "all";

/** The load profile applied when the operations run. */
export interface LoadConfig {
  /** Number of virtual users. */
  vus: number;
  /** k6-style duration, e.g. `30s` or `1m30s`. */
  duration: string;
}

/**
 * Static auth values. `${ENV_VAR}` references are interpolated at load time.
 *
 * There is no dedicated `apiKey` field: an API key is expressed as a static
 * header in {@link AuthConfig.headers}, whose key is the configurable header
 * name (e.g. `headers: { "X-Api-Key": "..." }`). A `token` produces
 * `Authorization: Bearer <token>` and, when set, wins over an `authorization`
 * entry in `headers` (case-insensitive). See `auth.ts` (SPEC-5).
 */
export interface AuthConfig {
  /** Bearer/API token value. */
  token?: string;
  /** Static request headers. */
  headers?: Record<string, string>;
}

/**
 * Per-operation payload override, keyed by `method` + `path`.
 *
 * `body` is the complete replacement for the generated JSON request body of the
 * matching operation (whole-value replacement, not a deep merge). The method is
 * normalized to uppercase so matching is case-insensitive, exactly like
 * operation selection.
 */
export interface PayloadOverride {
  /** Upper-cased HTTP method, e.g. `POST`. */
  method: string;
  /** OpenAPI path template, e.g. `/pets`. */
  path: string;
  /** The replacement JSON request body (any JSON value). */
  body: unknown;
}

/**
 * Fully validated, defaulted config handed to downstream tickets.
 *
 * This is the single typed contract for the whole CLI: it contains no `any`.
 */
export interface Config {
  /**
   * Local OpenAPI source path(s) (JSON or YAML) to load; URLs are not fetched.
   * Required to execute: `operations` is always present (a non-empty list or
   * the literal `"all"`), and without a spec there is no catalog to select from,
   * so the CLI exits `2` before running k6 or writing results (SPEC-14).
   * Parsing still permits omission so that no-run error can be reported at the
   * CLI boundary, alongside any SPEC-13 payload warnings.
   */
  specs?: string[];
  /**
   * Opt-in operations: either an explicit non-empty list or the literal `"all"`.
   * The list form is never empty for a validated config. `"all"` selects every
   * operation in the loaded catalog, expanded by the CLI (SPEC-23).
   */
  operations: OperationsSelector;
  /**
   * Optional request base URL. When present it overrides the spec's first
   * `servers[].url` as the base for generated requests (consumed by SPEC-6);
   * when absent the spec's `servers[].url` is used.
   */
  baseUrl?: string;
  /** Static auth, with `${ENV_VAR}` references already resolved. */
  auth?: AuthConfig;
  /**
   * Per-operation JSON body overrides, applied before auth injection. Each
   * entry replaces (never deep-merges) the generated body of the operation whose
   * normalized `method` + `path` matches.
   */
  payloads?: PayloadOverride[];
  /**
   * Results file path — names ONLY the SPEC-8 results JSON (never the generated
   * script/data). The concrete default, `specweaver-results.json` in the current
   * working directory, is owned by SPEC-8 (A1).
   */
  output?: string;
  /** Resolved load profile (defaults applied). */
  load: LoadConfig;
}

/** CLI values that take precedence over the corresponding YAML values. */
export interface ConfigOverrides {
  /** `--vus`, overrides `load.vus`. */
  vus?: number;
  /** `--duration`, overrides `load.duration`. */
  duration?: string;
  /** `--out`, overrides `output`. */
  out?: string;
}

/** A successful load: the validated config plus any non-fatal warnings. */
export interface ConfigResult {
  config: Config;
  /**
   * Non-fatal warnings raised while loading (currently unresolved `${ENV_VAR}`
   * references). SPEC-8 owns where these are surfaced: stderr, prefixed
   * `warning:`; they never fail validation or a successful exit code.
   */
  warnings: string[];
}

/**
 * Conservative default load profile applied when `load` (or one of its fields)
 * is omitted. Kept low so an accidental run does not generate heavy load.
 */
export const DEFAULT_LOAD: LoadConfig = { vus: 1, duration: "30s" };

/** HTTP methods accepted in `operations` (case-insensitive on input). */
export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);

/** k6-style duration: one or more `<number><unit>` segments, unit in ms|s|m|h. */
const DURATION_PATTERN = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/;

/** `${VAR}` reference; variable names are POSIX-ish identifiers. */
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const ROOT_KEYS = new Set([
  "specs",
  "operations",
  "baseUrl",
  "auth",
  "payloads",
  "output",
  "load",
]);
const LOAD_KEYS = new Set(["vus", "duration"]);
const AUTH_KEYS = new Set(["token", "headers"]);
/**
 * Fields accepted in a `payloads` entry. v1 supports only a whole-value JSON
 * body replacement; anything else is an explicit error rather than silently
 * ignored (SPEC-13).
 */
const PAYLOAD_KEYS = new Set(["method", "path", "body"]);

/** Error thrown when the config cannot be read, parsed, or validated. */
export class ConfigError extends Error {
  /** Every individual problem detected (aggregated, not just the first). */
  readonly errors: string[];

  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.errors = errors.length > 0 ? errors : [message];
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatErrors(sourceName: string, errors: string[]): string {
  const list = errors.map((error) => `  - ${error}`).join("\n");
  return `Invalid config in "${sourceName}":\n${list}`;
}

/**
 * Resolve `${ENV_VAR}` references from the process environment. Unresolved
 * references are left intact and recorded as warnings (never errors).
 */
function interpolate(value: string, at: string, warnings: string[]): string {
  return value.replace(ENV_PATTERN, (match, name: string): string => {
    const resolved = process.env[name];
    if (resolved === undefined) {
      warnings.push(
        `unresolved environment variable "${name}" referenced in \`${at}\``,
      );
      return match;
    }
    return resolved;
  });
}

interface PartialLoad {
  vus?: number;
  duration?: string;
}

function validateOperations(
  value: unknown,
  errors: string[],
): OperationsSelector {
  if (value === undefined || value === null) {
    errors.push("`operations` is required and must list at least one `{ method, path }` entry");
    return [];
  }
  // The selector is exact and case-sensitive: only the YAML scalar `all`.
  if (value === "all") {
    return "all";
  }
  if (!Array.isArray(value)) {
    errors.push(
      "`operations` must be a non-empty list of `{ method, path }` entries or the literal `all`",
    );
    return [];
  }
  if (value.length === 0) {
    errors.push("`operations` must list at least one operation");
    return [];
  }

  const operations: OperationConfig[] = [];
  const seen = new Set<string>();

  value.forEach((entry, index) => {
    const at = `operations[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`\`${at}\` must be a mapping with \`method\` and \`path\``);
      return;
    }

    for (const key of Object.keys(entry)) {
      if (key !== "method" && key !== "path") {
        errors.push(`unknown field \`${at}.${key}\``);
      }
    }

    const rawMethod = entry.method;
    const rawPath = entry.path;
    let valid = true;
    let method = "";
    let path = "";

    if (typeof rawMethod !== "string" || rawMethod.trim() === "") {
      errors.push(`\`${at}.method\` must be a non-empty string`);
      valid = false;
    } else if (!HTTP_METHOD_SET.has(rawMethod.toUpperCase())) {
      errors.push(
        `\`${at}.method\` must be one of ${HTTP_METHODS.join(", ")} (received "${rawMethod}")`,
      );
      valid = false;
    } else {
      method = rawMethod.toUpperCase();
    }

    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      errors.push(`\`${at}.path\` must be a non-empty string`);
      valid = false;
    } else {
      path = rawPath;
    }

    if (!valid) {
      return;
    }

    const id = `${method} ${path}`;
    if (seen.has(id)) {
      errors.push(`duplicate operation \`${id}\``);
      return;
    }
    seen.add(id);
    operations.push({ method, path });
  });

  return operations;
}

function validateSpecs(value: unknown, errors: string[]): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const isList = Array.isArray(value);
  const entries: unknown[] = isList ? value : [value];
  const specs: string[] = [];

  entries.forEach((entry, index) => {
    const at = isList ? `specs[${index}]` : "specs";
    if (typeof entry !== "string" || entry.trim() === "") {
      errors.push(`\`${at}\` must be a non-empty string`);
      return;
    }
    specs.push(entry);
  });

  return specs.length > 0 ? specs : undefined;
}

function validateLoad(value: unknown, errors: string[]): PartialLoad {
  const load: PartialLoad = {};
  if (value === undefined) {
    return load;
  }
  if (!isPlainObject(value)) {
    errors.push("`load` must be a mapping with optional `vus` and `duration`");
    return load;
  }

  for (const key of Object.keys(value)) {
    if (!LOAD_KEYS.has(key)) {
      errors.push(`unknown field \`load.${key}\``);
    }
  }

  if ("vus" in value) {
    const vus = value.vus;
    if (typeof vus !== "number" || !Number.isInteger(vus) || vus <= 0) {
      errors.push("`load.vus` must be a positive integer");
    } else {
      load.vus = vus;
    }
  }

  if ("duration" in value) {
    const duration = value.duration;
    if (typeof duration !== "string" || !DURATION_PATTERN.test(duration)) {
      errors.push('`load.duration` must be a k6-style duration such as "30s"');
    } else {
      load.duration = duration;
    }
  }

  return load;
}

function validateAuth(
  value: unknown,
  errors: string[],
  warnings: string[],
): AuthConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    errors.push("`auth` must be a mapping with optional `token` and `headers`");
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!AUTH_KEYS.has(key)) {
      errors.push(`unknown field \`auth.${key}\``);
    }
  }

  const auth: AuthConfig = {};

  if ("token" in value && value.token !== undefined) {
    if (typeof value.token !== "string") {
      errors.push("`auth.token` must be a string");
    } else {
      auth.token = interpolate(value.token, "auth.token", warnings);
    }
  }

  if ("headers" in value && value.headers !== undefined) {
    const headers = value.headers;
    if (!isPlainObject(headers)) {
      errors.push("`auth.headers` must be a mapping of header names to string values");
    } else {
      const resolved: Record<string, string> = {};
      for (const [name, headerValue] of Object.entries(headers)) {
        if (typeof headerValue !== "string") {
          errors.push(`\`auth.headers.${name}\` must be a string`);
        } else {
          resolved[name] = interpolate(headerValue, `auth.headers.${name}`, warnings);
        }
      }
      auth.headers = resolved;
    }
  }

  return auth;
}

function validatePayloads(value: unknown, errors: string[]): PayloadOverride[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    errors.push("`payloads` must be a list of per-operation overrides");
    return undefined;
  }

  const payloads: PayloadOverride[] = [];
  const seen = new Set<string>();

  value.forEach((entry, index) => {
    const at = `payloads[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`\`${at}\` must be a mapping with \`method\`, \`path\`, and \`body\``);
      return;
    }

    for (const key of Object.keys(entry)) {
      if (!PAYLOAD_KEYS.has(key)) {
        errors.push(
          `unknown field \`${at}.${key}\`; payload overrides support only \`method\`, \`path\`, and \`body\``,
        );
      }
    }
    if (!("body" in entry)) {
      errors.push(
        `\`${at}\` must define a \`body\` (payload overrides support only \`method\`, \`path\`, and \`body\`)`,
      );
    }

    const rawMethod = entry.method;
    const rawPath = entry.path;
    let valid = true;
    let method = "";
    let path = "";
    if (typeof rawMethod !== "string" || rawMethod.trim() === "") {
      errors.push(`\`${at}.method\` must be a non-empty string`);
      valid = false;
    } else if (!HTTP_METHOD_SET.has(rawMethod.toUpperCase())) {
      errors.push(
        `\`${at}.method\` must be one of ${HTTP_METHODS.join(", ")} (received "${rawMethod}")`,
      );
      valid = false;
    } else {
      method = rawMethod.toUpperCase();
    }
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      errors.push(`\`${at}.path\` must be a non-empty string`);
      valid = false;
    } else {
      path = rawPath;
    }
    if (!valid) {
      return;
    }

    const id = `${method} ${path}`;
    if (seen.has(id)) {
      errors.push(`duplicate payload override \`${id}\``);
      return;
    }
    seen.add(id);
    payloads.push({ method, path, body: entry.body });
  });

  return payloads;
}

function validateBaseUrl(value: unknown, errors: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    errors.push("`baseUrl` must be a non-empty string");
    return undefined;
  }
  return value;
}

function validateOutput(value: unknown, errors: string[]): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    errors.push("`output` must be a non-empty file path string");
    return undefined;
  }
  return value;
}

/**
 * Parse and validate YAML config text, returning a typed {@link Config}.
 *
 * @param source Raw YAML text.
 * @param overrides CLI values (`--vus`, `--duration`, `--out`) that take
 *   precedence over YAML values. Assumed already validated by `parseArgs`.
 * @param sourceName Name used in error messages (a file path, by default).
 * @throws {ConfigError} on invalid YAML or any schema violation. All schema
 *   violations are aggregated into a single error.
 */
export function parseConfig(
  source: string,
  overrides: ConfigOverrides = {},
  sourceName = "<config>",
): ConfigResult {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Invalid YAML in "${sourceName}": ${reason}`);
  }

  const warnings: string[] = [];

  if (!isPlainObject(document)) {
    throw new ConfigError(
      formatErrors(sourceName, [
        "config must be a YAML mapping with an `operations` list",
      ]),
    );
  }

  const errors: string[] = [];

  for (const key of Object.keys(document)) {
    if (!ROOT_KEYS.has(key)) {
      errors.push(`unknown field \`${key}\``);
    }
  }

  const operations = validateOperations(document.operations, errors);
  const specs = validateSpecs(document.specs, errors);
  const baseUrl = validateBaseUrl(document.baseUrl, errors);
  const rawLoad = validateLoad(document.load, errors);
  const auth = validateAuth(document.auth, errors, warnings);
  const payloads = validatePayloads(document.payloads, errors);
  const output = validateOutput(document.output, errors);

  if (errors.length > 0) {
    throw new ConfigError(formatErrors(sourceName, errors), errors);
  }

  const config: Config = {
    operations,
    load: {
      vus: overrides.vus ?? rawLoad.vus ?? DEFAULT_LOAD.vus,
      duration: overrides.duration ?? rawLoad.duration ?? DEFAULT_LOAD.duration,
    },
    output: overrides.out ?? output,
  };
  if (specs !== undefined) {
    config.specs = specs;
  }
  if (baseUrl !== undefined) {
    config.baseUrl = baseUrl;
  }
  if (auth !== undefined) {
    config.auth = auth;
  }
  if (payloads !== undefined) {
    config.payloads = payloads;
  }

  return { config, warnings };
}

/**
 * Read, parse, and validate the YAML config file at `path`.
 *
 * @throws {ConfigError} if the file cannot be read, or on any parse/validation
 *   failure.
 */
export function loadConfig(path: string, overrides: ConfigOverrides = {}): ConfigResult {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Cannot read config file "${path}": ${reason}`);
  }
  return parseConfig(source, overrides, path);
}
