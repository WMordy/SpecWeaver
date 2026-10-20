import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_SEED,
  applyPayloadOverrides,
  createFaker,
  generateAllRequestData,
  generateFromSchema,
  generateRequestData,
} from "../dist/request-data.js";
import { loadSpec } from "../dist/spec.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Build a minimal resolved operation entry. */
function operation(overrides = {}) {
  return {
    method: "POST",
    path: "/pets",
    parameters: [],
    security: [],
    ...overrides,
  };
}

/** Build a JSON request body whose media schema is `schema`. */
function jsonBody(schema, media = {}) {
  return {
    content: {
      "application/json": { schema, ...media },
    },
  };
}

test("generates values for path, query, and header parameters", () => {
  const data = generateRequestData(
    operation({
      path: "/pets/{petId}",
      parameters: [
        { name: "petId", in: "path", required: true, schema: { type: "string" } },
        { name: "limit", in: "query", required: false, schema: { type: "integer" } },
        {
          name: "X-Request-Id",
          in: "header",
          required: false,
          schema: { type: "string", format: "uuid" },
        },
      ],
    }),
  );

  assert.equal(typeof data.pathParams.petId, "string");
  assert.ok(data.pathParams.petId.length > 0);
  assert.equal(typeof data.query.limit, "string");
  assert.ok(Number.isInteger(Number(data.query.limit)));
  assert.match(data.headers["X-Request-Id"], UUID_RE);
});

test("carries the operation's method and path", () => {
  const data = generateRequestData(operation({ method: "PUT", path: "/pets/{id}" }));
  assert.equal(data.method, "PUT");
  assert.equal(data.path, "/pets/{id}");
});

test("omits cookie parameters (out of scope for v1)", () => {
  const data = generateRequestData(
    operation({
      parameters: [{ name: "session", in: "cookie", schema: { type: "string" } }],
    }),
  );
  assert.deepEqual(data.query, {});
  assert.deepEqual(data.headers, {});
  assert.deepEqual(data.pathParams, {});
});

test("generates a JSON request body for an operation", () => {
  const data = generateRequestData(
    operation({
      requestBody: jsonBody({
        type: "object",
        properties: { name: { type: "string" }, age: { type: "integer" } },
      }),
    }),
  );

  assert.equal(typeof data.body, "object");
  assert.equal(typeof data.body.name, "string");
  assert.ok(Number.isInteger(data.body.age));
});

test("ignores non-JSON request bodies (multipart/form-data)", () => {
  const data = generateRequestData(
    operation({
      requestBody: {
        content: {
          "multipart/form-data": { schema: { type: "object", properties: {} } },
        },
      },
    }),
  );

  assert.equal(data.body, undefined);
  assert.ok(!("body" in data));
});

test("prefers a parameter-level example over the schema's faker value", () => {
  const data = generateRequestData(
    operation({
      parameters: [
        { name: "limit", in: "query", example: 25, schema: { type: "integer" } },
        {
          name: "X-Trace",
          in: "header",
          example: "trace-abc",
          schema: { type: "string", format: "uuid" },
        },
      ],
    }),
  );

  assert.equal(data.query.limit, "25");
  assert.equal(data.headers["X-Trace"], "trace-abc");
});

test("prefers a parameter-level example over a schema-level example", () => {
  const data = generateRequestData(
    operation({
      parameters: [
        {
          name: "limit",
          in: "query",
          example: 10,
          schema: { type: "integer", example: 99 },
        },
      ],
    }),
  );

  assert.equal(data.query.limit, "10");
});

test("reads a parameter's examples map (first entry's value)", () => {
  const data = generateRequestData(
    operation({
      parameters: [
        {
          name: "status",
          in: "query",
          examples: { active: { value: "active" }, archived: { value: "archived" } },
          schema: { type: "string" },
        },
      ],
    }),
  );

  assert.equal(data.query.status, "active");
});

test("prefers a schema-level example for a parameter when no parameter example exists", () => {
  const data = generateRequestData(
    operation({
      parameters: [
        { name: "page", in: "query", schema: { type: "integer", example: 7 } },
      ],
    }),
  );

  assert.equal(data.query.page, "7");
});

test("prefers a media-type example for the body when present", () => {
  const data = generateRequestData(
    operation({
      requestBody: jsonBody(
        { type: "object", properties: { name: { type: "string" } } },
        { example: { name: "Fido" } },
      ),
    }),
  );

  assert.deepEqual(data.body, { name: "Fido" });
});

test("reads a media-type examples map for the body", () => {
  const data = generateRequestData(
    operation({
      requestBody: jsonBody(
        { type: "object", properties: {} },
        { examples: { first: { value: { name: "FromExamples" } } } },
      ),
    }),
  );

  assert.deepEqual(data.body, { name: "FromExamples" });
});

test("prefers a schema-level example for the body when the media type has none", () => {
  const data = generateRequestData(
    operation({
      requestBody: jsonBody({
        type: "object",
        properties: { name: { type: "string" } },
        example: { name: "FromSchema" },
      }),
    }),
  );

  assert.deepEqual(data.body, { name: "FromSchema" });
});

test("falls back to schema `default` values when no example is present", () => {
  const data = generateRequestData(
    operation({
      parameters: [
        { name: "page", in: "query", schema: { type: "integer", default: 1 } },
      ],
      requestBody: jsonBody({
        type: "object",
        properties: {
          status: { type: "string", default: "active" },
          retries: { type: "integer", default: 0 },
        },
      }),
    }),
  );

  assert.equal(data.query.page, "1");
  assert.equal(data.body.status, "active");
  assert.equal(data.body.retries, 0);
});

test("falls back to faker.js based on JSON Schema type and format", () => {
  const data = generateRequestData(
    operation({
      requestBody: jsonBody({
        type: "object",
        properties: {
          name: { type: "string" },
          id: { type: "string", format: "uuid" },
          email: { type: "string", format: "email" },
          birthday: { type: "string", format: "date" },
          createdAt: { type: "string", format: "date-time" },
          count: { type: "integer" },
          ratio: { type: "number" },
          active: { type: "boolean" },
          role: { type: "string", enum: ["admin", "user"] },
          tags: { type: "array", items: { type: "string" } },
        },
      }),
    }),
  );

  const body = data.body;
  assert.ok(typeof body.name === "string" && body.name.length > 0);
  assert.match(body.id, UUID_RE);
  assert.match(body.email, /@/);
  assert.match(body.birthday, DATE_RE);
  assert.match(body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(!Number.isNaN(Date.parse(body.createdAt)));
  assert.ok(Number.isInteger(body.count));
  assert.equal(typeof body.ratio, "number");
  assert.equal(typeof body.active, "boolean");
  assert.ok(["admin", "user"].includes(body.role));
  assert.ok(Array.isArray(body.tags));
  assert.equal(body.tags.length, 2);
  assert.ok(body.tags.every((tag) => typeof tag === "string"));
});

test("generates enum values from the enum alone, without a type", () => {
  const data = generateRequestData(
    operation({
      requestBody: jsonBody({
        type: "object",
        properties: { colour: { enum: ["red", "green", "blue"] } },
      }),
    }),
  );

  assert.ok(["red", "green", "blue"].includes(data.body.colour));
});

test("always generates both required and optional parameters", () => {
  const data = generateRequestData(
    operation({
      parameters: [
        {
          name: "requiredQuery",
          in: "query",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "optionalQuery",
          in: "query",
          required: false,
          schema: { type: "string" },
        },
        {
          name: "X-Required",
          in: "header",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "X-Optional",
          in: "header",
          required: false,
          schema: { type: "string" },
        },
      ],
    }),
  );

  assert.deepEqual(Object.keys(data.query).sort(), [
    "optionalQuery",
    "requiredQuery",
  ]);
  assert.deepEqual(Object.keys(data.headers).sort(), ["X-Optional", "X-Required"]);
});

test("always generates both required and optional body fields", () => {
  const data = generateRequestData(
    operation({
      requestBody: jsonBody({
        type: "object",
        required: ["requiredField"],
        properties: {
          requiredField: { type: "string" },
          optionalField: { type: "string" },
        },
      }),
    }),
  );

  assert.deepEqual(Object.keys(data.body).sort(), ["optionalField", "requiredField"]);
  assert.equal(typeof data.body.optionalField, "string");
});

test("recursively generates nested objects and arrays-of-objects, including optional nested fields", () => {
  const data = generateRequestData(
    operation({
      requestBody: jsonBody({
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          profile: {
            type: "object",
            properties: {
              nickname: { type: "string" },
              address: {
                type: "object",
                properties: {
                  city: { type: "string" },
                  zip: { type: "string" },
                },
              },
            },
          },
          friends: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                age: { type: "integer" },
              },
            },
          },
        },
      }),
    }),
  );

  const body = data.body;
  assert.equal(typeof body.profile.nickname, "string");
  assert.equal(typeof body.profile.address.city, "string");
  assert.equal(typeof body.profile.address.zip, "string");
  assert.ok(Array.isArray(body.friends));
  assert.equal(body.friends.length, 2);
  for (const friend of body.friends) {
    assert.equal(typeof friend.name, "string");
    assert.ok(Number.isInteger(friend.age));
  }
});

test("generated values are deterministic for a given faker seed", () => {
  const op = operation({
    path: "/pets/{petId}",
    parameters: [
      { name: "petId", in: "path", required: true, schema: { type: "string" } },
      { name: "limit", in: "query", schema: { type: "integer" } },
    ],
    requestBody: jsonBody({
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        name: { type: "string" },
        friends: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" } } },
        },
      },
    }),
  });

  assert.deepEqual(
    generateRequestData(op, { seed: 42 }),
    generateRequestData(op, { seed: 42 }),
  );
});

test("uses the default seed when none is supplied, deterministically", () => {
  const op = operation({
    requestBody: jsonBody({
      type: "object",
      properties: { id: { type: "string", format: "uuid" } },
    }),
  });

  const data = generateRequestData(op);
  const expected = generateRequestData(op, { seed: DEFAULT_SEED });
  assert.deepEqual(data, expected);
});

test("generateAllRequestData shares a seeded sequence and is deterministic", () => {
  const ops = [
    operation({
      method: "GET",
      path: "/pets",
      parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
    }),
    operation({
      method: "POST",
      path: "/pets",
      requestBody: jsonBody({
        type: "object",
        properties: { name: { type: "string" } },
      }),
    }),
  ];

  const first = generateAllRequestData(ops, { seed: 7 });
  const second = generateAllRequestData(ops, { seed: 7 });

  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  assert.equal(first[0].method, "GET");
  assert.equal(first[1].method, "POST");
});

test("generateFromSchema exposes the same example/default/faker priority", () => {
  const faker = createFaker(1);

  assert.deepEqual(generateFromSchema({ type: "string", example: "ex" }, faker), "ex");
  assert.deepEqual(generateFromSchema({ type: "integer", default: 3 }, faker), 3);
  assert.equal(typeof generateFromSchema({ type: "string" }, faker), "string");
});

test("date and date-time are deterministic for a seed and use a fixed reference window", () => {
  const op = operation({
    requestBody: jsonBody({
      type: "object",
      properties: {
        birthday: { type: "string", format: "date" },
        createdAt: { type: "string", format: "date-time" },
      },
    }),
  });

  const first = generateRequestData(op, { seed: 42 });
  const second = generateRequestData(op, { seed: 42 });

  assert.deepEqual(first, second);
  // A wall-clock reference would land near today (2026); the fixed window is 2020.
  assert.match(first.body.birthday, /^2020-\d{2}-\d{2}$/);
  assert.match(first.body.createdAt, /^2020-\d{2}-\d{2}T/);
});

test("date-time determinism does not depend on the wall-clock date", () => {
  const op = operation({
    requestBody: jsonBody({
      type: "object",
      properties: { createdAt: { type: "string", format: "date-time" } },
    }),
  });

  // Two calls separated by real time must still agree; the old `anytime()`
  // wall-clock default made the millisecond/second component drift.
  const before = generateRequestData(op, { seed: 7 });
  const start = Date.now();
  while (Date.now() - start < 5) {
    // busy-wait a few milliseconds to cross a potential time boundary
  }
  const after = generateRequestData(op, { seed: 7 });

  assert.deepEqual(before, after);
});

test("allOf merges member object properties (schema-valid object output)", () => {
  const data = generateRequestData(
    operation({
      requestBody: jsonBody({
        type: "object",
        allOf: [
          {
            type: "object",
            properties: {
              id: { type: "string", format: "uuid" },
              name: { type: "string" },
            },
            required: ["id"],
          },
          {
            type: "object",
            properties: { age: { type: "integer", minimum: 0, maximum: 120 } },
            required: ["age"],
          },
        ],
      }),
    }),
  );

  assert.equal(typeof data.body, "object");
  assert.match(data.body.id, UUID_RE);
  assert.equal(typeof data.body.name, "string");
  assert.ok(Number.isInteger(data.body.age));
  assert.ok(data.body.age >= 0 && data.body.age <= 120);
});

test("allOf applies later members' scalar constraints over earlier ones", () => {
  const data = generateRequestData(
    operation({
      requestBody: jsonBody({
        allOf: [
          { type: "integer", minimum: 10 },
          { minimum: 50, maximum: 60 },
        ],
      }),
    }),
  );

  assert.ok(Number.isInteger(data.body));
  assert.ok(data.body >= 50 && data.body <= 60);
});

test("allOf example on a member still wins over synthesis", () => {
  const data = generateRequestData(
    operation({
      requestBody: jsonBody({
        allOf: [
          { type: "object", properties: { name: { type: "string" } } },
          { type: "object", example: { name: "FromAllOf" } },
        ],
      }),
    }),
  );

  assert.deepEqual(data.body, { name: "FromAllOf" });
});

test("oneOf picks the first branch and produces a schema-valid value", () => {
  const data = generateRequestData(
    operation({
      requestBody: jsonBody({
        oneOf: [
          { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
          { type: "object", properties: { b: { type: "integer" } }, required: ["b"] },
        ],
      }),
    }),
  );

  assert.equal(typeof data.body, "object");
  assert.equal(typeof data.body.a, "string");
  assert.ok(!("b" in data.body));
});

test("anyOf picks the first branch and produces a schema-valid value", () => {
  const data = generateRequestData(
    operation({
      requestBody: jsonBody({
        anyOf: [
          { type: "object", properties: { first: { type: "string" } } },
          { type: "array", items: { type: "string" } },
        ],
      }),
    }),
  );

  assert.equal(typeof data.body, "object");
  assert.equal(typeof data.body.first, "string");
});

test("serializes an exploded array query parameter as repeated keys", () => {
  const data = generateRequestData(
    operation({
      parameters: [
        {
          name: "tag",
          in: "query",
          schema: { type: "array", items: { type: "string" }, example: ["a", "b", "c"] },
        },
      ],
    }),
  );

  assert.deepEqual(data.query.tag, ["a", "b", "c"]);
});

test("serializes a non-exploded array query parameter as a comma-joined string", () => {
  const data = generateRequestData(
    operation({
      parameters: [
        {
          name: "tag",
          in: "query",
          style: "form",
          explode: false,
          schema: { type: "array", items: { type: "string" }, example: ["a", "b"] },
        },
      ],
    }),
  );

  assert.equal(data.query.tag, "a,b");
});

test("serializes an exploded object query parameter as per-property entries", () => {
  const data = generateRequestData(
    operation({
      parameters: [
        {
          name: "filter",
          in: "query",
          schema: {
            type: "object",
            properties: { role: { type: "string" }, age: { type: "integer" } },
            example: { role: "admin", age: 30 },
          },
        },
      ],
    }),
  );

  assert.equal(data.query.role, "admin");
  assert.equal(data.query.age, "30");
  assert.ok(!("filter" in data.query));
});

test("serializes path and header array/object parameters with the simple style", () => {
  const data = generateRequestData(
    operation({
      path: "/pets/{ids}/{filter}",
      parameters: [
        {
          name: "ids",
          in: "path",
          schema: { type: "array", items: { type: "integer" }, example: [3, 4, 5] },
        },
        {
          name: "filter",
          in: "path",
          schema: {
            type: "object",
            properties: { role: { type: "string" } },
            example: { role: "admin" },
          },
        },
        {
          name: "X-Ids",
          in: "header",
          schema: { type: "array", items: { type: "integer" }, example: [1, 2] },
        },
      ],
    }),
  );

  assert.equal(data.pathParams.ids, "3,4,5");
  assert.equal(data.pathParams.filter, "role,admin");
  assert.equal(data.headers["X-Ids"], "1,2");
});

test("respects integer minimum and maximum", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const data = generateRequestData(
      operation({
        requestBody: jsonBody({
          type: "object",
          properties: { n: { type: "integer", minimum: 100, maximum: 110 } },
        }),
      }),
      { seed },
    );
    assert.ok(data.body.n >= 100 && data.body.n <= 110, `got ${data.body.n}`);
  }
});

test("respects integer format int32 bounds", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const data = generateRequestData(
      operation({
        requestBody: jsonBody({
          type: "object",
          properties: { n: { type: "integer", format: "int32" } },
        }),
      }),
      { seed },
    );
    assert.ok(data.body.n >= -2147483648 && data.body.n <= 2147483647);
    assert.ok(Number.isSafeInteger(data.body.n));
  }
});

test("respects integer format int64 and multipleOf", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const data = generateRequestData(
      operation({
        requestBody: jsonBody({
          type: "object",
          properties: {
            n: { type: "integer", format: "int64" },
            step: { type: "integer", minimum: 10, maximum: 100, multipleOf: 5 },
          },
        }),
      }),
      { seed },
    );
    assert.ok(Number.isSafeInteger(data.body.n));
    assert.equal(data.body.step % 5, 0);
    assert.ok(data.body.step >= 10 && data.body.step <= 100);
  }
});

test("respects number minimum, maximum, and multipleOf", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const data = generateRequestData(
      operation({
        requestBody: jsonBody({
          type: "object",
          properties: {
            ratio: { type: "number", minimum: 1, maximum: 2 },
            price: { type: "number", minimum: 0, maximum: 100, multipleOf: 0.5 },
          },
        }),
      }),
      { seed },
    );
    assert.ok(data.body.ratio >= 1 && data.body.ratio <= 2);
    assert.ok(data.body.price >= 0 && data.body.price <= 100);
    assert.equal(Math.round(data.body.price / 0.5) * 0.5, data.body.price);
  }
});

test("seals a one-sided number minimum (no maximum)", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const data = generateRequestData(
      operation({
        requestBody: jsonBody({
          type: "object",
          properties: { atLeast: { type: "number", minimum: 1000 } },
        }),
      }),
      { seed },
    );
    assert.ok(
      typeof data.body.atLeast === "number" && data.body.atLeast >= 1000,
      `got ${data.body.atLeast}`,
    );
  }
});

test("seals a one-sided number maximum (no minimum)", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const data = generateRequestData(
      operation({
        requestBody: jsonBody({
          type: "object",
          properties: { atMost: { type: "number", maximum: -5 } },
        }),
      }),
      { seed },
    );
    assert.ok(
      typeof data.body.atMost === "number" && data.body.atMost <= -5,
      `got ${data.body.atMost}`,
    );
  }
});

test("seals a one-sided integer minimum (no maximum)", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const data = generateRequestData(
      operation({
        requestBody: jsonBody({
          type: "object",
          properties: { atLeast: { type: "integer", minimum: 1000 } },
        }),
      }),
      { seed },
    );
    assert.ok(Number.isInteger(data.body.atLeast) && data.body.atLeast >= 1000);
  }
});

test("seals a one-sided integer maximum (no minimum)", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const data = generateRequestData(
      operation({
        requestBody: jsonBody({
          type: "object",
          properties: { atMost: { type: "integer", maximum: -5 } },
        }),
      }),
      { seed },
    );
    assert.ok(Number.isInteger(data.body.atMost) && data.body.atMost <= -5);
  }
});

test("number multipleOf is honoured when an in-range multiple exists", () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const data = generateRequestData(
      operation({
        requestBody: jsonBody({
          type: "object",
          properties: {
            price: { type: "number", minimum: 1, maximum: 5, multipleOf: 0.25 },
          },
        }),
      }),
      { seed },
    );
    const value = data.body.price;
    assert.ok(value >= 1 && value <= 5, `got ${value}`);
    assert.equal(Math.round(value / 0.25) * 0.25, value);
  }
});

test("terminates deterministically on a cyclic $ref schema through loadSpec -> generateRequestData", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-reqdata-"));
  const path = join(dir, "openapi.yaml");
  writeFileSync(
    path,
    `openapi: 3.1.0
info:
  title: Node
  version: 1.0.0
paths:
  /nodes:
    post:
      operationId: createNode
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Node'
      responses:
        '200':
          description: ok
components:
  schemas:
    Node:
      type: object
      properties:
        name:
          type: string
        next:
          $ref: '#/components/schemas/Node'
`,
  );

  const [op] = loadSpec(path).operations;

  const first = generateRequestData(op, { seed: 42 });
  const second = generateRequestData(op, { seed: 42 });

  // Must terminate with a plain value (no RangeError) and be reproducible.
  assert.deepEqual(first, second);
  assert.equal(typeof first.body, "object");
  assert.equal(typeof first.body.name, "string");
  assert.deepEqual(first.body.next, {}, "the cyclic branch is truncated, not infinite");
});

test("terminates on a cyclic $ref array schema through loadSpec -> generateRequestData", () => {
  const dir = mkdtempSync(join(tmpdir(), "specweaver-reqdata-"));
  const path = join(dir, "openapi.yaml");
  writeFileSync(
    path,
    `openapi: 3.1.0
info:
  title: Tree
  version: 1.0.0
paths:
  /trees:
    post:
      operationId: createTree
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Node'
      responses:
        '200':
          description: ok
components:
  schemas:
    Node:
      type: object
      properties:
        value:
          type: string
        children:
          type: array
          items:
            $ref: '#/components/schemas/Node'
`,
  );

  const [op] = loadSpec(path).operations;
  const data = generateRequestData(op, { seed: 1 });

  assert.equal(typeof data.body.value, "string");
  assert.ok(Array.isArray(data.body.children));
  // The first level of children is generated; the cyclic grandchild branch is
  // cut (truncated to an empty object) rather than recursing forever.
  assert.deepEqual(
    data.body.children,
    [{}, {}],
    "the recursive array branch is truncated, not infinite",
  );
});

// --- SPEC-13: payload overrides -------------------------------------------

/** A generated POST /pets request carrying a faker/example body. */
function postPetsRequest() {
  return generateRequestData(
    operation({
      method: "POST",
      path: "/pets",
      requestBody: jsonBody({
        type: "object",
        properties: {
          name: { type: "string", example: "GeneratedName" },
          tag: { type: "string", example: "generated-tag" },
        },
      }),
    }),
  );
}

test("a matching payload body replaces the generated JSON body wholesale", () => {
  const generated = postPetsRequest();
  assert.deepEqual(generated.body, {
    name: "GeneratedName",
    tag: "generated-tag",
  });

  const overrideBody = { name: "DistinctiveOverrideValue" };
  const { requests, warnings } = applyPayloadOverrides([generated], [
    { method: "POST", path: "/pets", body: overrideBody },
  ]);

  assert.deepEqual(warnings, []);
  assert.deepEqual(requests[0].body, overrideBody);
  // Whole-value replacement: the generated `tag` is gone, not merged in.
  assert.equal("tag" in requests[0].body, false);
  // Non-body request data is preserved.
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, "/pets");
});

test("payload override matching normalizes method case", () => {
  const generated = postPetsRequest();

  const lower = applyPayloadOverrides([generated], [
    { method: "post", path: "/pets", body: { name: "lower" } },
  ]);
  const upper = applyPayloadOverrides([generated], [
    { method: "POST", path: "/pets", body: { name: "lower" } },
  ]);

  assert.deepEqual(lower.warnings, []);
  assert.deepEqual(lower.requests[0].body, { name: "lower" });
  assert.deepEqual(lower.requests, upper.requests);
});

test("an override for an unselected operation warns and changes nothing", () => {
  const generated = postPetsRequest();

  const { requests, warnings } = applyPayloadOverrides([generated], [
    { method: "DELETE", path: "/pets", body: { name: "never-applied" } },
  ]);

  assert.deepEqual(requests, [generated]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /payload override for "DELETE \/pets"/);
  assert.match(warnings[0], /does not match any selected operation/);
});

test("no payloads leaves generated request data byte-identical", () => {
  const generated = [
    postPetsRequest(),
    generateRequestData(
      operation({
        method: "GET",
        path: "/pets",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" } },
        ],
      }),
    ),
  ];

  for (const payloads of [undefined, []]) {
    const { requests, warnings } = applyPayloadOverrides(generated, payloads);
    assert.deepEqual(warnings, []);
    assert.equal(JSON.stringify(requests), JSON.stringify(generated));
    assert.deepEqual(requests, generated);
  }
});

