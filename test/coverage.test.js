import assert from "node:assert/strict";
import test from "node:test";

import { resolveOperationAuth } from "../dist/auth.js";
import { buildCoverageWarnings } from "../dist/coverage.js";

/** A minimal operation entry; `overrides` replaces the gap-bearing fields. */
function operation(overrides = {}) {
  return {
    method: "GET",
    path: "/pets",
    parameters: [],
    security: [],
    ...overrides,
  };
}

/** Resolved auth for one operation, aligned for `buildCoverageWarnings`. */
function authState(op, auth) {
  return resolveOperationAuth(op, auth, {});
}

/** All messages emitted for one operation with the given auth. */
function warningsFor(overrides, auth) {
  const op = operation(overrides);
  return buildCoverageWarnings([op], [authState(op, auth)]);
}

test("buildCoverageWarnings is pure and returns no warnings for a modelable operation", () => {
  const operationWithJsonBody = operation({
    requestBody: {
      required: true,
      content: {
        "application/json": { schema: { type: "object" } },
      },
    },
    parameters: [
      { name: "limit", in: "query" },
      { name: "X-Trace", in: "header" },
    ],
  });

  assert.deepEqual(buildCoverageWarnings([operationWithJsonBody], []), []);
  assert.deepEqual(buildCoverageWarnings([], []), []);
});

test("required unsupported request bodies warn once and name the declared media types", () => {
  for (const [content, declared] of [
    [{ "text/csv": {} }, '"text/csv"'],
    [
      { "application/octet-stream": {}, "text/plain": {} },
      '"application/octet-stream", "text/plain"',
    ],
  ]) {
    const warnings = warningsFor({
      method: "POST",
      path: "/pets",
      requestBody: { required: true, content },
    });
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0], /^operation "POST \/pets" requires a request body/);
    assert.ok(warnings[0].includes(declared), warnings[0]);
    assert.match(warnings[0], /without a body/);
  }
});

test("a required body with empty or missing content warns as unsupported", () => {
  for (const requestBody of [{ required: true }, { required: true, content: {} }]) {
    const warnings = warningsFor({ requestBody });
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0], /declares none of the supported media types/);
    assert.match(warnings[0], /\(declared: none\)/);
  }
});

test("optional unsupported bodies and supported bodies do not warn", () => {
  for (const requestBody of [
    { content: { "text/csv": {} } },
    { required: false, content: { "text/csv": {} } },
    { required: false, content: { "application/xml": {} } },
    { required: false, content: { "multipart/form-data": {} } },
    { required: false, content: { "application/x-www-form-urlencoded": {} } },
    { required: true, content: { "text/csv": {}, "application/xml": {} } },
    { required: true, content: { "text/csv": {}, "application/json": {} } },
    { required: true, content: { "application/json": {} } },
    { required: true, content: { "application/problem+json": {} } },
    { required: true, content: { "application/x-www-form-urlencoded": {} } },
    { required: true, content: { "multipart/form-data": {} } },
    { required: true, content: { "application/xml": {} } },
  ]) {
    assert.deepEqual(warningsFor({ requestBody }), [], JSON.stringify(requestBody));
  }
});

test("cookie parameters are generated and no longer warn (SPEC-35)", () => {
  assert.deepEqual(
    warningsFor({
      method: "GET",
      path: "/pets",
      parameters: [
        { name: "session", in: "cookie", required: true },
        { name: "theme", in: "cookie" },
        { name: "limit", in: "query" },
      ],
    }),
    [],
  );
});

const BEARER_SCHEMES = { bearerAuth: { type: "http", scheme: "bearer" } };

test("a secured operation with a configured token does not warn", () => {
  assert.deepEqual(
    warningsFor({ security: [{ bearerAuth: [] }], securitySchemes: BEARER_SCHEMES }, {
      token: "abc",
    }),
    [],
  );
  // `token: ""` still injects a bearer header, so it also suppresses the warning.
  assert.deepEqual(
    warningsFor({ security: [{ bearerAuth: [] }], securitySchemes: BEARER_SCHEMES }, {
      token: "",
    }),
    [],
  );
});

test("a secured operation without a usable credential warns once, naming the scheme", () => {
  const warnings = warningsFor(
    { security: [{ bearerAuth: [] }], securitySchemes: BEARER_SCHEMES },
    undefined,
  );

  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /^operation "GET \/pets" declares bearer scheme "bearerAuth"/);
  assert.match(warnings[0], /no auth\.token/);
  assert.match(warnings[0], /without that credential/);
});

test("an undefined scheme reference warns once, naming the scheme", () => {
  const warnings = warningsFor({ security: [{ missing: [] }] }, undefined);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /references undefined scheme "missing"/);
});

test("security: [] and empty requirements never warn", () => {
  assert.deepEqual(warningsFor({ security: [] }, undefined), []);
  assert.deepEqual(warningsFor({ security: [{}] }, undefined), []);
});

test("warnings follow operation order and body -> auth within an operation", () => {
  const operations = [
    operation({
      method: "POST",
      path: "/first",
      requestBody: { required: true, content: { "text/csv": {} } },
      parameters: [{ name: "session", in: "cookie" }],
      security: [{ bearerAuth: [] }],
      securitySchemes: BEARER_SCHEMES,
    }),
    operation({
      method: "GET",
      path: "/second",
      security: [{ bearerAuth: [] }],
      securitySchemes: BEARER_SCHEMES,
    }),
  ];
  const states = operations.map((op) => authState(op, undefined));

  const warnings = buildCoverageWarnings(operations, states);
  assert.equal(warnings.length, 3, JSON.stringify(warnings));
  assert.match(warnings[0], /^operation "POST \/first" requires a request body/);
  assert.match(warnings[1], /^operation "POST \/first" declares bearer scheme/);
  assert.match(warnings[2], /^operation "GET \/second" declares bearer scheme/);

  // Repeated calls over the same inputs are identical.
  assert.deepEqual(buildCoverageWarnings(operations, states), warnings);
});
