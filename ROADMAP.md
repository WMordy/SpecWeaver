# SpecWeaver Roadmap

Single source of truth for planned work and agent handoff. Update this file when
priorities change; the Kanban board remains the source of truth for ticket status.

- **Project:** SpecWeaver (`SPEC`) — `01M57WNZ2HM1QNBMD684YFXK7D`
- **Audit of record:** SPEC-12 (closed) — `01M5CJ3JWM0S79R1GNVEEVJ5GX`
- **Snapshot:** 2026-10-24

## Where we are

SPEC-1 through SPEC-36 are `done`; P3 (adoption and live end-to-end proof) is
complete and committed. The P2 zero-override milestone remains complete.

P4 (SPEC-33…41) covers the capabilities deferred by P2/P3: base-URL fallback
breadth, `label`/`matrix` path styles, cookies, selectors beyond `all`, OpenAPI
3.1 `webhooks`, non-JSON bodies, `securitySchemes`-derived and per-operation
auth, and remote specs. SPEC-33, SPEC-34, SPEC-35, and SPEC-36 are done
(committed on `master`); SPEC-37 is in progress. Together they ship the
first-usable base-URL fallback, `label`/`matrix` path styles, generated and sent
cookie parameters, and the `operationId`, tags, and path-pattern selectors.
SPEC-37 is in progress; SPEC-38…41 are `todo` tickets.

P0 (correctness and trust) and P1 (proof it works) are both closed and
committed on `master`. The P0 commits are:

- SPEC-13 `96363cf` — Apply YAML payload overrides to generated requests
- SPEC-14 `1c30e7b` — Fail loudly when a run would execute no operations
- SPEC-15 `c3c139b` — Warn on specs that contribute zero operations
- SPEC-16 `39c9c3e` — Align docs with shipped behavior
- Roadmap `c92c2d6` — Add P0 roadmap for agent handoff

The v1 audit scored **10 Met / 1 Partial / 0 Missing**; the Partial (`payloads`)
and the audit's trust gaps were fixed by P0:

1. `payloads[].body` now replaces the generated body; unsupported keys are
   rejected and unmatched overrides warn (SPEC-13).
2. Missing `specs` or zero matched operations now exit `2` with actionable
   messages and no results file (SPEC-14).
3. Zero-operation specs (components-only in 3.1) now warn and feed the
   exit-`2` no-run path (SPEC-15).
4. README, config JSDoc, and the sample now match actual behavior (SPEC-16).

P1 (SPEC-17…21) proved the project works end to end: GitHub Actions CI builds
and tests every push/PR (SPEC-17), the k6 e2e is mandatory in CI rather than
skipped (SPEC-18), `--fail-on-check-failure` provides opt-in check gating
(SPEC-19), and the README documents the flag and exit-code behavior (SPEC-20).
SPEC-21 closed P1 with a verified roadmap refresh.

P2's first increment — the **zero-override run** — has shipped as SPEC-22…25.
A config can now supply just `specs` and `operations: all`; the tool selects the
whole catalog and derives payloads and the request base URL from the OpenAPI
document. Auth is **not** derived: it stays explicit and global, and a declared
`security` requirement without configured auth only produces a warning (there is
no `securitySchemes` mapping). SPEC-22 widened the config schema, SPEC-23
expands `all` in deterministic order, SPEC-24 fails loudly on an unusable
fallback base URL, and SPEC-25 warns on coverage gaps without failing. SPEC-26
documents the shipped behavior and refreshes this roadmap.

P2 commits on `master`:

- SPEC-22 `51cf606` — Accept `operations: all` in the config schema
- SPEC-23 `59f2724` — Select the whole catalog for `operations: all`
- SPEC-24 `b2e25af` — Fail on an unusable base URL in zero-override runs
- SPEC-25 `94d88ab` — Warn on zero-override coverage gaps
- SPEC-26 `0e0962e` — Document zero-override mode and refresh the roadmap

Verification at the P2 close (2026-10-21, CI re-run 2026-10-22): `npm run build`
clean (`tsc` exits 0); `npm test` passes **298/298** tests with **0 failed and
0 skipped**, including the k6 end-to-end test. That total is 58 tests above P1
close's 240. CI run `39691033919` is green on SPEC-26 commit `0e0962e`. The
zero-override sample was run from the repository root with the k6 PATH-stub
pattern from `test/cli.test.js`: it exited `0`, selected all 3 petstore
operations, and wrote a results file.

P3 (SPEC-27…32) is complete. All P3 tickets are `done` and committed. P3 added the adoption
surface and proof: a dependency-free POC API and runnable examples gallery
(SPEC-27/28), a real-k6 live end-to-end test wired into CI (SPEC-29), a README
overhaul (SPEC-30), and `AGENTS.md` onboarding (SPEC-31). It adds no new product
features; selectors beyond `all`, non-JSON bodies, auth derivation, and
remote specs remain deferred (cookies were deferred at P3 time and shipped later
in SPEC-35).

P3 commits on `master`:

- SPEC-27 `da4c80a` — Add a dependency-free POC API for examples and live e2e
- SPEC-28 `9f3e9e0` — Add a runnable examples gallery
- SPEC-29 `e3da8c2` — Run a live real-k6 e2e against the POC API in CI
- SPEC-31 `6954a49` — Add `AGENTS.md` onboarding for AI coding agents
- SPEC-30 `1aee7ca` — Overhaul the README for adopters and AI agents

Verification at the P3 close (2026-10-24, `master` at `1aee7ca`): `npm run build`
exits `0` (`tsc`); `npm test` passes **298/298** tests with **0 failed and
0 skipped**, including the k6 e2e; `npm run test:live-e2e` passes **1/1** with
real `k6 v2.3.0` (no PATH stub) in about 7s including the build; and CI run
`40045212473` is **green** on `1aee7ca`, with the "Run live k6 end-to-end test"
step completed successfully (not skipped). The documented link/anchor validator
checked 6 Markdown files and 123 links/anchors with no errors. All gallery
examples were run against the POC API and matched their documented exit codes,
operation sets, warnings, and results. The live e2e is a functional smoke test,
not a performance benchmark, and the POC API is example/test infrastructure, not
a supported service (see the P3 limitations below).

## Work order (do not reorder without updating this file)

### P0 — correctness and trust (complete)

| Order | Key | Ticket ID | Priority | Status | Title |
|---|---|---|---|---|---|
| 1 | SPEC-13 | `01M5CK4F1VDF1WGASPJCX03FSR` | urgent | done | Apply YAML payload overrides to generated requests |
| 2 | SPEC-14 | `01M5CK4J3QMCDQ2D326R8V8J01` | urgent | done | Fail loudly when a run would execute no operations |
| 3 | SPEC-15 | `01M5CK4MKHX334Z05PKTX62BJG` | high | done | Fail or warn on specs that contribute zero operations |
| 4 | SPEC-16 | `01M5CK4QW810RRWS12N6JMR11M` | high | done | Align README, config docs, and sample with actual behavior |

Dependencies (resolved):

- SPEC-15's exit-code criterion depends on SPEC-14's no-run behavior.
- SPEC-16 is docs-only and must come last, after 13–15 establish the real behavior.

#### SPEC-13 — payload overrides

- **Contract:** `payloads[].body` replaces the generated JSON body for the
  matching `{ method, path }`. Whole-value replacement, not a deep merge.
  Unsupported keys must be supported explicitly or rejected; never ignored.
- **Wiring point:** `src/config.ts` already returns `PayloadOverride[]`
  (`{ method, path, data }`). Apply overrides in the CLI between
  `generateAllRequestData(...)` and `injectAuth(...)` (`src/cli.ts:184-187`), or
  add an override parameter to the generation layer. Reuse the normalized
  `method + path` key from `selectOperations` (`src/cli.ts:67-90`).
- **Warnings:** overrides that match no selected operation go to stderr, same
  style as the existing unmatched-operation warning.
- **Tests:** matching body, non-matching warning, method-case normalization,
  no-override regression, and at least one distinctive value asserted in the
  emitted data/script.
- **Docs:** remove "Reserved for future use" (`README.md:116`) and describe the
  implemented semantics.

#### SPEC-14 — fail loudly on no-run

- `specs` becomes required to execute: whether `operations` is an explicit
  non-empty list or `all`, there must be a catalog to select from (a deliberate
  reversal of SPEC-2's "optional" decision; document it).
- Missing `specs` → exit `2`, actionable message, no results file.
- Every configured operation unmatched → exit `2`, list each unmatched
  `{ method, path }`, no success summary, no results file.
- Partial match → run, warn about unmatched entries, return k6's exit code.
- Preserve exit `1` for k6 failures and `2` for SpecWeaver errors.
- Read sites: `src/cli.ts:158-168`, `src/config.ts` schema validation,
  `README.md:182-193`.

#### SPEC-15 — zero-operation specs

- After loading each spec, warn when it contributes zero operations, naming the
  source and stating that 3.1 `webhooks` and components-only documents are not
  catalogued in v1.
- Loading a zero-catalog spec as the only source must fail via SPEC-14's no-run
  path (exit `2`, no results file).
- Do not implement webhook cataloging.
- Read sites: `src/spec.ts:394-403`, `src/spec.ts:448-452`.

#### SPEC-16 — docs truth pass

- README: payload semantics, local-file-only `specs`, required-`specs`/exit-`2`
  behavior, 3.1 webhooks limitation.
- `src/config.ts` JSDoc: remove "path(s)/URL(s)" wording.
- Sample config comments must match behavior; prefer a sample override value
  distinguishable from the spec example.
- Verify every README field/flag against `src/args.ts`, `src/config.ts`,
  `src/cli.ts`.

### P1 — prove it works (complete)

P1 is complete. Do not start a P2 item without a ticket; create it through the
normal pipeline and update this file first.

| Order | Key | Ticket ID | Priority | Status | Title |
|---|---|---|---|---|---|
| 1 | SPEC-17 | `01M5CNVCMCM78PF6P5BCKZGED1` | high | done | Add GitHub Actions CI workflow for build and tests |
| 2 | SPEC-18 | `01M5CNVD8DQ1QZHY5PK4XWQWF8` | high | done | Make the k6 e2e mandatory in CI |
| 3 | SPEC-19 | `01M5CNVDP4T9SGPEMSTFBXWGQT` | high | done | Add --fail-on-check-failure gating flag |
| 4 | SPEC-20 | `01M5CNVE4DZCKH6AG8WNK967H2` | medium | done | Document check gating and exit-code behavior |
| 5 | SPEC-21 | `01M5CNVESWZQN027V0CSSK08SY` | low | done | Refresh ROADMAP with verified P0 record and P1 plan |

Statuses are the board state at execution time (2026-10-20). All five P1 tickets
are `done`; P1 is closed.

Dependencies (resolved):

- SPEC-17 (CI workflow) is the prerequisite for observing SPEC-18 in CI. The
  SPEC-18 change is test-side and can land independently, but the
  mandatory-e2e guarantee is only exercised once SPEC-17's workflow runs it.
- SPEC-19 (the gating flag) precedes SPEC-20 (the README docs) because the docs
  must describe shipped behaviour, not a plan.
- SPEC-21 is last: it records the verified outcome of SPEC-17…20, so it cannot
  be written before they are `done`.

**Gating decision (resolved).** Checks remain informational by default, so a
run with failing checks still exits `0` unless the user opts in. The chosen gate
is the opt-in, CLI-only `--fail-on-check-failure` flag (SPEC-19), documented for
users in the README (SPEC-20). There is no `results.json`-based external gate in
v1, and no product-owner decision remains open for P1.

### P2 — integration convenience (zero-override increment complete; remainder deferred)

The zero-override increment shipped and is committed; broader P2 work remains
deferred and has no active ticket.

| Order | Key | Ticket ID | Priority | Status | Title |
|---|---|---|---|---|---|
| 1 | SPEC-22 | `01M5CX3NZCE8EHCPB38ZZ467PP` | high | done | Accept `operations: all` in the config schema |
| 2 | SPEC-23 | `01M5CX3PR9PBAFT1V6XC2BY20Z` | high | done | Select the whole catalog for `operations: all` |
| 3 | SPEC-24 | `01M5CX3QAJH27Y9ZYNT80MHYKQ` | high | done | Fail on an unusable base URL in zero-override runs |
| 4 | SPEC-25 | `01M5CX3QZH098D14DBD95GC9MK` | medium | done | Warn on zero-override coverage gaps |
| 5 | SPEC-26 | `01M5CX3RVF813NP33HYPSD30XX` | low | done | Document zero-override mode and refresh the ROADMAP |

Statuses are the board state at this refresh (2026-10-22). All of SPEC-22…26
are `done`; no active P2 ticket remains.

Dependencies (resolved):

- SPEC-23 consumes SPEC-22's `OperationsSelector` union; expansion lives in the
  CLI selection path.
- SPEC-24 and SPEC-25 wire into the post-selection, pre-preflight CLI path, so
  they depend on SPEC-23 returning concrete operations.
- SPEC-26 is docs-truth and must be last, written against the behavior shipped
  by SPEC-22…25.

#### P2 outcome

1. **Operation selection — partially delivered (`all` only).** `operations: all`
   selects every catalogued operation across every configured spec in
   deterministic order. At P2 close, `operationId` selectors, `tags` selectors,
   `*`/wildcard shorthands, per-operation include/exclude, and tolerant
   method/path matching were **deferred**, not shipped; the only accepted
   selector was the exact, case-sensitive literal `all`. P4/SPEC-36 later ships
   the additive `operationId`, tags, and path-pattern forms (include/exclude
   composition and tolerant matching remain deferred).
2. **Payload contract — delivered and documented.** Precedence is
   `payloads` override (whole-body replacement) → explicit example/examples →
   schema `default` → faker by `type`/`format`; required and optional fields are
   always generated. This is now the README's documented behavior, not a plan.
3. **Broader body/auth support — partially delivered.** Non-JSON bodies
   (multipart, form-urlencoded, XML), security-scheme-derived auth, and
   per-operation auth are still not implemented. Non-JSON required bodies and
   security without configured auth are surfaced by SPEC-25 warnings;
   security-scheme-derived and per-operation auth remain unimplemented without a
   dedicated warning. Cookie parameters, deferred at P2 close, are generated and
   sent since SPEC-35.

#### P2 limitations

- **Non-JSON request bodies** are not generated. A required non-JSON body is
  sent without a body and produces a `warning:`; optional non-JSON bodies are
  silent.
- **Cookie parameters were not generated or sent (fixed by SPEC-35).** They are
  now generated through the same example → `default` → faker chain (required and
  optional alike) and sent in exactly one percent-encoded `Cookie` header, in
  declaration order. Array/object values serialize non-exploded (`explode`
  treated as `false`, a documented deviation from OpenAPI's cookie default);
  `auth.headers` `Cookie` wins; no warning is emitted.
- **Auth gaps are warn-only.** Auth is a single global static token/headers
  value. An operation with non-empty `security` and no configured auth runs
  without authentication and warns; there is no `securitySchemes` mapping and no
  per-operation auth.
- **Base URL used only the first string fallback entry (fixed by SPEC-33).**
  P2 resolution took the first string `servers[].url` across the specs in `specs`
  order (server-variable defaults substituted), so a relative first entry failed
  even when a later entry was usable. SPEC-33 now uses the first usable entry
  and warns on stderr for each skipped one.
- **Explicit `baseUrl` is trusted verbatim.** It must be a non-empty string
  (config validation rejects an empty, whitespace-only, or non-string value);
  otherwise it is used
  as-is and bypasses the server-URL usability gate. Trailing slashes are
  stripped when request URLs are composed.
- **`specs` is local-file-only.** Remote `http(s)://` documents are never
  fetched.
- **OpenAPI 3.1 `webhooks` were not catalogued at P2 time** (fixed by SPEC-37;
  they are catalogued as path operations at `/<webhookName>` after `paths`).
  Components-only documents still load but contribute zero operations; under
  `all` they can lead to the zero-catalog exit `2`.

### P3 — adoption and live end-to-end proof (complete)

P3 is complete and committed as SPEC-27…32. The phase had two outcomes: make
the shipped tool easy to evaluate and adopt (POC API, runnable examples, README,
AGENTS.md), and prove the real pipeline in CI by running the built CLI with real
k6 against the checked-in POC API. P3 adds no new product capabilities;
selectors beyond `all`, non-JSON bodies, and auth derivation remain deferred
(cookies were deferred at P3 time and shipped later in SPEC-35).

| Order | Key | Ticket ID | Priority | Status | Title |
|---|---|---|---|---|---|
| 1 | SPEC-27 | `01M5GEG4EZ82GE2M64FBSTD81R` | high | done | Add dependency-free POC API and OpenAPI example |
| 2 | SPEC-28 | `01M5GEG8AQP1AAN2W121ABJK1A` | high | done | Add runnable examples for every shipped feature |
| 3 | SPEC-29 | `01M5GEGCG9RP255MDH95M2GQE9` | urgent | done | Add live e2e with real k6 and run it in CI |
| 4 | SPEC-31 | `01M5GEGK03GH1BD273RKQFMX72` | medium | done | Add concise AGENTS.md onboarding for AI coding agents |
| 5 | SPEC-30 | `01M5GEGGEYW0ETXCEK6NT1P05E` | high | done | Overhaul README for human adopters and AI agents |
| 6 | SPEC-32 | `01M5GEGNR7F206V1QA3M6Y2V6Y` | low | done | Close out P3 docs and refresh ROADMAP after delivery |

Statuses are the board state at this refresh (2026-10-24). All of SPEC-27…32 are
`done`; P3 is complete.

Dependencies (resolved):

- SPEC-28 reused SPEC-27's POC API/spec and warning config, and added only the
  minimum extra OpenAPI document needed for the multi-spec example.
- SPEC-29 depends on SPEC-27 (server/spec) and SPEC-28 (runnable config), and
  uses real k6 from `PATH` rather than a stub.
- SPEC-31 follows SPEC-29 so it documents the exact live-e2e command.
- SPEC-30 follows SPEC-27…29 and SPEC-31 so its AGENTS.md link resolves and it
  documents only behavior proved by the earlier tickets.
- SPEC-32 is last: it records verified outcomes and does not mark P3 done early.

#### P3 delivered outcomes / evidence

1. **Adoption surface — delivered.** A checked-in `examples/` tree contains a
   dependency-free POC API (`examples/poc-api/server.js`, `openapi.yaml`), the
   canonical and coverage-warning configs, and runnable configs for
   zero-override, explicit operations, auth, payload overrides,
   multi-spec/baseUrl, and CI usage. Every gallery command was run from the
   repository root against the POC API during closeout and matched its
   documented exit code, operation set, warnings, and results path.
2. **Human and agent documentation — delivered.** The README is restructured
   around value proposition, quick start, examples, configuration, CLI,
   recipes, how it works, exit codes, warnings, limitations, troubleshooting,
   development/testing, and AI-agent onboarding. `AGENTS.md` covers the repo map,
   canonical commands, test layout, conventions, ticket workflow, guardrails, and
   pitfalls without duplicating the README; it points to the README and roadmap
   for contracts and phase status.
3. **Real end-to-end proof in CI — delivered.** `e2e/live-e2e.mjs` starts the POC
   API on an ephemeral port, runs the built CLI with real k6 from `PATH` and
   `--vus 1 --duration 1s --fail-on-check-failure`, asserts exit `0`, the results
   JSON, per-operation checks, the POC request log, and cleanup, and uses no k6
   stub. CI runs `npm run test:live-e2e` as a dedicated step after `npm test`; the
   existing stub-based unit coverage remains unchanged.
4. **Verification evidence (2026-10-24, `master` `1aee7ca`).** Build `tsc` exit
   `0`; `npm test` **298/298 passed, 0 failed, 0 skipped** (k6 e2e included);
   live e2e **1/1 passed** with real `k6 v2.3.0`, 0 skipped, ~7s including build;
   CI run **`40045212473` success** with the live-e2e step completed, not
   skipped; link/anchor validator **6 files / 123 links, 0 errors**; `git status`
   clean before the docs closeout.

#### P3 documentation audit (2026-10-24)

Claim → evidence → result:

- `operations: all` is the only selector beyond an explicit list → `src/config.ts`
  accepts only the literal `all` or `{method, path}[]`; README, AGENTS, examples,
  and the P2 outcome label other selectors deferred → **pass**.
- Auth is never derived from the spec → `src/auth.ts` has no `securitySchemes`
  mapping; README, AGENTS, samples, and the P2 limitations say auth is explicit
  and global → **pass**.
- Specs are local files only → `src/config.ts`/`src/spec.ts` take local paths;
  README, AGENTS, examples, and the P2 limitations defer remote specs → **pass**.
- Deferred features are labeled and linked → README feature table, examples
  "Shipped vs deferred", and AGENTS pitfalls link to the ROADMAP limitations →
  **pass**.
- Example paths and commands are runnable → all six gallery commands were run
  against the POC API and matched their documented exit codes, operation sets,
  warnings, and results paths → **pass**.
- The live-e2e command matches CI → CI runs `npm run test:live-e2e`; README,
  `e2e/README.md`, and AGENTS name the same command → **pass**.
- The CI badge/link resolves → repository is `WMordy/SpecWeaver`; the badge and
  link target `.github/workflows/ci.yml`, which exists → **pass**.
- No stale P3 "planned/not started" claims → stale wording in `AGENTS.md`,
  `examples/README.md`, and `examples/poc-api/README.md` was corrected and this
  roadmap section rewritten → **pass**.

#### P3 limitations / non-goals

- No new product features. Selectors beyond `all`, non-JSON bodies,
  `securitySchemes`-derived auth, per-operation auth, and remote specs remain
  deferred and are documented as such in the README and examples gallery.
  Cookies were also deferred at P3 time; they shipped later in SPEC-35.
- The live e2e is a functional smoke test against a local, in-memory POC API;
  it is not a performance, capacity, or SLA test, and it does not call public
  internet APIs.
- The POC API is example/test infrastructure, not a supported product surface;
  it is not hardened for production, persistence, TLS, or auth flows.
- No Docker, k6 Cloud, npm publishing, or new CI providers are introduced.
- P3 does not reopen P2 scope or close deferred items implicitly.

#### P3 delivery decisions (as implemented)

- POC API: Node 22 built-in `http`, in-memory deterministic data, no new
  dependencies; listens on `127.0.0.1`, default port `8080` (override via
  `PORT`). It implements the existing `samples/petstore.openapi.json` routes so
  the shipped zero-override sample runs live on the default port, then extends
  for the extra example and warning cases.
- Live e2e lives at `e2e/live-e2e.mjs` (outside `test/` so `npm test` does not
  run it twice), exposed as `npm run test:live-e2e` and invoked by a dedicated
  CI step. It starts the POC server on an ephemeral port, waits for readiness,
  runs `dist/cli.js` with `--vus 1` and a short duration, and overrides
  `baseUrl` in a temp config; use real k6 from `PATH`, never the stub. Assert
  exit `0`, the results JSON (`outcome`, `k6ExitCode`, per-operation checks),
  and server-observed requests; always clean up the server and temp dirs.
- Examples live under `examples/`; the POC API, spec, and configs (including
  the coverage-warning config) live under `examples/poc-api/`. Existing
  `samples/` stay valid and are referenced, not deleted.
- `AGENTS.md` is a separate ticket (SPEC-31) and links to the README rather than
  restating it.
- P3 adds no new config fields or CLI flags.

### P4 — deferred capability expansion (in progress)

P4 is in progress. Nine skeleton tickets were seeded on 2026-10-24 from a
roadmap-vs-implementation gap review. SPEC-33, SPEC-34, SPEC-35, and SPEC-36 are
done; SPEC-37 is `in_progress` and the remaining four are `todo` and await
planner elaboration. The order below is the work order; do not reorder it without
updating this file. Each ticket must be planned before implementation, and docs
must describe shipped behavior only.

| Order | Key | Ticket ID | Priority | Status | Title |
|---|---|---|---|---|---|
| 1 | SPEC-33 | `01M5QTK2DF4M4R8BTX6RV905FS` | medium | done | Accept the first usable `servers[]` URL as the base-URL fallback |
| 2 | SPEC-34 | `01M5QTK52K557BCDRTKWV0N6PS` | low | done | Implement `label` and `matrix` path parameter styles |
| 3 | SPEC-35 | `01M5QTK8711DW0S5BFN0M78R1D` | medium | done | Generate and send cookie parameters |
| 4 | SPEC-36 | `01M5QTKB3GR8JAST4FF8Q35VQN` | high | done | Support operation selectors beyond the `all` literal |
| 5 | SPEC-37 | `01M5QTKE0SXC7BY1KX6WTCQGRT` | medium | in_progress | Catalogue OpenAPI 3.1 `webhooks` |
| 6 | SPEC-38 | `01M5QTKGSG573T640BKBVJJ8Q5` | high | todo | Generate non-JSON request bodies |
| 7 | SPEC-39 | `01M5QTKKJBDDMR0AJV6ENT8661` | high | todo | Derive global auth from `securitySchemes` |
| 8 | SPEC-40 | `01M5QTKPE005PRTKMFG1DGEFSX` | medium | todo | Add per-operation auth overrides |
| 9 | SPEC-41 | `01M5QTKSARFS9P8RXMTS9BB2AW` | medium | todo | Fetch remote `http(s)` specs |

Dependencies and sequencing:

- SPEC-33…38 are independent slices and may be planned in work order.
- SPEC-39 establishes the shared auth model; SPEC-40 depends on it and cannot be
  implemented first.
- SPEC-41 is last: remote fetching adds network egress, timeouts, redirects, and
  an SSRF surface that must be scoped before implementation.

Decisions and resolved behavior:

- SPEC-33 (done) changes which host a zero-override run targets when an unusable
  `servers[]` entry precedes a usable one; each skipped entry now warns on stderr
  (redacted), and the existing exit-`2` diagnostic remains when no entry is
  usable.
- SPEC-34 (done) serializes `label`/`matrix` path parameters (primitive, array,
  object; `explode` default `false`) into their OpenAPI wire forms. Structural
  delimiters (`.`, `,`, `;`, `=`) stay literal while scalar components are
  percent-encoded; URL composition substitutes these pre-encoded values verbatim
  and keeps encoding raw `simple` path values as before. Unknown path styles
  still fall back to `simple` without a new warning.
- SPEC-35 (done) generates every declared `in: cookie` parameter through the
  same seeded example → `default` → faker chain (required and optional alike) and
  sends them in exactly one `Cookie` request header: `name=value` pairs joined by
  `"; "` in declaration order, with names and values percent-encoded. Array and
  object values serialize non-exploded (`explode` treated as `false`) — a
  documented deviation from OpenAPI's cookie default. `auth.headers` `Cookie`
  wins case-insensitively (existing collision precedence). The per-operation
  cookie coverage warning and its classifier were removed; non-JSON-body and
  security warnings are unchanged. Cookie jars, `Set-Cookie` handling, and
  cross-request cookie reuse remain out of scope.
- SPEC-36 (done) adds three additive selector forms next to `all` and
  explicit `{ method, path }`: exact `{ operationId }`, `{ tags }` with
  case-sensitive OR semantics, and `{ path }` patterns (`*` = one non-empty
  segment, `**` = the remainder, optional `method` filter). Each entry expands
  in catalog order; the final selection is the config-entry-ordered union,
  deduplicated on `METHOD path` first-wins. No-match entries warn per selector
  form; a zero-match selection keeps the SPEC-14 exit-`2` no-run path. Include/
  exclude composition and tolerant matching remain deferred.
- SPEC-37 (in progress) catalogues 3.1 `webhooks` operations after the document's
  `paths`: each `webhooks.<name>` entry is catalogued exactly like a `paths`
  entry whose path is `/<name>` (leading `/` added when missing), with the
  fixed canonical method order. SpecWeaver inverts the webhook direction —
  load tests **send** webhook-shaped requests **to the configured base URL**
  (k6 plays the API server; the base URL plays the consumer endpoint) — so
  selection, generation, `payloads`, auth injection, emission, and the base-URL
  gate treat webhook operations exactly like path operations. A components-only
  3.1 document remains the reason a spec contributes zero operations; the
  zero-operation warning wording was retired accordingly. Only 3.1 documents
  catalogue the `webhooks` member. Webhook `$ref` resolution beyond the
  existing local `$ref` support and fetching/validating the real consumer are
  out of scope.
- SPEC-38 must define multipart/file-body representation without adding runtime
  dependencies.
- SPEC-39/40 must preserve explicit-config precedence and secret redaction;
  unsupported schemes stay warn-only.
- SPEC-41 must define an explicit timeout/redirect/SSRF policy before fetching.

Guardrails: no new dependencies without approval, emitted k6 scripts stay
dependency-free, warnings remain non-fatal, secrets are never logged, and the
roadmap is updated at phase close; per-ticket updates are limited to status and
marking limitations fixed.

## Explicit non-goals for this roadmap

Scheduling/continuous runs, baseline/regression comparison, SLA thresholds,
GraphQL/non-OpenAPI specs, k6 Cloud, and a Web UI remain deferred/out of scope
unless the product owner reopens them. Do not create tickets for them here.

## Agent working protocol

1. Read this file, then fetch the next ticket in order from the board.
2. Move it to `in_progress` and work only within its scope.
3. Implement, then run `npm run build` and `npm test`. Do not run the k6 e2e
   unless the ticket explicitly requires it.
4. Update subtasks as you complete them; leave the ticket `in_progress` for
   review unless the workflow says otherwise.
5. Run the reviewer before calling a ticket done.
6. After completing any phase, update this roadmap's "Where we are" section and
   check off that phase's tickets in its order table (or note their status).
7. Never commit unless the user explicitly asks. Never modify other tickets or
   the project description.

## Session handoff checklist

- [ ] Current ticket and its ID recorded here or on the board.
- [ ] `git status` clean or changes explained.
- [ ] `npm run build` and `npm test` results noted.
- [ ] Next ticket in order identified.
- [ ] New decisions written into this file, not just chat.

## Change log

- 2026-10-20: Created. P0 defined from SPEC-12 audit; SPEC-13…16 created.
- 2026-10-20: P0 complete. SPEC-13…16 approved and `done`; build clean,
  224/224 tests passing (including k6 e2e). P1 was next.
- 2026-10-20: P1 complete. SPEC-17…21 approved and `done`; SPEC-21 roadmap
  refresh approved. P0 is recorded as committed (`96363cf`, `1c30e7b`,
  `c3c139b`, `39c9c3e`, roadmap `c92c2d6`). `npm run build` clean;
  `npm test` 240/240 passing, 0 skipped, including the k6 e2e. P2 is next.
- 2026-10-21: P2 zero-override increment complete. SPEC-22…25 approved and
  `done` (`51cf606`, `59f2724`, `b2e25af`, `94d88ab`); SPEC-26 docs, sample,
  and roadmap refresh added. `npm run build` clean; `npm test` 298/298 passing,
  0 skipped, including the k6 e2e; the zero-override sample exits `0` against
  the k6 PATH stub. Selectors beyond `all` remain deferred.
- 2026-10-22: SPEC-26 approved and `done` (`0e0962e`); P2 zero-override
  milestone closed with no active ticket. CI run `39691033919` green on
  `0e0962e`. Remaining P2 items (selector breadth, non-JSON bodies, cookies,
  auth derivation/per-operation auth) stay deferred.
- 2026-10-22: P3 planned and seeded on the board; SPEC-27…32 created as
  `todo` skeletons, with no implementation started. P3 targets adoption (POC
  API, examples, README, AGENTS.md) plus a real-k6 live e2e in CI, and adds no
  new product features. Ticket IDs: SPEC-27 `01M5GEG4EZ82GE2M64FBSTD81R`,
  SPEC-28 `01M5GEG8AQP1AAN2W121ABJK1A`, SPEC-29
  `01M5GEGCG9RP255MDH95M2GQE9`, SPEC-30 `01M5GEGGEYW0ETXCEK6NT1P05E`,
  SPEC-31 `01M5GEGK03GH1BD273RKQFMX72`, SPEC-32
  `01M5GEGNR7F206V1QA3M6Y2V6Y`.
- 2026-10-24: P3 delivered and committed. SPEC-27 `da4c80a`, SPEC-28
  `9f3e9e0`, SPEC-29 `e3da8c2`, SPEC-31 `6954a49`, SPEC-30 `1aee7ca`; SPEC-32
  closeout was still pending at that verification point. Verified on `1aee7ca`: `npm run
  build` exits `0`; `npm test` 298/298 passing, 0 failed, 0 skipped, including
  the k6 e2e; `npm run test:live-e2e` 1/1 passing with real `k6 v2.3.0` (no
  stub); CI run `40045212473` green with the live-e2e step executed. Link/anchor
  validator: 6 files, 123 links, 0 errors. All gallery examples ran and matched
  their documented behavior. P3 adds no product features; deferred items remain
  deferred.
- 2026-10-24: SPEC-32 closeout approved and `done`; all P3 tickets (SPEC-27…32)
  are complete. Final roadmap statuses flipped to `done`/complete, and the
  AGENTS.md exit-`2` wording was aligned with the README's post-k6
  results-write exception.
- 2026-10-24: P4 planned from a roadmap-vs-implementation gap review. SPEC-33…41
  created as `todo` skeletons covering deferred base-URL fallback breadth,
  `label`/`matrix` path styles, cookies, selectors beyond `all`, 3.1
  `webhooks`, non-JSON bodies, `securitySchemes`-derived auth, per-operation
  auth, and remote specs. No implementation started; SPEC-33 is first in work
  order and awaits planning.
- 2026-10-29: SPEC-33 done: the fallback now uses the first usable
  `servers[].url` and warns on stderr for each distinct skipped entry, with the
  existing exit-`2` diagnostic preserved when none is usable. The P2 base-URL
  limitation is annotated as fixed. `npm run build` clean; `npm test` 305/305
  passing; reviewer passed. P4 remains open; the other eight tickets are
  untouched.
- 2026-10-30: SPEC-34 done: `label`/`matrix` path parameters now serialize to
  their documented wire forms for primitives, arrays, and objects (honoring
  `explode`, default `false`), with structural delimiters literal and scalar
  components percent-encoded during URL composition. The stale code comment
  claiming a "documented limitation" was corrected; no README/ROADMAP
  limitation entry existed to remove, and AGENTS.md/samples needed no edit.
  `npm run build` clean; `npm test` 322/322 passing. P4 remains open; the other
  seven tickets are untouched.
- 2026-10-31: SPEC-36 approved and done. `operations` entries now
  accept exact `{ operationId }`, case-sensitive OR `{ tags }`, and `{ path }`
  patterns (`*` one non-empty segment, `**` remainder, optional `method`) as
  additive forms; selection moved to `src/selection.ts` with deterministic
  config-entry-ordered union expansion, `METHOD path` first-wins dedupe,
  per-form unmatched warnings, and the unchanged SPEC-14 zero-match exit `2`.
  `OperationEntry` records operation-level `tags`. README/AGENTS/examples
  limitations no longer claim selectors are deferred. `npm run build` clean;
  `npm test` 338/338 passing (16 new/updated selector, catalog, and CLI tests).
- 2026-11-01: SPEC-35 implemented (in review): `in: cookie` parameters are
  generated through the same seeded example → `default` → faker chain and sent
  in one percent-encoded `Cookie` header (`name=value; name2=value2`, declaration
  order; array/object values non-exploded, a documented deviation from OpenAPI's
  cookie default). `auth.headers` `Cookie` wins case-insensitively, and an
  explicit `Cookie` header parameter is preserved. The cookie coverage warning
  and its classifier were removed from `src/coverage.ts`; the non-JSON-body and
  security warnings are unchanged. README, ROADMAP, AGENTS.md, and the examples
  gallery no longer list cookies as deferred. `npm run build` clean; `npm test`
  344/344 passing, 0 failed, 0 skipped. P4 remains open; the other five tickets
  are untouched.
- 2026-11-03: SPEC-35 approved and done (committed as `fc43905`).
- 2026-11-03: SPEC-37 implemented: OpenAPI 3.1 `webhooks` entries are catalogued
  as path operations at `/<webhookName>` (leading `/` added when missing) after
  `paths`, in document order with the canonical method order, sharing the
  `paths` catalogue code path. Webhook operations are exercised as outbound
  webhook-shaped requests to the configured base URL and flow through
  selection, generation, `payloads`, auth, emission, and the base-URL gate
  unchanged. Webhooks-only specs no longer contribute zero operations; the
  zero-operation warning now names components-only documents as the only
  remaining cause (`only \`paths\` and \`webhooks\` operations are catalogued`).
  Only 3.1 documents catalogue a `webhooks` member. README feature table,
  selection docs, and limitations updated; ROADMAP P2 limitation annotated as
  fixed and the P4 decision recorded. `npm run build` clean; `npm test`
  350/350 passing (catalog, selection, warning, and CLI run tests). P4 remains
  open; the other four tickets are untouched.
