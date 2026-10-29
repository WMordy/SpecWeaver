# AGENTS.md — working in SpecWeaver

SpecWeaver is a Node/TypeScript CLI that turns OpenAPI 3.0/3.1 definitions plus a
YAML config into dependency-free k6 load tests, runs them, and writes a results
JSON.

**Current phase:** P0 (correctness/trust), P1 (proof), P2 (zero-override), and
P3 (adoption + real-k6 live proof) are done and committed. Phase status, work
order, and limitations live
in [ROADMAP.md](ROADMAP.md) — do not duplicate them here. The Kanban board is
the source of truth for ticket status; ROADMAP tables can lag it.

## Repo map

| Path | Responsibility |
|---|---|
| `src/args.ts` | CLI flags/usage parsing (`--config`, `--vus`, `--duration`, `--out`, gate, help/version). |
| `src/cli.ts` | Orchestration: config/specs → selection → payloads → auth → warnings → base-URL gate → emit → run → results. |
| `src/config.ts` | YAML load, schema validation/defaults, CLI overrides, `${ENV_VAR}` resolution. |
| `src/spec.ts` | OpenAPI 3.0/3.1 loading, `$ref` resolution (local files), operation cataloguing. |
| `src/request-data.ts` | Path/query/header/JSON-body generation and `payloads` whole-body overrides. |
| `src/auth.ts` | Global static token/header injection and secret redaction. |
| `src/coverage.ts` | Non-fatal coverage-gap warnings (non-JSON body, cookie, security-without-auth). |
| `src/script/emit.ts` | Emits the dependency-free k6 script plus companion JSON data. |
| `src/run.ts` | k6 PATH preflight/spawn, streaming output, temp-directory lifecycle. |
| `src/results.ts` | Results JSON, console summary, warning channel, exit-code policy. |

- `test/` — unit and integration suites (see [Test layout](#test-layout)); `test/support/` holds shared helpers.
- `e2e/live-e2e.mjs` — live real-k6 suite (details in [e2e/README.md](e2e/README.md)).
- `samples/` — minimal canonical configs/spec: `petstore.openapi.json`, `specweaver.config.yaml`, `specweaver.zero-override.yaml`.
- `examples/` — runnable gallery ([README](examples/README.md)); `examples/poc-api/` holds the dependency-free test server, spec, and configs; `examples/configs/` and `examples/specs/` hold extra configs/specs.
- `.github/workflows/ci.yml` — Node 22, real k6, `npm ci`, build, `npm test`, live e2e.

## Setup, build, test

Prerequisites: Node >=18 (`package.json` engines; CI uses 22; the live e2e is
documented for Node 22+) and real `k6` on `PATH` for k6-backed suites. Run
everything from the repository root:

```sh
npm ci                 # install from package-lock.json
npm run build          # tsc -> dist/
npm test               # build + node --test (test/**)
npm run clean          # remove dist/
npm run test:live-e2e  # build + node --test e2e/live-e2e.mjs (real k6)
```

k6 rules:

- `npm test`: most CLI/run suites use a fake `k6` on `PATH`, so they need no real
  k6. `test/e2e.test.js` (built CLI against an in-test HTTP stub server) uses
  real k6 and skips when k6 is absent, unless `CI` or `SPECWEAVER_REQUIRE_K6` is
  truthy (then it fails). One `test/script-emit.test.js` runtime test also uses
  real k6 and skips whenever k6 is absent.
- `npm run test:live-e2e`: requires real k6 and fails if it is missing. The only
  local opt-out is a truthy `SPECWEAVER_SKIP_LIVE_E2E` (e.g. `1`), honored only
  when `CI` and `SPECWEAVER_REQUIRE_K6` are falsy. CI sets `CI=true` and installs
  k6, so it never skips.
- Truthy means set to anything except unset/empty/`0`/`false` (case-insensitive).
- `SPECWEAVER_KEEP_TEMP=1` keeps generated k6 artifacts under `os.tmpdir()`.

## Test layout

| File | Covers | Real k6? |
|---|---|---|
| `test/config.test.js` | YAML parsing, schema validation, defaults, CLI overrides. | no |
| `test/auth.test.js` | Token/header injection, collision precedence, redaction, `${ENV_VAR}`. | no |
| `test/request-data.test.js` | Parameter/body generation, example/default/faker chain, payload overrides, `$ref`s. | no |
| `test/spec.test.js` | OpenAPI loading, internal/external-file `$ref`, catalog ordering, errors. | no |
| `test/script-emit.test.js` | Emitted script/data shape, syntax, base URL; one runtime test. | one test |
| `test/cli.test.js` | Built CLI end-to-end with fake k6: config/selection/base-URL gates/exit codes/temp. | no (stub) |
| `test/run.test.js` | k6 discovery, spawn failures, temp cleanup. | no (stub) |
| `test/results.test.js` | NDJSON metrics, per-operation checks, summary, results path, exit policy. | no (stub) |
| `test/coverage.test.js` | Three warning kinds, ordering, dedupe, selector independence. | no |
| `test/e2e.test.js` | Built CLI against an in-test HTTP stub server. | yes (skips if absent) |
| `test/k6-requirement.test.js` | Pure `CI`/`SPECWEAVER_REQUIRE_K6` decision matrix. | no |
| `test/support/k6-requirement.js` | Shared helper imported by tests (no assertions of its own). | no |
| `e2e/live-e2e.mjs` | Real k6 against the checked-in POC API; results and server cross-checks. | yes (required) |

## Code conventions

- Strict TypeScript, ESM (`"type": "module"`, NodeNext, `strict: true`); Node
  >=18, CI Node 22. Build with `tsc`; no bundler.
- Diagnostics: warnings are `warning:`-prefixed on stderr and never change exit
  status; errors are `error:` on stderr. Never print resolved secrets/tokens.
- Exit codes: `0` success; `1` k6 failure or the `--fail-on-check-failure` gate;
  `2` SpecWeaver/config/spec/preflight/internal error. Most exit-`2` errors occur
  before k6 runs; a post-run results-file write failure also exits `2` after k6.
- Config: YAML only, `--config` only. `operations` is required; `specs` is
  optional at the schema level but required to execute (missing `specs` exits `2`
  before k6). `specs` are local files only. Coverage gaps warn, not fail.
- No unnecessary comments; match neighboring style; keep diffs scoped.
- No new dependencies unless justified and approved. Emitted k6 scripts stay
  dependency-free (k6 built-ins + plain JS only; faker runs in the CLI).

## Ticket / ROADMAP workflow

1. Read `ROADMAP.md` first; work one ticket at a time in work-order sequence.
2. Resolve the ticket, move it to `in_progress`, and implement only its scope and
   acceptance criteria.
3. Tick subtasks only when objectively satisfied; build and test before finishing.
4. Leave the ticket `in_progress`; run the reviewer (`/kanban-review <KEY>`)
   before `done`.
5. Update `ROADMAP.md` at phase end (only when the ticket allows it).
6. Branches and commits happen only when the user explicitly asks.

## Guardrails

- Never commit, branch, or push unless explicitly asked.
- Docs tickets (README/AGENTS/ROADMAP) must not change runtime behavior or tests.
- Do not modify other tickets or the project description.
- Keep deferred-feature claims truthful and link to ROADMAP limitations. If code
  and docs disagree, the code wins — fix the docs.

## Common pitfalls

- Paths (`--config`, `--out`, `specs`, `output`) resolve from `process.cwd()`;
  run commands from the repository root.
- `k6` must be on `PATH`; SpecWeaver never installs it and exits `2` if missing.
- Generated scripts/data go to a unique `mkdtemp` directory under `os.tmpdir()`
  and are deleted after the run; use `SPECWEAVER_KEEP_TEMP=1` to inspect.
- Never log resolved secrets; diagnostics redact them.
- Warnings go to stderr (`warning:`), never to stdout or the results JSON.
- Zero-override runs still need a usable base URL: an explicit `baseUrl` or an
  absolute `servers[].url` (unusable entries are skipped with a warning),
  otherwise the run exits `2`.
- `specs` are local files only; remote `http(s)` URLs are not fetched.
- Deferred (not shipped): selectors beyond `all` (`operationId`, tags,
  wildcards), non-JSON bodies, cookies, `securitySchemes`-derived auth,
  per-operation auth, and remote specs. See [ROADMAP.md](ROADMAP.md).

## Contracts and docs

- Config, CLI, exit codes, results: [README.md](README.md).
- Phase, work order, limitations/deferred scope: [ROADMAP.md](ROADMAP.md).
- Runnable examples: [examples/README.md](examples/README.md); POC API:
  [examples/poc-api/README.md](examples/poc-api/README.md).
- Live e2e behavior and env vars: [e2e/README.md](e2e/README.md).
- Minimal configs: [samples/](samples/).
- CI: [.github/workflows/ci.yml](.github/workflows/ci.yml). Build config:
  [package.json](package.json), [tsconfig.json](tsconfig.json).
