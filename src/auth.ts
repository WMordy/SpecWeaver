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
 * - **Static headers** (`auth.headers`) -> applied verbatim.
 * - **`securitySchemes`-derived auth** (SPEC-39): `http`/`bearer` schemes use
 *   `auth.token`; `apiKey` schemes with `in: header` or `in: query` use the
 *   credential in `auth.apiKeys[<scheme name>]`. Unsupported or unconfigured
 *   schemes are warn-only.
 *
 * Locked decisions implemented here:
 * - **A1/A4 — global:** the single configured `auth` is applied to *every*
 *   operation passed in as the explicit layer. Each selected operation then
 *   resolves its own effective `security` against its document's
 *   `securitySchemes` (SPEC-39), adding only the derived wire values.
 * - **A3/A6 — collision precedence:** when an auth header shares a name with a
 *   generated (SPEC-4) header, the auth header wins, compared
 *   case-insensitively. *Within* the auth material itself the bearer token wins
 *   over any `authorization` entry in `auth.headers`, also case-insensitively
 *   (product-owner decision, 2026-10-18). Explicit `auth.token`/`auth.headers`
 *   also win over derived scheme values on the same wire target (SPEC-39).
 * - **A5 — redaction:** resolved secret values are fully masked (`***`) on every
 *   diagnostic path; only header *names* may be shown. Raw `${ENV_VAR}`-bearing
 *   config values are never emitted either. {@link resolveAuthSecrets} supplies
 *   the values the run stage scrubs from k6's live stream.
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
import type {
  OperationEntry,
  SecurityRequirement,
  SecuritySchemeObject,
} from "./spec.js";

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

/**
 * Per-operation resolved auth (SPEC-39): the explicit global credentials plus
 * any `securitySchemes`-derived wire values for that operation.
 *
 * `headers` and `query` are already de-duplicated and collision-free: explicit
 * `auth.token`/`auth.headers` win over derived values on the same wire target.
 * `warnings` are the security-scheme gaps for this operation (unsupported,
 * undefined, or unconfigured). Never contains a credential value.
 */
export interface ResolvedOperationAuth {
  /** Header name -> value, explicit values first. */
  headers: Record<string, string>;
  /** Query parameter name -> value derived from `apiKey` schemes. */
  query: Record<string, string>;
  /** Non-fatal scheme warnings for this operation. */
  warnings: string[];
}

/** Options for {@link injectAuth}. */
export interface InjectAuthOptions {
  /**
   * The selected operations in the same order as `requests` (SPEC-39). When
   * omitted, only the explicit global `auth` is applied.
   */
  operations?: readonly OperationEntry[];
  /** Environment for `${ENV_VAR}` resolution. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** `${VAR}` reference; variable names are POSIX-ish identifiers (matches SPEC-2). */
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read an own property, ignoring `Object.prototype` members. Scheme names come
 * from the spec, so `constructor`/`toString` must not resolve to inherited
 * functions.
 */
function ownValue<T>(
  record: Record<string, T> | undefined,
  key: string,
): T | undefined {
  return record !== undefined && Object.hasOwn(record, key)
    ? record[key]
    : undefined;
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
 * Every configured credential value, resolved from `${ENV_VAR}` references, for
 * scrubbing k6's live output (SPEC-39 AC1).
 *
 * Includes `auth.token`, every `auth.headers` value, and every
 * `auth.apiKeys` value. Empty values are omitted; unresolved references are
 * returned literally, because that literal text is what gets sent on the wire.
 * The returned strings are secrets: callers must only pass them to the stream
 * redactor, never print them.
 */
export function resolveAuthSecrets(
  auth: AuthConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (auth === undefined || !isPlainObject(auth)) {
    return [];
  }
  const secrets = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const resolved = interpolate(value, "auth", [], env);
    if (resolved !== "") {
      secrets.add(resolved);
    }
  };

  add(auth.token);
  if (isPlainObject(auth.headers)) {
    for (const value of Object.values(auth.headers)) {
      add(value);
    }
  }
  if (isPlainObject(auth.apiKeys)) {
    for (const value of Object.values(auth.apiKeys)) {
      add(value);
    }
  }
  return [...secrets];
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
 * Return a copy of `request` with the resolved auth merged in: headers
 * case-insensitively (explicit wins) and derived query parameters overriding a
 * generated parameter of the same name. The input is not mutated.
 */
export function withResolvedAuth(
  request: GeneratedRequestData,
  auth: ResolvedOperationAuth,
): GeneratedRequestData {
  const query = { ...(request.query ?? {}) };
  for (const [name, value] of Object.entries(auth.query)) {
    query[name] = value;
  }
  return {
    ...request,
    headers: mergeAuthHeaders(request.headers ?? {}, auth.headers),
    query,
  };
}

/** `METHOD path`, the operation identity used in auth diagnostics. */
function operationLabel(operation: OperationEntry): string {
  return `${operation.method} ${operation.path}`;
}

/** One requirement's scheme outcome: whether it is satisfiable, and how. */
interface SchemeResolution {
  /** True when the scheme's wire target is (or will be) satisfied. */
  satisfied: boolean;
  /** Derived header, when the scheme adds one. */
  header?: [string, string];
  /** Derived query parameter, when the scheme adds one. */
  query?: [string, string];
  /** Deterministic warn-only message when the scheme cannot be satisfied. */
  warning?: string;
}

function schemeWarning(
  operation: OperationEntry,
  message: string,
): SchemeResolution {
  return {
    satisfied: false,
    warning: `operation "${operationLabel(operation)}" ${message}`,
  };
}

/**
 * Resolve one security scheme against the configured credentials (SPEC-39).
 *
 * Supported mappings: `http`/`bearer` (satisfied by `auth.token` or an explicit
 * `Authorization` header), `apiKey` in a header (satisfied by an explicit
 * header of that name or `auth.apiKeys`), and `apiKey` in a query (satisfied by
 * `auth.apiKeys`). Everything else is warn-only.
 */
function resolveScheme(
  operation: OperationEntry,
  schemeName: string,
  scheme: SecuritySchemeObject | undefined,
  auth: AuthConfig | undefined,
  explicitHeaders: Readonly<Record<string, string>>,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): SchemeResolution {
  if (scheme === undefined) {
    return schemeWarning(
      operation,
      `security requirement references undefined scheme "${schemeName}"; no auth is sent for it.`,
    );
  }

  const hasExplicitHeader = (name: string): boolean =>
    Object.keys(explicitHeaders).some(
      (existing) => existing.toLowerCase() === name.toLowerCase(),
    );

  const type = typeof scheme.type === "string" ? scheme.type : "";
  if (type === "http") {
    const httpScheme =
      typeof scheme.scheme === "string" ? scheme.scheme.toLowerCase() : "";
    if (httpScheme !== "bearer") {
      return schemeWarning(
        operation,
        `security scheme "${schemeName}" uses unsupported http scheme "${httpScheme || "unknown"}"; only bearer is supported.`,
      );
    }
    if (hasExplicitHeader("Authorization")) {
      return { satisfied: true };
    }
    return schemeWarning(
      operation,
      `declares bearer scheme "${schemeName}" but no auth.token is configured; the request will be sent without that credential.`,
    );
  }

  if (type === "apiKey") {
    const location = typeof scheme.in === "string" ? scheme.in : "";
    const parameter =
      typeof scheme.name === "string" && scheme.name !== "" ? scheme.name : undefined;
    if (parameter === undefined) {
      return schemeWarning(
        operation,
        `apiKey scheme "${schemeName}" is missing its parameter name; no auth is sent for it.`,
      );
    }
    if (location === "header") {
      if (hasExplicitHeader(parameter)) {
        return { satisfied: true };
      }
    } else if (location !== "query") {
      return schemeWarning(
        operation,
        `apiKey scheme "${schemeName}" uses unsupported location "${location || "unknown"}"; only header and query api keys are supported.`,
      );
    }

    const credential = ownValue(auth?.apiKeys, schemeName);
    if (credential === undefined) {
      return schemeWarning(
        operation,
        `declares apiKey scheme "${schemeName}" but no auth.apiKeys.${schemeName} credential is configured; the request will be sent without that credential.`,
      );
    }
    const value = interpolate(
      credential,
      `auth.apiKeys.${schemeName}`,
      warnings,
      env,
    );
    return location === "header"
      ? { satisfied: true, header: [parameter, value] }
      : { satisfied: true, query: [parameter, value] };
  }

  return schemeWarning(
    operation,
    `security scheme "${schemeName}" uses unsupported type "${type || "unknown"}"; no auth is sent for it.`,
  );
}

/** The explicit global auth, resolved once and shared across operations. */
function resolveOperationAuthWithExplicit(
  operation: OperationEntry,
  auth: AuthConfig | undefined,
  explicit: ResolvedAuthHeaders,
  env: NodeJS.ProcessEnv,
): ResolvedOperationAuth {
  const headers: Record<string, string> = { ...explicit.headers };
  const existing = new Set(
    Object.keys(headers).map((name) => name.toLowerCase()),
  );
  const query: Record<string, string> = {};
  const warnings = [...explicit.warnings];

  if (operation.security.length > 0) {
    const schemeWarnings: string[] = [];
    const interpolationWarnings: string[] = [];
    const requirements: SecurityRequirement[] = operation.security;
    let satisfiedRequirement:
      | { headers: Array<[string, string]>; query: Array<[string, string]> }
      | undefined;

    for (const requirement of requirements) {
      const resolutions = Object.keys(requirement).map((schemeName) =>
        resolveScheme(
          operation,
          schemeName,
          ownValue(operation.securitySchemes, schemeName),
          auth,
          headers,
          env,
          interpolationWarnings,
        ),
      );
      for (const resolution of resolutions) {
        if (
          resolution.warning !== undefined &&
          !schemeWarnings.includes(resolution.warning)
        ) {
          schemeWarnings.push(resolution.warning);
        }
      }
      if (resolutions.every((resolution) => resolution.satisfied)) {
        satisfiedRequirement = {
          headers: resolutions.flatMap((resolution) =>
            resolution.header === undefined ? [] : [resolution.header],
          ),
          query: resolutions.flatMap((resolution) =>
            resolution.query === undefined ? [] : [resolution.query],
          ),
        };
        break;
      }
    }

    for (const warning of interpolationWarnings) {
      if (!warnings.includes(warning)) {
        warnings.push(warning);
      }
    }

    if (satisfiedRequirement === undefined) {
      // No alternative is satisfiable: report each scheme gap once, in
      // requirement then declaration order. Empty requirements (`{}`, meaning
      // "no auth required") never reach this branch.
      for (const warning of schemeWarnings) {
        if (!warnings.includes(warning)) {
          warnings.push(warning);
        }
      }
    } else {
      // Explicit config wins on the same wire target; derived values only fill
      // the gaps (e.g. an apiKey header/query).
      for (const [name, value] of satisfiedRequirement.headers) {
        const lower = name.toLowerCase();
        if (!existing.has(lower)) {
          headers[name] = value;
          existing.add(lower);
        }
      }
      for (const [name, value] of satisfiedRequirement.query) {
        query[name] = value;
      }
    }
  }

  return { headers, query, warnings };
}

/**
 * Resolve the effective auth for one operation (SPEC-39), the shared model
 * SPEC-40 extends.
 *
 * Starts from the explicit global `auth` (SPEC-5) and adds
 * `securitySchemes`-derived wire values only when the operation's effective
 * `security` references a supported, configured scheme. Explicit values win on
 * the same wire target. Empty/no security yields the explicit auth unchanged
 * and no warnings.
 *
 * @param operation The operation, including its document's `securitySchemes`.
 * @param auth The validated run auth, or `undefined`.
 * @param env Environment for `${ENV_VAR}` references; defaults to `process.env`.
 */
export function resolveOperationAuth(
  operation: OperationEntry,
  auth: AuthConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOperationAuth {
  return resolveOperationAuthWithExplicit(
    operation,
    auth,
    resolveAuthHeaders(auth, env),
    env,
  );
}

/**
 * Read `config.auth`, resolve it, and inject the resulting wire values into
 * every operation's generated request data.
 *
 * With `options.operations` (same order as `requests`), each request gets its
 * per-operation resolved auth (explicit + `securitySchemes`-derived, SPEC-39).
 * Without it, the explicit global credential is applied to every request
 * unchanged (the SPEC-5 contract). The caller owns how `warnings` are surfaced.
 */
export function injectAuth(
  config: Pick<Config, "auth"> | undefined,
  requests: GeneratedRequestData[],
  options: InjectAuthOptions = {},
): AuthInjectionResult {
  const env = options.env ?? process.env;
  const explicit = resolveAuthHeaders(config?.auth, env);
  const warnings: string[] = [];
  const seen = new Set<string>();

  const withAuth = requests.map((request, index) => {
    const operation = options.operations?.[index];
    const resolved =
      operation === undefined
        ? {
            headers: explicit.headers,
            query: {},
            warnings: explicit.warnings,
          }
        : resolveOperationAuthWithExplicit(
            operation,
            config?.auth,
            explicit,
            env,
          );
    for (const warning of resolved.warnings) {
      if (!seen.has(warning)) {
        seen.add(warning);
        warnings.push(warning);
      }
    }
    return withResolvedAuth(request, resolved);
  });

  return { requests: withAuth, warnings };
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
