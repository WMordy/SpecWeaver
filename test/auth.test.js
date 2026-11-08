import assert from "node:assert/strict";
import test from "node:test";

import {
  AuthError,
  REDACTED,
  injectAuth,
  mergeAuthHeaders,
  redactHeaders,
  resolveAuthHeaders,
  resolveAuthSecrets,
  resolveOperationAuth,
  withAuthHeaders,
  withResolvedAuth,
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
  // The generic headers map only feeds headers; SPEC-39's scheme-derived query
  // keys are resolved by resolveOperationAuth.
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
      { env: {} },
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

test("an explicit auth `Cookie` header wins over generated cookie parameters (SPEC-35)", () => {
  const generated = generateRequestData(
    operation({
      parameters: [
        { name: "session", in: "cookie", schema: { type: "string" } },
        { name: "theme", in: "cookie", example: "dark" },
      ],
    }),
  );
  assert.match(generated.headers.Cookie, /^session=[^;]+; theme=dark$/);

  // The configured header wins case-insensitively and replaces the generated
  // pair list entirely (no merge of the two values).
  const { requests } = injectAuth(
    { auth: { headers: { cookie: "auth=1" } } },
    [generated],
  );
  assert.deepEqual(requests[0].headers, { cookie: "auth=1" });

  // Cookie values are redacted on every diagnostic path like any other header.
  assert.deepEqual(redactHeaders(requests[0].headers), { cookie: REDACTED });
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
  const { requests: result, warnings } = injectAuth({}, requests, { env: {} });
  assert.deepEqual(result, requests);
  assert.deepEqual(warnings, []);
});

// --- securitySchemes-derived auth (SPEC-39) --------------------------------

const BEARER_SCHEMES = { bearerAuth: { type: "http", scheme: "bearer" } };
const HEADER_KEY_SCHEMES = {
  headerKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
};
const QUERY_KEY_SCHEMES = {
  queryKey: { type: "apiKey", in: "query", name: "api_key" },
};

test("a bearer-scheme operation with auth.token receives Authorization and does not warn", () => {
  const secured = operation({
    security: [{ bearerAuth: [] }],
    securitySchemes: BEARER_SCHEMES,
  });

  const resolved = resolveOperationAuth(secured, { token: "tok" }, {});
  assert.deepEqual(resolved.headers, { Authorization: "Bearer tok" });
  assert.deepEqual(resolved.query, {});
  assert.deepEqual(resolved.warnings, []);
});

test("a header apiKey scheme injects the scheme-named header from auth.apiKeys", () => {
  const secured = operation({
    security: [{ headerKey: [] }],
    securitySchemes: HEADER_KEY_SCHEMES,
  });

  const resolved = resolveOperationAuth(
    secured,
    { apiKeys: { headerKey: "key-123" } },
    {},
  );
  assert.deepEqual(resolved.headers, { "X-Api-Key": "key-123" });
  assert.deepEqual(resolved.query, {});
  assert.deepEqual(resolved.warnings, []);
});

test("a query apiKey scheme appends the scheme-named query parameter", () => {
  const secured = operation({
    security: [{ queryKey: [] }],
    securitySchemes: QUERY_KEY_SCHEMES,
  });

  const resolved = resolveOperationAuth(
    secured,
    { apiKeys: { queryKey: "key-456" } },
    {},
  );
  assert.deepEqual(resolved.headers, {});
  assert.deepEqual(resolved.query, { api_key: "key-456" });
  assert.deepEqual(resolved.warnings, []);
});

test("prototype-named schemes never resolve to Object.prototype members", () => {
  const secured = operation({
    security: [{ constructor: [] }],
    securitySchemes: {
      constructor: { type: "apiKey", in: "header", name: "X-Proto" },
    },
  });

  const missing = resolveOperationAuth(
    secured,
    { apiKeys: { otherKey: "other" } },
    {},
  );
  assert.deepEqual(missing.headers, {});
  assert.equal(missing.warnings.length, 1);
  assert.match(missing.warnings[0], /no auth\.apiKeys\.constructor credential/);

  const configured = resolveOperationAuth(
    secured,
    { apiKeys: { constructor: "proto-secret" } },
    {},
  );
  assert.deepEqual(configured.headers, { "X-Proto": "proto-secret" });
  assert.deepEqual(configured.warnings, []);

  const undeclared = resolveOperationAuth(
    operation({ security: [{ toString: [] }], securitySchemes: {} }),
    undefined,
    {},
  );
  assert.equal(undeclared.warnings.length, 1);
  assert.match(undeclared.warnings[0], /references undefined scheme "toString"/);
});

test("explicit auth wins over derived values on the same wire target", () => {
  const secured = operation({
    security: [{ headerKey: [] }],
    securitySchemes: HEADER_KEY_SCHEMES,
  });

  const resolved = resolveOperationAuth(
    secured,
    { headers: { "x-api-key": "explicit" }, apiKeys: { headerKey: "derived" } },
    {},
  );
  assert.deepEqual(resolved.headers, { "x-api-key": "explicit" });
  assert.deepEqual(resolved.warnings, []);
});

test("unsupported schemes, unsupported locations, and undefined references warn naming the scheme", () => {
  const documentSchemes = {
    basicAuth: { type: "http", scheme: "basic" },
    cookieKey: { type: "apiKey", in: "cookie", name: "session" },
    oauth: { type: "oauth2", flows: {} },
    mutual: { type: "mutualTLS" },
  };
  const cases = [
    ["basicAuth", /unsupported http scheme "basic"/],
    ["cookieKey", /unsupported location "cookie"/],
    ["oauth", /unsupported type "oauth2"/],
    ["mutual", /unsupported type "mutualTLS"/],
  ];

  for (const [schemeName, pattern] of cases) {
    const secured = operation({
      security: [{ [schemeName]: [] }],
      securitySchemes: documentSchemes,
    });
    const resolved = resolveOperationAuth(secured, undefined, {});
    assert.equal(resolved.warnings.length, 1, JSON.stringify(resolved.warnings));
    assert.match(resolved.warnings[0], new RegExp(`"${schemeName}"`));
    assert.match(resolved.warnings[0], pattern);
    assert.deepEqual(resolved.headers, {});
  }

  const undefinedScheme = operation({
    security: [{ missing: [] }],
    securitySchemes: documentSchemes,
  });
  const resolved = resolveOperationAuth(undefinedScheme, undefined, {});
  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /references undefined scheme "missing"/);
});

test("a supported scheme with no configured credential warns but empty security stays silent", () => {
  const secured = operation({
    security: [{ headerKey: [] }],
    securitySchemes: HEADER_KEY_SCHEMES,
  });
  const resolved = resolveOperationAuth(secured, undefined, {});
  assert.equal(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /"headerKey"/);
  assert.match(resolved.warnings[0], /no auth\.apiKeys\.headerKey credential/);

  assert.deepEqual(
    resolveOperationAuth(operation({ security: [] }), { token: "tok" }, {})
      .warnings,
    [],
  );
  assert.deepEqual(
    resolveOperationAuth(operation({ security: [] }), undefined, {}).warnings,
    [],
  );
});

test("derived auth resolution is deterministic and warnings never carry a credential", () => {
  const secured = operation({
    security: [{ headerKey: [], queryKey: [] }],
    securitySchemes: { ...HEADER_KEY_SCHEMES, ...QUERY_KEY_SCHEMES },
  });
  const auth = { apiKeys: { headerKey: "secret-h", queryKey: "secret-q" } };

  const first = resolveOperationAuth(secured, auth, {});
  const second = resolveOperationAuth(secured, auth, {});
  assert.deepEqual(first, second);
  assert.deepEqual(first.warnings, []);
  assert.ok(!JSON.stringify(first.warnings).includes("secret-h"));
  assert.ok(!JSON.stringify(first.warnings).includes("secret-q"));
});

test("a derived query apiKey replaces a generated parameter of the same name", () => {
  const merged = withResolvedAuth(
    request({ query: { api_key: "generated-value", other: "kept" } }),
    { headers: {}, query: { api_key: "derived-secret" }, warnings: [] },
  );
  assert.deepEqual(merged.query, {
    api_key: "derived-secret",
    other: "kept",
  });
});

test("injectAuth applies both derived headers and query parameters in request order", () => {
  const secured = operation({
    security: [{ headerKey: [], queryKey: [] }],
    securitySchemes: { ...HEADER_KEY_SCHEMES, ...QUERY_KEY_SCHEMES },
  });
  const generated = generateRequestData(secured);

  const { requests, warnings } = injectAuth(
    { auth: { apiKeys: { headerKey: "h", queryKey: "q" } } },
    [generated],
    { operations: [secured], env: {} },
  );

  assert.deepEqual(warnings, []);
  assert.equal(requests[0].headers["X-Api-Key"], "h");
  assert.equal(requests[0].query.api_key, "q");
});

// --- Stream redaction (SPEC-39 AC1) ---------------------------------------

test("resolveAuthSecrets returns every resolved credential once", () => {
  assert.deepEqual(
    resolveAuthSecrets(
      {
        token: "${TOKEN}",
        headers: { "X-Client": "client", "X-Trace": "trace" },
        apiKeys: { headerKey: "header-secret", queryKey: "${QUERY_KEY}" },
      },
      { TOKEN: "bearer-secret", QUERY_KEY: "query-secret" },
    ).sort(),
    ["bearer-secret", "client", "header-secret", "query-secret", "trace"],
  );
});

test("resolveAuthSecrets omits empty values but keeps unresolved literals", () => {
  assert.deepEqual(
    resolveAuthSecrets(
      {
        token: "${MISSING}",
        headers: { "X-Empty": "" },
        apiKeys: { key: "ab${ALSO_MISSING}cd" },
      },
      {},
    ).sort(),
    ["${MISSING}", "ab${ALSO_MISSING}cd"],
  );
  assert.deepEqual(resolveAuthSecrets(undefined, {}), []);
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

  const first = injectAuth(config, requests, { env });
  const second = injectAuth(config, requests, { env });

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
