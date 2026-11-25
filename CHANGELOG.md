# Changelog

All notable changes to SpecWeaver are recorded here, in the spirit of
[Keep a Changelog](https://keepachangelog.com/). The project uses semantic
versioning. The Kanban board (`SPEC-*`) and [ROADMAP.md](ROADMAP.md) remain the
source of truth for ticket status and limitations; this file summarizes what
shipped. Each bullet names the test suite, commit, or board record that covers
it.

## [1.0.0] — 2026-11-25

First public release, covering everything since the `0.1.0` scaffold. The
v1.0.0 tree was prepared on 2026-11-13 and released on 2026-11-25 as a GitHub
Release tarball: tag `v1.0.0` on commit `f509035`,
<https://github.com/WMordy/SpecWeaver/releases/tag/v1.0.0>, assets
`specweaver-1.0.0.tgz`, the stable alias `specweaver.tgz`, and `SHA256SUMS`
(`a5adb89a0821e46fe5ac8cf38864e6464a2ec58fd20a855fcfb83e3d847cf7ff`).
Install with the tarball URL or the `github:` paths in the README. **npm
publishing has not been performed**; the registry path is parked in SPEC-53.
The go/no-go record is in
[ROADMAP.md](ROADMAP.md#p5--public-release-readiness-spec-4251-complete).

### v1 core (SPEC-1…12)

- TypeScript/ESM npm CLI (`specweaver`) with strict `tsc` build, YAML-only
  config, and no runtime dependencies beyond `yaml` and `@faker-js/faker`
  (SPEC-1, SPEC-2; `test/cli.test.js`, `test/config.test.js`).
- OpenAPI 3.0 and 3.1 loading with internal and external-file `$ref`
  resolution and deterministic operation cataloguing (SPEC-3;
  `test/spec.test.js`).
- Request generation for path, query, header, and cookie parameters and JSON
  bodies from examples → schema `default` → seeded faker by `type`/`format`;
  required and optional fields are generated (SPEC-4;
  `test/request-data.test.js`).
- Static auth injection from YAML/env (`auth.token`, `auth.headers`) with
  `${ENV_VAR}` interpolation and secret redaction (SPEC-5;
  `test/auth.test.js`).
- Dependency-free k6 emission: a generated script (k6 built-ins only) plus a
  companion JSON data file; faker runs only in the CLI (SPEC-6;
  `test/script-emit.test.js`).
- k6 PATH preflight and spawn, streaming output, a unique temp directory per
  run with `0600` files, and cleanup (SPEC-7, SPEC-11;
  `test/run.test.js`, `test/script-emit.test.js`).
- Results JSON, human console summary, per-operation checks, and the
  `0`/`1`/`2` exit-code policy (SPEC-8; `test/results.test.js`).
- Test suite, sample-spec e2e, README, and the optional `baseUrl` override
  (SPEC-9, SPEC-10; `test/e2e.test.js`, `test/config.test.js`).
- SPEC-12 audited the shipped feature set against the v1 goal (SPEC-12; audit
  recorded on the board, no code change).

### P0 — correctness and trust (SPEC-13…16)

- `payloads[].body` replaces the generated JSON body for a matching
  `method`+`path`; unmatched overrides warn and unsupported keys are rejected
  (SPEC-13; `test/request-data.test.js`, `test/cli.test.js`).
- Runs with no `specs` or zero selected operations exit `2` with an actionable
  message and write no results file (SPEC-14; `test/cli.test.js`).
- Specs that contribute zero operations warn (components-only 3.1 documents
  remain the catalogued case), feeding the no-run exit path (SPEC-15;
  `test/coverage.test.js`, `test/spec.test.js`).
- README, config JSDoc, and the sample were aligned with actual behavior
  (SPEC-16; `39c9c3e`).

### P1 — proof it works (SPEC-17…21)

- GitHub Actions CI builds and tests every push and pull request (SPEC-17),
  and the k6 e2e is mandatory in CI rather than skipped (SPEC-18;
  `.github/workflows/ci.yml`, `test/k6-requirement.test.js`).
- Opt-in `--fail-on-check-failure` check gating (SPEC-19;
  `test/cli.test.js`, `test/results.test.js`), documented with the exit-code
  behavior (SPEC-20; `1702e4e`); SPEC-21 recorded the verified P0/P1 state
  (`94f9efe`).

### P2 — zero-override convenience (SPEC-22…26)

- `operations: all` selects the whole catalog in deterministic order
  (SPEC-22, SPEC-23; `test/config.test.js`, `test/selection.test.js`).
- Zero-override runs fail loudly on an unusable base URL (SPEC-24;
  `test/cli.test.js`) and warn on coverage gaps instead of failing (SPEC-25;
  `test/coverage.test.js`).
- Zero-override mode was documented and the roadmap refreshed (SPEC-26;
  `0e0962e`).

### P3 — adoption and live end-to-end proof (SPEC-27…32)

- A dependency-free POC API and OpenAPI example (SPEC-27) plus runnable
  examples for every shipped feature (SPEC-28; `examples/`,
  `e2e/live-e2e.mjs`).
- A real-k6 live e2e that starts the POC API, runs the built CLI, and asserts
  results, checks, server-observed requests, and cleanup; it runs in CI
  (SPEC-29; `e2e/live-e2e.mjs`).
- README overhauled for human adopters and AI agents (SPEC-30; `1aee7ca`) and
  AGENTS.md added for agent onboarding (SPEC-31; `6954a49`); SPEC-32 closed
  out P3 (`aaffc45`).

### P4 — deferred capability expansion (SPEC-33…41)

- Base-URL fallback uses the first usable `servers[].url`, warning per skipped
  entry (SPEC-33; `test/spec.test.js`, `test/cli.test.js`).
- `label` and `matrix` path-parameter styles serialize to their OpenAPI wire
  forms (SPEC-34; `test/request-data.test.js`).
- Cookie parameters are generated and sent in one percent-encoded `Cookie`
  header (SPEC-35; `test/request-data.test.js`).
- Selectors beyond `all`: exact `operationId`, case-sensitive `tags`, and
  `path` patterns with `*`/`**` (SPEC-36; `test/selection.test.js`).
- OpenAPI 3.1 `webhooks` are catalogued as `/<webhookName>` path operations
  (SPEC-37; `test/spec.test.js`).
- Non-JSON bodies are generated in the CLI for
  `application/x-www-form-urlencoded`, `multipart/form-data`, and
  `application/xml` (SPEC-38; `test/request-data.test.js`).
- Bearer and header/query `apiKey` auth derive from `securitySchemes`
  (SPEC-39), with per-operation `authOperations` overrides (SPEC-40;
  `test/auth.test.js`).
- Remote `http(s)` specs are fetched under an explicit timeout, size, and
  redirect policy with redacted diagnostics (SPEC-41; `test/spec.test.js`).

### P5 — public-release readiness (SPEC-42…51)

- Audited every advertised claim against shipped behavior (SPEC-42), ran the
  README as a stranger on a clean clone (SPEC-43), fixed documentation drift
  (SPEC-44), and fixed onboarding friction (SPEC-45); the audit record lives
  in [docs/readiness.md](docs/readiness.md) (`3dbe2eb`).
- Added public-release repo hygiene: MIT `LICENSE`, npm `repository`,
  `homepage`, `bugs` and `author` metadata, a README license link, and a
  `npm pack` content check that ships only `LICENSE`, `README.md`,
  `package.json`, and `dist/**` (SPEC-46; `a9b48c5`).
- Upgraded `@faker-js/faker` to `10.6.0`, clearing
  `GHSA-qxc2-j82w-r537`; seeded output stays deterministic and payload types,
  formats, and bounds are unchanged (SPEC-48; `78b5790`).
- Webhook operations now use their declared 2xx status in generated checks,
  with `paths` taking precedence on a shared route (SPEC-49; `369686c`,
  `test/script-emit.test.js`), and the zero-selection diagnostic names both
  `paths` and 3.1 `webhooks` (SPEC-50; `7045c5f`, `test/cli.test.js`).
- The documented Node/npm floor now mirrors faker 10:
  `^20.19.0 || ^22.13.0 || ^23.5.0 || >=24.0.0` and npm `>=10`, with a
  Node 20.19.0 + 22 CI matrix (SPEC-51; `6aa0944`).
- This cut: version `1.0.0`, this changelog, and the ROADMAP P5 closeout
  (SPEC-47; this release commit).

### Verification for 1.0.0

- `npm run build` exits `0`; `npm test` reports **414 tests, 414 passed, 0
  failed, 0 skipped**; `npm run test:live-e2e` reports **1 passed** with real
  k6 `v2.4.0`.
- On the declared floor (Node `v20.19.0`, npm `10.8.2`) `npm ci` is
  warning-free and the build and full test suite pass; the README link/anchor
  validator reports 6 Markdown files and 138 links/anchors with no errors.
- `npm audit --audit-level=high` reports `found 0 vulnerabilities`.

### Deferred in 1.0.0

These remain documented limitations, not shipped features:

- Non-JSON request bodies outside `application/x-www-form-urlencoded`,
  `multipart/form-data`, and `application/xml`.
- Security schemes other than bearer and header/query `apiKey`: `http`
  basic/digest, `apiKey` in a cookie, `oauth2`, `openIdConnect`, and
  `mutualTLS` are warn-only.
- Selector include/exclude composition and tolerant method/path matching.
- Cookie jars, `Set-Cookie` handling, and cross-request cookie reuse.
- Fetching or validating the real webhook consumer; webhooks are exercised by
  sending requests to the configured base URL.
- DNS/IP-level SSRF filtering for remote specs; the operator owns configured
  URLs.
- Publishing, tagging, and GitHub releases (see the go/no-go record).
- k6 Cloud, a Web UI, GraphQL/non-OpenAPI specs, scheduling/continuous runs,
  baseline/regression comparison, and SLA thresholds.
