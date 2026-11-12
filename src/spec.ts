/**
 * OpenAPI 3.0/3.1 loading, `$ref` resolution, and operation cataloguing (SPEC-3).
 *
 * Every downstream stage — operation selection, payload generation, and k6
 * script emission — needs a single normalized, fully-resolved in-memory model
 * of the spec. This module is that layer:
 *
 * - {@link loadSpec} reads a **local** OpenAPI 3.0/3.1 document (JSON or YAML),
 *   verifies the version, resolves every `$ref` (internal and external file
 *   refs), and returns the resolved document plus a normalized operation
 *   catalog.
 * - {@link loadSpecs} does the same for several sources in order, and
 *   additionally fetches absolute `http(s)://` sources (SPEC-41).
 *
 * Remote fetching policy (SPEC-41) is explicit and documented in the README:
 * `fetch` with a 10 second `AbortController` timeout, a 5 MiB body cap, and a
 * manual redirect loop capped at 10 hops that rejects `https -> http`
 * downgrades. Documents are memoized per run. There is no DNS/IP-level SSRF
 * filtering; the operator owns the configured URLs. OpenAPI 2.0 / Swagger,
 * GraphQL, and non-JSON request bodies remain out of scope.
 */
import { readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve as resolvePath } from "node:path";

import { parse as parseYaml } from "yaml";

/** A JSON-like object (the shape of an OpenAPI node after parsing). */
export type JsonObject = Record<string, unknown>;

/** An operation parameter after `$ref` resolution. */
export interface ParameterObject {
  /** Parameter name, e.g. `limit`. */
  name: string;
  /** Location: `path`, `query`, `header`, or `cookie`. */
  in: string;
  /** Whether the parameter is required. */
  required?: boolean;
  /** The parameter's (resolved) JSON schema, when present. */
  schema?: unknown;
  [key: string]: unknown;
}

/** An operation request body after `$ref` resolution. */
export interface RequestBodyObject {
  /** Media type -> media-type object (with resolved schemas). */
  content?: Record<string, unknown>;
  /** Whether the request body is required. */
  required?: boolean;
  [key: string]: unknown;
}

/** An OpenAPI security requirement: scheme name -> scopes. */
export type SecurityRequirement = Record<string, string[]>;

/**
 * A resolved `components.securitySchemes` entry (SPEC-39).
 *
 * Only the fields auth derivation reads are typed; every OpenAPI field is
 * preserved on the object. `$ref`s are already resolved by {@link loadSpec}.
 */
export interface SecuritySchemeObject {
  /** `http`, `apiKey`, `oauth2`, `openIdConnect`, or `mutualTLS`. */
  type?: string;
  /** For `type: http`, the HTTP auth scheme, e.g. `bearer` or `basic`. */
  scheme?: string;
  /** For `type: apiKey`, where the key is carried: `header`, `query`, or `cookie`. */
  in?: string;
  /** For `type: apiKey`, the header/query/cookie parameter name. */
  name?: string;
  [key: string]: unknown;
}

/** A single normalized operation, as exposed to downstream tickets. */
export interface OperationEntry {
  /** Upper-cased HTTP method, e.g. `GET`. */
  method: string;
  /** OpenAPI path template, e.g. `/pets/{petId}`. */
  path: string;
  /** The spec's `operationId`, when present. */
  operationId?: string;
  /** The operation's declared `tags`, in document order, when any are present. */
  tags?: string[];
  /** Path- and operation-level parameters (operation wins on conflict). */
  parameters: ParameterObject[];
  /** The operation's request body, when present. */
  requestBody?: RequestBodyObject;
  /**
   * Effective security requirements: the operation's own `security` when
   * declared (an explicit empty list means "no security"), otherwise the
   * document-level `security`, otherwise an empty list.
   */
  security: SecurityRequirement[];
  /**
   * The originating document's resolved `components.securitySchemes`, when it
   * declares any (SPEC-39). Omitted for documents without schemes.
   */
  securitySchemes?: Record<string, SecuritySchemeObject>;
}

/** The result of loading one OpenAPI document (local file or remote URL). */
export interface LoadedSpec {
  /**
   * The source as requested for local files; remote URLs are normalized and
   * have any userinfo redacted, so a credentials-bearing URL is never printed.
   */
  source: string;
  /** The fully `$ref`-resolved document. */
  document: JsonObject;
  /** The normalized operation catalog derived from the resolved document. */
  operations: OperationEntry[];
}

/** Error thrown when a spec cannot be read, parsed, validated, or resolved. */
export class SpecError extends Error {
  /** Every individual problem detected. */
  readonly errors: string[];

  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = "SpecError";
    this.errors = errors.length > 0 ? errors : [message];
  }
}

/** OpenAPI versions SpecWeaver supports: 3.0.x and 3.1.x. */
const SUPPORTED_OPENAPI = /^3\.(?:0|1)\.\d+$/;

/**
 * OpenAPI path-item operation keys, in a fixed canonical order so the emitted
 * catalog is deterministic regardless of document key order.
 */
const OPERATION_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const;

/** Default per-fetch timeout for remote specs (SPEC-41). */
const FETCH_TIMEOUT_MS = 10_000;
/** Hard cap on a fetched spec body; larger responses fail the fetch (SPEC-41). */
const MAX_SPEC_BYTES = 5 * 1024 * 1024;
/** Maximum redirect hops followed for one spec fetch (SPEC-41). */
const MAX_REDIRECTS = 10;
/** `fetch` statuses that are redirects under `redirect: "manual"`. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Placeholder used when redacting credentials from a spec URL. */
const REDACTED = "***";

/** True for an absolute `http(s)://` spec source. */
function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Render a spec source for diagnostics. Local paths are returned unchanged;
 * remote URLs have any userinfo (username/password) masked, because a
 * credentials-bearing URL must never be printed (SPEC-41).
 */
function redactSpecSource(source: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    return source;
  }
  try {
    const url = new URL(source);
    if (url.username === "" && url.password === "") {
      return url.href;
    }
    url.username = REDACTED;
    url.password = "";
    return url.href;
  } catch {
    return REDACTED;
  }
}

/** The host (no credentials, no path) of a URL, for actionable errors. */
function specHost(url: string): string {
  try {
    return new URL(url).host || REDACTED;
  } catch {
    return REDACTED;
  }
}

/**
 * Validate a `specs` entry that looks like a URL. Returns the normalized URL
 * for an absolute `http(s)` URL with a host, or `undefined` for a local path.
 *
 * @throws {SpecError} for URL-shaped entries that cannot be fetched.
 */
function remoteUrlFor(source: string): string | undefined {
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(source);
  if (!looksLikeUrl) {
    return undefined;
  }
  if (!isRemoteUrl(source)) {
    const scheme = source.slice(0, source.indexOf("://") + 1);
    throw new SpecError(
      `Unsupported spec URL scheme "${scheme}": only http and https remote specs are supported`,
    );
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new SpecError(
      `Invalid spec URL "${redactSpecSource(source)}": expected an absolute http(s) URL with a host`,
    );
  }
  if (url.hostname === "") {
    throw new SpecError(
      `Invalid spec URL "${redactSpecSource(source)}": the URL must include a host`,
    );
  }
  return url.href;
}

/** Replace credential substrings that `fetch` may echo in its own message. */
function redactUrlSecrets(text: string, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return text;
  }
  const secrets = [parsed.username, parsed.password].filter(
    (secret) => secret !== "",
  );
  if (secrets.length === 0) {
    return text;
  }
  const safe = redactSpecSource(url);
  let redacted = text.split(url).join(safe);
  for (const secret of secrets) {
    const variants = new Set([secret]);
    try {
      variants.add(decodeURIComponent(secret));
    } catch {
      // Keep the raw form when it is not valid percent-encoding.
    }
    for (const variant of variants) {
      redacted = redacted.split(variant).join(REDACTED);
    }
  }
  return redacted;
}

/** Best-effort reason for a failed `fetch`, including Node's `cause` code. */
function fetchFailureReason(error: unknown, url: string): string {
  let message: string;
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    message =
      cause instanceof Error && cause.message !== ""
        ? cause.message
        : error.message;
  } else {
    message = String(error);
  }
  return redactUrlSecrets(message, url);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Parse spec text as JSON or YAML. The file extension selects the parser:
 * `.json` uses `JSON.parse` (for precise JSON errors); every other extension
 * uses the YAML parser, which also accepts JSON (YAML 1.2 is a superset).
 */
function parseSpecText(text: string, sourceName: string): unknown {
  if (extname(sourceName).toLowerCase() === ".json") {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new SpecError(`Invalid JSON in "${sourceName}": ${reason(error)}`);
    }
  }
  try {
    return parseYaml(text);
  } catch (error) {
    throw new SpecError(`Invalid YAML in "${sourceName}": ${reason(error)}`);
  }
}

/**
 * Reject cycles introduced by YAML anchors/aliases (e.g.
 * `node: &n { self: *n }`). The YAML parser materialises such references as a
 * cyclic JavaScript object graph, which is not representable as JSON and would
 * otherwise make `$ref` resolution recurse until the stack overflows. Cycles
 * created purely by `$ref` *strings* are a different, legitimate case and are
 * handled by {@link RefResolver}; they do not produce a containment cycle in
 * the parsed document, so this check does not flag them.
 *
 * @throws {SpecError} when a node contains itself through object/array nesting.
 */
function detectAliasCycles(
  node: unknown,
  sourceName: string,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): void {
  if (node === null || typeof node !== "object") {
    return;
  }
  if (ancestors.has(node)) {
    throw new SpecError(
      `"${sourceName}" contains a YAML anchor/alias cycle (a node references itself); such a document cannot be resolved`,
    );
  }
  ancestors.add(node);
  const children: unknown[] = Array.isArray(node) ? node : Object.values(node);
  for (const child of children) {
    detectAliasCycles(child, sourceName, ancestors);
  }
  ancestors.delete(node);
}

/**
 * Read and parse a spec file from disk.
 *
 * Alias-cycle detection runs here (rather than only on the root document) so
 * that externally referenced files are guarded too.
 */
function readSpecFile(absolute: string): unknown {
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    throw new SpecError(`Cannot read spec file "${absolute}": ${reason(error)}`);
  }
  const parsed = parseSpecText(text, absolute);
  detectAliasCycles(parsed, absolute);
  return parsed;
}

/**
 * Read a spec body, enforcing the 5 MiB cap while streaming so an oversized
 * response is never buffered in full (SPEC-41).
 */
async function readCappedBody(response: Response, host: string): Promise<string> {
  const body = response.body;
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_SPEC_BYTES) {
      await reader.cancel().catch(() => {});
      throw new SpecError(
        `Spec fetched from "${host}" exceeds the ${MAX_SPEC_BYTES / (1024 * 1024)} MiB size cap`,
      );
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Resolve and validate one redirect hop for a remote spec fetch (SPEC-41).
 *
 * Relative `Location` values resolve against the current URL hierarchy.
 * `http -> https` upgrades are allowed; `https -> http` downgrades are
 * rejected. `redirects` is the number of hops already followed.
 *
 * Exported so the redirect policy can be exercised directly by tests without
 * standing up a TLS server.
 *
 * @throws {SpecError} for a missing/invalid `Location`, the 10-hop limit, a
 *   non-`http(s)` target, or an `https -> http` downgrade.
 */
export function resolveRedirect(
  current: string,
  location: string | null,
  redirects: number,
): string {
  const fromHost = specHost(current);
  if (location === null || location.trim() === "") {
    throw new SpecError(`Redirect from "${fromHost}" is missing a Location header`);
  }
  if (redirects >= MAX_REDIRECTS) {
    throw new SpecError(
      `Too many redirects fetching a spec from "${fromHost}": stopped after ${MAX_REDIRECTS} hops`,
    );
  }
  let next: URL;
  try {
    next = new URL(location, current);
  } catch {
    throw new SpecError(`Redirect from "${fromHost}" has an invalid Location header`);
  }
  if (next.protocol !== "http:" && next.protocol !== "https:") {
    throw new SpecError(
      `Redirect from "${fromHost}" targets unsupported protocol "${next.protocol}": only http and https are followed`,
    );
  }
  const from = new URL(current);
  if (from.protocol === "https:" && next.protocol === "http:") {
    throw new SpecError(
      `Refusing insecure redirect from "https://${from.host}" to "http://${next.host}": an https spec URL must not downgrade to http`,
    );
  }
  return next.href;
}

/**
 * Fetch a remote spec body under the SPEC-41 network policy: a 10 second
 * timeout covering the whole redirect chain, a manual redirect loop capped at
 * 10 hops, and the 5 MiB body cap.
 *
 * @throws {SpecError} with an actionable message naming the host (never the
 *   full credentials-bearing URL) for every failure mode.
 */
async function fetchSpecText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let current = url;
  let redirects = 0;
  try {
    for (;;) {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
      });
      const host = specHost(current);
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        current = resolveRedirect(
          current,
          response.headers.get("location"),
          redirects,
        );
        redirects += 1;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const suffix = response.statusText === "" ? "" : ` ${response.statusText}`;
        throw new SpecError(
          `Failed to fetch spec from "${host}": HTTP ${response.status}${suffix}`,
        );
      }
      return await readCappedBody(response, host);
    }
  } catch (error) {
    if (error instanceof SpecError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new SpecError(
        `Timed out after ${FETCH_TIMEOUT_MS / 1000}s fetching spec from "${specHost(current)}"`,
      );
    }
    throw new SpecError(
      `Failed to fetch spec from "${specHost(current)}": ${fetchFailureReason(error, current)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse remote spec text: JSON first, then YAML (SPEC-41). A remote source has
 * no filesystem extension to key off, so both parsers are always attempted.
 */
function parseRemoteText(text: string, sourceName: string): unknown {
  try {
    return JSON.parse(text);
  } catch (jsonError) {
    try {
      return parseYaml(text);
    } catch (yamlError) {
      throw new SpecError(
        `Invalid JSON or YAML in "${sourceName}": ${reason(yamlError)} (JSON: ${reason(jsonError)})`,
      );
    }
  }
}

/** Fetch (or reuse) a remote document, parsing and alias-guarding it once. */
async function fetchRemoteDocument(
  url: string,
  documents: Map<string, unknown>,
): Promise<unknown> {
  if (documents.has(url)) {
    return documents.get(url);
  }
  const label = redactSpecSource(url);
  const text = await fetchSpecText(url);
  const parsed = parseRemoteText(text, label);
  detectAliasCycles(parsed, label);
  documents.set(url, parsed);
  return parsed;
}

/** Resolve one `$ref`'s file part to an absolute remote URL. */
function remoteRefTarget(ref: string, base: string): string {
  const hashIndex = ref.indexOf("#");
  const filePart = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
  if (filePart === "") {
    return base;
  }
  const labelFrom = redactSpecSource(base);
  if (/^[a-z][a-z0-9+.-]*:/i.test(filePart) && !isRemoteUrl(filePart)) {
    throw new SpecError(
      `Remote $ref "${ref}" in "${labelFrom}" is not supported: only http(s) references can be fetched`,
    );
  }
  let target: URL;
  try {
    target = new URL(filePart, base);
  } catch {
    throw new SpecError(
      `Cannot resolve $ref "${ref}" in "${labelFrom}": malformed URL reference`,
    );
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new SpecError(
      `Remote $ref "${ref}" in "${labelFrom}" is not supported: only http(s) references can be fetched`,
    );
  }
  return target.href;
}

/** Collect every `$ref` string reachable in a (cycle-free) parsed document. */
function collectRefs(node: unknown, refs: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRefs(item, refs);
    }
    return refs;
  }
  if (!isObject(node)) {
    return refs;
  }
  if (typeof node.$ref === "string") {
    refs.push(node.$ref);
  }
  for (const value of Object.values(node)) {
    collectRefs(value, refs);
  }
  return refs;
}

/** Every remote document referenced by `document`, resolved against `base`. */
function collectRefTargets(document: unknown, base: string): string[] {
  return collectRefs(document)
    .map((ref) => remoteRefTarget(ref, base))
    .filter((target) => target !== base);
}

/**
 * Fetch the transitive closure of remote `$ref` targets before resolution.
 * Shared memoization means each document is fetched at most once per run.
 */
async function preloadRemoteRefs(
  document: unknown,
  base: string,
  documents: Map<string, unknown>,
): Promise<void> {
  const queue = collectRefTargets(document, base);
  while (queue.length > 0) {
    const target = queue.shift() as string;
    if (documents.has(target)) {
      continue;
    }
    const parsed = await fetchRemoteDocument(target, documents);
    queue.push(...collectRefTargets(parsed, target));
  }
}

/**
 * Resolves `$ref` nodes to their targets, inlining internal and external file
 * references. Circular reference chains are handled by pre-registering a
 * placeholder for each in-progress target, so a cycle yields a live cyclic
 * object graph instead of unbounded recursion.
 *
 * Remote documents (SPEC-41) are preloaded by {@link preloadRemoteRefs} and
 * looked up in `remoteDocuments`; local documents are still read from disk on
 * demand, so local-only behavior is unchanged.
 */
class RefResolver {
  private readonly documents = new Map<string, unknown>();
  private readonly resolved = new Map<string, unknown>();

  constructor(
    private readonly root: string,
    rootDocument: unknown,
    private readonly remoteDocuments?: ReadonlyMap<string, unknown>,
  ) {
    this.documents.set(root, rootDocument);
  }

  resolve(): unknown {
    return this.resolveNode(this.document(this.root), this.root);
  }

  private document(file: string): unknown {
    const cached = this.documents.get(file);
    if (cached !== undefined || this.documents.has(file)) {
      return cached;
    }
    if (isRemoteUrl(file)) {
      const remote = this.remoteDocuments?.get(file);
      if (remote === undefined && !this.remoteDocuments?.has(file)) {
        throw new SpecError(
          `Internal error: remote document "${redactSpecSource(file)}" was not preloaded`,
        );
      }
      this.documents.set(file, remote);
      return remote;
    }
    const document = readSpecFile(file);
    this.documents.set(file, document);
    return document;
  }

  private resolveNode(node: unknown, file: string): unknown {
    if (Array.isArray(node)) {
      return node.map((item) => this.resolveNode(item, file));
    }
    if (!isObject(node)) {
      return node;
    }

    const ref = node.$ref;
    if (typeof ref === "string") {
      const target = this.resolveRef(ref, file);
      const siblings = { ...node };
      delete siblings.$ref;
      if (Object.keys(siblings).length === 0) {
        return target;
      }
      // OpenAPI 3.1 / JSON Schema 2020-12 allow sibling keywords alongside
      // `$ref`. Decision: siblings are applied as a shallow, top-level merge
      // over the referenced value (`{ ...target, ...siblings }`), with siblings
      // taking precedence key-by-key. This does not implement full JSON Schema
      // applicator semantics (an `allOf`-style conjunction, where e.g. sibling
      // `properties` would be *combined* with the target's rather than replace
      // them); that richer behaviour is out of scope for the v1 resolver. Under
      // OpenAPI 3.0 siblings are formally ignored, so merging is at worst a
      // forward-compatible superset. See the SPEC-3 implementation note.
      if (isObject(target)) {
        return { ...target, ...(this.resolveNode(siblings, file) as JsonObject) };
      }
      return target;
    }

    const out: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = this.resolveNode(value, file);
    }
    return out;
  }

  private resolveRef(ref: string, file: string): unknown {
    const { targetFile, pointer } = this.parseRef(ref, file);
    const key = `${targetFile}#${pointer}`;
    if (this.resolved.has(key)) {
      return this.resolved.get(key);
    }

    const target = getPointer(
      this.document(targetFile),
      pointer,
      ref,
      redactSpecSource(targetFile),
    );

    // Pre-register a placeholder before recursing so a cyclic `$ref` chain
    // terminates and every occurrence shares the same node.
    const placeholder: JsonObject | unknown[] = Array.isArray(target) ? [] : {};
    this.resolved.set(key, placeholder);

    const value = this.resolveNode(target, targetFile);
    if (Array.isArray(placeholder)) {
      if (Array.isArray(value)) {
        placeholder.push(...value);
        return placeholder;
      }
      this.resolved.set(key, value);
      return value;
    }
    if (isObject(value)) {
      Object.assign(placeholder, value);
      return placeholder;
    }
    this.resolved.set(key, value);
    return value;
  }

  private parseRef(ref: string, file: string): { targetFile: string; pointer: string } {
    const hashIndex = ref.indexOf("#");
    const filePart = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
    const pointer = hashIndex === -1 ? "" : ref.slice(hashIndex + 1);
    if (isRemoteUrl(file)) {
      if (filePart === "") {
        return { targetFile: file, pointer };
      }
      return { targetFile: remoteRefTarget(ref, file), pointer };
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) {
      throw new SpecError(
        `Remote $ref "${ref}" is not supported: only local spec files can be referenced`,
      );
    }
    let targetFile: string;
    if (filePart === "") {
      targetFile = file;
    } else {
      let decoded: string;
      try {
        decoded = decodeURIComponent(filePart);
      } catch {
        // `decodeURIComponent` throws a URIError on malformed `%` sequences;
        // surface it as a SpecError so every failure path stays typed.
        throw new SpecError(
          `Cannot resolve $ref "${ref}" in "${file}": malformed percent-encoding in the reference path`,
        );
      }
      targetFile = resolvePath(dirname(file), decoded);
    }
    return { targetFile, pointer };
  }
}

/** Walk a JSON pointer (e.g. `/components/schemas/Pet`) within a document. */
function getPointer(document: unknown, pointer: string, ref: string, file: string): unknown {
  if (pointer === "" || pointer === "/") {
    return document;
  }

  let current = document;
  for (const raw of pointer.split("/").slice(1)) {
    const segment = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new SpecError(`Cannot resolve $ref "${ref}" in "${file}": "${pointer}" is not an array index`);
      }
      current = current[index];
    } else if (isObject(current)) {
      if (!(segment in current)) {
        throw new SpecError(`Cannot resolve $ref "${ref}" in "${file}": path "${pointer}" does not exist`);
      }
      current = current[segment];
    } else {
      throw new SpecError(`Cannot resolve $ref "${ref}" in "${file}": path "${pointer}" does not exist`);
    }
  }
  return current;
}

/**
 * Reject anything that is not a usable OpenAPI 3.0.x / 3.1.x document.
 *
 * This checks the version marker *and* the structurally required members, so a
 * document like `{ openapi: "3.0.3" }` — which carries the version but cannot
 * yield a catalog — is rejected rather than silently accepted:
 *
 * - both 3.0 and 3.1 require an `info` object (with a non-empty `title` and
 *   `version`, per the OpenAPI Info Object);
 * - OpenAPI 3.0 requires `paths`;
 * - OpenAPI 3.1 requires at least one of `paths`, `webhooks`, or `components`.
 */
function validateOpenApi(document: unknown, sourceName: string): void {
  if (!isObject(document)) {
    throw new SpecError(
      `"${sourceName}" is not a valid OpenAPI document: expected a mapping at the document root`,
    );
  }

  const openapi = document.openapi;
  if (typeof openapi !== "string") {
    if (document.swagger !== undefined) {
      throw new SpecError(
        `"${sourceName}" is not a supported OpenAPI document: Swagger 2.0 is not supported, only OpenAPI 3.0 and 3.1`,
      );
    }
    throw new SpecError(
      `"${sourceName}" is not a valid OpenAPI document: missing the \`openapi\` version field`,
    );
  }
  if (!SUPPORTED_OPENAPI.test(openapi)) {
    throw new SpecError(
      `Unsupported OpenAPI version "${openapi}" in "${sourceName}": SpecWeaver supports OpenAPI 3.0 and 3.1`,
    );
  }

  const problems: string[] = [];

  const info = document.info;
  if (!isObject(info)) {
    problems.push("missing the required `info` object");
  } else {
    if (typeof info.title !== "string" || info.title.trim() === "") {
      problems.push("`info.title` must be a non-empty string");
    }
    if (typeof info.version !== "string" || info.version.trim() === "") {
      problems.push("`info.version` must be a non-empty string");
    }
  }

  if (openapi.startsWith("3.1.")) {
    if (
      !isObject(document.paths) &&
      !isObject(document.webhooks) &&
      !isObject(document.components)
    ) {
      problems.push(
        "must define at least one of `paths`, `webhooks`, or `components`",
      );
    }
  } else if (!isObject(document.paths)) {
    problems.push("missing the required `paths` object");
  }

  if (problems.length > 0) {
    const list = problems.map((problem) => `  - ${problem}`).join("\n");
    throw new SpecError(
      `"${sourceName}" is not a valid OpenAPI ${openapi} document:\n${list}`,
      problems,
    );
  }
}

function toParameters(value: unknown): ParameterObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isObject) as ParameterObject[];
}

/** Merge path-level and operation-level parameters, operation wins on a clash. */
function mergeParameters(
  pathLevel: ParameterObject[],
  operationLevel: ParameterObject[],
): ParameterObject[] {
  const merged = new Map<string, ParameterObject>();
  for (const parameter of [...pathLevel, ...operationLevel]) {
    if (typeof parameter.name === "string" && typeof parameter.in === "string") {
      merged.set(`${parameter.in}\u0000${parameter.name}`, parameter);
    }
  }
  return [...merged.values()];
}

function toSecurity(operationSecurity: unknown, documentSecurity: unknown): SecurityRequirement[] {
  const source = Array.isArray(operationSecurity)
    ? operationSecurity
    : Array.isArray(documentSecurity)
      ? documentSecurity
      : [];
  return source.filter(isObject) as SecurityRequirement[];
}

/**
 * Catalogue the operations of one Path-Item-shaped container (`paths` or 3.1
 * `webhooks`), appending to `operations` in document order with canonical
 * method order. `pathFor` maps a container key to the operation's path.
 */
function catalogueOperations(
  container: unknown,
  pathFor: (key: string) => string,
  documentSecurity: unknown,
  securitySchemes: Record<string, SecuritySchemeObject> | undefined,
  operations: OperationEntry[],
): void {
  if (!isObject(container)) {
    return;
  }

  for (const [key, pathItem] of Object.entries(container)) {
    if (!isObject(pathItem)) {
      continue;
    }
    const pathParameters = toParameters(pathItem.parameters);

    for (const method of OPERATION_METHODS) {
      const operation = pathItem[method];
      if (!isObject(operation)) {
        continue;
      }

      const entry: OperationEntry = {
        method: method.toUpperCase(),
        path: pathFor(key),
        parameters: mergeParameters(pathParameters, toParameters(operation.parameters)),
        security: toSecurity(operation.security, documentSecurity),
      };
      if (securitySchemes !== undefined) {
        entry.securitySchemes = securitySchemes;
      }
      if (typeof operation.operationId === "string") {
        entry.operationId = operation.operationId;
      }
      if (Array.isArray(operation.tags)) {
        const tags = operation.tags.filter(
          (tag): tag is string => typeof tag === "string",
        );
        if (tags.length > 0) {
          entry.tags = tags;
        }
      }
      if (isObject(operation.requestBody)) {
        entry.requestBody = operation.requestBody as RequestBodyObject;
      }
      operations.push(entry);
    }
  }
}

/** True for an OpenAPI 3.1.x document, the only version with `webhooks`. */
function isOpenApi31(document: JsonObject): boolean {
  return typeof document.openapi === "string" && document.openapi.startsWith("3.1.");
}

/** A webhook name becomes a path template, gaining a leading `/` when missing. */
function webhookPath(name: string): string {
  return name.startsWith("/") ? name : `/${name}`;
}

/** Resolved `components.securitySchemes`, when the document declares any. */
function documentSecuritySchemes(
  document: JsonObject,
): Record<string, SecuritySchemeObject> | undefined {
  const components = document.components;
  if (!isObject(components) || !isObject(components.securitySchemes)) {
    return undefined;
  }
  const schemes: Record<string, SecuritySchemeObject> = {};
  for (const [name, scheme] of Object.entries(components.securitySchemes)) {
    if (isObject(scheme)) {
      schemes[name] = scheme as SecuritySchemeObject;
    }
  }
  return Object.keys(schemes).length > 0 ? schemes : undefined;
}

/**
 * Build the normalized operation catalog from a resolved document.
 *
 * `paths` operations come first, then — for OpenAPI 3.1 — `webhooks`
 * operations (SPEC-37). A webhook describes an event the API server sends to
 * its consumer; SpecWeaver inverts that deterministically: the webhook's
 * operations are catalogued as path operations at `/<webhookName>` and are
 * exercised by sending requests to the configured base URL. Downstream stages
 * therefore treat them exactly like `paths` operations.
 *
 * Every operation carries its document's resolved `securitySchemes` (SPEC-39)
 * so auth can be derived per operation without re-reading the spec.
 */
export function buildOperationCatalog(document: JsonObject): OperationEntry[] {
  const operations: OperationEntry[] = [];
  const securitySchemes = documentSecuritySchemes(document);
  catalogueOperations(
    document.paths,
    (path) => path,
    document.security,
    securitySchemes,
    operations,
  );
  if (isOpenApi31(document)) {
    catalogueOperations(
      document.webhooks,
      webhookPath,
      document.security,
      securitySchemes,
      operations,
    );
  }
  return operations;
}

/**
 * Load, validate, and fully resolve a local OpenAPI 3.0/3.1 document.
 *
 * Remote `http(s)://` sources are rejected here because fetching is
 * asynchronous; pass them to {@link loadSpecs}.
 *
 * @param source Local file path to a JSON or YAML spec (resolved against
 *   `cwd` when relative).
 * @throws {SpecError} when the file cannot be read, is malformed, is not a
 *   structurally valid 3.0/3.1 document, contains a YAML alias cycle, or
 *   contains an unresolvable `$ref`.
 *
 * Base-directory decision (SPEC-3): a relative `source` is resolved against
 * `process.cwd()`, **not** against the directory of the `--config` file that
 * listed it. Spec paths therefore behave like ordinary CLI path arguments
 * (and match how `--config`/`--out` are interpreted); a config that wants
 * spec-relative paths must use paths relative to the working directory. The
 * config layer does not thread a base directory through, by design, to keep
 * spec sources independent of where the config file happens to live.
 */
export function loadSpec(source: string): LoadedSpec {
  if (isRemoteUrl(source)) {
    throw new SpecError(
      `Spec "${redactSpecSource(source)}" is a remote URL; fetch it with loadSpecs(), which loads remote documents asynchronously`,
    );
  }
  const absolute = isAbsolute(source) ? source : resolvePath(process.cwd(), source);
  const parsed = readSpecFile(absolute);
  validateOpenApi(parsed, source);
  const document = new RefResolver(absolute, parsed).resolve();
  return {
    source,
    document: document as JsonObject,
    operations: buildOperationCatalog(document as JsonObject),
  };
}

/** Load, validate, and resolve one remote document under the SPEC-41 policy. */
async function loadRemoteSpec(
  url: string,
  documents: Map<string, unknown>,
): Promise<LoadedSpec> {
  const label = redactSpecSource(url);
  const root = await fetchRemoteDocument(url, documents);
  validateOpenApi(root, label);
  await preloadRemoteRefs(root, url, documents);
  const document = new RefResolver(url, root, documents).resolve();
  return {
    source: label,
    document: document as JsonObject,
    operations: buildOperationCatalog(document as JsonObject),
  };
}

/**
 * Load several specs in order, local paths and absolute `http(s)` URLs alike
 * (SPEC-41). Stops at the first {@link SpecError}.
 *
 * Relative paths share {@link loadSpec}'s `process.cwd()` base directory.
 * Remote documents — including on-demand `$ref` targets — are fetched at most
 * once per call through a shared memo, which also covers repeated `specs`
 * URLs. Remote sources are never fetched concurrently, so failure reporting
 * follows `specs` order deterministically.
 */
export async function loadSpecs(sources: string[]): Promise<LoadedSpec[]> {
  const documents = new Map<string, unknown>();
  const loaded: LoadedSpec[] = [];
  for (const source of sources) {
    const remote = remoteUrlFor(source);
    loaded.push(
      remote === undefined
        ? loadSpec(source)
        : await loadRemoteSpec(remote, documents),
    );
  }
  return loaded;
}

/**
 * Non-fatal warnings for loaded specs that contributed no operations (SPEC-15).
 *
 * The catalog is built from `document.paths` plus, for OpenAPI 3.1,
 * `document.webhooks` ({@link buildOperationCatalog}). OpenAPI 3.1 still
 * permits a valid document with only `components`, so such a spec loads
 * successfully yet yields zero operations. Rather than let that pass silently,
 * each zero-catalog source is named in a warning explaining the limitation. The
 * run-level failure for an empty overall catalog remains the CLI's
 * no-operations path (SPEC-14).
 */
export function zeroOperationWarnings(specs: readonly LoadedSpec[]): string[] {
  return specs
    .filter((spec) => spec.operations.length === 0)
    .map(
      (spec) =>
        `spec "${spec.source}" contributes zero operations: only \`paths\` and \`webhooks\` operations are catalogued, so a components-only document yields none.`,
    );
}
