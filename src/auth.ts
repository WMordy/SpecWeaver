/**
 * Static auth header injection (SPEC-5).
 *
 * This stage is the single producer of the auth headers that reach the wire. It
 * sits between config loading (SPEC-2), spec loading (SPEC-3), and request-data
 * generation (SPEC-4), and feeds the k6 script emitter (SPEC-6).
 *
 * Given the validated `Config.auth` and the per-operation request data produced
 * by SPEC-4, it produces concrete auth headers and merges them into every
 * selected operation's generated request data. The emitter (SPEC-6, assumption
 * A6) then serializes those already-injected headers unchanged.
 *
 * Supported auth shapes (all sourced from the typed {@link AuthConfig} — no YAML
 * is re-parsed here):
 * - **Bearer token** (`auth.token`) -> `Authorization: Bearer <token>`.
 * - **API key** -> applied as an HTTP header (A2; query-parameter keys are not
 *   supported in v1).
 * - **Arbitrary static headers** (`auth.headers`) -> applied verbatim.
 *
 * There is deliberately **no dedicated `auth.apiKey` field**: an API key is just
 * a static header expressed through the generic `auth.headers` map, where the
 * map *key* is the configurable header name and the map *value* is the secret —
 * e.g. `auth.headers: { "X-Api-Key": "..." }`. Adding a separate `auth.apiKey`
 * shape is out of scope for v1 (product-owner decision, 2026-10-18).
 *
 * Locked decisions implemented here:
 * - **A1/A4 — global:** the single configured `auth` is applied to *every*
 *   operation passed in, regardless of the spec's `security`; no
 *   `securitySchemes` -> header mapping is performed.
 * - **A3/A6 — collision precedence:** when an auth header shares a name with a
 *   generated (SPEC-4) header, the auth header wins, compared
 *   case-insensitively. *Within* the auth material itself the bearer token wins
 *   over any `authorization` entry in `auth.headers`, also case-insensitively
 *   (product-owner decision, 2026-10-18).
 * - **A5 — redaction:** resolved secret values are fully masked (`***`) on every
 *   diagnostic path; only header *names* may be shown. Raw `${ENV_VAR}`-bearing
 *   config values are never emitted either.
 *
 * ## Environment interpolation (intentional double resolution)
 *
 * `${ENV_VAR}` references are resolved from the process environment *at injection
 * time*. SPEC-2 already interpolates the whole config at load time, and this
 * stage **intentionally re-resolves** whatever survives. This late resolution is
 * a deliberate, accepted trade-off (product-owner decision, 2026-10-18):
 * - a variable that was unset when the config was parsed but is set by injection
 *   time now takes effect;
 * - conversely, a value that SPEC-2 resolved *into* a literal `${...}` sequence
 *   would be re-processed here (double interpolation). This is accepted as-is;
 *   there is no escaping mechanism in v1.
 *
 * An unresolved reference emits a non-fatal warning — it never throws and never
 * fails validation. SPEC-8 owns its destination (stderr, prefixed `warning:`).
 */
import type { AuthConfig, Config } from "./config.js";
import type { GeneratedRequestData } from "./request-data.js";

/** Mask shown in place of every secret value on diagnostic paths (A5). */
export const REDACTED = "***";

/** Error thrown when `auth` is malformed (defensive; config validation is SPEC-2's job). */
export class AuthError extends Error {
  /** Every individual problem detected. */
  readonly errors: string[];

  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = "AuthError";
    this.errors = errors.length > 0 ? errors : [message];
  }
}

/** The concrete auth headers for one configured credential, plus warnings. */
export interface ResolvedAuthHeaders {
  /** Header name -> value, in deterministic insertion order. */
  headers: Record<string, string>;
  /**
   * Non-fatal warnings (unresolved `${ENV_VAR}` references). Never contains a
   * secret value; header names and variable names may appear.
   */
  warnings: string[];
}

/** The result of injecting auth into a list of operations. */
export interface AuthInjectionResult {
  /** The request data, each carrying the merged auth headers. */
  requests: GeneratedRequestData[];
  /** Non-fatal warnings collected while resolving the auth headers. */
  warnings: string[];
}

/** `${VAR}` reference; variable names are POSIX-ish identifiers (matches SPEC-2). */
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolve `${ENV_VAR}` references from the environment. Unresolved references
 * are left intact and recorded as warnings (never errors), matching SPEC-2. The
 * warning names only the variable and the offending field — never the value.
 */
function interpolate(
  value: string,
  at: string,
  warnings: string[],
  env: NodeJS.ProcessEnv,
): string {
  return value.replace(ENV_PATTERN, (match, name: string): string => {
    const resolved = env[name];
    if (resolved === undefined) {
      warnings.push(
        `unresolved environment variable "${name}" referenced in \`${at}\``,
      );
      return match;
    }
    return resolved;
  });
}

/**
 * Insert or replace a header by name, case-insensitively (A6), preserving the
 * position of an existing entry. Builds an ordered list so output is
 * deterministic.
 */
function upsertHeader(
  entries: Array<[string, string]>,
  name: string,
  value: string,
): void {
  const lower = name.toLowerCase();
  const index = entries.findIndex(([existing]) => existing.toLowerCase() === lower);
  if (index === -1) {
    entries.push([name, value]);
  } else {
    entries[index] = [name, value];
  }
}

/**
 * Resolve a validated {@link AuthConfig} (i.e. `Config.auth`) into concrete
 * request headers.
 *
 * Precedence within the auth material: a bearer `token` wins over any
 * `authorization` entry in `auth.headers` (case-insensitive), so the
 * `Authorization` header always reflects the token when one is configured.
 *
 * @param auth The validated auth value, or `undefined` when no auth is
 *   configured (produces no headers).
 * @param env Environment to read `${ENV_VAR}` references from. Defaults to
 *   `process.env`; injectable for tests.
 * @throws {AuthError} when `auth` is malformed (wrong value types). The message
 *   names the offending field and never includes a secret value (A5).
 */
export function resolveAuthHeaders(
  auth: AuthConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAuthHeaders {
  if (auth === undefined) {
    return { headers: {}, warnings: [] };
  }
  if (!isPlainObject(auth)) {
    throw new AuthError("`auth` must be a mapping with optional `token` and `headers`");
  }

  const warnings: string[] = [];
  const entries: Array<[string, string]> = [];

  const hasToken = "token" in auth && auth.token !== undefined;
  if (hasToken) {
    if (typeof auth.token !== "string") {
      throw new AuthError("`auth.token` must be a string");
    }
    // SPEC-2 resolves at config load; re-resolving here is intentional (late-set
    // env vars apply, and a literal `${...}` in a resolved value is re-processed).
    const token = interpolate(auth.token, "auth.token", warnings, env);
    upsertHeader(entries, "Authorization", `Bearer ${token}`);
  }

  if ("headers" in auth && auth.headers !== undefined) {
    const headers = auth.headers;
    if (!isPlainObject(headers)) {
      throw new AuthError(
        "`auth.headers` must be a mapping of header names to string values",
      );
    }
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value !== "string") {
        // The value is malformed; never render it (it may be a secret).
        throw new AuthError(`\`auth.headers.${name}\` must be a string`);
      }
      // The bearer token wins over any `authorization` static header
      // (case-insensitive); skip the colliding entry entirely.
      if (hasToken && name.toLowerCase() === "authorization") {
        continue;
      }
      // Re-resolve at injection time — see the module-level note on intentional
      // double interpolation.
      const resolved = interpolate(value, `auth.headers.${name}`, warnings, env);
      upsertHeader(entries, name, resolved);
    }
  }

  const resolvedHeaders: Record<string, string> = {};
  for (const [name, value] of entries) {
    resolvedHeaders[name] = value;
  }
  return { headers: resolvedHeaders, warnings };
}

/**
 * Merge auth headers into a base header map, case-insensitively (A3/A6).
 *
 * Any base header whose name matches an auth header (ignoring case) is dropped;
 * the auth header wins with its own name and value. Base headers keep their
 * order, then auth headers are appended in their resolved order — so the result
 * is deterministic for a given input.
 */
export function mergeAuthHeaders(
  base: Record<string, string>,
  auth: Record<string, string>,
): Record<string, string> {
  const authNames = new Set(Object.keys(auth).map((name) => name.toLowerCase()));
  const merged: Record<string, string> = {};

  for (const [name, value] of Object.entries(base)) {
    if (authNames.has(name.toLowerCase())) {
      continue;
    }
    merged[name] = value;
  }
  for (const [name, value] of Object.entries(auth)) {
    merged[name] = value;
  }
  return merged;
}

/**
 * Return a copy of `request` with `authHeaders` merged into its headers. The
 * input is not mutated, and its method/path/params/body are preserved.
 */
export function withAuthHeaders(
  request: GeneratedRequestData,
  authHeaders: Record<string, string>,
): GeneratedRequestData {
  return {
    ...request,
    headers: mergeAuthHeaders(request.headers ?? {}, authHeaders),
  };
}

/**
 * Read `config.auth`, resolve it, and inject the resulting headers into every
 * operation's generated request data.
 *
 * The credential is global (A1): it is applied to every request in `requests`,
 * irrespective of each operation's `security` (A4). When no auth is configured,
 * the requests are returned unchanged. The caller owns how `warnings` are
 * surfaced (SPEC-8).
 */
export function injectAuth(
  config: Pick<Config, "auth"> | undefined,
  requests: GeneratedRequestData[],
  env: NodeJS.ProcessEnv = process.env,
): AuthInjectionResult {
  const { headers, warnings } = resolveAuthHeaders(config?.auth, env);
  if (Object.keys(headers).length === 0) {
    return { requests, warnings };
  }
  return {
    requests: requests.map((request) => withAuthHeaders(request, headers)),
    warnings,
  };
}

/**
 * Mask every header value for safe logging (A5). Header *names* are preserved;
 * resolved values are replaced with {@link REDACTED}. Never call a logger with
 * raw auth headers.
 */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    redacted[name] = REDACTED;
  }
  return redacted;
}
