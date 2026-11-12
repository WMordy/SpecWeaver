# SpecWeaver public-release readiness audit (SPEC-42)

- **Audit date:** 2026-11-12
- **Git revision:** `eafefdb` (branch `master`; working tree clean at audit start)
- **Node:** `v22.22.1`
- **k6:** `k6 v2.4.0 (commit/dd9395906d, go1.26.11, linux/amd64)`
- **Repository root:** `/home/wmordy/Projects/kanban-demo`
- **Scope:** `README.md`, `AGENTS.md`, `examples/README.md`,
  `examples/poc-api/README.md`, `e2e/README.md`, `samples/*`, `ROADMAP.md`,
  `.github/workflows/ci.yml`, and `package.json`.
- **Method:** claims were checked against the implementation in `src/`, the
  suites in `test/` and `e2e/`, and commands actually run from the repository
  root. Documentation was not used as evidence for itself.
- **Line references:** claim-matrix and findings `doc:line` references describe
  `eafefdb`. They drift as the documents are edited afterwards (including the
  SPEC-44 fixes) and are not renumbered here.

## How to read this

Every row in the claim matrix gets exactly one verdict.

| Verdict | Meaning |
|---|---|
| **match** | Code, tests, or the observed command agree with the claim as written. |
| **stale** | The claim was true once or describes an older state, and current code/tests/run contradict it. |
| **ambiguous** | The wording admits several readings, is incomplete, or is not falsifiable as written. |
| **unsupported** | The claim describes behavior that is not present in the shipped code or tests. |

Routing for the rest of P5: doc-only wording/ROADMAP drift belongs to SPEC-44;
onboarding/quick-start/example friction belongs to SPEC-45; package metadata
(C5) belongs to SPEC-46; a claim that would require code, CLI, contract, or test
changes is recorded under
[Candidate follow-up tickets](#candidate-follow-up-tickets) as a **new ticket**
and was **not** implemented here. No source, test, sample, README, AGENTS,
ROADMAP, e2e, or package file was edited by this audit.

## Verification run

| Check | Command | Observed result |
|---|---|---|
| Node version | `node --version` | `v22.22.1` |
| k6 version | `k6 version` | `k6 v2.4.0 (commit/dd9395906d, go1.26.11, linux/amd64)` |
| Build | `npm run build` | exit `0` (`tsc`) |
| Unit/integration | `npm test` | exit `0`; `# tests 408`, `# pass 408`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`; duration `45.5s` |
| Live real-k6 e2e | `npm run test:live-e2e` | exit `0`; `# tests 1`, `# pass 1`, `# fail 0`, `# skipped 0`; test duration `2.39s`; built first with `npm run build` |
| README link/anchor validator | extracted `README.md:942-1010` and ran `node --input-type=module < /tmp/readme-link-check.mjs` | exit `0`; `Checked 6 Markdown files and 129 links/anchors.` / `All relative links and in-page anchors resolve.` |
| CLI help/version | `node dist/cli.js --help`; `node dist/cli.js --version` | both exit `0`; version prints `0.1.0` |
| Exit `1` gate | warnings config + `--fail-on-check-failure` | exit `1`; `2 failing checks recorded`; results file still written |
| Exit `2` no-run | temp config with `operations: all` and no `specs` | exit `2`; actionable `specs` error; no results file |
| Temp artifacts | run with `SPECWEAVER_KEEP_TEMP=1`, then without | kept run left `specweaver.generated.js` with mode `600`; normal run deleted the generated script |
| POC invalid port | `PORT=abc node examples/poc-api/server.js`; `PORT=99999 ...` | exit `1`, message `expected an integer between 0 and 65535` |
| Gallery CI snippet | executed `examples/README.md:391-450` verbatim | exit `0`; `8 passed, 0 failed`; `results check passed: GET /pets, POST /pets, GET /owners, GET /owners/{ownerId}` |

### Link/anchor validator note

The validator referenced by `ROADMAP.md:102-104` is not checked in as a script;
it is embedded in `README.md:941-1011`. The audit extracted the script body
(`README.md:942-1010`), ran it with Node's module input mode, and recorded the
output above. It resolves every relative link and in-page anchor reachable from
`README.md`, including links and anchors into `ROADMAP.md`, `AGENTS.md`,
`examples/README.md`, `examples/poc-api/README.md`, and `e2e/README.md`.

### Gallery and recipe command observations

The POC API was started with `node examples/poc-api/server.js` on
`127.0.0.1:8080`. All commands below ran from the repository root. "Ops" is the
operation set reported by the run; "checks" is the console summary.

| Documented command | Exit | Ops / checks | stderr | Results path |
|---|---|---|---|---|
| README quick start: `node dist/cli.js --config examples/poc-api/specweaver.config.yaml --vus 1 --duration 2s --out /tmp/specweaver-quickstart.json` | `0` | 6 ops (`GET /health`, `GET /pets`, `POST /pets`, `GET /pets/{petId}`, `GET /owners`, `GET /owners/{ownerId}`); 12 pass, 0 fail | none | `/tmp/specweaver-quickstart.json` |
| Gallery zero-override: `samples/specweaver.zero-override.yaml` with `/tmp/specweaver-examples/zero-override.json` | `0` | 3 ops (`GET /pets`, `POST /pets`, `GET /pets/{petId}`); 6 pass, 0 fail | none | `/tmp/specweaver-examples/zero-override.json` |
| Gallery explicit + auth + payload: `samples/specweaver.config.yaml` with `/tmp/specweaver-examples/explicit-auth-payload.json` | `0` | 3 ops (same petstore set); 6 pass, 0 fail | none | `/tmp/specweaver-examples/explicit-auth-payload.json` |
| Gallery auth from env, variables set: `POC_API_TOKEN=POC-TOKEN POC_API_CLIENT=examples` + `examples/configs/auth.from-env.yaml` | `0` | 3 selected (`GET /health`, `GET /owners`, `GET /admin/stats`); 6 pass, 0 fail | none | `/tmp/specweaver-examples/auth-from-env.json` |
| Gallery auth from env, variables unset: `env -u POC_API_TOKEN -u POC_API_CLIENT` + same config | `0` | 3 selected; 4 pass, 2 fail (`GET /admin/stats`) | exactly the two documented `warning:` lines for `POC_API_TOKEN` and `POC_API_CLIENT` | `/tmp/specweaver-examples/auth-from-env.unresolved.json` |
| Gallery multi-spec + explicit baseUrl: `examples/configs/multi-spec.baseurl.yaml` | `0` | 4 selected (`GET /pets`, `POST /pets`, `GET /owners`, `GET /owners/{ownerId}`); 8 pass, 0 fail | none | `/tmp/specweaver-examples/multi-spec.baseurl.json` |
| Gallery coverage warnings: `examples/poc-api/specweaver.warnings.config.yaml` | `0` | 9 ops (`operations: all`); 16 pass, 2 fail (`GET /admin/stats`) | exactly one documented bearer-scheme warning | `/tmp/specweaver-examples/warnings.json` |
| Gallery POC canonical: `examples/poc-api/specweaver.config.yaml` with `/tmp/specweaver-examples/poc-canonical.json` | `0` | 6 ops; 12 pass, 0 fail | none | `/tmp/specweaver-examples/poc-canonical.json` |
| README payload override: same canonical config with `/tmp/specweaver-payload.json` | `0` | 6 ops; 12 pass, 0 fail | none; POC log shows `POST /pets -> 201 body={"name":"PocOverridePet","tag":"override","age":4}` | `/tmp/specweaver-payload.json` |
| Warnings config + `--fail-on-check-failure` (exit-code claim) | `1` | 9 ops; 16 pass, 2 fail | one coverage warning plus `error: --fail-on-check-failure: 2 failing checks recorded; exiting with code 1.` | `/tmp/specweaver-audit/warnings-gate.json` |
| Gallery CI snippet (multi-spec + gate + results assertion) | `0` | 4 selected; 8 pass, 0 fail | none | temp path, removed by the snippet's cleanup |

## Claim matrix

### README.md — Features at a glance

| # | Claim (short quote + doc:line) | Evidence (file:line / test / command) | Verdict |
|---|---|---|---|
| R1 | OpenAPI 3.0/3.1, JSON or YAML, local or remote (`README.md:50`) | `src/spec.ts:125,144-149,777-843,1052-1093`; `test/spec.test.js:100,112,122,852,869`; gallery/config runs above | match |
| R2 | "local and remote `$ref`s resolved" (`README.md:50`) | A local document's absolute remote `$ref` is rejected (`test/spec.test.js:774`); only relative refs inside a remote document resolve (`test/spec.test.js:976`), and `README.md:391-393` says local documents keep local-only behavior | ambiguous |
| R3 | Selector entries `{ method, path }`, `{ operationId }`, `{ tags }`, `{ path }` patterns (`README.md:51`) | `src/selection.ts:105-200`; `test/selection.test.js:52,89,106,154,191` | match |
| R4 | `operations: all` is the exact, case-sensitive literal (`README.md:52`) | `src/config.ts:354-368`; `test/config.test.js:32`; `test/cli.test.js:467` | match |
| R5 | Derived path/query/header/cookie parameters and JSON bodies; `simple`/`label`/`matrix`; example → default → faker; required and optional (`README.md:53`) | `src/request-data.ts:9-13,962-1045`; `test/request-data.test.js:587,626,1052,1104` | match |
| R6 | Whole-body `payloads` replaces the generated JSON body (`README.md:54`) | `src/request-data.ts:1296-1341`; `test/request-data.test.js:1414`; POC log for `PocOverridePet` | match |
| R7 | Global static bearer/header auth with `${ENV_VAR}`, explicit values win (`README.md:55`) | `src/auth.ts:15-57,220-270`; `test/auth.test.js:49,117,130,201`; auth gallery runs | match |
| R8 | Base URL: explicit wins, else first usable `servers[].url`, variable defaults, skips warn (`README.md:56`) | `src/script/emit.ts:588-638`; `test/script-emit.test.js:790,829,877,947`; zero-override run | match |
| R9 | Non-fatal coverage warnings for unsupported required body and unsatisfiable security (`README.md:57`) | `src/coverage.ts:74-139`; `test/coverage.test.js:47,76,128`; warnings run emitted exactly one line | match |
| R10 | Dependency-free k6 emission (`README.md:58`) | `src/script/emit.ts:13-15,769-826`; `test/script-emit.test.js:1067` | match |
| R11 | Real k6 on `PATH`, streamed output (`README.md:59`) | `src/run.ts:29-34,421-455`; `test/run.test.js:69,194`; live e2e run | match |
| R12 | Results JSON, console summary, per-operation checks; documented 2xx passes (`README.md:60`) | `src/results.ts:422-455`; `test/results.test.js:257,268,288`; warnings run shows 401 check failure | match |
| R13 | Opt-in `--fail-on-check-failure` gate (`README.md:61`) | `src/args.ts:82`; `src/results.ts:320-331`; `test/results.test.js:570,649,670,691`; observed exit `1` | match |
| R14 | CLI `--vus` / `--duration` / `--out` overrides (`README.md:62`) | `src/args.ts:104-122`; `src/config.ts:931-935`; every gallery run used the overrides | match |
| R15 | Non-JSON body generation for XML, multipart, form-urlencoded (`README.md:63`) | `src/request-data.ts:694-704,755-800,854-912`; `test/request-data.test.js:207,236,294`; POC log shows the fixed boundary/placeholder | match |
| R16 | Cookie parameters in one percent-encoded `Cookie` header, non-exploded (`README.md:64`) | `src/request-data.ts:1137-1208`; `test/request-data.test.js:71,143,153`; `test/coverage.test.js:95` | match |
| R17 | `securitySchemes`-derived bearer/header/query `apiKey` auth (`README.md:65`) | `src/auth.ts:490-570`; `test/auth.test.js:378,390,406,471,506`; auth-set run satisfies `/admin/stats` | match |
| R18 | `authOperations` replaces the global explicit surface; unmatched warn (`README.md:66`) | `src/auth.ts:435-442,594-669`; `test/auth.test.js:573,608,666,690` | match |
| R19 | Remote `http(s)` specs with timeout/cap/redirect policy (`README.md:67`) | `src/spec.ts:144-149,430-455`; `test/spec.test.js:852,869,899,920,931` | match |
| R20 | 3.1 `webhooks` catalogued as `/<name>` path operations (`README.md:68`) | `src/spec.ts:965-988`; `test/spec.test.js:373,397`; `test/cli.test.js:334` | match |

### README.md — Fields, selectors, CLI, exit codes, warnings, temp, remote, tests

| # | Claim (short quote + doc:line) | Evidence (file:line / test / command) | Verdict |
|---|---|---|---|
| R21 | YAML only, `--config` only, no TOML/discovery; relative paths resolve from cwd (`README.md:182-186`) | `src/config.ts:881-923`; `src/spec.ts:1010-1023`; `src/results.ts:525`; `test/config.test.js:58` | match |
| R22 | `specs` required to execute, string/list, local or remote, `$ref`s, URL validation, no-specs exit `2` (`README.md:226`) | `src/config.ts:513-555`; `src/cli.ts:281-301`; `test/cli.test.js:239`; observed exit `2` | match |
| R23 | `operations` required, non-empty list or exact `all` (`README.md:227`) | `src/config.ts:354-368`; `test/config.test.js:32,49` | match |
| R24 | `baseUrl` non-empty string, trusted verbatim, bypasses server gate (`README.md:228`) | `src/config.ts:849-858`; `src/script/emit.ts:246-253`; `test/script-emit.test.js:519,785` | match |
| R25 | `auth` token/headers/apiKeys, env refs, explicit precedence, absent means none (`README.md:229`) | `src/auth.ts:156-170,220-270,490-570`; `test/auth.test.js:44,49,117,338` | match |
| R26 | `authOperations` replaces global, at least one field, unknown/duplicate rejected, unmatched warn (`README.md:230`) | `src/config.ts:703-776`; `src/auth.ts:435-442,690`; `test/auth.test.js:573,690` | match |
| R27 | `payloads` only method/path/body, body replaces JSON body, unmatched warn (`README.md:231`) | `src/config.ts:779-846`; `test/request-data.test.js:1414,1435`; observed override body | match |
| R28 | `output` names only results JSON; default `specweaver-results.json`; `--out` wins (`README.md:232`) | `src/config.ts:860-875,931-935`; `src/results.ts:131-140`; `test/results.test.js:131` | match |
| R29 | `load` defaults `vus: 1`, `duration: 30s`; CLI overrides (`README.md:233`) | `src/config.ts:253,931-935`; `test/config.test.js:32`; galleries used 1/2s | match |
| R30 | Explicit `{ method, path }`: exact normalized match, accepted methods, duplicates rejected (`README.md:240-243`) | `src/selection.ts:160-176`; `src/config.ts:255-273`; `test/selection.test.js:176` | match |
| R31 | `{ operationId }`: exact/case-sensitive, first occurrence per `METHOD path` (`README.md:244-246`) | `src/selection.ts:160-176`; `test/selection.test.js:52,73` | match |
| R32 | `{ tags }`: non-empty list, any tag, case-sensitive OR (`README.md:247-248`) | `src/selection.ts:178-186`; `test/selection.test.js:89` | match |
| R33 | `{ path }` patterns: `*` one segment, `**` remainder, optional method, literal `*` caveat (`README.md:249-255`) | `src/selection.ts:39-57,188-200`; `test/selection.test.js:106,136` | match |
| R34 | `all` exact; wrong spellings and `[*]`/`{all:true}` rejected (`README.md:271-275`) | `src/config.ts:354-368`; `test/config.test.js:32` | match |
| R35 | Deterministic expansion, config-entry union, `METHOD path` first-wins, unmatched warnings (`README.md:257-269`) | `src/selection.ts:105-200`; `test/selection.test.js:154,191,213` | match |
| R36 | `all` deterministic order; cross-spec duplicates first-wins with warning; zero catalog exits `2` (`README.md:277-284`) | `src/selection.ts:105-155`; `test/cli.test.js:467,539,369` | match |
| R37 | Webhooks follow `paths`; catalogued as `/<name>`; selectable/generated/auth/emitted like paths (`README.md:286-292`) | `src/spec.ts:965-988`; `test/spec.test.js:373,397`; `test/cli.test.js:334` | match |
| R38 | Components-only 3.1 spec loads, contributes zero, warns; zero-run exits `2` (`README.md:294-297`) | `src/spec.ts:1078-1093`; `test/cli.test.js:369`; `test/coverage.test.js:29` | match |
| R39 | Payload priority override → example/examples → default → faker; required/optional generated; recursion (`README.md:301-315`) | `src/request-data.ts:9-13,585-621`; `test/request-data.test.js:411,516,626,644` | match |
| R40 | Non-JSON body shape and `Content-Type`; CLI serialization; payload override not applied to non-JSON (`README.md:317-343`) | `src/request-data.ts:694-912`; `test/request-data.test.js:207,236,294,345`; POC log shows boundary | match |
| R41 | Cookie header shape, non-exploded, `auth.headers.Cookie` and explicit `Cookie` win, no jar (`README.md:345-357`) | `src/request-data.ts:1137-1208`; `test/request-data.test.js:71,153,179`; `test/auth.test.js:315` | match |
| R42 | Explicit baseUrl wins; trailing slashes stripped (`README.md:361-365`) | `src/config.ts:849-858`; `src/script/emit.ts:246-253,638`; `test/script-emit.test.js:519` | match |
| R43 | Fallback: first usable `servers[].url`, spec/server order, defaults substituted, unusable skipped with warning (`README.md:367-375`) | `src/script/emit.ts:588-638`; `test/script-emit.test.js:790,829,877` | match |
| R44 | No usable fallback exits `2` before k6/results; diagnostic/remedies; selector-independent; redaction (`README.md:377-384`) | `src/cli.ts:145-205,378-397`; `test/script-emit.test.js:897,912` | match |
| R45 | Remote fetch memoized once per run, including external `$ref`s (`README.md:388-393`) | `src/spec.ts:576,1052-1075`; `test/spec.test.js:1020` | match |
| R46 | Remote timeout 10s, 5 MiB streaming cap, manual 10-hop redirects, upgrade allowed, downgrade rejected (`README.md:395-404`) | `src/spec.ts:144-149,347-455`; `test/spec.test.js:899,920,931,949` | match |
| R47 | Remote failures exit `2` before k6; host-scoped/redacted; SSRF is a documented non-goal; URLs unauthenticated (`README.md:405-415`) | `src/spec.ts:160,367,382-425`; `test/spec.test.js:881,890,911,1124`; `src/config.ts:533-555` | match |
| R48 | Auth layers: override > explicit > derived; derived mappings and warn-only list; env refs; scrubbed stream; warnings not in results (`README.md:419-486`) | `src/auth.ts:15-57,490-669`; `src/run.ts:351-420`; `test/auth.test.js:49,378,471,506,573,608,690` | match |
| R49 | CLI flags and precedence; `--fail-on-check-failure` CLI-only, no YAML equivalent (`README.md:490-512`) | `src/args.ts:44-54,82-122`; `src/config.ts:275-282`; `test/cli.test.js:146,164,204` | match |
| R50 | `--out`/`output` name only results JSON; temp script/data unique, `0600`, deleted unless `SPECWEAVER_KEEP_TEMP` (`README.md:514-520`) | `src/script/emit.ts:122,849-861`; `src/run.ts:97,316-323`; `test/run.test.js:309,345,366`; observed kept file mode `600` and deletion | match |
| R51 | Env-var truthy definition is "anything except unset/empty/`0`/`false`" (`README.md:927`); `SPECWEAVER_KEEP_TEMP` row (`README.md:925`) | `src/run.ts:309-315` also treats `no` as false for `SPECWEAVER_KEEP_TEMP`; the shared truthy helper used by k6/CI/live-e2e does not exclude `no` (`test/support/k6-requirement.js:36-42`) | ambiguous |
| R52 | Results path order `--out` → `output` → cwd default; summary after k6; write failure exits `2` (`README.md:524-538`) | `src/results.ts:131-140,504-527`; `src/cli.ts:456-512`; `test/results.test.js:131,345` | match |
| R53 | Results JSON schema, `tool`/`version`/`outcome`/`checks`/`summary`/`resultsFile` (`README.md:540-562`) | `src/results.ts:209-238,504`; `test/results.test.js:288`; observed results files | match |
| R54 | Per-operation counts from k6 raw NDJSON; documented 2xx pass (`README.md:564-568`) | `src/results.ts:31-36,422-455`; `test/results.test.js:257,268`; warnings run 16/2 | match |
| R55 | Exit `0` / `1` / `2` semantics and examples (`README.md:694-728`) | `src/results.ts:55-68,320-331`; `src/cli.ts:476-512`; observed `0`, `1`, `2` | match |
| R56 | Coverage warning classes: required unsupported body, unsatisfiable security; one per gap (`README.md:730-752`) | `src/coverage.ts:74-139`; `test/coverage.test.js:47,76,128,151`; warnings run emitted one line | match |
| R57 | Warnings are `warning:` stderr, deduped, chosen before k6 preflight, non-fatal, not in results, selector-independent (`README.md:745-752`) | `src/cli.ts:76-80,351-365`; `src/results.ts:151,387`; `test/coverage.test.js:151`; observed warning runs | match |
| R58 | Warning demo: exactly one line, photo no longer warns (`README.md:754-762`) | observed warnings run: exactly one line; `test/request-data.test.js:236`; `test/coverage.test.js:95` | match |
| R59 | Limitations: additive selectors only, exact/case-sensitive, literal `*` caveat (`README.md:772-776`) | `src/selection.ts:39-57,160-200`; `test/selection.test.js:106,191` | match |
| R60 | Non-JSON media outside four are deferred; parameterized variants not generated; binary placeholder (`README.md:777-784`) | `src/request-data.ts:694-704,854-862`; `test/request-data.test.js:207,236,294` | match |
| R61 | Unsupported security schemes warn-only; bearer/apiKey derived; authOperations shipped (`README.md:785-789`) | `src/auth.ts:490-570`; `test/auth.test.js:471,506,573` | match |
| R62 | Remote specs fetched not cached across runs; no cache/proxy/auth/DNS SSRF filtering (`README.md:790-794`) | `src/spec.ts:16-18,144-149,576`; `test/spec.test.js:1020,1124` | match |
| R63 | Components-only 3.1 zero operations; webhooks-only catalogued (`README.md:795-797`) | `src/spec.ts:1078-1093`; `test/spec.test.js:433,460`; `test/cli.test.js:334,369` | match |
| R64 | Unusable `servers[]` skipped with warning; none usable exits `2`, no skip warnings on error path (`README.md:798-802`) | `src/script/emit.ts:588-638`; `src/cli.ts:378-397`; `test/script-emit.test.js:829,897` | match |
| R65 | Explicit `baseUrl` trusted verbatim and bypasses server gate (`README.md:803-804`) | `src/config.ts:849-858`; `src/script/emit.ts:246-253,378`; `test/script-emit.test.js:519` | match |
| R66 | Warnings are warn-only; live e2e is a smoke test; POC is not supported (`README.md:805-809`) | `src/coverage.ts:39-44`; `e2e/README.md:118-124`; live run 1/1 functional; POC README limitations | match |
| R67 | Node.js >=18, examples verified on Node 22 (`README.md:91,150`) | `package.json:12-14`; observed Node `v22.22.1`; CI Node 22 | match |
| R68 | k6 v2.x, "verified with `k6 v2.3.0`" (`README.md:151`) | Observed `k6 v2.4.0`; v2.x holds, the exact version is older than the audit environment | stale |
| R69 | README stated test count: 338 tests, 0 failed, 0 skipped (`README.md:900`) | Observed `408` tests, `408` pass, `0` fail, `0` skipped; `test/` has 408 passing tests | stale |
| R70 | CI runs Node 22, installs real k6, `npm ci`, build, `npm test`, live e2e on push/PR (`README.md:931-933`) | `.github/workflows/ci.yml:18-42`; observed local equivalents | match |
| R71 | README link/anchor validator resolves all relative links/anchors (`README.md:935-1015`) | Extracted embedded validator; observed `6 files`, `129 links/anchors`, 0 errors | match |

### AGENTS.md

| # | Claim (short quote + doc:line) | Evidence (file:line / test / command) | Verdict |
|---|---|---|---|
| A1 | Current phase: P0-P3 done; phase status lives in ROADMAP (`AGENTS.md:7-11`) | P4 (SPEC-33-41) is also complete (`ROADMAP.md:419-438`; board `kanban-list` shows all P0-P4 tickets `done`), and P5 is active (this ticket). The sentence is an older phase snapshot. | stale |
| A2 | Repo map: `src/args.ts` CLI flags/usage (`AGENTS.md:17`) | `src/args.ts:4-6,44-54,82-122` | match |
| A3 | Repo map: `src/cli.ts` orchestration (`AGENTS.md:18`) | `src/cli.ts:1-20,243-418,456-512` | match |
| A4 | Repo map: `src/config.ts` YAML/validation/defaults/env (`AGENTS.md:19`) | `src/config.ts:1-21,253,354,513,849-935` | match |
| A5 | Repo map: `src/spec.ts` local/remote loading, `$ref`s, cataloguing (`AGENTS.md:20`) | `src/spec.ts:1-18,777-843,965-988,1052-1093` | match |
| A6 | Repo map: `src/selection.ts` all/selectors/dedupe/unmatched (`AGENTS.md:21`) | `src/selection.ts:1-22,105-200` | match |
| A7 | Repo map: `src/request-data.ts` params/JSON/payloads (`AGENTS.md:22`) | `src/request-data.ts:1-58,1296-1341`; the row omits non-JSON/cookie generation, but does not contradict it | match |
| A8 | Repo map: `src/auth.ts` explicit/overrides/derived/redaction (`AGENTS.md:23`) | `src/auth.ts:1-57,220-270,490-669`; `src/run.ts:351-420` | match |
| A9 | Repo map: `src/coverage.ts` non-fatal warnings (`AGENTS.md:24`) | `src/coverage.ts:1-44,74-139` | match |
| A10 | Repo map: `src/script/emit.ts` dependency-free emission (`AGENTS.md:25`) | `src/script/emit.ts:1-34,769-826` | match |
| A11 | Repo map: `src/run.ts` k6 PATH/spawn/stream/temp (`AGENTS.md:26`) | `src/run.ts:1-42,97-128,421-455` | match |
| A12 | Repo map: `src/results.ts` results/summary/warnings/exit (`AGENTS.md:27`) | `src/results.ts:1-43,55-68,320-331,504-527` | match |
| A13 | Test layout: `test/config.test.js` config parsing/validation/defaults (`AGENTS.md:67`) | `test/config.test.js:32,49,58`; suite passes | match |
| A14 | Test layout: `test/auth.test.js` auth, overrides, redaction (`AGENTS.md:68`) | `test/auth.test.js:49,315,573,706`; suite passes | match |
| A15 | Test layout: `test/request-data.test.js` params/body/chain/payloads/`$ref`s (`AGENTS.md:69`) | `test/request-data.test.js:71,207,411,587,1414`; suite passes | match |
| A16 | Test layout: `test/spec.test.js` loading/local/external refs/order/errors (`AGENTS.md:70`) | `test/spec.test.js:100,134,147,182,852`; suite passes | match |
| A17 | Test layout: `test/selection.test.js` selectors/dedupe/unmatched (`AGENTS.md:71`) | `test/selection.test.js:52,89,106,154,191`; suite passes | match |
| A18 | Test layout: `test/script-emit.test.js`, one runtime test uses k6 (`AGENTS.md:72`) | `test/script-emit.test.js:1067,1135-1137`; observed 0 skipped with k6 installed | match |
| A19 | Test layout: `test/cli.test.js` built CLI with fake k6 (`AGENTS.md:73`) | `test/cli.test.js:146,239,334,467,539`; suite passes | match |
| A20 | Test layout: `test/run.test.js` k6 discovery/spawn/temp (`AGENTS.md:74`) | `test/run.test.js:69,194,237,309,345`; suite passes | match |
| A21 | Test layout: `test/results.test.js` NDJSON/checks/summary/exit (`AGENTS.md:75`) | `test/results.test.js:257,288,570,649,789`; suite passes | match |
| A22 | Test layout: `test/coverage.test.js` warning kinds/order/dedupe (`AGENTS.md:76`) | `test/coverage.test.js:47,128,151`; suite passes | match |
| A23 | Test layout: `test/e2e.test.js` built CLI + stub server, real k6, skips if absent (`AGENTS.md:77`) | `test/e2e.test.js:117,132,142-149`; observed 0 skipped because k6 is present | match |
| A24 | Test layout: `test/k6-requirement.test.js` pure decision matrix (`AGENTS.md:78`) | `test/k6-requirement.test.js:14,45,57`; no k6 needed | match |
| A25 | Test layout: `test/support/k6-requirement.js` shared helper, no assertions (`AGENTS.md:79`) | `test/support/k6-requirement.js:1-45`; no `assert` import/usage | match |
| A26 | Test layout: `e2e/live-e2e.mjs` real k6 vs POC, results/server checks (`AGENTS.md:80`) | `e2e/live-e2e.mjs:298-299,788-850`; live run 1/1 pass, 0 skipped | match |
| A27 | Canonical commands `npm ci`, `npm run build`, `npm test`, `npm run clean`, `npm run test:live-e2e` (`AGENTS.md:41-47`) | `package.json:15-19`; build/test/live-e2e observed; `clean` removes `dist` by script | match |
| A28 | `npm test` mostly uses fake k6; `e2e.test.js` uses real k6 and skips only when optional; one `script-emit` runtime test uses real k6 (`AGENTS.md:51-55`) | `test/e2e.test.js:142-149`; `test/script-emit.test.js:1135-1137`; observed 0 skipped | match |
| A29 | Live e2e requires real k6; only local opt-out is truthy `SPECWEAVER_SKIP_LIVE_E2E` when CI/REQUIRE_K6 falsy; CI never skips (`AGENTS.md:56-59`) | `e2e/live-e2e.mjs:95-121,298-336`; observed live run 1/1, 0 skipped | match |
| A30 | Truthy means anything except unset/empty/`0`/`false`; `SPECWEAVER_KEEP_TEMP=1` keeps artifacts (`AGENTS.md:60-61`) | Shared `isTruthyEnvValue` matches (`test/k6-requirement.test.js:45`); `src/run.ts:316-323` additionally treats `no` as false for `SPECWEAVER_KEEP_TEMP` | ambiguous |
| A31 | Exit codes `0`/`1`/`2`, including post-run results-write failure (`AGENTS.md:88-90`) | `src/results.ts:55-68,320-331`; `src/cli.ts:476-512`; observed `0`, `1`, `2` | match |
| A32 | Config: YAML/`--config` only; `operations` required; `specs` optional at schema but required to execute; local or remote; coverage gaps warn (`AGENTS.md:91-94`) | `src/config.ts:181-225,354,513`; `src/cli.ts:281-301`; `test/config.test.js:58`; observed no-specs exit `2` | match |
| A33 | Strict ESM TypeScript, Node >=18, CI Node 22, `tsc` only (`AGENTS.md:84-85`) | `package.json:5,12-19`; `tsconfig.json`; build observed | match |
| A34 | Deferred list: non-JSON outside three, unsupported schemes; remote specs shipped SPEC-41; bearer/apiKey derived; authOperations shipped (`AGENTS.md:133-138`) | `src/request-data.ts:694-704`; `src/auth.ts:490-570`; `src/spec.ts:1052-1075`; `src/config.ts:703-776` | match |
| A35 | CI line: Node 22, real k6, `npm ci`, build, test, live e2e (`AGENTS.md:33`) | `.github/workflows/ci.yml:18-42` | match |

### examples/README.md

| # | Claim (short quote + doc:line) | Evidence (file:line / test / command) | Verdict |
|---|---|---|---|
| E1 | Every example runnable from repo root against POC API; deferred capabilities at end (`examples/README.md:3-6`) | All gallery commands above ran from repo root with exit `0` and expected ops/checks | match |
| E2 | Prerequisite "Node.js 22 or newer" (`examples/README.md:12`) | `package.json:12-14` and `README.md:91,150` accept Node >=18; Node 22 is the verified environment, not the package minimum | ambiguous |
| E3 | k6 v2.x, "verified with `k6 v2.3.0`" (`examples/README.md:14`) | Observed `k6 v2.4.0`; v2.x holds, exact version is older | stale |
| E4 | POC readiness line/port override/shutdown (`examples/README.md:18-26`) | Observed readiness line, `PORT` handling, and `poc-api shutting down` with exit `0` | match |
| E5 | `--vus 1 --duration 2s`; results under `/tmp/specweaver-examples/` (`examples/README.md:28-35`) | All gallery runs used those flags; `mkdirSync` creates the results parent (`src/results.ts:526`); observed files there | match |
| E6 | Six gallery examples and expected outputs (`examples/README.md:43-50,52-354`) | All six were run (plus auth-set/unset and payload/quickstart variants); exits, ops, checks, stderr, results matched the documented values | match |
| E7 | Zero-override sample reuses `samples/*` unchanged (`examples/README.md:54-56`) | `samples/specweaver.zero-override.yaml:16-20`; observed 3 ops | match |
| E8 | Auth from env warns for unset variables and `/admin/stats` fails but exits `0` (`examples/README.md:190-216`) | Observed exactly two warnings, 4 pass/2 fail, exit `0` | match |
| E9 | Coverage warnings demo emits exactly one line; photo/cookie no longer warn (`examples/README.md:262-312`) | Observed exactly one line; `test/coverage.test.js:95`; `test/request-data.test.js:236` | match |
| E10 | CI snippet is copy-pasteable and asserts results (`examples/README.md:381-451`) | Executed `examples/README.md:391-450`; exit `0`; `results check passed: GET /pets, POST /pets, GET /owners, GET /owners/{ownerId}` | match |
| E11 | "Shipped and demonstrated here: ... webhooks" (`examples/README.md:453-466`) | No gallery config/spec demonstrates webhooks (`grep -rn webhook examples samples` finds only this prose line); webhooks are documented in README/ROADMAP and tested in `test/spec.test.js`/`test/cli.test.js`, not in the gallery | unsupported |
| E12 | Deferred list includes "remote `http(s)` specs" (`examples/README.md:468-470`) | `specs` accepts remote `http(s)` URLs (`src/config.ts:513-555`; `src/spec.ts:1052-1075`; `test/spec.test.js:852`); README features list and ROADMAP P4 record SPEC-41 shipped | stale |
| E13 | Feature-to-example map rows (`examples/README.md:356-379`) | Rows map to the six gallery examples above; no row claims a missing example except the webhooks sentence handled in E11 | match |
| E14 | Existing samples remain canonical minimal configs (`examples/README.md:478-480`) | `samples/*` exist, run, and are reused by the gallery | match |

### examples/poc-api/README.md

| # | Claim (short quote + doc:line) | Evidence (file:line / test / command) | Verdict |
|---|---|---|---|
| P1 | Dependency-free POC, no `npm install` for the POC (`examples/poc-api/README.md:3-10`) | `examples/poc-api/server.js` imports only Node built-ins; server started without install | match |
| P2 | File table: server, 9-operation OpenAPI, two configs (`examples/poc-api/README.md:15-23`) | `examples/poc-api/openapi.yaml` catalogs 9 operations; `test/cli.test.js:334` and warnings run; configs exist | match |
| P3 | Start server, readiness line, `PORT` override, invalid/used ports fail fast, shutdown exit `0` (`examples/poc-api/README.md:25-56`) | Observed readiness, `PORT=9090`/`PORT=0` documented behavior, `PORT=abc`/`99999` exit `1`, shutdown exit `0` | match |
| P4 | Seed data (Fido/Whiskers/Bubbles; Alice/Bob; new ids from 4) (`examples/poc-api/README.md:58-65`) | Observed `GET /pets` and `GET /owners` bodies; `POST /pets` created ids from 4 in runs | match |
| P5 | Request log: one JSON line with method/path/status/auth/line; write bodies; `/admin/stats` auth marker; token never logged (`examples/poc-api/README.md:67-79`) | Observed `/tmp/specweaver-audit/poc-api.log`; `server.js:75-101,287-320`; token value absent from logs | match |
| P6 | Endpoint smoke tests: health, pets/limit, invalid limit, create, get/404, owners/404, admin 401/200, recommendations, photo 202/404 (`examples/poc-api/README.md:81-123`) | Observed health/pets/owners/admin; warnings/canonical runs exercised recommendations and photo; `server.js:130-272` | match |
| P7 | SpecWeaver/k6 smoke run exits `0`, writes `specweaver-results.json`, sends bearer, uses POC server URL, replaces `POST /pets` body (`examples/poc-api/README.md:125-147`) | Canonical run exit `0`; results path behavior tested in `test/results.test.js:749`; POC log shows `PocOverridePet` body and `auth=ok` | match |
| P8 | Warnings config emits exactly one bearer warning; cookie/photo no warnings; `/admin/stats` 401 check fails but exit `0` (`examples/poc-api/README.md:149-175`) | Observed exactly one warning, 16 pass/2 fail, exit `0` | match |
| P9 | Zero-override sample runs live; IPv4 `baseUrl` workaround (`examples/poc-api/README.md:177-199`) | Zero-override run exit `0` with 3 ops; workaround is the documented config-add, not code | match |
| P10 | Limitations: in-memory, no TLS/rate limiting/auth flows/cookie handling/multipart parsing, single token, not supported (`examples/poc-api/README.md:201-210`) | `examples/poc-api/server.js:7-10,20,75-77,249-269`; POC is not in `package.json` files/bin | match |
| P11 | POC implements the petstore sample routes (`examples/poc-api/README.md:179-180`) | Observed zero-override sample against POC: 3 ops, 6 pass | match |

### e2e/README.md

| # | Claim (short quote + doc:line) | Evidence (file:line / test / command) | Verdict |
|---|---|---|---|
| L1 | `e2e/live-e2e.mjs` is outside `test/` and not named `*.test.*`, so `npm test` never discovers it (`e2e/README.md:19-21`) | File path; `package.json:18` runs bare `node --test`; observed `npm test` 408 tests excludes live suite | match |
| L2 | Command is `npm run test:live-e2e` = build + `node --test e2e/live-e2e.mjs` (`e2e/README.md:44-53`) | `package.json:19`; observed exit `0`, 1 test | match |
| L3 | Prereqs Node.js 22 or newer; k6 v2.x "verified with `k6 v2.3.0`" (`e2e/README.md:23-39`) | Observed Node `v22.22.1` and k6 `v2.4.0`; Node 22 holds, exact k6 version is older | stale |
| L4 | Env vars `CI`, `SPECWEAVER_REQUIRE_K6`, `SPECWEAVER_SKIP_LIVE_E2E` behavior (`e2e/README.md:55-64`) | `e2e/live-e2e.mjs:95-121,298-336`; `test/k6-requirement.test.js:14,34,45` | match |
| L5 | Real-k6 proof: unmodified PATH, `k6 version`, realpath outside temp, CLI `k6 found:` line (`e2e/README.md:66-100`) | `e2e/live-e2e.mjs:617-741,901`; live run 1/1 pass | match |
| L6 | Readiness/ephemeral port/temp config with baseUrl and `/admin/stats` (`e2e/README.md:70-78`) | `e2e/live-e2e.mjs:272-293,538-609`; observed live run | match |
| L7 | Results/check/server cross-check assertions (`e2e/README.md:79-96`) | `e2e/live-e2e.mjs:788-850`; live run 1/1 pass | match |
| L8 | Cleanup: two `mkdtemp` dirs removed, server SIGTERM/SIGKILL, process gone (`e2e/README.md:101-104,126-133`) | `e2e/live-e2e.mjs:451-472,487-488`; live run and post-run port check | match |
| L9 | Expected runtime 5-15s including build; hard ceiling 120s (`e2e/README.md:118-124`) | Observed live suite test duration `2.39s`; `timeout: 120_000` at `e2e/live-e2e.mjs:299` | match |
| L10 | Reproduce CI failure locally with `CI=true npm run test:live-e2e`; missing-k6 failure (`e2e/README.md:135-159`) | Same command/env semantics in `e2e/live-e2e.mjs:298-336`; not re-run with an empty PATH in this audit | ambiguous |

### samples/*.yaml and samples/petstore.openapi.json

| # | Claim (short quote + doc:line) | Evidence (file:line / test / command) | Verdict |
|---|---|---|---|
| S1 | Sample paths resolve from cwd; run from repo root (`samples/specweaver.config.yaml:5-6`; `samples/specweaver.zero-override.yaml:5-6`) | `src/spec.ts:1010-1023`; all sample runs from repo root succeeded | match |
| S2 | `specs` may be local or absolute `http(s)`; fallback is first usable `servers[].url`, skips warn; no usable fallback exits `2` (`samples/specweaver.config.yaml:10-16`) | `src/config.ts:513-555`; `src/script/emit.ts:588-638`; `test/script-emit.test.js:829,897` | match |
| S3 | `operations` required, list or exact `all`; with `all` every catalogued op runs (`samples/specweaver.config.yaml:20-25`) | `src/config.ts:354-368`; zero-override run 3 ops; explicit run 3 ops | match |
| S4 | Static auth token/headers injected; env refs warn not fail (`samples/specweaver.config.yaml:34-40`) | `src/auth.ts:220-270`; explicit run POC log `auth=ok`; `test/auth.test.js:130` | match |
| S5 | `payloads` whole-body replacement, method normalization, unmatched warn, unknown keys error (`samples/specweaver.config.yaml:42-53`) | `src/config.ts:779-846`; `test/request-data.test.js:1414,1435`; POC log `SampleOverridePet` | match |
| S6 | `output` default and `load` overrides (`samples/specweaver.config.yaml:55-62`) | `src/config.ts:860-875,931-935`; `test/results.test.js:131` | match |
| S7 | Zero-override sample: no auth/payloads/baseUrl; derives payloads/base URL; no auth without credentials (`samples/specweaver.zero-override.yaml:8-20`) | Observed zero-override run exit `0`, 3 ops, no warnings; `src/auth.ts` sends no derived auth without credentials | match |
| S8 | Petstore spec is OpenAPI 3.0.3, 3 operations, path/query params, JSON body, internal `$ref`s, used by README/e2e (`samples/petstore.openapi.json:1-6`) | `test/e2e.test.js:117,132`; catalog has 3 operations; `$ref` resolution tests pass | match |
| S9 | Sample invokes `specweaver` command (`samples/specweaver.config.yaml:3-4`) | `package.json:6-13` exposes `bin.specweaver`; audit used `node dist/cli.js` instead of a global install | ambiguous |

### ROADMAP.md

| # | Claim (short quote + doc:line) | Evidence (file:line / test / command) | Verdict |
|---|---|---|---|
| M1 | Project ID / audit of record SPEC-12 done / snapshot date (`ROADMAP.md:6-8`) | Ticket project ID matches; `kanban-list` shows SPEC-12 `done`; snapshot is historical | match |
| M2 | SPEC-1 through SPEC-36 done; P3 complete and committed (`ROADMAP.md:12-13`) | `kanban-list --status done` shows all; `git log` contains P3 commits | match |
| M3 | P4 complete: SPEC-33-40 done/committed, SPEC-41 done as `8221d08` (`ROADMAP.md:15-25,419-438`) | Board shows all P4 tickets `done`; `git cat-file -e 8221d08^{commit}` succeeds; `git log` shows the P4 commits | match |
| M4 | P0/P2/P3 commit hashes (`ROADMAP.md:30-34,64-70,89-95`) | All listed hashes resolve (`git cat-file -e <hash>^{commit}`) | match |
| M5 | Work-order statuses in P0-P4 tables (`ROADMAP.md:113-118,181-187,213-219,304-311,427-437`) | `kanban-list` shows every listed ticket `done` | match |
| M6 | P2 fixed limitations: non-JSON, cookies, auth, base URL, remote specs, webhooks annotated fixed (`ROADMAP.md:256-292`) | `src/request-data.ts:694-704`; `src/auth.ts:490-570`; `src/script/emit.ts:588-638`; `src/spec.ts:965-988,1052-1075`; tests cited in R40-R47 | match |
| M7 | P3 limitation bullet says selectors beyond `all`, per-operation auth, and remote specs "remain deferred and are documented as such in the README and examples gallery" (`ROADMAP.md:383-389`) | The present-tense sentence is contradicted by SPEC-36 (`src/selection.ts:160-200`), SPEC-40 (`src/auth.ts:435-442`), and SPEC-41 (`src/spec.ts:1052-1075`); README no longer documents these as deferred, and only the examples gallery still carries the stale remote-spec line (E12). The opening "at P3 time" does not repair the present-tense claim. | stale |
| M8 | SPEC-38 decision marker "(in progress)" (`ROADMAP.md:491`) | SPEC-38 is `done` in the P4 work-order table (`ROADMAP.md:434`), on the board, and in git history (`b87623a`); the current decisions text still says in progress. The changelog citation used in the first draft was wrong: `ROADMAP.md:646-658` is itself the "in progress" entry, not a completion entry (see M8b). | stale |
| M8b | ROADMAP changelog records SPEC-38 completion | The changelog stops at "SPEC-38 in progress" (`ROADMAP.md:646-658`) and has no later SPEC-38 completion entry, even though the work-order row (`ROADMAP.md:434`), board status, and commit `b87623a` show it is done. This is a documentation gap, not a code gap. | stale |
| M9 | P3 verification: build 0; `npm test` 298/298; live 1/1 with k6 v2.3.0; link validator 6 files/123 (`ROADMAP.md:97-107`) | Historical at `1aee7ca`; not re-run at that commit. Current audit: build 0, `npm test` 408/408, live 1/1 with k6 v2.4.0, validator 6 files/129 | ambiguous |
| M10 | P4/SPEC-41 final test counts: 408/408 on Node 22 and 18.20.8 (`ROADMAP.md:714-716`) | Observed 408/408 on Node `v22.22.1`; Node 18.20.8 was not available/re-run in this audit | ambiguous |
| M11 | Historical close counts 224/240/298/305/322/338/344/350/358 (`ROADMAP.md:73-75,97-99,562-572,607-671`) | Each is labelled to a close/commit; not independently re-run. Current count is 408 and the sequence is monotonic/consistent with the changelog | ambiguous |
| M12 | Historical k6 v2.3.0 verification records (`ROADMAP.md:100,351,589`) | Historical; current environment is `k6 v2.4.0` | ambiguous |
| M13 | P4 fixed-limitation narratives (SPEC-33/34/35/36/37/38/39/40) (`ROADMAP.md:447-524`) | Code/tests cited in R8, R15, R16, R3, R20, R17, R18, R19; SPEC-38 changelog/marker issues are M8/M8b | match |
| M14 | Explicit non-goals unchanged (`ROADMAP.md:531-535`) | No scheduling/baseline/SLA/GraphQL/k6 Cloud/Web UI code or tickets found in `src/` or board | match |
| M15 | "CI and the no-DNS/IP SSRF posture sign-off remain for a human" (`ROADMAP.md:717`) | CI run IDs cannot be queried from this offline audit; SSRF remains a documented non-goal (`README.md:408-413`) | ambiguous |

### package.json and .github/workflows/ci.yml

| # | Claim (short quote + doc:line) | Evidence (file:line / test / command) | Verdict |
|---|---|---|---|
| C1 | Package name/version/bin `specweaver` → `dist/cli.js` (`package.json:2-8`) | Build creates `dist/cli.js`; `--version` prints `0.1.0` | match |
| C2 | `engines.node >=18` (`package.json:12-14`) | Observed Node `v22.22.1`; README/AGENTS agree on >=18 | match |
| C3 | Scripts `build`/`clean`/`test`/`test:live-e2e` (`package.json:15-19`) | `npm run build` exit 0; `npm test` 408/408; `npm run test:live-e2e` 1/1; `clean` removes `dist` by script | match |
| C4 | `files: ["dist"]` (`package.json:9-11`) | Build output is `dist/`; no source is published by the `files` list | match |
| C5 | `license: MIT` (`package.json:27`) | No `LICENSE` file is checked in (`git ls-files`); SPEC-46 is the planned MIT LICENSE + package metadata ticket | ambiguous |
| C6 | Dependencies `@faker-js/faker`/`yaml`; dev `typescript`/`@types/node` (`package.json:28-35`) | Build/test/live-e2e pass; emitted script imports only k6 built-ins (`src/script/emit.ts:769-786`) | match |
| C7 | CI on push/PR, Node 22, real k6, `npm ci`/build/`npm test`/live e2e (`ci.yml:3-42`) | Workflow file matches; local equivalents observed green | match |
| C8 | Live e2e CI timeout 5 minutes (`ci.yml:40-42`) | `timeout-minutes: 5` present; observed live suite under 15s | match |

## Findings summary

Counts are by verdict across the claim matrix above.

| Verdict | Count |
|---|---|
| match | 152 |
| stale | 9 |
| ambiguous | 12 |
| unsupported | 1 |
| **total** | **174** |

### Non-match routing

Every non-match matrix row is listed here with its owning ticket.

| Row | Finding | Verdict | Owning ticket |
|---|---|---|---|
| R68 | README says k6 was verified with `v2.3.0`; audit environment is `v2.4.0`. | stale | SPEC-44 |
| R69 | README says `npm test` runs 338 tests; observed 408. | stale | SPEC-44 |
| A1 | AGENTS.md's "Current phase" stops at P3; P4 is complete and P5 is active. | stale | SPEC-44 |
| E3 | examples/README says k6 was verified with `v2.3.0`; audit environment is `v2.4.0`. | stale | SPEC-44 |
| E12 | examples/README lists remote `http(s)` specs as deferred; SPEC-41 shipped them. | stale | SPEC-44 |
| L3 | e2e/README says k6 was verified with `v2.3.0`; audit environment is `v2.4.0`. | stale | SPEC-44 |
| M7 | P3 limitation bullet's present-tense "remain deferred … documented as such in the README" is contradicted by SPEC-36/40/41. | stale | SPEC-44 |
| M8 | ROADMAP decision text still calls SPEC-38 "in progress". | stale | SPEC-44 |
| M8b | ROADMAP changelog has no SPEC-38 completion entry after the "in progress" entry. | stale | SPEC-44 |
| R2 | README says local and remote `$ref`s are resolved; local documents reject absolute remote refs, and the detailed section says local-only. | ambiguous | SPEC-44 |
| R51 | README/AGENTS truthy definition omits that `SPECWEAVER_KEEP_TEMP=no` is treated as false. | ambiguous | SPEC-44 |
| A30 | Same truthy/`KEEP_TEMP` wording as R51. | ambiguous | SPEC-44 |
| M9 | P3 historical test/version/link counts were not re-run at `1aee7ca`. | ambiguous | SPEC-44 |
| M10 | The Node 18.20.8 half of the 408/408 claim was not re-run. | ambiguous | SPEC-44 |
| M11 | Historical close counts were not re-run at their commits. | ambiguous | SPEC-44 |
| M12 | Historical k6 v2.3.0 records were not re-run. | ambiguous | SPEC-44 |
| M15 | CI run IDs/sign-off cannot be verified from this offline audit. | ambiguous | SPEC-44 |
| E2 | examples/README says Node 22+; package/README support Node >=18. | ambiguous | SPEC-45 |
| L10 | The missing-k6 reproduction command was not re-run in this audit. | ambiguous | SPEC-45 |
| S9 | Sample comments show the global `specweaver` command; audit used `node dist/cli.js` without a global install. | ambiguous | SPEC-45 |
| C5 | Package declares MIT but no LICENSE file is checked in. | ambiguous | SPEC-46 |
| E11 | examples/README says webhooks are "demonstrated here", but no gallery config/spec contains a webhook. | unsupported | SPEC-44 |

### SPEC-44 findings (documentation/ROADMAP drift)

- R68, R69, A1, E3, E12, L3, M7, M8, M8b (stale).
- R2, R51, A30, M9, M10, M11, M12, M15 (ambiguous).
- E11 (unsupported).

### SPEC-45 findings (onboarding/quick-start/example friction)

- **E2** — examples/README requires "Node.js 22 or newer" while
  `package.json:12-14` and README support Node >=18; quick-start users on
  Node 18/20 get a contradictory prerequisite.
- **S9** — sample comments point at the global `specweaver` command, while every
  repository example and this audit use `node dist/cli.js`; the global-install
  path is not exercised by the walkthrough.
- **L10** — the documented missing-k6 reproduction command was not re-run; the
  local failure/opt-out path remains unverified in this audit.
- **Additional onboarding friction** — `examples/README.md:12` says `npm install`
  while the canonical setup and CI use `npm ci`; the gallery should use the
  pinned install command.
- **E11 (optional)** — if the team prefers to keep the "webhooks … demonstrated
  here" sentence instead of deleting it, adding a webhook gallery example is
  onboarding work for SPEC-45; the minimal fix is a SPEC-44 wording change.

### Behavior gap (new ticket)

- **`src/cli.ts:323`** — the `operations: all` zero-selection diagnostic still
  says only `paths` are catalogued, ignoring shipped 3.1 `webhooks`. This needs
  source plus test changes, so it is routed to a **new ticket**, not SPEC-44/45.

## Candidate follow-up tickets

Behavior gaps (not wording-only), proposed for triage after review. No board
ticket was created and no fix was applied.

1. **Update the `operations: all` zero-selection diagnostic to mention webhooks.**
   `src/cli.ts:323` still tells users "Only `paths` operations are catalogued in
   v1; add a spec with path operations...", but SPEC-37 also catalogues OpenAPI
   3.1 `webhooks` (`src/spec.ts:965-988`; `test/spec.test.js:373`;
   `test/cli.test.js:334`). This is a user-facing CLI diagnostic/contract change,
   so it needs source plus test updates, not a docs-only edit.

## Clean-clone walkthrough (SPEC-43)

- **Walkthrough date:** 2026-11-12
- **Clone of record:** `eafefdb` (`eafefdbdf2e1af99f832b170061317939e08685e`, branch `master`), cloned from
  `https://github.com/WMordy/SpecWeaver.git` in 1.8 s. The local
  `git clone --no-hardlinks` fallback was not required.
- **Temp root:** `/tmp/opencode/spec43-stranger-2026-11-12/` with `repo/`, `home/`,
  `npm-global/`, `npm-cache/`, `tmp/`, and `evidence/`.
- **Environment:** Linux x86_64; Node `v22.22.1`; npm `9.2.0`; k6
  `v2.4.0 (commit/dd9395906d, go1.26.11, linux/amd64)`; `bash --noprofile --norc`.
- **Isolation:** `env -i` with `HOME=$root/home`,
  `NPM_CONFIG_PREFIX=$root/npm-global`, `NPM_CONFIG_CACHE=$root/npm-cache`,
  `TMPDIR=$root/tmp`, and
  `PATH=$root/npm-global/bin:/usr/bin:/usr/local/bin:/bin`; `CI`,
  `SPECWEAVER_*`, and `POC_API_*` unset. k6 was an environment precondition and
  was never installed.
- **Clone state at start:** `HEAD` was `eafefdb`, `git status --porcelain` was
  empty, `git ls-files docs` was empty, and there was no `node_modules/`,
  `dist/`, or `specweaver-results.json`. The clone was deliberately not seeded
  with the untracked working-tree `docs/` directory.
- **Scope:** `README.md` plus only the docs it links: `examples/README.md`,
  `examples/poc-api/README.md`, and `e2e/README.md`.
- **Fixes applied:** none. No README, source, test, sample, example, e2e,
  AGENTS, ROADMAP, or package file was changed; this readiness section is the
  only working-tree edit made by SPEC-43.

**Outcome:** every documented happy-path command completed with the documented
result. No blocker or major walkthrough finding was found. One new minor
finding (a high-severity dependency advisory printed by `npm ci`) is recorded
below; all other encountered issues are existing SPEC-42 findings, cited rather
than duplicated.

**Stranger questions recorded:**

- "Which Node version is actually required?" The README says `>=18`; the
  gallery says `22 or newer` (`E2`).
- "Should I run `npm install` or `npm ci`?" The quick start/CI use `npm ci`;
  the gallery and POC prerequisites say `npm install` (existing SPEC-45 item).
- "Is k6 `v2.3.0` required or is any `v2.x` acceptable?" The docs say `v2.x`
  but name only `v2.3.0`; the walkthrough used `v2.4.0` (`R68`, `E3`, `L3`).
- "Will the global install work without a writable npm prefix?" Not answered by
  the README; the walkthrough used an isolated prefix to avoid touching global
  state, so the default-prefix permission path is untested (see Fidelity
  limits).
- "Do I need to restart the POC before the smoke tests?" Gallery runs create
  pets; the POC README says the store resets on every start. Re-running the
  smoke suite on a fresh server confirmed the documented seed state.

### Procedure

The walkthrough followed the README literally, in this order, from the
repository root of the pristine clone. Each step was entered only from the
linked documentation; no implicit `cd`, config edit, or missing prerequisite was
supplied.

1. P1 clone and isolation (`SPEC-43` scope; `README.md:89-96`).
2. Quick start install/build/POC start (`README.md:95-107`).
3. Canonical quick-start run, results inspection, and `Ctrl+C` shutdown
   (`README.md:109-126`).
4. Install and requirements: global install in an isolated prefix and the
   `node dist/cli.js` alternative (`README.md:148-178`).
5. `examples/README.md` prerequisites, index, six gallery examples, results
   artifacts, and the copy-pasteable CI snippet (`examples/README.md:8-451`).
6. POC API smoke tests including `PORT` override, invalid port, `/admin/stats`
   401/200, and photo 202/404 (`examples/poc-api/README.md:25-123`).
7. `npm test`, `npm run test:live-e2e`, `CI=true` variant, missing-k6
   reproduction, and local skip opt-out (`README.md:888-933`;
   `e2e/README.md:44-159`).
8. Troubleshooting and the embedded README link/anchor validator
   (`README.md:811-887`, `README.md:935-1015`).

### Step log

Wall-clock seconds are from the evidence runner. `n/a` marks a long-lived POC
server start; its shutdown exit code is recorded separately. Every row has a
full log under `/tmp/opencode/spec43-stranger-2026-11-12/evidence/`, and every
log now carries an `artifacts:` line repeating the row's Artifacts column.

| Step | Doc | Cwd | Command | Exit | s | Expected (quoted) | Observed excerpt | Artifacts |
|---|---|---|---|---:|---|---|---|---|
| 00 clone | SPEC-43 P1 | `$root` | `git clone https://github.com/WMordy/SpecWeaver.git repo` | 0 | 1.8 | network clone succeeds or fallback is logged | `Cloning into 'repo'...` | `repo/`, `00-network-clone.log` |
| 01 clone state | P1; `README.md:89-96` | `repo/` | `git rev-parse HEAD; git status --porcelain; git ls-files docs; ls -1` | 0 | 0.1 | `eafefdb`; clean; no `docs/`/`dist/`/`node_modules/` | `HEAD eafefdbdf...`; status empty; tracked docs `0`; top level has no `dist`/`node_modules` | `01-clone-state.log` |
| 02 env metadata | `AGENTS.md:36-61`; `README.md:91-96,148-155` | `repo/` | `node --version; npm --version; k6 version; uname -sm` | 0 | 0.7 | record versions in isolation | `v22.22.1`; `9.2.0`; `k6 v2.4.0`; `Linux x86_64` | `02-isolation-metadata.log` |
| 03 npm ci | `README.md:97-101` | `repo/` | `npm ci` | 0 | 2.0 | install from `package-lock.json` | `added 5 packages`; `1 high severity vulnerability` | `03-npm-ci.log` |
| 04 build | `README.md:97-101` | `repo/` | `npm run build` | 0 | 3.8 | `tsc -> dist/` | `> tsc` | `dist/`, `04-npm-build.log` |
| 05 POC start | `README.md:95-107` | `repo/` | `node examples/poc-api/server.js` (background) | n/a | <=1.0 | `poc-api listening on http://127.0.0.1:8080` | readiness line printed | `05-poc-server.log`, `05-poc-start.log` |
| 06 quick start | `README.md:109-122` | `repo/` | `node dist/cli.js --config examples/poc-api/specweaver.config.yaml --vus 1 --duration 2s --out /tmp/specweaver-quickstart.json` | 0 | 3.0 | exit `0`; `Outcome: success`; `k6 exit code: 0`; six operations | `Outcome: success`; `k6 exit code: 0`; six `Checks (per operation)` rows; `Results file: /tmp/specweaver-quickstart.json` | `/tmp/specweaver-quickstart.json`, `06-quickstart-cli.log` |
| 07 results | `README.md:118-122` | `repo/` | `cat /tmp/specweaver-quickstart.json; node -e ...` | 0 | 0.2 | results JSON at the documented path | `"outcome": "success"`; `"k6ExitCode": 0`; six check keys | `/tmp/specweaver-quickstart.json`, `07-quickstart-results.log` |
| 08 shutdown | `README.md:124-126` | `repo/` | start server, `kill -INT`, `wait` | 0 | 0.4 | prints `poc-api shutting down` and exits `0` | `poc-api shutting down`; `server_exit=0` | `08-poc-shutdown.log` |
| 09 global install | `README.md:160-170` | `repo/` | `npm i -g . && command -v specweaver && specweaver --version` | 0 | 2.5 | isolated global install; `0.1.0` | `.../npm-global/bin/specweaver`; `0.1.0` | `09-global-install.log` |
| 10 gallery server | `examples/README.md:8-26` | `repo/` | `node examples/poc-api/server.js` (background) | n/a | <=1.0 | readiness line | `poc-api listening on http://127.0.0.1:8080` | `10-gallery-poc-server.log`, `10-gallery-server-start.log` |
| 11 zero override | `examples/README.md:52-96` | `repo/` | `node dist/cli.js --config samples/specweaver.zero-override.yaml --vus 1 --duration 2s --out /tmp/specweaver-examples/zero-override.json` | 0 | 2.8 | 3 ops; 6 pass/0 fail | `Checks total: 6 passed, 0 failed (100.0%)` | `/tmp/specweaver-examples/zero-override.json`, `11-gallery-zero-override.log` |
| 12 explicit auth/payload | `examples/README.md:97-143` | `repo/` | `node dist/cli.js --config samples/specweaver.config.yaml --vus 1 --duration 2s --out /tmp/specweaver-examples/explicit-auth-payload.json` | 0 | 2.8 | 3 ops; 6/0; `SampleOverridePet` in POC log | `Checks total: 6 passed, 0 failed`; `POST /pets -> 201 body={"name":"SampleOverridePet"...}` | JSON, POC log, `12-gallery-explicit-auth-payload.log` |
| 13 auth set | `examples/README.md:144-218` | `repo/` | `POC_API_TOKEN=POC-TOKEN POC_API_CLIENT=examples node dist/cli.js --config examples/configs/auth.from-env.yaml --vus 1 --duration 2s --out /tmp/specweaver-examples/auth-from-env.json` | 0 | 2.9 | 3 selected; 6/0; no warnings | `Checks total: 6 passed, 0 failed` | JSON, `13-gallery-auth-set.log` |
| 14 auth unset | `examples/README.md:190-217` | `repo/` | `env -u POC_API_TOKEN -u POC_API_CLIENT node dist/cli.js --config examples/configs/auth.from-env.yaml --vus 1 --duration 2s --out /tmp/specweaver-examples/auth-from-env.unresolved.json` | 0 | 2.9 | two exact warnings; `GET /admin/stats` 0/2; 4/2 | both `warning: unresolved environment variable ...` lines; `Checks total: 4 passed, 2 failed (66.7%)` | JSON, `14-gallery-auth-unset.log` |
| 15 multi-spec | `examples/README.md:219-261` | `repo/` | `node dist/cli.js --config examples/configs/multi-spec.baseurl.yaml --vus 1 --duration 2s --out /tmp/specweaver-examples/multi-spec.baseurl.json` | 0 | 3.0 | 4 ops; 8/0 | `Checks total: 8 passed, 0 failed (100.0%)` | JSON, `15-gallery-multi-spec.log` |
| 16 warnings | `examples/README.md:262-313` | `repo/` | `node dist/cli.js --config examples/poc-api/specweaver.warnings.config.yaml --vus 1 --duration 2s --out /tmp/specweaver-examples/warnings.json` | 0 | 2.9 | exactly one warning; 9 ops; 16/2 | one bearer-scheme `warning:`; `Checks total: 16 passed, 2 failed (88.9%)` | JSON, `16-gallery-warnings.log` |
| 17 POC canonical | `examples/README.md:314-355` | `repo/` | `node dist/cli.js --config examples/poc-api/specweaver.config.yaml --vus 1 --duration 2s --out /tmp/specweaver-examples/poc-canonical.json` | 0 | 3.0 | 6 ops; 12/0 | `Checks total: 12 passed, 0 failed (100.0%)` | JSON, `17-gallery-poc-canonical.log` |
| 18 gallery artifacts | `examples/README.md:28-40,52-355` | `repo/` | `ls -l /tmp/specweaver-examples/*.json; node -e ...` | 0 | 0.2 | six documented results files and operation sets | seven files (six examples plus unresolved variant), all `success`, expected op/check counts | `/tmp/specweaver-examples/*.json`, `18-gallery-artifacts.log` |
| 19 POC smoke | `examples/poc-api/README.md:81-123` | `repo/` | documented `curl` smoke commands | 0 | 0.2 | health 200; admin 401/200; photo 202/404 | `admin_unauth_status=401`; `photo1_status=202`; `photo999_status=404`; seeded pet/owner bodies | `19b-poc-smoke-fresh.log` |
| 20 PORT override | `examples/poc-api/README.md:36-46` | `repo/` | start `PORT=9090`, health, SIGINT | 0 | 0.4 | readiness names 9090; health; exit `0` | `poc-api listening on http://127.0.0.1:9090`; `server_exit=0` | `20-port-override.log` |
| 21 invalid port | `examples/poc-api/README.md:48-53` | `repo/` | `PORT=abc node examples/poc-api/server.js` | 1 | 0.4 | non-zero with integer-range message | `poc-api: invalid PORT "abc": expected an integer between 0 and 65535` | `21-invalid-port.log` |
| 22 npm test | `README.md:888-913`; `AGENTS.md:41-55` | `repo/` | `npm test` | 0 | 58.4 | build + tests pass; 0 skipped | `# tests 408`; `# pass 408`; `# fail 0`; `# skipped 0` | `22-npm-test.log` |
| 23 live e2e | `README.md:914-923`; `e2e/README.md:44-53` | `repo/` | `npm run test:live-e2e` | 0 | 7.4 | 1 live test passes | `# tests 1`; `# pass 1`; `# skipped 0` | `23-live-e2e.log` |
| 24 CI variant | `e2e/README.md:135-146` | `repo/` | `CI=true npm run test:live-e2e` | 0 | 7.3 | 1 live test passes with `CI` truthy | `# tests 1`; `# pass 1` | `24-live-e2e-ci.log` |
| 25 missing k6 | `e2e/README.md:148-153` | `repo/` | documented `PATH="$empty_path" CI=true node --test e2e/live-e2e.mjs` | 1 | 0.6 | fails non-zero with install hint | `requires real k6 on PATH`; `spawnSync k6 ENOENT` | `25-missing-k6.log` |
| 26 skip opt-out | `e2e/README.md:55-64,159` | `repo/` | `SPECWEAVER_SKIP_LIVE_E2E=1 node --test e2e/live-e2e.mjs` | 0 | 0.7 | prints notice and skips with exit `0` | `# SKIP SPECWEAVER_SKIP_LIVE_E2E=1 ...`; `# skipped 1` | `26-live-e2e-skip.log` |
| 27 k6 missing CLI | `README.md:811-823` | `repo/` | empty `PATH` with absolute node and canonical config | 2 | 0.5 | three documented lines; no results file | `k6 was not found on your PATH.`; `no_results_file=yes` | `27-troubleshoot-k6-missing.log` |
| 28 base URL gate | `README.md:825-833` | `repo/` | temp config/spec with no `servers[].url` | 2 | 0.5 | exit `2` before k6; no results | `error: no request base URL was resolved ...`; `no_results_file=yes` | `28-troubleshoot-base-url.log` |
| 29 port in use | `README.md:851-862` | `repo/` | `PORT=8080 node examples/poc-api/server.js` while 8080 was bound | 1 | 0.3 | non-zero `EADDRINUSE` | `cannot listen on 127.0.0.1:8080 (port already in use)` | `29-troubleshoot-port-in-use.log` |
| 30 default results | `README.md:172-178,871-877` | `repo/` | `node dist/cli.js --config examples/poc-api/specweaver.config.yaml --vus 1 --duration 2s` | 0 | 2.8 | writes `specweaver-results.json` in cwd | `Results file: .../repo/specweaver-results.json`; file exists | `specweaver-results.json`, `30-node-alternative-default-out.log` |
| 31 keep temp | `README.md:864-869,514-520` | `repo/` | `SPECWEAVER_KEEP_TEMP=1 ...`; then normal run | 0 | 3.6 | kept script/data are `0600`; normal run deletes script | `mode=600`; `normal_script_deleted=yes`; kept dir `0700` | temp dir, `31-keep-temp-artifacts.log` |
| 32 link validator | `README.md:935-1015` | `repo/` | `sed -n '942,1010p' README.md &#124; node --input-type=module` | 0 | 0.2 | all links/anchors resolve | `Checked 6 Markdown files and 129 links/anchors.`; `All relative links and in-page anchors resolve.` | `32-readme-link-validator.log` |
| 33 CI snippet | `examples/README.md:381-451` | `repo/` | extracted lines 391-450, run with `bash` | 0 | 8.8 | copy-pasteable; results assertion passes | `results check passed: GET /pets, POST /pets, GET /owners, GET /owners/{ownerId}` | `33-gallery-ci-snippet.log` |
| 34 npm audit | `package.json:28-35` | `repo/` | `npm audit --json` | 1 | 1.4 | identify the advisory behind step 03 | `@faker-js/faker` `9.9.0` `high`; `GHSA-qxc2-j82w-r537`; fix `10.6.0` | `34-npm-audit.log`, `34b-faker-version.log` |

### Findings

Only newly discovered walkthrough findings receive a new `SW-WT-*` ID. Existing
SPEC-42 IDs are cited in the next subsection and are not duplicated.

| ID | Class | Step | Doc ref | Symptom | Routing |
|---|---|---|---|---|---|
| `SW-WT-01` | minor | 03 | `package.json:32-35`; `README.md:97-101` | `npm ci` prints `1 high severity vulnerability`; `npm audit` identifies `GHSA-qxc2-j82w-r537` in direct dependency `@faker-js/faker` (`<=10.4.0`), with a semver-major fix at `10.6.0`. The walkthrough still completes with correct results. | SPEC-48 |

### Finding detail

#### `SW-WT-01` — high-severity advisory on the documented install

- **Evidence:** `evidence/03-npm-ci.log`, `evidence/34-npm-audit.log`,
  `evidence/34b-faker-version.log`.
- **Reproduction:** from the pristine clone, `npm ci` exits `0` but prints
  `1 high severity vulnerability`; `npm audit --json` exits `1` and reports
  `@faker-js/faker` `9.9.0` (installed; affected `<=10.4.0`) `high`,
  `GHSA-qxc2-j82w-r537` ("helpers.fake exploitable into arbitrary code
  execution"), with `fixAvailable` `10.6.0` and `isSemVerMajor: true`.
- **Claim vs observed:** the README does not claim a clean audit, so no
  documented expectation is false. The walkthrough completes and produces the
  documented results. The finding is recorded because the first documented
  install command surfaces a high-severity advisory on a public-release path.
- **Impact:** minor walkthrough impact (no block, no wrong result); a stranger
  must decide whether to proceed. The advisory itself is high severity.
- **Routing:** SPEC-48 (`Upgrade @faker-js/faker for advisory
  GHSA-qxc2-j82w-r537`, split from the phase after this walkthrough). The fix
  is a major-version bump, so it needs `npm run build` and `npm test`
  verification; if the bump requires source changes, the ticket splits its own
  follow-up.

### Existing SPEC-42 findings re-confirmed

These were encountered again during the walkthrough. Their original IDs and
owners stand; no new `SW-WT` IDs were allocated for them.

| ID | Step | Doc ref | Walkthrough observation | Owner |
|---|---|---|---|---|
| `E2` | 10 | `examples/README.md:12` | Says "Node.js 22 or newer" while `package.json:12-14` and `README.md:91,150` accept Node >=18. Node 18 was not exercised in this walkthrough. | SPEC-45 |
| `S9` | 09 | `samples/specweaver.config.yaml:3-4` | The global `specweaver` path was exercised: `npm i -g .` into the isolated prefix and `specweaver --version` printed `0.1.0`. The sample still assumes a global install; no new defect. | SPEC-45 |
| `L10` | 25 | `e2e/README.md:148-153` | Missing-k6 reproduction now verified: narrow `PATH` with `CI=true` fails non-zero with the install hint. No doc change appears necessary beyond recording the verification. | SPEC-45 |
| `npm install` vs `npm ci` | 10 | `examples/README.md:12`; `examples/poc-api/README.md:129` | Gallery and POC prerequisites say `npm install`; quick start and CI use `npm ci`. This walkthrough used `npm ci` and left the lockfile untouched. | SPEC-45 |
| `R68` | 02, 04 | `README.md:151` | Says verified with `k6 v2.3.0`; observed `k6 v2.4.0`. The v2.x claim holds; the exact version is stale. | SPEC-44 |
| `E3` | 10 | `examples/README.md:14` | Same `k6 v2.3.0` text; observed `v2.4.0`. | SPEC-44 |
| `L3` | 23 | `e2e/README.md:36` | Same `k6 v2.3.0` text; observed `v2.4.0`. | SPEC-44 |
| `R69` | 22 | `README.md:900` | Says `npm test` runs 338 tests; observed `408` tests, `408` pass, `0` fail, `0` skipped. | SPEC-44 |
| `C5` | 01, 09 | `package.json:27` | Package declares MIT but the clone contains no `LICENSE` file (`git ls-files`). Global install still succeeds. | SPEC-46 |
| `E11` | 10 | `examples/README.md:453-466` | Says webhooks are "demonstrated here"; no gallery config/spec demonstrates a webhook. | SPEC-44 |
| `E12` | 10 | `examples/README.md:468-470` | Lists remote `http(s)` specs as deferred; SPEC-41 shipped them. | SPEC-44 |
| `A1` | 01 | `AGENTS.md:7-11` | "Current phase" stops at P3; P4 is complete and P5 is active. | SPEC-44 |

### Counts

| Scope | blocker | major | minor | observation | total |
|---|---:|---:|---:|---:|---:|
| New `SW-WT` findings | 0 | 0 | 1 | 0 | 1 |
| Existing SPEC-42 findings re-confirmed (no new IDs) | — | — | — | — | 12 |

### Routing

- **SPEC-48 (new follow-up):** `SW-WT-01` (dependency advisory), split into its
  own ticket because it needs a semver-major upgrade and verification.
- **SPEC-46:** existing `C5` (LICENSE/metadata).
- **SPEC-45:** existing `E2`, `S9`, `L10`, and the `npm install` vs `npm ci`
  item. No new SPEC-45 finding was discovered.
- **SPEC-44:** existing `R68`, `E3`, `L3`, `R69`, `E11`, `E12`, and `A1`.
- **New-ticket candidate:** none beyond SPEC-48.

### SPEC-45 re-check checklist

Each item names the doc `file:line` to change or re-check and an exact command
that must pass from a fresh clone. `SW-WT-01` is routed to SPEC-48; it is
included here because P6 asks for one checkbox per routed finding.

- [ ] **`SW-WT-01` (SPEC-48):** `package.json:32-35`. After upgrading
  `@faker-js/faker` to `>=10.6.0`, run from a fresh clone:
  `npm ci && npm run build && npm test && npm audit --audit-level=high`; it
  must exit `0` with no high-severity advisory.
- [x] **`E2` Node 22 vs >=18:** `examples/README.md:12`. Either change the line
  to the supported range or verify the stricter claim on Node 18/20; run from a
  fresh clone on the claimed minimum:
  `node --version && npm ci && npm run build && npm test`; it must exit `0`.
  - `Result:` fresh clone `node --version` → `v22.22.1`; on `v18.20.8` (via the
    `node@18.20.8` npm package) `node --version` → `v18.20.8`. `npm ci && npm
    run build && npm test` → exit `0`, `408` tests / `408` pass / `0` fail / `0`
    skipped on both. Docs now use `Node.js >= 18 (verified on 18.20.8 and 22.x;
    CI uses Node 22)`.
- [x] **`S9` global `specweaver`:** `samples/specweaver.config.yaml:3-4`. Keep
  the global command but document the install prerequisite, or switch the sample
  comment to `node dist/cli.js`; run from a fresh clone:
  `npm ci && npm run build && npm i -g . && specweaver --version`; it must exit
  `0` and print `0.1.0` (isolated `NPM_CONFIG_PREFIX`).
  - `Result:` fresh clone with isolated `NPM_CONFIG_PREFIX`/`NPM_CONFIG_CACHE`:
    `npm ci && npm run build && npm i -g . && specweaver --version` → exit `0`,
    prints `0.1.0`. Both sample headers now name `npm i -g .` and the
    `node dist/cli.js` no-install form.
- [x] **`L10` missing-k6 reproduction:** `e2e/README.md:148-153`. Re-run the
  documented snippet from a fresh clone:
  `node_bin=$(command -v node); empty_path=$(mktemp -d); PATH="$empty_path" CI=true "$node_bin" --test e2e/live-e2e.mjs; status=$?; rmdir "$empty_path"; test "$status" -ne 0`;
  the inner `node --test` must exit non-zero with the install hint (observed
  exit `1`), and the wrapper above passes when it does.
  - `Result:` fresh clone: inner `node --test e2e/live-e2e.mjs` exited `1` and
    printed `The live k6 end-to-end test requires real k6 on PATH.`; the
    status-capture wrapper (`test "$status" -ne 0`) exited `0`. Expected outcome
    documented in `e2e/README.md`.
- [x] **`npm install` vs `npm ci`:** `examples/README.md:12` and
  `examples/poc-api/README.md:129`. Change both to the pinned install; run from
  a fresh clone: `npm ci && npm run build && git status --porcelain`; it must
  exit `0` with an empty status (no lockfile change).
  - `Result:` fresh clone `npm ci && npm run build` → exit `0`; `git status
    --porcelain` showed no `package-lock.json` change (only the intended
    docs/example edits). Both prerequisites now use `npm ci`; `README.md`
    "Install and requirements" states the contributor/consumer split.

### Fidelity limits

- One environment only: Linux x86_64, Node `v22.22.1`, npm `9.2.0`, k6
  `v2.4.0`. Node 18/20, other OSes, and other k6 versions were not exercised
  (out of SPEC-43 scope), so `E2` remains ambiguous.
- The network clone succeeded, so the `--no-hardlinks` local fallback was not
  exercised. The clone was not seeded with `docs/` or any untracked file.
- `npm test` ran with real k6 present and reported `0` skipped. The
  k6-absent `npm test` skip path was not re-run; the separate missing-k6 live
  e2e reproduction was.
- The POC store was mutated by the gallery before the first smoke run; the
  smoke suite was repeated on a freshly restarted server (`19b`) so the seed
  data matched the documented fresh state. The earlier run showed the extra
  created pets that the POC README documents as reset-on-start behavior.
- The `localhost` IPv6-only caveat was not triggered: the zero-override run
  using the derived `http://localhost:8080` passed on this host.
- The CI workflow itself was not run; only its local command equivalents
  (`npm ci`, build, test, live e2e, `CI=true`) were. CI run IDs/sign-off remain
  a human step (`M15`).
- The embedded link validator was extracted from `README.md:942-1010` and run
  through stdin; this is equivalent to the documented heredoc but not typed
  interactively.
- `npm audit` reflects registry advisory data at walkthrough time; the
  advisory feed can change.
- Global npm state: all installs used `NPM_CONFIG_PREFIX=$root/npm-global` and
  `NPM_CONFIG_CACHE=$root/npm-cache`. The normal prefix `/usr/local` and normal
  global `specweaver` command remained untouched. P7 verification is in
  `evidence/35-p7-verification.log`: only `?? docs/readiness.md`, empty tracked
  diff, `HEAD` still `eafefdb`, zero commits since start, unchanged
  `package.json`/`package-lock.json` hashes, and no normal-prefix `specweaver`.
- The default npm global prefix was not exercised: `npm i -g .` ran only with
  the isolated prefix, so a normal user's `EACCES`/`sudo` path is untested.
  Testing it would have violated the "global npm state untouched" constraint.
- `PORT=0` ephemeral binding and `SPECWEAVER_SKIP_LIVE_E2E` with `CI=true` were
  not re-run; `PORT=9090`, invalid port, and the unset-CI skip were.

### Non-goals observed

- No fix, repair, or source/test/doc change outside this section.
- No edits to SPEC-44/45/46 and no new board ticket.
- No commits, branches, tags, or pushes.
- No new dependency added; `npm ci` installed only from the committed
  lockfile.
- No ROADMAP phase update and no CI or release sign-off.
- No attempt to make the POC a supported service or to test deferred
  capabilities.


## SPEC-44 resolution (append-only)

- **Resolution date:** 2026-11-12
- **Base revision:** `eafefdb`; docs-only edits to `README.md`, `AGENTS.md`,
  `ROADMAP.md`, `examples/README.md`, and `e2e/README.md`. No `src/`, `test/`,
  `samples/`, `package.json`, `package-lock.json`, or `.github/` change.
- **Verification environment:** Node `v22.22.1`; k6
  `v2.4.0 (commit/dd9395906d, go1.26.11, linux/amd64)`; `npm run build` exit
  `0`; `npm test` 408 pass / 0 fail / 0 skipped; `npm run test:live-e2e`
  1 pass / 0 fail / 0 skipped; README link/anchor validator exit `0`:
  `Checked 6 Markdown files and 132 links/anchors.` /
  `All relative links and in-page anchors resolve.`

This section gives one disposition per claim-matrix row routed to SPEC-44. It
does not rewrite the audit history above; the verdicts, findings counts, and
routing table stand as recorded at `eafefdb`. Line references in the matrix
drift after this ticket and are not renumbered.

| Row | Disposition | Where the fix/record lives |
|---|---|---|
| R68 | fixed | `README.md` "Install and requirements" (`README.md#install-and-requirements`): `k6 v2.4.0`. |
| R69 | fixed | `README.md` "Development and testing" (`README.md#development-and-testing`): 408 tests, `0` failed, `0` skipped; the "command is authoritative" caveat stays. |
| A1 | fixed | `AGENTS.md` "Current phase": P0–P4 done and committed, P5 active, detail still deferred to `ROADMAP.md`. |
| E3 | fixed | `examples/README.md` "Prerequisites": `k6 v2.4.0`. |
| E11 | fixed | `examples/README.md` "Shipped vs deferred" (`examples/README.md#shipped-vs-deferred`): `webhooks` removed from "demonstrated here"; now documented-but-not-demonstrated beside `authOperations`. No gallery config/spec added. |
| E12 | fixed | `examples/README.md` "Shipped vs deferred": remote `http(s)` specs removed from the deferred list and described as shipped per SPEC-41. |
| L3 | fixed | `e2e/README.md` "Prerequisites": `k6 v2.4.0`. |
| M7 | fixed | `ROADMAP.md` "P3 limitations / non-goals" (`ROADMAP.md#p3-limitations--non-goals`): past tense; names SPEC-36/SPEC-40/SPEC-41 as the shipping tickets. |
| M8 | fixed | `ROADMAP.md` P4 "Decisions and resolved behavior": the SPEC-38 bullet reads done, committed as `b87623a`. |
| M8b | fixed | `ROADMAP.md` change log: 2026-11-03 SPEC-38 approved/done entry. |
| R2 | fixed | `README.md` "Features at a glance" (`README.md#features-at-a-glance`) and "Field reference" (`README.md#field-reference`): remote-document `$ref`s resolve; local documents keep local-only behavior, matching `README.md` "Remote specs" and `test/spec.test.js`. |
| A30 | fixed | `AGENTS.md` truthy bullet: `SPECWEAVER_KEEP_TEMP` also treats `no` as false; the `CI`/`SPECWEAVER_REQUIRE_K6`/`SPECWEAVER_SKIP_LIVE_E2E` helper does not (`src/run.ts:309-315`; `test/support/k6-requirement.js:36-42`). No behavior change. |
| R51 | documented-in-place | The nuance is recorded in `AGENTS.md` (A30) for agents. The README's generic "truthy" definition and its `SPECWEAVER_KEEP_TEMP` table row are unchanged by this ticket because README edits were scoped to the R68/R69/R2/E11 rows above; no runtime behavior changed. |
| M9 | unverified | P3-close 298/298 and 6-file/123-link counts are historical at `1aee7ca`; annotated, not re-run, in the `ROADMAP.md` "Historical verification records" note and not edited. |
| M10 | unverified | The Node 18.20.8 half of 408/408 was not re-run; annotated in the same `ROADMAP.md` note. Current 408/408 is Node `v22.22.1`. |
| M11 | unverified | Historical close counts (224…358) remain records at their own commits; annotated in the same note. |
| M12 | unverified | Historical `k6 v2.3.0` records remain; annotated in the same note. Current verification used `k6 v2.4.0`. |
| M15 | unverified | CI run IDs remain a human step; the no-DNS/IP SSRF sign-off remains a documented non-goal. Annotated in the same `ROADMAP.md` note. |

### Routed out of SPEC-44

| Item | Owner | State after SPEC-44 |
|---|---|---|
| E2 (`examples/README.md:12`, Node 22 vs `>=18`) | SPEC-45 | unchanged; still recorded as open. |
| `npm install` vs `npm ci` (`examples/README.md:12`, `examples/poc-api/README.md:129`) | SPEC-45 | unchanged. |
| S9 (global `specweaver` command assumption) | SPEC-45 | unchanged. |
| L10 (missing-k6 reproduction command) | SPEC-45 | unchanged. |
| C5 (LICENSE/package metadata) | SPEC-46 | unchanged. |
| `src/cli.ts:323` zero-selection diagnostic missing webhooks | new behavior ticket | unchanged; still a candidate follow-up, not fixed here. |

### Verification commands

From the repository root, after the edits above:

```sh
npm run build
npm test
npm run test:live-e2e
awk '/^node --input-type=module <<.NODE.$/{f=1;next}/^NODE$/{f=0}f' README.md | node --input-type=module
git status --porcelain -uall
```

`git status` was limited to the five audited Markdown files plus the untracked
`docs/` directory (`docs/readiness.md`). No commit, branch, tag, or push was
made, and this file was not `git add`ed.

## SPEC-45 resolution (append-only)

- **Resolution date:** 2026-11-12
- **Base revision:** `eafefdb`; docs/example-only edits. No `src/`, `test/`,
  `e2e/live-e2e.mjs`, `package.json`, `package-lock.json`, or `.github/` change.
  The `examples/poc-api/server.js` edit is comment-only.
- **Verification environment:** Node `v22.22.1` and `v18.20.8` (the latter via
  the `node@18.20.8` npm package); k6
  `v2.4.0 (commit/dd9395906d, go1.26.11, linux/amd64)`; a fresh clone seeded with
  the working-tree edits. `npm ci` exit `0`; `npm run build` exit `0`;
  `npm test` 408 pass / 0 fail / 0 skipped on both Node versions;
  `npm run test:live-e2e` 1 pass / 0 fail / 0 skipped; `CI=true npm run
  test:live-e2e` 1 pass / 0 fail / 0 skipped;
  README link/anchor validator exit `0`: `Checked 6 Markdown files and 132
  links/anchors.` / `All relative links and in-page anchors resolve.`

| Item | Disposition | Where the fix/record lives |
|---|---|---|
| E2 | fixed | One formula in the README quick start/install/development sections, `examples/README.md`, `e2e/README.md`, and `AGENTS.md`: `Node.js >= 18 (verified on 18.20.8 and 22.x; CI uses Node 22)`. The POC README and server header are version-neutral. `package.json` metadata unchanged. |
| npm-ci | fixed | `examples/README.md` prerequisites and `examples/poc-api/README.md` smoke command use `npm ci`; `README.md` "Install and requirements" states that checkout contributors use `npm ci`, while `npm install` is for consuming the published package and can rewrite the lockfile. |
| S9 | fixed | `samples/specweaver.config.yaml` and `samples/specweaver.zero-override.yaml` header comments show `specweaver` (after `npm i -g .`) and `node dist/cli.js` (no global install). Comment-only; YAML values unchanged and both samples still run. |
| L10 | fixed | `e2e/README.md` records the observed missing-k6 outcome: the inner `node --test e2e/live-e2e.mjs` exits `1` and prints `requires real k6 on PATH`; a status-capture wrapper passes when it does. |
| E11 | deferred to SPEC-49 | The attempted webhook gallery example was reverted: the shipped expected-status lookup reads `paths` only, so a `webhooks.pets.post` example checks the POC's documented `201` against the default `200`, reporting `0 passed / 2 failed` and exiting `1` under `--fail-on-check-failure`. The gallery keeps webhooks documented-but-not-demonstrated; the behavior fix is tracked in SPEC-49. |
| `SW-WT-01` | deferred | SPEC-48; its checklist box is left unchecked. |

- **Follow-up noted (out of SPEC-45 scope, source change required):** the
  emitter's documented-2xx lookup (`src/script/emit.ts`, `documented2xx`) scans
  `paths` only, so webhook catalog entries fall back to the default expected
  status `200`. The attempted gallery example made this visible (checks
  `0 passed / 2 failed`, `--fail-on-check-failure` exits `1`), so SPEC-45
  removed `examples/specs/webhooks.openapi.yaml`,
  `examples/configs/webhooks.yaml`, and its gallery section, and kept webhooks
  documented-but-not-demonstrated. **SPEC-49** tracks the behavior fix.

`git status --porcelain -uall` listed only the intended Markdown/example files
plus the untracked `docs/readiness.md`. No commit, branch, tag, or push was made.
