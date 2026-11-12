import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SpecError,
  buildOperationCatalog,
  loadSpec,
  loadSpecs,
  resolveRedirect,
  zeroOperationWarnings,
} from "../dist/spec.js";

/** Create a throwaway directory for spec fixtures. */
function makeDir() {
  return mkdtempSync(join(tmpdir(), "specweaver-spec-"));
}

/** Write `contents` to `name` inside `dir` and return the absolute path. */
function write(dir, name, contents) {
  const path = join(dir, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

/** Assert that no `$ref` key survives anywhere in the (acyclic) value. */
function assertNoRefs(value, seen = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoRefs(item, seen);
    return;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return;
    seen.add(value);
    assert.ok(!("$ref" in value), `unresolved $ref found: ${JSON.stringify(value)}`);
    for (const item of Object.values(value)) assertNoRefs(item, seen);
  }
}

const OAS30_YAML = `openapi: 3.0.3
info:
  title: Pets
  version: 1.0.0
paths:
  /pets:
    get:
      operationId: listPets
      parameters:
        - name: limit
          in: query
          schema:
            type: integer
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Pet'
      security:
        - apiKey: []
      responses:
        '200':
          description: ok
components:
  schemas:
    Pet:
      type: object
      properties:
        id:
          type: string
`;

const OAS31_OBJECT = {
  openapi: "3.1.0",
  info: { title: "Pets", version: "1.0.0" },
  paths: {
    "/pets": {
      post: {
        operationId: "createPet",
        requestBody: {
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
  },
  components: {
    schemas: {
      Pet: { type: "object", properties: { name: { type: "string" } } },
    },
  },
};

test("loads a valid OpenAPI 3.0 spec from a local file and returns a parsed document", () => {
  const dir = makeDir();
  const path = write(dir, "openapi.yaml", OAS30_YAML);

  const loaded = loadSpec(path);

  assert.equal(loaded.source, path);
  assert.equal(loaded.document.openapi, "3.0.3");
  assert.equal(loaded.document.info.title, "Pets");
  assert.equal(loaded.operations.length, 1);
});

test("loads a valid OpenAPI 3.1 spec from a local file", () => {
  const dir = makeDir();
  const path = write(dir, "openapi.json", JSON.stringify(OAS31_OBJECT));

  const loaded = loadSpec(path);

  assert.equal(loaded.document.openapi, "3.1.0");
  assert.deepEqual(loaded.operations.map((op) => op.operationId), ["createPet"]);
});

test("supports both JSON and YAML spec encodings from a local file", () => {
  const dir = makeDir();
  const yamlPath = write(dir, "openapi.yaml", OAS30_YAML);
  const jsonPath = write(dir, "openapi.json", JSON.stringify(OAS31_OBJECT));

  const fromYaml = loadSpec(yamlPath);
  const fromJson = loadSpec(jsonPath);

  assert.equal(fromYaml.document.openapi, "3.0.3");
  assert.equal(fromJson.document.openapi, "3.1.0");
});

test("resolves internal $refs so downstream consumers see inlined schemas", () => {
  const dir = makeDir();
  const path = write(dir, "openapi.yaml", OAS30_YAML);

  const loaded = loadSpec(path);

  assertNoRefs(loaded.document);
  const schema =
    loaded.operations[0].requestBody.content["application/json"].schema;
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.properties, { id: { type: "string" } });
});

test("resolves external file $refs (relative file paths)", () => {
  const dir = makeDir();
  write(dir, "schemas/pet.yaml", "Pet:\n  type: object\n  properties:\n    id:\n      type: string\n");
  const root = write(
    dir,
    "root.yaml",
    `openapi: 3.0.3
info:
  title: Ext
  version: 1.0.0
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: './schemas/pet.yaml#/Pet'
`,
  );

  const loaded = loadSpec(root);

  assertNoRefs(loaded.document);
  const schema =
    loaded.document.paths["/pets"].get.responses["200"].content["application/json"].schema;
  assert.deepEqual(schema, {
    type: "object",
    properties: { id: { type: "string" } },
  });
});

test("produces an operation catalog with method, path, operationId, parameters, requestBody, and security", () => {
  const dir = makeDir();
  const path = write(dir, "openapi.yaml", OAS30_YAML);

  const [operation] = loadSpec(path).operations;

  assert.equal(operation.method, "GET");
  assert.equal(operation.path, "/pets");
  assert.equal(operation.operationId, "listPets");
  assert.deepEqual(operation.parameters, [
    { name: "limit", in: "query", schema: { type: "integer" } },
  ]);
  assert.equal(operation.requestBody.required, true);
  assert.equal(
    operation.requestBody.content["application/json"].schema.type,
    "object",
  );
  assert.deepEqual(operation.security, [{ apiKey: [] }]);
});

test("catalog records operation-level tags in document order and skips non-strings", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.json",
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Tags", version: "1" },
      paths: {
        "/pets": {
          get: {
            tags: ["pets", "store"],
            responses: { "200": { description: "ok" } },
          },
        },
        "/plain": {
          get: { responses: { "200": { description: "ok" } } },
        },
        "/mixed": {
          get: {
            tags: ["store", 7, "pets"],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    }),
  );

  const operations = loadSpec(path).operations;
  assert.deepEqual(operations[0].tags, ["pets", "store"]);
  assert.equal(operations[1].tags, undefined);
  assert.deepEqual(operations[2].tags, ["store", "pets"]);
});

test("falls back to document-level security when an operation declares none", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.yaml",
    `openapi: 3.0.3
info:
  title: Sec
  version: 1.0.0
security:
  - bearerAuth: []
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: ok
`,
  );

  const [operation] = loadSpec(path).operations;
  assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
});

test("an explicit empty operation security overrides document-level security", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.yaml",
    `openapi: 3.0.3
info:
  title: Sec
  version: 1.0.0
security:
  - bearerAuth: []
paths:
  /pets:
    get:
      operationId: listPets
      security: []
      responses:
        '200':
          description: ok
`,
  );

  const [operation] = loadSpec(path).operations;
  assert.deepEqual(operation.security, []);
});

test("catalog carries the document securitySchemes for auth derivation (SPEC-39)", () => {
  const documented = {
    openapi: "3.0.3",
    info: { title: "Sec", version: "1.0.0" },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        headerKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
      },
    },
    paths: { "/pets": { get: { responses: {} } } },
  };

  const [operation] = buildOperationCatalog(documented);
  assert.deepEqual(operation.securitySchemes, {
    bearerAuth: { type: "http", scheme: "bearer" },
    headerKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
  });

  const [schemeLess] = buildOperationCatalog({
    openapi: "3.0.3",
    info: { title: "No schemes", version: "1.0.0" },
    paths: { "/pets": { get: { responses: {} } } },
  });
  assert.equal(schemeLess.securitySchemes, undefined);
});

test("operation-level parameters override path-level parameters of the same name and location", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.yaml",
    `openapi: 3.0.3
info:
  title: Params
  version: 1.0.0
paths:
  /pets/{petId}:
    parameters:
      - name: petId
        in: path
        required: true
        schema:
          type: string
    get:
      operationId: getPet
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: integer
      responses:
        '200':
          description: ok
`,
  );

  const [operation] = loadSpec(path).operations;
  assert.equal(operation.parameters.length, 1);
  assert.deepEqual(operation.parameters[0].schema, { type: "integer" });
});

test("the operation catalog is deterministic and covers every operation method", () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "Ops", version: "1.0.0" },
    paths: {
      "/a": {
        delete: { responses: {} },
        get: { responses: {} },
        post: { responses: {} },
      },
    },
  };

  const first = buildOperationCatalog(document);
  const second = buildOperationCatalog(document);

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((op) => op.method),
    ["GET", "POST", "DELETE"],
  );
});

test("catalogues OpenAPI 3.1 webhooks as /<name> operations after paths", () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "Hooks", version: "1.0.0" },
    paths: {
      "/pets": { get: { responses: {} } },
    },
    webhooks: {
      newPet: {
        post: { responses: {} },
        get: { responses: {} },
      },
      "/already/slashed": {
        put: { responses: {} },
      },
    },
  };

  assert.deepEqual(
    buildOperationCatalog(document).map((op) => `${op.method} ${op.path}`),
    ["GET /pets", "GET /newPet", "POST /newPet", "PUT /already/slashed"],
  );
});

test("webhook operations carry parameters, bodies, and security like path operations", () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "Hooks", version: "1.0.0" },
    security: [{ bearer: [] }],
    webhooks: {
      newPet: {
        parameters: [{ name: "x-tenant", in: "header" }],
        post: {
          operationId: "onNewPet",
          tags: ["hooks"],
          parameters: [{ name: "id", in: "path", required: true }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: {},
        },
      },
    },
  };

  const [operation] = buildOperationCatalog(document);

  assert.equal(operation.method, "POST");
  assert.equal(operation.path, "/newPet");
  assert.equal(operation.operationId, "onNewPet");
  assert.deepEqual(operation.tags, ["hooks"]);
  assert.deepEqual(
    operation.parameters.map((parameter) => `${parameter.in}:${parameter.name}`),
    ["header:x-tenant", "path:id"],
  );
  assert.equal(operation.requestBody.required, true);
  assert.deepEqual(operation.security, [{ bearer: [] }]);
});

test("a webhooks-only 3.1 spec yields operations and no zero-operation warning", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "hooks.yaml",
    `openapi: 3.1.0
info:
  title: Hooks
  version: 1.0.0
webhooks:
  newPet:
    post:
      responses:
        '200':
          description: ok
`,
  );

  const spec = loadSpec(path);

  assert.deepEqual(
    spec.operations.map((operation) => `${operation.method} ${operation.path}`),
    ["POST /newPet"],
  );
  assert.deepEqual(zeroOperationWarnings([spec]), []);
});

test("zeroOperationWarnings names only components-only documents", () => {
  const warning = zeroOperationWarnings([
    { source: "components.json", document: {}, operations: [] },
  ])[0];

  assert.match(warning, /only `paths` and `webhooks` operations are catalogued/);
  assert.match(warning, /components-only document yields none/);
  assert.doesNotMatch(warning, /webhooks.*not catalogued/);
});

test("OpenAPI 3.0 documents do not catalogue a webhooks member", () => {
  const document = {
    openapi: "3.0.3",
    info: { title: "Hooks", version: "1.0.0" },
    paths: {},
    webhooks: {
      newPet: { post: { responses: {} } },
    },
  };

  assert.deepEqual(buildOperationCatalog(document), []);
});

test("handles circular $ref chains without infinite recursion or crash", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.yaml",
    `openapi: 3.1.0
info:
  title: Node
  version: 1.0.0
paths:
  /nodes:
    get:
      operationId: getNode
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

  const schema =
    loadSpec(path).operations[0].requestBody.content["application/json"].schema;

  assert.equal(schema.type, "object");
  // The cycle terminates as a live self-reference rather than recursing.
  assert.equal(schema.properties.next, schema);
});

test("rejects a YAML anchor/alias cycle with a clear SpecError instead of crashing", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.yaml",
    `openapi: 3.1.0
info:
  title: Node
  version: 1.0.0
paths: {}
components:
  schemas:
    Node: &node
      type: object
      properties:
        next: *node
`,
  );

  assert.throws(
    () => loadSpec(path),
    (error) => {
      assert.ok(
        error instanceof SpecError,
        "an alias cycle must surface as a SpecError, not a RangeError",
      );
      assert.match(error.message, /alias cycle/);
      return true;
    },
  );
});

test("accepts non-cyclic YAML aliases (shared anchors) without rejecting them", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.yaml",
    `openapi: 3.1.0
info:
  title: Aliases
  version: 1.0.0
paths: {}
components:
  schemas:
    Id: &id
      type: string
    Pet:
      type: object
      properties:
        a: *id
        b: *id
`,
  );

  const schemas = loadSpec(path).document.components.schemas;
  assert.deepEqual(schemas.Pet.properties.a, { type: "string" });
  assert.deepEqual(schemas.Pet.properties.b, { type: "string" });
});

test("merges sibling keywords alongside $ref, with siblings winning at the top level", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.yaml",
    `openapi: 3.1.0
info:
  title: Siblings
  version: 1.0.0
paths: {}
components:
  schemas:
    Base:
      type: object
      description: base
    Derived:
      $ref: '#/components/schemas/Base'
      description: overridden
`,
  );

  const derived = loadSpec(path).document.components.schemas.Derived;
  assert.equal(derived.type, "object");
  assert.equal(derived.description, "overridden");
});

test("rejects a Swagger 2.0 document with a clear error", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "swagger.yaml",
    "swagger: '2.0'\ninfo:\n  title: Old\n  version: 1.0.0\npaths: {}\n",
  );

  assert.throws(
    () => loadSpec(path),
    (error) => {
      assert.ok(error instanceof SpecError);
      assert.match(error.message, /Swagger 2\.0 is not supported/);
      return true;
    },
  );
});

test("rejects a document missing the openapi version field", () => {
  const dir = makeDir();
  const path = write(dir, "openapi.yaml", "info:\n  title: Nope\n  version: 1.0.0\npaths: {}\n");

  assert.throws(() => loadSpec(path), /missing the `openapi` version field/);
});

test("rejects a document with the version but no info/paths", () => {
  const dir = makeDir();
  const path = write(dir, "openapi.json", JSON.stringify({ openapi: "3.0.3" }));

  assert.throws(
    () => loadSpec(path),
    (error) => {
      assert.ok(error instanceof SpecError);
      assert.match(error.message, /not a valid OpenAPI 3\.0\.3 document/);
      assert.match(error.message, /missing the required `info` object/);
      assert.match(error.message, /missing the required `paths` object/);
      return true;
    },
  );
});

test("rejects a 3.0 document whose info lacks a title/version", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.yaml",
    "openapi: 3.0.3\ninfo:\n  title: ''\npaths: {}\n",
  );

  assert.throws(
    () => loadSpec(path),
    (error) => {
      assert.ok(error instanceof SpecError);
      assert.match(error.message, /`info\.title` must be a non-empty string/);
      assert.match(error.message, /`info\.version` must be a non-empty string/);
      return true;
    },
  );
});

test("rejects an OpenAPI 3.1 document with no paths, webhooks, or components", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.yaml",
    "openapi: 3.1.0\ninfo:\n  title: Empty\n  version: 1.0.0\n",
  );

  assert.throws(
    () => loadSpec(path),
    /at least one of `paths`, `webhooks`, or `components`/,
  );
});

test("accepts an OpenAPI 3.1 document that defines only components", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.yaml",
    "openapi: 3.1.0\ninfo:\n  title: Components\n  version: 1.0.0\ncomponents:\n  schemas:\n    Pet:\n      type: object\n",
  );

  const loaded = loadSpec(path);
  assert.equal(loaded.document.openapi, "3.1.0");
  assert.deepEqual(loaded.operations, []);
});

test("rejects an unsupported OpenAPI version", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.yaml",
    "openapi: 2.0.0\ninfo:\n  title: Nope\n  version: 1.0.0\npaths: {}\n",
  );

  assert.throws(() => loadSpec(path), /Unsupported OpenAPI version "2\.0\.0"/);
});

test("rejects malformed JSON with a clear error", () => {
  const dir = makeDir();
  const path = write(dir, "openapi.json", '{ "openapi": "3.0.0", ');

  assert.throws(
    () => loadSpec(path),
    (error) => {
      assert.ok(error instanceof SpecError);
      assert.match(error.message, /Invalid JSON in/);
      return true;
    },
  );
});

test("rejects malformed YAML with a clear error", () => {
  const dir = makeDir();
  const path = write(dir, "openapi.yaml", "openapi: 3.0.0\npaths: [\n");

  assert.throws(
    () => loadSpec(path),
    (error) => {
      assert.ok(error instanceof SpecError);
      assert.match(error.message, /Invalid YAML in/);
      return true;
    },
  );
});

test("reports a missing spec file as a SpecError", () => {
  const missing = join(tmpdir(), "specweaver-spec-does-not-exist.yaml");

  assert.throws(
    () => loadSpec(missing),
    (error) => {
      assert.ok(error instanceof SpecError);
      assert.match(error.message, /Cannot read spec file/);
      return true;
    },
  );
});

test("an unresolvable $ref produces a clear SpecError", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.yaml",
    `openapi: 3.0.3
info:
  title: Broken
  version: 1.0.0
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Missing'
`,
  );

  assert.throws(() => loadSpec(path), /Cannot resolve \$ref .*Missing/);
});

test("rejects a remote $ref as out of scope", () => {
  const dir = makeDir();
  const path = write(
    dir,
    "openapi.yaml",
    `openapi: 3.0.3
info:
  title: Remote
  version: 1.0.0
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: 'https://example.com/schema.json#/Pet'
`,
  );

  assert.throws(() => loadSpec(path), /Remote \$ref .* not supported/);
});

test("loadSpecs loads multiple local sources in order", async () => {
  const dir = makeDir();
  const first = write(dir, "a.yaml", OAS30_YAML);
  const second = write(dir, "b.json", JSON.stringify(OAS31_OBJECT));

  const loaded = await loadSpecs([first, second]);

  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].document.openapi, "3.0.3");
  assert.equal(loaded[1].document.openapi, "3.1.0");
});

// --- Remote specs (SPEC-41) -------------------------------------------------

/** A minimal valid OpenAPI 3.0 document served by the remote tests. */
const REMOTE_OAS30 = {
  openapi: "3.0.3",
  info: { title: "Remote", version: "1.0.0" },
  servers: [{ url: "http://127.0.0.1:9" }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

/**
 * Start an in-process stub HTTP server for one test. `handler` receives
 * `(req, res, requests)`; every request path is recorded in `requests`.
 */
async function listen(t, handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.on("error", () => {});
    handler(req, res, requests);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  );
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, requests };
}

test("fetches a remote JSON spec and catalogues its operations (SPEC-41)", async (t) => {
  const { base, requests } = await listen(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(REMOTE_OAS30));
  });

  const [loaded] = await loadSpecs([`${base}/spec.json`]);

  assert.equal(loaded.source, `${base}/spec.json`);
  assert.equal(loaded.document.openapi, "3.0.3");
  assert.deepEqual(
    loaded.operations.map((op) => `${op.method} ${op.path}`),
    ["GET /pets"],
  );
  assert.deepEqual(requests, ["/spec.json"]);
});

test("fetches a remote YAML spec (JSON first, then YAML) (SPEC-41)", async (t) => {
  const { base } = await listen(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/yaml" });
    res.end(OAS30_YAML);
  });

  const [loaded] = await loadSpecs([`${base}/openapi.yaml`]);

  assert.equal(loaded.document.openapi, "3.0.3");
  assert.equal(loaded.operations[0].operationId, "listPets");
});

test("a failing remote fetch is an actionable SpecError naming the host (SPEC-41)", async () => {
  await assert.rejects(loadSpecs(["http://127.0.0.1:1/spec.json"]), (error) => {
    assert.ok(error instanceof SpecError);
    assert.match(error.message, /Failed to fetch spec from "127\.0\.0\.1:1":/);
    assert.doesNotMatch(error.message, /at .*\.js:\d+/);
    return true;
  });
});

test("non-2xx remote responses fail with the status (SPEC-41)", async (t) => {
  const { base } = await listen(t, (req, res) => {
    res.writeHead(503, "Service Unavailable");
    res.end("down");
  });

  await assert.rejects(loadSpecs([`${base}/spec.json`]), /HTTP 503 Service Unavailable/);
});

test("oversized remote bodies fail at the 5 MiB cap (SPEC-41)", async (t) => {
  const { base } = await listen(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("x".repeat(5 * 1024 * 1024 + 1));
  });

  await assert.rejects(
    loadSpecs([`${base}/big.json`]),
    /exceeds the 5 MiB size cap/,
  );
});

test("unparsable remote content fails as invalid JSON or YAML (SPEC-41)", async (t) => {
  const { base } = await listen(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("a: [1, 2");
  });

  await assert.rejects(loadSpecs([`${base}/bad.json`]), /Invalid JSON or YAML/);
});

test("a remote fetch timeout aborts after 10 seconds (SPEC-41)", async (t) => {
  const { base } = await listen(t, () => {
    // Never respond; the client-side AbortController must fire.
  });

  await assert.rejects(
    loadSpecs([`${base}/slow.json`]),
    /Timed out after 10s fetching spec from "127\.0\.0\.1:\d+"/,
  );
});

test("redirects are followed manually with relative Location resolution (SPEC-41)", async (t) => {
  const body = JSON.stringify(REMOTE_OAS30);
  const { base, requests } = await listen(t, (req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: "./real.json" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });

  const [loaded] = await loadSpecs([`${base}/start`]);

  assert.equal(loaded.operations.length, 1);
  assert.deepEqual(requests, ["/start", "/real.json"]);
});

test("the redirect policy resolves relative hops and rejects https->http (SPEC-41)", () => {
  assert.equal(
    resolveRedirect("https://example.com/a/b/spec.yaml", "../c.yaml", 0),
    "https://example.com/a/c.yaml",
  );
  assert.equal(
    resolveRedirect("http://example.com/a", "https://example.com/a", 0),
    "https://example.com/a",
  );
  assert.equal(
    resolveRedirect("https://example.com/a", "/b", 9),
    "https://example.com/b",
  );
  assert.throws(
    () => resolveRedirect("https://example.com/a", "http://example.com/b", 0),
    /Refusing insecure redirect from "https:\/\/example\.com" to "http:\/\/example\.com"/,
  );
  assert.throws(
    () => resolveRedirect("https://example.com/a", "/b", 10),
    /Too many redirects .* stopped after 10 hops/,
  );
  assert.throws(
    () => resolveRedirect("https://example.com/a", null, 0),
    /missing a Location header/,
  );
});

test("relative external $refs in a remote document resolve against its URL (SPEC-41)", async (t) => {
  const root = {
    openapi: "3.0.3",
    info: { title: "Remote", version: "1.0.0" },
    paths: {
      "/pets": {
        post: {
          operationId: "createPet",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "schemas/pet.yaml#/Pet" },
              },
            },
          },
          responses: { "201": { description: "created" } },
        },
      },
    },
  };
  const pet = { Pet: { type: "object", properties: { name: { type: "string" } } } };
  const { base, requests } = await listen(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/yaml" });
    if (req.url === "/api/spec.yaml") {
      res.end(JSON.stringify(root));
      return;
    }
    if (req.url === "/api/schemas/pet.yaml") {
      res.end(JSON.stringify(pet));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const [loaded] = await loadSpecs([`${base}/api/spec.yaml`]);
  const schema =
    loaded.operations[0].requestBody.content["application/json"].schema;

  assert.deepEqual(schema, pet.Pet);
  assert.deepEqual(requests, ["/api/spec.yaml", "/api/schemas/pet.yaml"]);
});

test("remote $ref targets normalize ../ and share the per-run fetch memo (SPEC-41)", async (t) => {
  const root = {
    openapi: "3.0.3",
    info: { title: "Remote", version: "1.0.0" },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "../../common.yaml#/Pet" },
                },
              },
            },
          },
        },
      },
    },
  };
  const common = {
    Pet: { type: "object", properties: { id: { type: "string" } } },
  };
  const { base, requests } = await listen(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/yaml" });
    if (req.url === "/api/v1/spec.yaml") {
      res.end(JSON.stringify(root));
      return;
    }
    if (req.url === "/common.yaml") {
      res.end(JSON.stringify(common));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const url = `${base}/api/v1/spec.yaml`;
  const loaded = await loadSpecs([url, url]);

  assert.equal(loaded.length, 2);
  assert.deepEqual(
    loaded[0].document.paths["/pets"].get.responses["200"].content[
      "application/json"
    ].schema,
    common.Pet,
  );
  // One fetch for the root (shared by both `specs` entries) and one for the
  // `../`-normalized ref target.
  assert.deepEqual(requests, ["/api/v1/spec.yaml", "/common.yaml"]);
});

test("local and remote specs load together in order, deterministically (SPEC-41)", async (t) => {
  const dir = makeDir();
  const local = write(dir, "local.yaml", OAS30_YAML);
  const { base } = await listen(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ...REMOTE_OAS30,
        paths: {
          "/owners": {
            get: { responses: { "200": { description: "ok" } } },
          },
        },
      }),
    );
  });

  const loaded = await loadSpecs([local, `${base}/remote.json`]);

  assert.deepEqual(
    loaded.map((spec) => spec.document.openapi),
    ["3.0.3", "3.0.3"],
  );
  assert.deepEqual(
    loaded.flatMap((spec) => spec.operations.map((op) => op.path)),
    ["/pets", "/owners"],
  );
  assert.equal(buildOperationCatalog(loaded[1].document)[0].path, "/owners");
});

test("a parse-valid, operation-less remote document warns like a local one (SPEC-41)", async (t) => {
  const { base } = await listen(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: "Components only", version: "1.0.0" },
        components: { schemas: { Pet: { type: "object" } } },
      }),
    );
  });

  const loaded = await loadSpecs([`${base}/components.json`]);
  const [warning] = zeroOperationWarnings(loaded);

  assert.equal(loaded[0].operations.length, 0);
  assert.match(warning, /contributes zero operations/);
  assert.match(warning, new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("credentials in a remote spec URL are never printed (SPEC-41)", async (t) => {
  const { base } = await listen(t, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(REMOTE_OAS30));
  });
  const url = base.replace("http://", "http://user:s3cret@");

  // Node's `fetch` refuses credential-bearing URLs; whatever the outcome, the
  // diagnostic may name the host but must never echo the credentials.
  await assert.rejects(loadSpecs([url]), (error) => {
    assert.match(error.message, /Failed to fetch spec from "127\.0\.0\.1:\d+"/);
    assert.doesNotMatch(error.message, /s3cret|user:/);
    return true;
  });
});

test("loadSpec rejects a remote source with a pointer to loadSpecs (SPEC-41)", () => {
  assert.throws(
    () => loadSpec("https://example.com/spec.json"),
    /is a remote URL; fetch it with loadSpecs\(\)/,
  );
});
