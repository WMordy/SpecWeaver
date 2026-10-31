import assert from "node:assert/strict";
import test from "node:test";

import { selectOperations } from "../dist/selection.js";

/** One minimal catalog entry; selection only reads method/path/id/tags. */
function operation(method, path, extra = {}) {
  return { method, path, parameters: [], ...extra };
}

/** One loaded spec source with its catalog. */
function loaded(source, operations) {
  return { source, operations };
}

/** A two-spec catalog reused by the selector tests. */
function catalog() {
  return [
    loaded("first.json", [
      operation("GET", "/pets", {
        operationId: "listPets",
        tags: ["pets"],
      }),
      operation("POST", "/pets", {
        operationId: "createPet",
        tags: ["pets", "store"],
      }),
      operation("GET", "/pets/{id}", {
        operationId: "getPet",
        tags: ["pets"],
      }),
    ]),
    loaded("second.json", [
      // Duplicate operationId and METHOD path across specs: the first wins.
      operation("GET", "/pets", {
        operationId: "listPets",
        tags: ["store"],
      }),
      operation("DELETE", "/store", {
        operationId: "clearStore",
        tags: ["store"],
      }),
    ]),
  ];
}

/** `METHOD path` keys in selection order. */
function keys(selection) {
  return selection.selected.map((op) => `${op.method} ${op.path}`);
}

test("operationId matches exactly and case-sensitively, deduplicated on METHOD path", () => {
  const specs = catalog();

  assert.deepEqual(keys(selectOperations([{ operationId: "listPets" }], specs)), [
    "GET /pets",
  ]);
  assert.equal(
    selectOperations([{ operationId: "listPets" }], specs).selected[0].operationId,
    "listPets",
  );
  assert.deepEqual(keys(selectOperations([{ operationId: "getPet" }], specs)), [
    "GET /pets/{id}",
  ]);

  const missing = selectOperations([{ operationId: "ListPets" }], specs);
  assert.deepEqual(missing.selected, []);
  assert.deepEqual(missing.unmatched, [
    { label: 'operationId "ListPets"', explicit: false },
  ]);
});

test("operationId selects every distinct operation sharing an id across specs", () => {
  const specs = [
    loaded("first.json", [
      operation("GET", "/health", { operationId: "health" }),
    ]),
    loaded("second.json", [
      operation("GET", "/status", { operationId: "health" }),
    ]),
  ];

  assert.deepEqual(keys(selectOperations([{ operationId: "health" }], specs)), [
    "GET /health",
    "GET /status",
  ]);
});

test("tags select any listed tag with case-sensitive OR semantics in catalog order", () => {
  const specs = catalog();

  assert.deepEqual(keys(selectOperations([{ tags: ["store"] }], specs)), [
    "POST /pets",
    "GET /pets",
    "DELETE /store",
  ]);
  // Case-sensitive: "Store" matches nothing.
  assert.deepEqual(keys(selectOperations([{ tags: ["Store"] }], specs)), []);
  // OR across both tags keeps catalog order, never config order.
  assert.deepEqual(
    keys(selectOperations([{ tags: ["store", "pets"] }], specs)),
    ["GET /pets", "POST /pets", "GET /pets/{id}", "DELETE /store"],
  );
});

test("path patterns: * is one segment, ** is the remainder, exact matches any method", () => {
  const specs = catalog();

  assert.deepEqual(keys(selectOperations([{ path: "/pets/*" }], specs)), [
    "GET /pets/{id}",
  ]);
  assert.deepEqual(keys(selectOperations([{ path: "/pets/**" }], specs)), [
    "GET /pets/{id}",
  ]);
  // A wildcard-free path selects every method on that exact path.
  assert.deepEqual(keys(selectOperations([{ path: "/pets" }], specs)), [
    "GET /pets",
    "POST /pets",
  ]);
  // An optional method narrows either form.
  assert.deepEqual(
    keys(selectOperations([{ method: "POST", path: "/pets" }], specs)),
    ["POST /pets"],
  );
  assert.deepEqual(
    keys(selectOperations([{ method: "GET", path: "/pets/*" }], specs)),
    ["GET /pets/{id}"],
  );
  // A pattern never matches across a segment boundary for `*`.
  assert.deepEqual(
    keys(selectOperations([{ path: "/pets/*/toys" }], specs)),
    [],
  );
});

test("path patterns: ** spans multiple segments and is anchored", () => {
  const specs = [
    loaded("deep.json", [
      operation("GET", "/pets"),
      operation("GET", "/pets/a/b"),
      operation("GET", "/pets/a/b/toys"),
    ]),
  ];

  assert.deepEqual(keys(selectOperations([{ path: "/pets/**" }], specs)), [
    "GET /pets/a/b",
    "GET /pets/a/b/toys",
  ]);
  assert.deepEqual(keys(selectOperations([{ path: "/pets/**/toys" }], specs)), [
    "GET /pets/a/b/toys",
  ]);
});

test("selection is the config-entry-ordered union, deduplicated on METHOD path", () => {
  const specs = catalog();
  const selection = selectOperations(
    [
      { path: "/pets/**" },
      { operationId: "getPet" },
      { path: "/pets" },
      { tags: ["pets", "store"] },
    ],
    specs,
  );

  // First entry order wins; later overlapping selectors add only new keys.
  assert.deepEqual(keys(selection), [
    "GET /pets/{id}",
    "GET /pets",
    "POST /pets",
    "DELETE /store",
  ]);
  assert.deepEqual(selection.unmatched, []);
});

test("explicit entries keep exact matching and first occurrence across specs", () => {
  const specs = catalog();
  const selection = selectOperations(
    [
      { method: "GET", path: "/pets" },
      { method: "DELETE", path: "/store" },
    ],
    specs,
  );

  assert.deepEqual(keys(selection), ["GET /pets", "DELETE /store"]);
  // The first spec's operation wins over the duplicate in the second spec.
  assert.equal(selection.selected[0].tags.includes("pets"), true);
});

test("unmatched entries are reported per form without dropping matched selectors", () => {
  const specs = catalog();
  const selection = selectOperations(
    [
      { method: "GET", path: "/missing" },
      { operationId: "nope" },
      { tags: ["nope"] },
      { path: "/missing/**" },
      { method: "GET", path: "/pets" },
    ],
    specs,
  );

  assert.deepEqual(keys(selection), ["GET /pets"]);
  assert.deepEqual(selection.unmatched, [
    { label: "GET /missing", explicit: true },
    { label: 'operationId "nope"', explicit: false },
    { label: 'tags ["nope"]', explicit: false },
    { label: 'path pattern "/missing/**"', explicit: false },
  ]);
});

test("repeated runs over identical inputs produce identical selection", () => {
  const operations = [
    { tags: ["store", "pets"] },
    { path: "/pets/*" },
    { operationId: "createPet" },
  ];
  const first = selectOperations(operations, catalog());
  const second = selectOperations(operations, catalog());
  assert.deepEqual(keys(first), keys(second));
  assert.deepEqual(first.unmatched, second.unmatched);
});
