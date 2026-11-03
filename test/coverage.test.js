import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuthHeaders } from "../dist/auth.js";
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

/** All messages emitted for one operation, with no auth configured. */
function warningsFor(overrides) {
  return buildCoverageWarnings([operation(overrides)], {});
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

  assert.deepEqual(buildCoverageWarnings([operationWithJsonBody], {}), []);
  assert.deepEqual(buildCoverageWarnings([], {}), []);
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

test("declared security with no configured auth warns once", () => {
  const warnings = warningsFor({
    method: "GET",
    path: "/pets",
    security: [{ bearerAuth: [] }],
  });

  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /^operation "GET \/pets" declares security/);
  assert.match(warnings[0], /no auth is configured/);
  assert.match(warnings[0], /without authentication/);
});

test("security: [] never warns", () => {
  assert.deepEqual(warningsFor({ security: [] }), []);
});

test("any configured token (including an empty one) or header suppresses the auth warning", () => {
  const secured = operation({ security: [{ bearerAuth: [] }] });

  // A configured token — even `token: ""` — still injects a bearer header.
  for (const auth of [
    { token: "" },
    { token: "abc" },
    { headers: { "X-Api-Key": "" } },
    {},
  ]) {
    const headers = resolveAuthHeaders(auth, {}).headers;
    const warnings = buildCoverageWarnings([secured], headers);
    assert.equal(
      warnings.length,
      auth.headers === undefined && auth.token === undefined ? 1 : 0,
      JSON.stringify({ auth, headers, warnings }),
    );
  }
});

test("warnings follow operation order and body -> security within an operation", () => {
  const operations = [
    operation({
      method: "POST",
      path: "/first",
      requestBody: { required: true, content: { "text/csv": {} } },
      parameters: [{ name: "session", in: "cookie" }],
      security: [{ bearerAuth: [] }],
    }),
    operation({
      method: "GET",
      path: "/second",
      security: [{ bearerAuth: [] }],
    }),
  ];

  const warnings = buildCoverageWarnings(operations, {});
  assert.equal(warnings.length, 3, JSON.stringify(warnings));
  assert.match(warnings[0], /^operation "POST \/first" requires a request body/);
  assert.match(warnings[1], /^operation "POST \/first" declares security/);
  assert.match(warnings[2], /^operation "GET \/second" declares security/);

  // Repeated calls over the same inputs are identical.
  assert.deepEqual(buildCoverageWarnings(operations, {}), warnings);
});
