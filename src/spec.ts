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
 * - {@link loadSpecs} does the same for several sources in order.
 *
 * Remote/http(s) sources, OpenAPI 2.0 / Swagger, GraphQL, and non-JSON request
 * bodies are intentionally out of scope for v1.
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
}

/** The result of loading one local OpenAPI document. */
export interface LoadedSpec {
  /** The source path exactly as requested (for error messages). */
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
 * Resolves `$ref` nodes to their targets, inlining internal and external file
 * references. Circular reference chains are handled by pre-registering a
 * placeholder for each in-progress target, so a cycle yields a live cyclic
 * object graph instead of unbounded recursion.
 */
class RefResolver {
  private readonly documents = new Map<string, unknown>();
  private readonly resolved = new Map<string, unknown>();

  constructor(
    private readonly root: string,
    rootDocument: unknown,
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

    const target = getPointer(this.document(targetFile), pointer, ref, targetFile);

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
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) {
      throw new SpecError(
        `Remote $ref "${ref}" is not supported: only local spec files can be referenced`,
      );
    }
    const hashIndex = ref.indexOf("#");
    const filePart = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
    const pointer = hashIndex === -1 ? "" : ref.slice(hashIndex + 1);
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

/** Build the normalized operation catalog from a resolved document. */
export function buildOperationCatalog(document: JsonObject): OperationEntry[] {
  const paths = document.paths;
  if (!isObject(paths)) {
    return [];
  }

  const operations: OperationEntry[] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
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
        path,
        parameters: mergeParameters(pathParameters, toParameters(operation.parameters)),
        security: toSecurity(operation.security, document.security),
      };
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
  return operations;
}

/**
 * Load, validate, and fully resolve a local OpenAPI 3.0/3.1 document.
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

/**
 * Load several local specs in order. Stops at the first {@link SpecError}.
 *
 * Relative paths share {@link loadSpec}'s `process.cwd()` base directory.
 */
export function loadSpecs(sources: string[]): LoadedSpec[] {
  return sources.map((source) => loadSpec(source));
}

/**
 * Non-fatal warnings for loaded specs that contributed no operations (SPEC-15).
 *
 * The catalog is built exclusively from `document.paths`
 * ({@link buildOperationCatalog}). OpenAPI 3.1 permits a valid document with
 * only `webhooks` or only `components`, so such a spec loads successfully yet
 * yields zero operations. Rather than let that pass silently, each zero-catalog
 * source is named in a warning explaining the v1 limitation. Webhooks are not
 * catalogued here; the run-level failure for an empty overall catalog remains
 * the CLI's no-operations path (SPEC-14).
 */
export function zeroOperationWarnings(specs: readonly LoadedSpec[]): string[] {
  return specs
    .filter((spec) => spec.operations.length === 0)
    .map(
      (spec) =>
        `spec "${spec.source}" contributes zero operations: only \`paths\` operations are supported, so OpenAPI 3.1 \`webhooks\` and components-only documents are not catalogued in v1.`,
    );
}
