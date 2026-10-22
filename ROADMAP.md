# SpecWeaver Roadmap

Single source of truth for planned work and agent handoff. Update this file when
priorities change; the Kanban board remains the source of truth for ticket status.

- **Project:** SpecWeaver (`SPEC`) — `01M57WNZ2HM1QNBMD684YFXK7D`
- **Audit of record:** SPEC-12 (closed) — `01M5CJ3JWM0S79R1GNVEEVJ5GX`
- **Snapshot:** 2026-10-22

## Where we are

SPEC-1 through SPEC-26 are `done`; the P2 zero-override milestone is complete
and committed, and no ticket is currently `in_progress`.

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
3. Zero-operation specs (3.1 `webhooks`/components-only) now warn and feed the
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

P3 (SPEC-27…32) is now planned and seeded on the board. All six P3 tickets
are `todo`; no P3 implementation has started. P3 is about adoption and proof: a
dependency-free POC API and examples tree, a README/AGENTS.md overhaul, and a
real-k6 live end-to-end test in CI. It adds no new product features; see the P3
section below.

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
   deterministic order. `operationId` selectors, `tags` selectors, `*`/wildcard
   shorthands, per-operation include/exclude, and tolerant method/path matching
   are **deferred**, not shipped. The only accepted selector is the exact,
   case-sensitive literal `all`.
2. **Payload contract — delivered and documented.** Precedence is
   `payloads` override (whole-body replacement) → explicit example/examples →
   schema `default` → faker by `type`/`format`; required and optional fields are
   always generated. This is now the README's documented behavior, not a plan.
3. **Broader body/auth support — deferred (warn-only).** Non-JSON bodies
   (multipart, form-urlencoded, XML), cookie parameters, security-scheme-derived
   auth, and per-operation auth are not implemented. Non-JSON required bodies,
   cookie parameters, and security without configured auth are surfaced by
   SPEC-25 warnings; security-scheme-derived and per-operation auth remain
   unimplemented without a dedicated warning.

#### P2 limitations

- **Non-JSON request bodies** are not generated. A required non-JSON body is
  sent without a body and produces a `warning:`; optional non-JSON bodies are
  silent.
- **Cookie parameters** (`in: cookie`) are not generated or sent; each operation
  with one warns once.
- **Auth gaps are warn-only.** Auth is a single global static token/headers
  value. An operation with non-empty `security` and no configured auth runs
  without authentication and warns; there is no `securitySchemes` mapping and no
  per-operation auth.
- **Base URL uses only the first string fallback entry.** Without an explicit
  `baseUrl`, resolution takes the first string `servers[].url` across the specs
  in `specs` order (server-variable defaults substituted). A later absolute
  entry is not a fallback, so a relative first entry fails even when a later
  entry would be usable.
- **Explicit `baseUrl` is trusted verbatim.** It must be a non-empty string
  (config validation rejects an empty, whitespace-only, or non-string value);
  otherwise it is used
  as-is and bypasses the server-URL usability gate. Trailing slashes are
  stripped when request URLs are composed.
- **`specs` is local-file-only.** Remote `http(s)://` documents are never
  fetched.
- **OpenAPI 3.1 `webhooks` are not catalogued**, and neither are
  components-only documents. Such specs load but contribute zero operations;
  under `all` they can lead to the zero-catalog exit `2`.

### P3 — adoption and live end-to-end proof (planned; not started)

P3 is seeded on the board as SPEC-27…32; every ticket is `todo` and no P3
implementation has started. The phase has two outcomes: make the shipped tool
easy to evaluate and adopt (POC API, runnable examples, README, AGENTS.md), and
prove the real pipeline in CI by running the built CLI with real k6 against the
checked-in POC API. P3 adds no new product capabilities; selectors beyond `all`,
non-JSON bodies, cookies, and auth derivation remain deferred.

| Order | Key | Ticket ID | Priority | Status | Title |
|---|---|---|---|---|---|
| 1 | SPEC-27 | `01M5GEG4EZ82GE2M64FBSTD81R` | high | todo | Add dependency-free POC API and OpenAPI example |
| 2 | SPEC-28 | `01M5GEG8AQP1AAN2W121ABJK1A` | high | todo | Add runnable examples for every shipped feature |
| 3 | SPEC-29 | `01M5GEGCG9RP255MDH95M2GQE9` | urgent | todo | Add live e2e with real k6 and run it in CI |
| 4 | SPEC-31 | `01M5GEGK03GH1BD273RKQFMX72` | medium | todo | Add concise AGENTS.md onboarding for AI coding agents |
| 5 | SPEC-30 | `01M5GEGGEYW0ETXCEK6NT1P05E` | high | todo | Overhaul README for human adopters and AI agents |
| 6 | SPEC-32 | `01M5GEGNR7F206V1QA3M6Y2V6Y` | low | todo | Close out P3 docs and refresh ROADMAP after delivery |

Statuses are the board state at this planning refresh (2026-10-22). All six P3
tickets are `todo`; none is `in_progress`.

Dependencies:

- SPEC-28 reuses SPEC-27's POC API/spec and warning config, and adds only the
  minimum extra OpenAPI document needed for the multi-spec example.
- SPEC-29 depends on SPEC-27 (server/spec) and SPEC-28 (runnable config), and
  must use real k6 from `PATH` rather than a stub.
- SPEC-31 follows SPEC-29 so it can document the exact live-e2e command.
- SPEC-30 follows SPEC-27…29 and SPEC-31 so its AGENTS.md link resolves and it
  documents only behavior proved by the earlier tickets.
- SPEC-32 is last: it records verified outcomes and must not mark P3 done early.

#### P3 outcome goals

1. **Adoption surface.** A checked-in `examples/` tree with a dependency-free
   POC API, its OpenAPI document, and runnable configs for zero-override,
   explicit operations, auth, payload overrides, multi-spec/baseUrl, coverage
   warnings, and CI usage. Every example runs from the repository root and
   documents its expected output.
2. **Human and agent documentation.** README restructured around the value
   proposition, quick start, examples, recipes, limits, and AI-agent onboarding;
   a concise `AGENTS.md` covers repo map, commands, tests, workflow, and
   conventions without duplicating the README.
3. **Real end-to-end proof in CI.** CI runs the built CLI with real k6 against
   the POC API, asserts exit code `0` and a successful results JSON with
   expected checks, and shuts the server down deterministically. The existing
   stub-based unit coverage remains.

#### P3 limitations / non-goals

- No new product features. Selectors beyond `all`, non-JSON bodies, cookies,
  `securitySchemes`-derived auth, per-operation auth, and remote specs remain
  deferred and must be documented as such.
- The live e2e is a functional smoke test against a local, in-memory POC API;
  it is not a performance, capacity, or SLA test, and it must not call public
  internet APIs.
- The POC API is example/test infrastructure, not a supported product surface;
  it is not hardened for production, persistence, TLS, or auth flows.
- No Docker, k6 Cloud, npm publishing, or new CI providers are introduced.
- P3 does not reopen P2 scope or close deferred items implicitly.

#### P3 decisions recorded at planning (defaults chosen; not blocking)

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
