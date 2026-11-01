/**
 * Request-data generation from resolved OpenAPI schemas (SPEC-4).
 *
 * Before SpecWeaver can emit a k6 script it must build concrete request data
 * for every selected operation. This module is that stage: given a resolved
 * {@link OperationEntry} (from SPEC-3) it produces a {@link GeneratedRequestData}
 * object carrying path params, query params, headers, and a JSON body.
 *
 * Value priority (examples-first, then defaults, then synthesis):
 * 1. an explicit `example`/`examples` at the parameter / media-type level;
 * 2. an explicit `example`/`examples` at the schema level;
 * 3. the schema's `default`;
 * 4. faker.js values derived from the JSON Schema `type`/`format`.
 *
 * Generation is deterministic for a given seed so generated tests are
 * reproducible. Both required **and** optional fields are always populated
 * (there is no omission and no config flag), and generation recurses through
 * every nested object and array.
 *
 * Parameter values are serialized to their OpenAPI wire form using the
 * effective `style`/`explode` for each location (query: `form`/`explode=true`;
 * path & header: `simple`/`explode=false`), overridable per parameter. Path
 * parameters additionally honor `label` and `matrix`, and query parameters
 * support `spaceDelimited`, `pipeDelimited`, and `deepObject`. Array and object
 * values therefore expand into the documented wire forms rather than being
 * JSON-encoded.
 *
 * Cookie parameters (SPEC-35) are generated with the same value chain and ride
 * exactly one `Cookie` request header: `name=value; name2=value2` in parameter
 * declaration order, with names and values percent-encoded. Array/object values
 * use the non-exploded `form` wire text (`3,4,5` / `role,admin,...`) before
 * encoding — a documented deviation from OpenAPI's cookie default of
 * `explode: true`. An explicit `auth.headers` `Cookie` wins (SPEC-5 collision
 * precedence), and so does a declared `Cookie` header parameter.
 *
 * Composed schemas are supported at a practical level: `allOf` members are
 * merged (properties unioned, `required` unioned, scalar keywords overridden
 * by later members), and `oneOf`/`anyOf` pick their first branch. Full
 * JSON-Schema validation semantics (exclusive branch selection, discriminators,
 * `not`, conditional applicators) are out of scope.
 *
 * Cyclic `$ref` graphs — which SPEC-3 intentionally resolves to a live
 * self-referential object graph — are handled by an ancestor check plus a depth
 * cap ({@link MAX_SCHEMA_DEPTH}): generation always terminates, truncating a
 * cyclic/over-deep branch to an empty object or array rather than recursing
 * forever. One-sided numeric bounds (`minimum` without `maximum`, or vice
 * versa) are sealed to a valid range before delegating to faker.
 *
 * Out of scope for v1: non-JSON request bodies (multipart/form-data,
 * application/x-www-form-urlencoded, XML), cookie jars / response `Set-Cookie`
 * handling, auth header injection (SPEC-5), and executing requests.
 *
 * SPEC-13 adds {@link applyPayloadOverrides}: after generation, a configured
 * `payloads[].body` replaces the generated JSON body of the operation whose
 * normalized `METHOD path` key matches. Matching and warnings live here so the
 * override contract is unit-testable independently of the CLI.
 */
import { Faker, base, en } from "@faker-js/faker";

import type { PayloadOverride } from "./config.js";
import type {
  JsonObject,
  OperationEntry,
  ParameterObject,
  RequestBodyObject,
} from "./spec.js";

/**
 * A serialized query-string value.
 *
 * Scalars and non-exploded arrays/objects serialize to a single string. An
 * exploded (default) array parameter yields repeated query keys, represented
 * here as a `string[]` so the wire form can be reconstructed losslessly.
 */
export type QueryValue = string | string[];

/** Concrete request data for one operation, ready to embed in a k6 script. */
export interface GeneratedRequestData {
  /** Upper-cased HTTP method, e.g. `POST`. */
  method: string;
  /** The operation's path template, e.g. `/pets/{petId}`. */
  path: string;
  /** Path parameter name -> value (values serialized to strings). */
  pathParams: Record<string, string>;
  /**
   * Path parameter names whose {@link pathParams} value is already
   * percent-encoded wire text (`label`/`matrix`). Omitted when empty; other
   * path values are raw and are encoded when the URL is composed.
   */
  preEncodedPathParams?: readonly string[];
  /** Query parameter name -> value, in OpenAPI `form` wire form. */
  query: Record<string, QueryValue>;
  /**
   * Header name -> value, including the generated `Cookie` header (SPEC-35)
   * when the operation declares cookie parameters. Values are serialized to
   * strings so SPEC-5 can merge auth headers into the same map.
   */
  headers: Record<string, string>;
  /** Decoded JSON request body, when the operation declares a JSON body. */
  body?: unknown;
}

/** Options controlling generation. */
export interface GenerateOptions {
  /** faker.js seed. Defaults to {@link DEFAULT_SEED}. */
  seed?: number;
}

/**
 * Default faker seed. A fixed default keeps generated tests reproducible
 * without requiring the caller to pick a seed.
 */
export const DEFAULT_SEED = 1;

/**
 * Number of items generated for a schema with `type: array`. The array length
 * is not part of the documented contract; a small fixed count keeps output
 * deterministic and keeps arrays-of-objects non-empty.
 */
const ARRAY_SAMPLE_SIZE = 2;

/**
 * Fixed reference window used for `format: date` / `date-time` synthesis.
 *
 * faker's `anytime()` defaults its reference to the wall clock, which makes the
 * same seed produce different values between calls (and days). Pinning an
 * explicit `between` range makes date output byte-identical for a given seed for
 * all time. The window is deliberately in the past so generated timestamps never
 * race the clock.
 */
const FIXED_DATE_FROM = new Date("2020-01-01T00:00:00.000Z");
const FIXED_DATE_TO = new Date("2020-12-31T23:59:59.999Z");

/** Inclusive bounds used when a schema declares `format: int32`. */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Inclusive bounds used when a schema declares `format: int64`. */
const INT64_MIN = Number.MIN_SAFE_INTEGER;
const INT64_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Maximum recursion depth for schema-driven generation.
 *
 * Object and array schemas recurse into their child schemas. SPEC-3 resolves
 * circular `$ref` chains to a *live cyclic object graph*, so following
 * containment can revisit a schema forever. This cap — together with the
 * ancestor-identity check in {@link generateFromSchema} — guarantees generation
 * terminates deterministically. A branch that exceeds the cap (or that revisits
 * a schema already on the current path) is truncated to a terminal value
 * instead of recursing.
 */
const MAX_SCHEMA_DEPTH = 16;

/**
 * Recursion state threaded through schema generation.
 *
 * `ancestors` holds the schema nodes on the current containment path (by object
 * identity), so a cyclic `$ref` graph — where a schema is its own descendant —
 * is detected immediately rather than only at the depth cap. The set is mutated
 * with stack discipline (added on entry, removed on exit), so *sibling* reuse of
 * a shared schema is not mistaken for a cycle.
 */
interface GenerationContext {
  readonly ancestors: Set<object>;
  readonly depth: number;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return `value` when it is a finite number, otherwise `undefined`. */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Serialize a generated value to the string form used on the wire. */
function toScalarString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Create a faker.js instance seeded deterministically.
 *
 * A fresh instance (rather than the shared global faker) is used so generation
 * never depends on — or leaks into — unrelated faker state.
 */
export function createFaker(seed: number = DEFAULT_SEED): Faker {
  const faker = new Faker({ locale: [en, base] });
  faker.seed(seed);
  return faker;
}

interface ExampleResult {
  found: boolean;
  value: unknown;
}

/**
 * Find the first explicit example on a node that may carry OpenAPI
 * `example`/`examples` or JSON Schema `examples`.
 *
 * - `example` (OpenAPI parameter/media-type or JSON Schema 3.0) wins.
 * - `examples` as an object (OpenAPI) takes the first entry's `value`.
 * - `examples` as an array (JSON Schema 2020-12) takes the first element.
 */
function firstExample(node: JsonObject): ExampleResult {
  if ("example" in node && node.example !== undefined) {
    return { found: true, value: node.example };
  }

  const examples = node.examples;
  if (Array.isArray(examples)) {
    if (examples.length > 0) {
      return { found: true, value: examples[0] };
    }
    return { found: false, value: undefined };
  }
  if (isObject(examples)) {
    for (const entry of Object.values(examples)) {
      if (isObject(entry)) {
        if ("value" in entry) {
          return { found: true, value: entry.value };
        }
        if ("externalValue" in entry) {
          continue;
        }
      }
      return { found: true, value: entry };
    }
  }
  return { found: false, value: undefined };
}

/** The declared JSON Schema `type`(s), normalized to a list of strings. */
function schemaTypes(schema: JsonObject): string[] {
  const type = schema.type;
  if (typeof type === "string") {
    return [type];
  }
  if (Array.isArray(type)) {
    return type.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

/** faker.js synthesis for `type: string`, honouring common formats. */
function generateString(schema: JsonObject, faker: Faker): string {
  const format = typeof schema.format === "string" ? schema.format : undefined;
  switch (format) {
    case "uuid":
      return faker.string.uuid();
    case "email":
      return faker.internet.email();
    case "date":
      return faker.date
        .between({ from: FIXED_DATE_FROM, to: FIXED_DATE_TO })
        .toISOString()
        .slice(0, 10);
    case "date-time":
      return faker.date
        .between({ from: FIXED_DATE_FROM, to: FIXED_DATE_TO })
        .toISOString();
    case "uri":
    case "url":
      return faker.internet.url();
    default:
      return faker.lorem.word();
  }
}

/**
 * A child context that shares the ancestor stack with its parent and tracks one
 * more level of nesting.
 */
function descend(context: GenerationContext): GenerationContext {
  return { ancestors: context.ancestors, depth: context.depth + 1 };
}

/**
 * Terminal value for a cyclic or over-deep schema branch: an empty object for
 * object schemas and an empty array for array schemas (otherwise `null`).
 *
 * This keeps the parent field / list present — the generator never silently
 * drops a property — while cutting the cyclic branch at a documented depth.
 */
function truncateCycle(schema: JsonObject): unknown {
  const types = schemaTypes(schema);
  const looksArray =
    types.includes("array") ||
    (schema.items !== undefined && !isObject(schema.properties));
  if (looksArray) {
    return [];
  }
  if (types.includes("object") || isObject(schema.properties)) {
    return {};
  }
  return null;
}

/**
 * Generate every declared property, required or optional, recursing into each
 * property schema.
 */
function generateObject(
  schema: JsonObject,
  faker: Faker,
  context: GenerationContext,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const properties = isObject(schema.properties) ? schema.properties : {};
  const child = descend(context);
  for (const [name, propertySchema] of Object.entries(properties)) {
    output[name] = generateFromSchema(propertySchema, faker, child);
  }
  return output;
}

/** Generate a fixed-size array, recursing into the `items` schema. */
function generateArray(
  schema: JsonObject,
  faker: Faker,
  context: GenerationContext,
): unknown[] {
  const items = schema.items;
  const output: unknown[] = [];
  const child = descend(context);
  for (let index = 0; index < ARRAY_SAMPLE_SIZE; index += 1) {
    output.push(generateFromSchema(items, faker, child));
  }
  return output;
}

/** faker.js synthesis for `type: integer`, honouring bounds/format/multipleOf. */
function generateInteger(schema: JsonObject, faker: Faker): number {
  const format = typeof schema.format === "string" ? schema.format : undefined;

  let min = asFiniteNumber(schema.minimum);
  let max = asFiniteNumber(schema.maximum);

  // `format` provides a default bound that an explicit minimum/maximum narrows
  // (never widens): int32 clamps to the 32-bit signed range, int64 to the
  // JavaScript safe-integer range.
  if (format === "int32") {
    min = Math.max(min ?? INT32_MIN, INT32_MIN);
    max = Math.min(max ?? INT32_MAX, INT32_MAX);
  } else if (format === "int64") {
    min = Math.max(min ?? INT64_MIN, INT64_MIN);
    max = Math.min(max ?? INT64_MAX, INT64_MAX);
  }

  if (min === undefined) {
    min = 0;
  }
  if (max === undefined) {
    max = INT64_MAX;
  }

  const multiple = asFiniteNumber(schema.multipleOf);
  if (multiple !== undefined && multiple > 0) {
    const lo = Math.ceil(min / multiple);
    const hi = Math.floor(max / multiple);
    if (hi >= lo) {
      return faker.number.int({ min: lo, max: hi }) * multiple;
    }
    // No multiple of `multiple` lies inside the range; the upper bound is a
    // schema contradiction, so saturate to the smallest multiple >= minimum.
    return lo * multiple;
  }

  if (min > max) {
    min = max;
  }
  return faker.number.int({ min, max });
}

/**
 * Snap a value to a multiple of `multiple`, keeping it within the declared
 * bounds. When both bounds are known and a multiple lies inside the range, an
 * in-range multiple is returned; when the range holds no multiple the smallest
 * multiple at or above the lower bound is returned (saturating).
 */
function roundToMultiple(
  value: number,
  min: number | undefined,
  max: number | undefined,
  multiple: number,
): number {
  const lo = min === undefined ? undefined : Math.ceil(min / multiple) * multiple;
  const hi = max === undefined ? undefined : Math.floor(max / multiple) * multiple;

  if (lo !== undefined && hi !== undefined) {
    if (hi < lo) {
      // No multiple of `multiple` lies inside the range; saturate to the
      // smallest multiple at or above the lower bound.
      return lo;
    }
    const snapped = Math.round(value / multiple) * multiple;
    return Math.min(Math.max(snapped, lo), hi);
  }

  const snapped = Math.round(value / multiple) * multiple;
  if (lo !== undefined && snapped < lo) {
    return lo;
  }
  if (hi !== undefined && snapped > hi) {
    return hi;
  }
  return snapped;
}

/** faker.js synthesis for `type: number`, honouring bounds/multipleOf. */
function generateNumber(schema: JsonObject, faker: Faker): number {
  let min = asFiniteNumber(schema.minimum);
  let max = asFiniteNumber(schema.maximum);
  const multiple = asFiniteNumber(schema.multipleOf);

  // Seal a one-sided bound before handing it to faker. `faker.number.float`
  // defaults any *missing* side to 0..1, which throws whenever the declared
  // side lies outside that window (`{minimum: 1000}` -> "Max 1 should be greater
  // than min 1000", `{maximum: -5}` -> "Max -5 should be greater than min 0").
  // Defaulting the open side relative to the declared one mirrors the integer
  // generator's "missing minimum means 0" convention while always producing a
  // value that satisfies the declared bound.
  if (min !== undefined || max !== undefined) {
    if (min === undefined) {
      min = (max as number) <= 0 ? (max as number) - 1 : 0;
    }
    if (max === undefined) {
      max = min >= 0 ? min + 1 : 0;
    }
    if (max < min) {
      // Contradictory bounds (minimum > maximum): saturate to the lower bound.
      max = min;
    }
  }

  const value =
    min === undefined || max === undefined
      ? faker.number.float()
      : faker.number.float({ min, max });

  if (multiple !== undefined && multiple > 0) {
    return roundToMultiple(value, min, max, multiple);
  }
  return value;
}

/**
 * Merge an overlay schema onto a base schema. Object `properties` are unioned
 * (overlay wins per property) and `required` arrays are unioned; every other
 * keyword is overridden by the overlay.
 */
function mergeSchemas(base: JsonObject, overlay: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) {
      continue;
    }
    if (key === "properties" && isObject(value) && isObject(out.properties)) {
      out.properties = { ...out.properties, ...value };
    } else if (
      key === "required" &&
      Array.isArray(value) &&
      Array.isArray(out.required)
    ) {
      out.required = [...new Set([...out.required, ...value])];
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Collapse JSON Schema composition keywords into a single effective schema.
 *
 * - `allOf`: every member (then the outer keywords) is merged in order.
 * - `oneOf`/`anyOf`: the first object branch is used.
 *
 * The loop re-runs because a chosen branch or merged member may itself carry a
 * composition keyword. A small depth cap guards against pathological nesting.
 */
function resolveComposition(schema: JsonObject): JsonObject {
  let current = schema;
  for (let depth = 0; depth < 16; depth += 1) {
    const allOf = Array.isArray(current.allOf) ? current.allOf : undefined;
    const oneOf = Array.isArray(current.oneOf) ? current.oneOf : undefined;
    const anyOf = Array.isArray(current.anyOf) ? current.anyOf : undefined;

    if (allOf && allOf.length > 0) {
      const { allOf: _allOf, ...rest } = current;
      let merged: JsonObject = {};
      for (const member of allOf) {
        if (isObject(member)) {
          merged = mergeSchemas(merged, member);
        }
      }
      current = mergeSchemas(merged, rest);
      continue;
    }

    const key = oneOf && oneOf.length > 0 ? "oneOf" : anyOf && anyOf.length > 0 ? "anyOf" : undefined;
    if (key !== undefined) {
      const branches = (key === "oneOf" ? oneOf : anyOf) as unknown[];
      const first = branches.find(isObject);
      const { [key]: _omit, ...rest } = current;
      current = isObject(first) ? mergeSchemas(first, rest) : rest;
      continue;
    }

    return current;
  }
  return current;
}

/** faker.js synthesis driven by the schema's `enum`/`type`/`format`. */
function generateByType(
  schema: JsonObject,
  faker: Faker,
  context: GenerationContext,
): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return faker.helpers.arrayElement(schema.enum as unknown[]);
  }

  const types = schemaTypes(schema);
  const primary = types.find((type) => type !== "null");

  switch (primary) {
    case "string":
      return generateString(schema, faker);
    case "integer":
      return generateInteger(schema, faker);
    case "number":
      return generateNumber(schema, faker);
    case "boolean":
      return faker.datatype.boolean();
    case "object":
      return generateObject(schema, faker, context);
    case "array":
      return generateArray(schema, faker, context);
    default:
      break;
  }

  // Un-typed schemas: infer from the structural keywords, then fall back.
  if (isObject(schema.properties)) {
    return generateObject(schema, faker, context);
  }
  if (schema.items !== undefined) {
    return generateArray(schema, faker, context);
  }
  if (types.includes("null")) {
    return null;
  }
  return faker.lorem.word();
}

/**
 * Generate a value for a JSON Schema fragment.
 *
 * Priority: schema-level `example`/`examples`, then `default`, then faker.js.
 * Recurses through all nested objects and arrays. Composition keywords
 * (`allOf`/`oneOf`/`anyOf`) are collapsed first — see {@link resolveComposition}.
 *
 * Cyclic `$ref` graphs (which SPEC-3 resolves to live self-references) are
 * handled: if a schema is reached again while still being generated, or the
 * recursion exceeds {@link MAX_SCHEMA_DEPTH}, the branch is truncated to an
 * empty object/array (see {@link truncateCycle}) rather than recursing forever.
 * Explicit examples/defaults are honoured first, so a cyclic schema that carries
 * one still yields that value.
 */
export function generateFromSchema(
  schema: unknown,
  faker: Faker,
  context: GenerationContext = { ancestors: new Set<object>(), depth: 0 },
): unknown {
  if (!isObject(schema)) {
    return faker.lorem.word();
  }

  const effective = resolveComposition(schema);

  const example = firstExample(effective);
  if (example.found) {
    return example.value;
  }
  if (effective.default !== undefined) {
    return effective.default;
  }

  if (context.ancestors.has(schema) || context.depth >= MAX_SCHEMA_DEPTH) {
    return truncateCycle(effective);
  }

  context.ancestors.add(schema);
  try {
    return generateByType(effective, faker, context);
  } finally {
    context.ancestors.delete(schema);
  }
}

/**
 * Generate a value for a single operation parameter.
 *
 * A parameter-level `example`/`examples` wins over the parameter's schema.
 */
export function generateParameterValue(
  parameter: ParameterObject,
  faker: Faker,
): unknown {
  const example = firstExample(parameter);
  if (example.found) {
    return example.value;
  }
  return generateFromSchema(parameter.schema, faker);
}

/**
 * Pick the JSON media type of a request body, if any.
 *
 * Exported so SPEC-25's coverage classifier applies exactly the same rule as
 * generation: `application/json`, or any media type containing `json`
 * (e.g. `application/problem+json`). A body without such a media type is one
 * {@link generateRequestBody} cannot model.
 */
export function jsonMediaType(content: JsonObject): JsonObject | undefined {
  const direct = content["application/json"];
  if (isObject(direct)) {
    return direct;
  }
  for (const [mediaType, media] of Object.entries(content)) {
    if (isObject(media) && /json/i.test(mediaType)) {
      return media;
    }
  }
  return undefined;
}

/**
 * Generate the JSON request body for an operation.
 *
 * A media-type-level `example`/`examples` wins over the media type's schema.
 * Non-JSON bodies are out of scope and yield `undefined`.
 */
export function generateRequestBody(
  requestBody: RequestBodyObject | undefined,
  faker: Faker,
): unknown {
  if (!isObject(requestBody) || !isObject(requestBody.content)) {
    return undefined;
  }
  const media = jsonMediaType(requestBody.content);
  if (media === undefined) {
    return undefined;
  }

  const example = firstExample(media);
  if (example.found) {
    return example.value;
  }
  return generateFromSchema(media.schema, faker);
}

/**
 * The OpenAPI default `style` for a parameter location: `form` for query
 * parameters, `simple` for path, header, and cookie parameters. Cookie
 * serialization ignores `style` (see `serializeCookieParameter`).
 */
function defaultParameterStyle(location: string): string {
  return location === "query" ? "form" : "simple";
}

/** The effective `style` for a parameter (its own, else the location default). */
function parameterStyle(parameter: ParameterObject): string {
  const location = typeof parameter.in === "string" ? parameter.in : "query";
  return typeof parameter.style === "string"
    ? parameter.style
    : defaultParameterStyle(location);
}

/**
 * The effective `explode` for a parameter. OpenAPI defaults `explode` to `true`
 * for the `form` style and to `false` for every other style.
 */
function parameterExplode(parameter: ParameterObject, style: string): boolean {
  return typeof parameter.explode === "boolean" ? parameter.explode : style === "form";
}

/**
 * Serialize a value using the `simple` style (the path/header default).
 *
 * - array (explode false): `3,4,5`
 * - object (explode false): `role,admin,firstName,Alex`
 * - object (explode true): `role=admin,firstName=Alex`
 */
function serializeSimple(value: unknown, explode: boolean): string {
  if (Array.isArray(value)) {
    return value.map(toScalarString).join(",");
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (explode) {
      return entries.map(([key, item]) => `${key}=${toScalarString(item)}`).join(",");
    }
    return entries.flatMap(([key, item]) => [key, toScalarString(item)]).join(",");
  }
  return toScalarString(value);
}

/** Encode one scalar path component while leaving structural delimiters literal. */
function encodePathComponent(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Serialize a value using the `label` path style, percent-encoding scalar
 * components but leaving the `.`, `,`, and `=` delimiters literal.
 */
function serializeLabel(value: unknown, explode: boolean): string {
  if (Array.isArray(value)) {
    const items = value.map((item) => encodePathComponent(toScalarString(item)));
    return `.${items.join(explode ? "." : ",")}`;
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (explode) {
      return `.${entries
        .map(
          ([key, item]) =>
            `${encodePathComponent(key)}=${encodePathComponent(toScalarString(item))}`,
        )
        .join(".")}`;
    }
    return `.${entries
      .flatMap(([key, item]) => [
        encodePathComponent(key),
        encodePathComponent(toScalarString(item)),
      ])
      .join(",")}`;
  }
  return `.${encodePathComponent(toScalarString(value))}`;
}

/**
 * Serialize a value using the `matrix` path style, percent-encoding scalar
 * components but leaving the `;` and `=` delimiters literal.
 */
function serializeMatrix(name: string, value: unknown, explode: boolean): string {
  const encodedName = encodePathComponent(name);
  if (Array.isArray(value)) {
    const items = value.map((item) => encodePathComponent(toScalarString(item)));
    if (explode) {
      return items.map((item) => `;${encodedName}=${item}`).join("");
    }
    return `;${encodedName}=${items.join(",")}`;
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (explode) {
      return entries
        .map(
          ([key, item]) =>
            `;${encodePathComponent(key)}=${encodePathComponent(toScalarString(item))}`,
        )
        .join("");
    }
    return `;${encodedName}=${entries
      .flatMap(([key, item]) => [
        encodePathComponent(key),
        encodePathComponent(toScalarString(item)),
      ])
      .join(",")}`;
  }
  return `;${encodedName}=${encodePathComponent(toScalarString(value))}`;
}

/** A serialized path value plus whether it is already percent-encoded. */
interface SerializedPathParameter {
  value: string;
  preEncoded: boolean;
}

/**
 * Serialize a path parameter for its effective style. `label`/`matrix` values
 * are already percent-encoded; `simple` and unknown styles stay raw so URL
 * composition keeps encoding them as before.
 */
function serializePathParameter(
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
): SerializedPathParameter {
  if (style === "label") {
    return { value: serializeLabel(value, explode), preEncoded: true };
  }
  if (style === "matrix") {
    return { value: serializeMatrix(name, value, explode), preEncoded: true };
  }
  return { value: serializeSimple(value, explode), preEncoded: false };
}

/** A single serialized query-string entry (name/value pair). */
type QueryEntry = [string, string];

/**
 * Serialize a query parameter to OpenAPI wire entries.
 *
 * The OpenAPI default (`form` + `explode=true`) is implemented: an array yields
 * repeated `name=` entries and an object yields one entry per property. The
 * non-default `spaceDelimited`, `pipeDelimited`, and `deepObject` styles are also
 * supported. `label`/`matrix` are path-only styles and are not applicable here.
 */
function serializeQueryParameter(
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
): QueryEntry[] {
  if (Array.isArray(value)) {
    const items = value.map(toScalarString);
    if (style === "spaceDelimited") {
      return [[name, items.join(" ")]];
    }
    if (style === "pipeDelimited") {
      return [[name, items.join("|")]];
    }
    if (explode) {
      return items.map((item): QueryEntry => [name, item]);
    }
    return [[name, items.join(",")]];
  }

  if (isObject(value)) {
    const entries = Object.entries(value);
    if (style === "deepObject") {
      return entries.map(
        ([key, item]): QueryEntry => [`${name}[${key}]`, toScalarString(item)],
      );
    }
    if (style === "spaceDelimited") {
      return [
        [name, entries.flatMap(([key, item]) => [key, toScalarString(item)]).join(" ")],
      ];
    }
    if (style === "pipeDelimited") {
      return [
        [name, entries.flatMap(([key, item]) => [key, toScalarString(item)]).join("|")],
      ];
    }
    if (explode) {
      return entries.map(([key, item]): QueryEntry => [key, toScalarString(item)]);
    }
    return [
      [name, entries.flatMap(([key, item]) => [key, toScalarString(item)]).join(",")],
    ];
  }

  return [[name, toScalarString(value)]];
}

/** Add a serialized query entry, accumulating repeated keys into a list. */
function addQueryEntry(
  query: Record<string, QueryValue>,
  key: string,
  value: string,
): void {
  const existing = query[key];
  if (existing === undefined) {
    query[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  query[key] = [existing, value];
}

/**
 * Serialize one cookie parameter into a `name=value` pair (SPEC-35).
 *
 * `form` is the only style OpenAPI allows for cookie parameters, so the
 * non-exploded form wire text is used for arrays (`3,4,5`) and objects
 * (`role,admin,firstName,Alex`) and then percent-encoded as a whole, together
 * with the name. Encoding the whole serialized value keeps structural
 * delimiters (`;`, `,`, `=`) from splitting or corrupting the single `Cookie`
 * header. OpenAPI's cookie default is `explode: true`; treating it as `false` is
 * a deliberate, documented deviation.
 */
function serializeCookieParameter(name: string, value: unknown): string {
  const wireValue = serializeSimple(value, false);
  return `${encodeURIComponent(name)}=${encodeURIComponent(wireValue)}`;
}

/** Generate request data for one operation using an already-seeded faker. */
function generateWith(operation: OperationEntry, faker: Faker): GeneratedRequestData {
  const pathParams: Record<string, string> = {};
  const preEncodedPathParams: string[] = [];
  const query: Record<string, QueryValue> = {};
  const headers: Record<string, string> = {};
  const cookies: string[] = [];

  for (const parameter of operation.parameters) {
    if (typeof parameter.name !== "string" || typeof parameter.in !== "string") {
      continue;
    }
    const raw = generateParameterValue(parameter, faker);
    switch (parameter.in) {
      case "path": {
        // `simple` is the path default; `label` and `matrix` are implemented.
        // Other/unknown styles fall back to `simple` without warning.
        const style = parameterStyle(parameter);
        const serialized = serializePathParameter(
          parameter.name,
          raw,
          style,
          parameterExplode(parameter, style),
        );
        pathParams[parameter.name] = serialized.value;
        if (serialized.preEncoded) {
          preEncodedPathParams.push(parameter.name);
        }
        break;
      }
      case "query": {
        const style = parameterStyle(parameter);
        const explode = parameterExplode(parameter, style);
        for (const [key, entry] of serializeQueryParameter(
          parameter.name,
          raw,
          style,
          explode,
        )) {
          addQueryEntry(query, key, entry);
        }
        break;
      }
      case "header":
        headers[parameter.name] = serializeSimple(
          raw,
          parameterExplode(parameter, parameterStyle(parameter)),
        );
        break;
      case "cookie":
        cookies.push(serializeCookieParameter(parameter.name, raw));
        break;
      default:
        // Unknown parameter locations are not generated.
        break;
    }
  }

  // All generated cookie parameters ride exactly one `Cookie` header, in
  // declaration order (SPEC-35). A declared `Cookie` header parameter keeps its
  // explicit value, and an `auth.headers` `Cookie` wins later through the
  // existing SPEC-5 collision precedence.
  if (
    cookies.length > 0 &&
    !Object.keys(headers).some((name) => name.toLowerCase() === "cookie")
  ) {
    headers.Cookie = cookies.join("; ");
  }

  const result: GeneratedRequestData = {
    method: operation.method,
    path: operation.path,
    pathParams,
    query,
    headers,
  };
  if (preEncodedPathParams.length > 0) {
    result.preEncodedPathParams = preEncodedPathParams;
  }

  const body = generateRequestBody(operation.requestBody, faker);
  if (body !== undefined) {
    result.body = body;
  }
  return result;
}

/**
 * Generate request data for a single operation.
 *
 * The generator is seeded from `options.seed` (default {@link DEFAULT_SEED}), so
 * repeated calls with the same seed produce identical output.
 */
export function generateRequestData(
  operation: OperationEntry,
  options: GenerateOptions = {},
): GeneratedRequestData {
  return generateWith(operation, createFaker(options.seed));
}

/**
 * Generate request data for several operations in order.
 *
 * A single seeded faker is shared across the operations so that each operation
 * draws a distinct (but reproducible) sequence of values.
 */
export function generateAllRequestData(
  operations: OperationEntry[],
  options: GenerateOptions = {},
): GeneratedRequestData[] {
  const faker = createFaker(options.seed);
  return operations.map((operation) => generateWith(operation, faker));
}

/** The result of applying configured payload overrides. */
export interface PayloadOverrideResult {
  /** The request data with matching bodies replaced, in the original order. */
  requests: GeneratedRequestData[];
  /**
   * Non-fatal warnings for overrides that matched no generated operation. The
   * caller surfaces these on stderr (SPEC-8 style); they never fail the run.
   */
  warnings: string[];
}

/** The normalized `METHOD path` key shared with operation selection (SPEC-13). */
function operationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * Apply `payloads` overrides to the generated request data (SPEC-13).
 *
 * Matching uses the same normalized key as operation selection: the method is
 * upper-cased and the path is the OpenAPI path template, e.g. `POST /pets`.
 * `body` is a **whole-value replacement** for the generated JSON body — there is
 * no deep merge and all other generated request fields are preserved.
 *
 * Overrides that match no entry in `requests` (because the operation was not
 * selected, or is absent from the loaded spec) are reported in `warnings` and
 * otherwise ignored. When `payloads` is absent or empty the input array is
 * returned unchanged, so the no-override path is byte-identical to before.
 */
export function applyPayloadOverrides(
  requests: GeneratedRequestData[],
  payloads: readonly PayloadOverride[] | undefined,
): PayloadOverrideResult {
  if (payloads === undefined || payloads.length === 0) {
    return { requests, warnings: [] };
  }

  const overrides = new Map<string, PayloadOverride>();
  for (const override of payloads) {
    overrides.set(operationKey(override.method, override.path), override);
  }

  const applied = new Set<string>();
  const result = requests.map((request) => {
    const key = operationKey(request.method, request.path);
    const override = overrides.get(key);
    if (override === undefined) {
      return request;
    }
    applied.add(key);
    return { ...request, body: override.body };
  });

  const warnings: string[] = [];
  for (const override of payloads) {
    const key = operationKey(override.method, override.path);
    if (!applied.has(key)) {
      warnings.push(
        `payload override for "${key}" does not match any selected operation; ignoring.`,
      );
    }
  }

  return { requests: result, warnings };
}
