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

test("required non-JSON request bodies warn once and name the declared media types", () => {
  for (const [content, declared] of [
    [{ "application/xml": {} }, '"application/xml"'],
    [
      { "multipart/form-data": {}, "text/plain": {} },
      '"multipart/form-data", "text/plain"',
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

test("a required body with empty or missing content warns as non-JSON", () => {
  for (const requestBody of [{ required: true }, { required: true, content: {} }]) {
    const warnings = warningsFor({ requestBody });
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0], /declares no JSON media type \(declared: none\)/);
  }
});

test("optional non-JSON bodies and JSON bodies (including +json) do not warn", () => {
  for (const requestBody of [
    { content: { "application/xml": {} } },
    { required: false, content: { "application/xml": {} } },
    { required: true, content: { "application/json": {} } },
    { required: true, content: { "application/problem+json": {} } },
  ]) {
    assert.deepEqual(warningsFor({ requestBody }), [], JSON.stringify(requestBody));
  }
});

test("cookie parameters warn once per operation naming every cookie name", () => {
  const warnings = warningsFor({
    method: "GET",
    path: "/pets",
    parameters: [
      { name: "session", in: "cookie", required: true },
      { name: "theme", in: "cookie" },
      { name: "limit", in: "query" },
    ],
  });

  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /^operation "GET \/pets" declares cookie parameter/);
  assert.ok(warnings[0].includes('"session", "theme"'), warnings[0]);
  assert.doesNotMatch(warnings[0], /limit/);
});

test("operations without cookie parameters do not warn", () => {
  assert.deepEqual(
    warningsFor({
      parameters: [
        { name: "limit", in: "query" },
        { name: "id", in: "path" },
        { name: "X-Trace", in: "header" },
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

test("warnings follow operation order and body -> cookies -> security within an operation", () => {
  const operations = [
    operation({
      method: "POST",
      path: "/first",
      requestBody: { required: true, content: { "application/xml": {} } },
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
  assert.equal(warnings.length, 4, JSON.stringify(warnings));
  assert.match(warnings[0], /^operation "POST \/first" requires a request body/);
  assert.match(warnings[1], /^operation "POST \/first" declares cookie parameter/);
  assert.match(warnings[2], /^operation "POST \/first" declares security/);
  assert.match(warnings[3], /^operation "GET \/second" declares security/);

  // Repeated calls over the same inputs are identical.
  assert.deepEqual(buildCoverageWarnings(operations, {}), warnings);
});
