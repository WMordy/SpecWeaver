# SpecWeaver Roadmap

Single source of truth for planned work and agent handoff. Update this file when
priorities change; the Kanban board remains the source of truth for ticket status.

- **Project:** SpecWeaver (`SPEC`) — `01M57WNZ2HM1QNBMD684YFXK7D`
- **Audit of record:** SPEC-12 (closed) — `01M5CJ3JWM0S79R1GNVEEVJ5GX`
- **Snapshot:** 2026-10-20

## Where we are

SPEC-1 through SPEC-16 are `done`. The v1 audit scored **10 Met / 1 Partial / 0
Missing**; the Partial (`payloads`) and the audit's trust gaps are now fixed by
P0:

1. `payloads[].body` now replaces the generated body; unsupported keys are
   rejected and unmatched overrides warn (SPEC-13).
2. Missing `specs` or zero matched operations now exit `2` with actionable
   messages and no results file (SPEC-14).
3. Zero-operation specs (3.1 `webhooks`/components-only) now warn and feed the
   exit-`2` no-run path (SPEC-15).
4. README, config JSDoc, and the sample now match actual behavior (SPEC-16).

Verification at P0 close: `npm run build` clean, `npm test` 224/224 passing,
including the k6 e2e (k6 present on this machine). Changes are uncommitted.

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

- `specs` becomes required whenever `operations` is non-empty (a deliberate
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

### P1 — prove it works (next)

P0 is complete. Do not start a P1 item without a ticket; create it through the
normal pipeline and update this file first.

1. **K6 e2e in CI.** `test/e2e.test.js:127-128` skips without `k6`. Install k6
   in the pipeline so end-to-end execution is mandatory in CI.
2. **Gating story.** Checks are informational; a 100%-failed run exits `0`.
   Either add `--fail-on-check-failure` or document a `results.json`-based CI
   gate. Decide with the product owner before implementing.

### P2 — integration convenience (after P1)

1. **Operation selection:** support `operationId`, `tags`, or an `all` selector
   plus tolerant method/path matching, so teams stop hand-enumerating every
   operation.
2. **Payload contract:** define precedence `payloads` → example/default →
   faker before adding automatic schema-driven payload resolution. SPEC-13
   defines the merge point; do not build on top of it until it ships.
3. **Broader body/auth support:** non-JSON bodies (multipart, form-urlencoded,
   XML), cookie params, per-operation auth. These are new features, not P0.

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
6. After completing P0, update this roadmap's "Where we are" section and check
   off the ticket in the order table (or note its status).
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
  224/224 tests passing (including k6 e2e). P1 is next; changes uncommitted.
