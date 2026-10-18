import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthError,
  REDACTED,
  injectAuth,
  mergeAuthHeaders,
  redactHeaders,
  resolveAuthHeaders,
  withAuthHeaders,
} from "../dist/auth.js";
import { generateRequestData } from "../dist/request-data.js";

/** Build a minimal resolved operation entry (the SPEC-4 input shape). */
function operation(overrides = {}) {
  return {
    method: "GET",
    path: "/pets",
    parameters: [],
    security: [],
    ...overrides,
  };
}

/** Build one generated request-data object (the SPEC-4 output shape). */
function request(overrides = {}) {
  return {
    method: "GET",
    path: "/pets",
    pathParams: {},
    query: {},
    headers: {},
    ...overrides,
  };
}

// --- Auth shapes -----------------------------------------------------------

test("no configured auth yields no headers and no warnings", () => {
  assert.deepEqual(resolveAuthHeaders(undefined), { headers: {}, warnings: [] });
  assert.deepEqual(resolveAuthHeaders({}), { headers: {}, warnings: [] });
});

test("a bearer token produces exactly `Authorization: Bearer <token>`", () => {
  const { headers, warnings } = resolveAuthHeaders({ token: "abc123" });
  assert.deepEqual(headers, { Authorization: "Bearer abc123" });
  assert.deepEqual(warnings, []);
});

test("an API key is applied as a header whose name comes from config (A2)", () => {
  const { headers, warnings } = resolveAuthHeaders({
    headers: { "X-Api-Key": "key-456" },
  });
  assert.deepEqual(headers, { "X-Api-Key": "key-456" });
  assert.deepEqual(warnings, []);
  // Placement is a header, never a query parameter.
  assert.equal("X-Api-Key" in headers, true);
});

test("arbitrary static headers are applied verbatim", () => {
  const { headers } = resolveAuthHeaders({
    headers: { "X-Tenant": "acme", "X-Trace-Id": "trace-1" },
  });
  assert.deepEqual(headers, { "X-Tenant": "acme", "X-Trace-Id": "trace-1" });
});

test("a bearer token and static headers combine deterministically", () => {
  const { headers } = resolveAuthHeaders({
    token: "tok",
    headers: { "X-Api-Key": "key" },
  });
  assert.deepEqual(headers, {
    Authorization: "Bearer tok",
    "X-Api-Key": "key",
  });
  assert.deepEqual(Object.keys(headers), ["Authorization", "X-Api-Key"]);
});

// --- Intra-auth collision precedence (product decision, 2026-10-18) --------
//
// The bearer token wins over an `authorization` entry in `auth.headers`,
// case-insensitively (both directions of casing).

test("a bearer token wins over a lower-cased `authorization` static header", () => {
  const { headers } = resolveAuthHeaders({
    token: "tok",
    headers: { authorization: "static-secret" },
  });
  assert.deepEqual(headers, { Authorization: "Bearer tok" });
  assert.equal("authorization" in headers, false);
});

test("a bearer token wins over a canonical `Authorization` static header", () => {
  const { headers, warnings } = resolveAuthHeaders({
    token: "tok",
    headers: { Authorization: "static-secret", "X-Trace": "keep" },
  });
  assert.deepEqual(headers, { Authorization: "Bearer tok", "X-Trace": "keep" });
  assert.deepEqual(warnings, []);
});

test("without a token, an `authorization` static header is applied verbatim", () => {
  const { headers } = resolveAuthHeaders({
    headers: { authorization: "Bearer static" },
  });
  assert.deepEqual(headers, { authorization: "Bearer static" });
});

// --- Environment interpolation --------------------------------------------

test("resolves ${ENV_VAR} references from the process environment", () => {
  const env = { API_TOKEN: "resolved-token" };
  const { headers, warnings } = resolveAuthHeaders(
    { token: "${API_TOKEN}", headers: { "X-Api-Key": "${API_KEY}" } },
    { ...env, API_KEY: "resolved-key" },
  );
  assert.deepEqual(headers, {
    Authorization: "Bearer resolved-token",
    "X-Api-Key": "resolved-key",
  });
  assert.deepEqual(warnings, []);
});

test("an unresolved ${ENV_VAR} emits a warning and does not throw", () => {
  const { headers, warnings } = resolveAuthHeaders(
    { token: "${MISSING_TOKEN}" },
    {},
  );
  // The raw reference is left intact (SPEC-2 semantics) and never fails.
  assert.deepEqual(headers, { Authorization: "Bearer ${MISSING_TOKEN}" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unresolved environment variable "MISSING_TOKEN"/);
  assert.match(warnings[0], /auth\.token/);
});

test("a partially-resolved header emits a warning for each missing variable", () => {
  const { warnings } = resolveAuthHeaders(
    { headers: { "X-Api-Key": "${A}-${B}" } },
    { A: "one" },
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"B"/);
  assert.match(warnings[0], /auth\.headers\.X-Api-Key/);
});

// --- Redaction (A5) --------------------------------------------------------

test("error messages name the offending field and never leak a secret value", () => {
  const secret = "sup3r-secret-value";

  assert.throws(
    () => resolveAuthHeaders({ token: 42 }),
    (error) => {
      assert.ok(error instanceof AuthError);
      assert.match(error.message, /auth\.token/);
      assert.doesNotMatch(error.message, /42/);
      return true;
    },
  );

  assert.throws(
    () => resolveAuthHeaders({ headers: { "X-Api-Key": { nested: secret } } }),
    (error) => {
      assert.ok(error instanceof AuthError);
      assert.match(error.message, /auth\.headers\.X-Api-Key/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("a malformed auth container produces a clear error naming `auth`", () => {
  assert.throws(
    () => resolveAuthHeaders([]),
    (error) => {
      assert.ok(error instanceof AuthError);
      assert.match(error.message, /`auth`/);
      return true;
    },
  );
});

test("redactHeaders masks every value but keeps the header names", () => {
  const headers = {
    Authorization: "Bearer secret",
    "X-Api-Key": "key-456",
  };
  assert.deepEqual(redactHeaders(headers), {
    Authorization: REDACTED,
    "X-Api-Key": REDACTED,
  });
  assert.equal(REDACTED, "***");
});

test("resolution and injection never write secret values to stdout/stderr", () => {
  const secret = "sup3r-secret-value";
  const written = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };

  try {
    const { requests, warnings } = injectAuth(
      { auth: { token: secret, headers: { "X-Api-Key": "${MISSING}" } } },
      [request()],
      {},
    );
    assert.equal(requests[0].headers.Authorization, `Bearer ${secret}`);
    assert.equal(warnings.length, 1);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }

  assert.equal(written.length, 0);
  assert.ok(written.every((line) => !line.includes(secret)));
});

// --- Merge and collision precedence (A3/A6) --------------------------------

test("mergeAuthHeaders appends auth headers after generated ones", () => {
  const merged = mergeAuthHeaders(
    { "Content-Type": "application/json", "X-Trace-Id": "gen" },
    { Authorization: "Bearer tok" },
  );
  assert.deepEqual(merged, {
    "Content-Type": "application/json",
    "X-Trace-Id": "gen",
    Authorization: "Bearer tok",
  });
});

test("a colliding auth header wins case-insensitively (A3 + A6)", () => {
  const merged = mergeAuthHeaders(
    { "x-api-key": "generated", "X-Trace": "keep" },
    { "X-Api-Key": "auth-secret" },
  );
  assert.deepEqual(merged, {
    "X-Trace": "keep",
    "X-Api-Key": "auth-secret",
  });
  // The generated, differently-cased duplicate is gone.
  assert.equal("x-api-key" in merged, false);
});

test("withAuthHeaders merges auth into a copy without mutating the input", () => {
  const original = request({ headers: { "x-api-key": "generated" } });
  const result = withAuthHeaders(original, { "X-Api-Key": "auth" });
  assert.deepEqual(original.headers, { "x-api-key": "generated" });
  assert.deepEqual(result.headers, { "X-Api-Key": "auth" });
  assert.notEqual(result, original);
});

// --- Integration with SPEC-4 output ----------------------------------------

test("injectAuth merges auth into each operation's generated request data (A6)", () => {
  const generated = generateRequestData(
    operation({
      parameters: [
        {
          name: "X-Request-Id",
          in: "header",
          schema: { type: "string", format: "uuid" },
        },
      ],
    }),
  );

  const { requests, warnings } = injectAuth(
    { auth: { token: "tok", headers: { "X-Api-Key": "key" } } },
    [generated],
  );

  assert.deepEqual(warnings, []);
  const headers = requests[0].headers;
  assert.equal(headers.Authorization, "Bearer tok");
  assert.equal(headers["X-Api-Key"], "key");
  assert.equal(typeof headers["X-Request-Id"], "string");
  // The rest of the generated request data is preserved.
  assert.equal(requests[0].method, generated.method);
  assert.equal(requests[0].path, generated.path);
});

test("injectAuth wins over a header generated by SPEC-4, case-insensitively", () => {
  const generated = generateRequestData(
    operation({
      parameters: [
        { name: "x-api-key", in: "header", schema: { type: "string" } },
      ],
    }),
  );
  assert.ok("x-api-key" in generated.headers);

  const { requests } = injectAuth(
    { auth: { headers: { "X-Api-Key": "auth-secret" } } },
    [generated],
  );

  assert.deepEqual(requests[0].headers, { "X-Api-Key": "auth-secret" });
});

test("the configured auth is applied globally, regardless of `security` (A1/A4)", () => {
  const requests = [
    generateRequestData(operation({ method: "GET", path: "/public", security: [] })),
    generateRequestData(
      operation({
        method: "GET",
        path: "/private",
        security: [{ apiKey: [] }],
      }),
    ),
  ];

  const { requests: injected } = injectAuth(
    { auth: { token: "tok" } },
    requests,
  );

  assert.equal(injected.length, 2);
  for (const entry of injected) {
    assert.equal(entry.headers.Authorization, "Bearer tok");
  }
});

test("no configured auth leaves the generated requests untouched", () => {
  const requests = [request({ headers: { "X-Trace": "gen" } })];
  const { requests: result, warnings } = injectAuth({}, requests, {});
  assert.deepEqual(result, requests);
  assert.deepEqual(warnings, []);
});

// --- Determinism -----------------------------------------------------------

test("injected headers and their ordering are deterministic", () => {
  const config = {
    auth: {
      token: "${TOKEN}",
      headers: { "X-Api-Key": "key", "X-Trace": "trace" },
    },
  };
  const requests = [
    generateRequestData(operation()),
    generateRequestData(operation({ method: "POST", path: "/pets" })),
  ];
  const env = { TOKEN: "abc" };

  const first = injectAuth(config, requests, env);
  const second = injectAuth(config, requests, env);

  assert.deepEqual(first.requests, second.requests);
  assert.deepEqual(
    Object.keys(first.requests[0].headers),
    Object.keys(second.requests[0].headers),
  );
  assert.deepEqual(Object.keys(first.requests[0].headers), [
    "Authorization",
    "X-Api-Key",
    "X-Trace",
  ]);
});
