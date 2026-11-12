# SpecWeaver

**Turn an OpenAPI definition plus a YAML config into a dependency-free k6 load test — then run it and get a results JSON.**

[![CI](https://github.com/WMordy/SpecWeaver/actions/workflows/ci.yml/badge.svg)](https://github.com/WMordy/SpecWeaver/actions/workflows/ci.yml)

SpecWeaver is a Node/TypeScript CLI. Point it at an OpenAPI 3.0/3.1 document and
a small YAML file (specs, operations, auth, payload overrides), and it selects
operations, generates request data, emits a k6 script that needs only k6
built-ins and plain JavaScript, runs it with the real `k6` binary, and writes a
machine-readable results file. It never installs k6 for you.

## Why SpecWeaver

Writing a k6 script by hand for every service is repetitive and drifts from the
API contract. The OpenAPI document already describes the paths, parameters,
bodies, examples, and server URLs — SpecWeaver turns that description into a
runnable load test without a pile of generated code to maintain.

The honest differentiators:

- **OpenAPI + YAML → dependency-free k6.** The emitted script uses k6 built-ins
  and plain JavaScript; nothing in `node_modules` is needed when k6 runs it.
- **Deterministic by default.** Operation selection, payload derivation, warning
  order, and per-operation check attribution are defined and stable, so runs are
  reproducible.
- **A real no-override path.** `operations: all` with only `specs` configured
  selects the whole catalog and derives payloads and the base URL from the
  OpenAPI document. Auth is derived from `securitySchemes` when credentials are configured, and explicit values win.
- **Loud failures, quiet non-fatal warnings.** Setup problems exit `2` before
  k6 runs; coverage gaps are `warning:` lines on stderr and never change a
  successful exit code. Resolved secrets are not printed.
- **Usable locally and in CI.** Real k6 `v2.x`, a results JSON with per-operation
  checks, an opt-in check gate, and a live end-to-end test against a checked-in
  POC API.

SpecWeaver is not a k6 replacement, a hosted load-testing service, or a
performance benchmark generator. It is a small, deterministic front end from
OpenAPI to k6.

## Features at a glance

**Shipped** capabilities are implemented. The gallery at
[`examples/`](examples/README.md) demonstrates most of them; its
[shipped-vs-deferred list](examples/README.md#shipped-vs-deferred) names the
shipped ones that are documented but not demonstrated. **Deferred** capabilities
are explicitly not available in v1 and link to the matching limitation in
[`ROADMAP.md`](ROADMAP.md).

| Capability | Status | Notes |
| --- | --- | --- |
| OpenAPI 3.0/3.1 specs (JSON or YAML), local or remote | Shipped | Local paths and absolute `http(s)://` URLs. `$ref`s inside a remote document resolve against that document's URL; a local document's `$ref`s keep local-only behavior (see [Remote specs](#remote-specs-network-and-error-policy)). |
| Selector entries: `{ method, path }`, `{ operationId }`, `{ tags }`, `{ path }` patterns | Shipped | Additive forms; deterministic union expansion with `METHOD path` dedupe. |
| Whole-catalog selector `operations: all` | Shipped | Exact, case-sensitive literal; deterministic expansion. |
| Derived request data | Shipped | Path/query/header/cookie parameters and JSON bodies; path parameters honor `simple`, `label`, and `matrix` styles with `explode`; explicit example/examples → `default` → faker; required and optional fields generated. |
| Whole-body `payloads` overrides | Shipped | Replaces the generated JSON body for the matching operation. |
| Global static auth | Shipped | Bearer `token` and/or static `headers`; `${ENV_VAR}` references; explicit values win over derived auth. |
| Base URL resolution | Shipped | Explicit `baseUrl` wins; otherwise the first usable `servers[].url`, with server-variable defaults substituted and unusable entries skipped with a warning. |
| Non-fatal coverage warnings | Shipped | Non-JSON required body, unsatisfiable security schemes. |
| Dependency-free k6 script emission | Shipped | k6 built-ins and plain JavaScript only. |
| Real k6 execution and streaming output | Shipped | k6 must be on `PATH`; SpecWeaver never installs it. |
| Results JSON, console summary, per-operation checks | Shipped | Documented-2xx requests pass; everything else fails. |
| Opt-in `--fail-on-check-failure` gate | Shipped | Check failures are informational by default. |
| CLI `--vus` / `--duration` / `--out` overrides | Shipped | Override the corresponding YAML values. |
| Non-JSON body generation (XML, multipart, form-urlencoded) | Shipped | Generated in the CLI as one wire string with the matched `Content-Type`; fixed multipart boundary, deterministic binary placeholder. Other media types still warn. |
| Cookie parameters | Shipped | `in: cookie` parameters are generated and sent in one percent-encoded `Cookie` header; array/object values serialize non-exploded (OpenAPI's cookie default is `explode: true`). No cookie jar or `Set-Cookie` handling. |
| `securitySchemes`-derived auth | Shipped | Bearer schemes use `auth.token`; `apiKey` header/query schemes use `auth.apiKeys[<scheme name>]`. Other scheme types are warn-only. |
| Per-operation auth overrides | Shipped | `authOperations` entries keyed by `METHOD path` replace the global explicit auth for matched operations; derived schemes then resolve against the override. Unmatched entries warn. |
| Remote `http(s)` specs | Shipped | Fetched once per run with a 10 s timeout, 5 MiB cap, and redirect/downgrade policy. See [Remote specs](#remote-specs-network-and-error-policy). |
| OpenAPI 3.1 `webhooks` cataloguing | Shipped | Catalogued as path operations at `/<webhookName>` after `paths`, selectable like any path operation; k6 plays the API server that sends events, and the base URL stands in for the consumer endpoint. |

## Contents

- [Why SpecWeaver](#why-specweaver)
- [Features at a glance](#features-at-a-glance)
- [Contents](#contents)
- [Quick start (2 minutes)](#quick-start-2-minutes)
- [Examples](#examples)
- [Install and requirements](#install-and-requirements)
- [Configuration](#configuration)
- [CLI reference](#cli-reference)
- [Recipes](#recipes)
- [How it works](#how-it-works)
- [Exit codes and check gating](#exit-codes-and-check-gating)
- [Coverage warnings](#coverage-warnings)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development and testing](#development-and-testing)
- [For AI agents](#for-ai-agents)

## Quick start (2 minutes)

Prerequisites: Node.js >= 18 (verified on 18.20.8 and 22.x; CI uses Node 22),
real `k6` v2.x on `PATH`, and this repository checked out. All commands run from
the repository root.

In the first terminal, install, build, and start the checked-in POC API:

```sh
npm ci
npm run build
node examples/poc-api/server.js
```

Wait for its readiness line:

```text
poc-api listening on http://127.0.0.1:8080
```

In a second terminal, still in the repository root, run the canonical POC
config and inspect the results JSON:

```sh
node dist/cli.js --config examples/poc-api/specweaver.config.yaml \
  --vus 1 --duration 2s --out /tmp/specweaver-quickstart.json
cat /tmp/specweaver-quickstart.json
```

The run exits `0`. The summary reports `Outcome: success`, `k6 exit code: 0`,
and the six selected operations; the exact pass counts depend on how many
iterations complete in two seconds. The results file is at
`/tmp/specweaver-quickstart.json`. Omit `--out` to write the default
`specweaver-results.json` in the current directory instead.

Stop the POC server with `Ctrl+C`; it prints `poc-api shutting down` and exits
`0`. The POC API is example/test infrastructure, not a supported service — see
[`examples/poc-api/README.md`](examples/poc-api/README.md).

## Examples

The runnable gallery is [`examples/README.md`](examples/README.md). Every
example runs from the repository root against the POC API and documents its
expected output, exit code, and results path.

Highlights:

| Example | What it shows |
| --- | --- |
| [Zero-override `operations: all`](examples/README.md#zero-override-operations-all) | Select the whole catalog; derive payloads and the base URL; no auth. |
| [Explicit operations + auth + payload](examples/README.md#explicit-operations--global-auth--payload-override) | An explicit operation list, a global bearer token plus headers, and a whole-body payload override. |
| [Auth from environment variables](examples/README.md#auth-from-environment-variables) | `${ENV_VAR}`-only auth and the non-fatal unresolved-variable warning. |
| [Multi-spec + explicit `baseUrl`](examples/README.md#multi-spec--explicit-baseurl) | Two local specs in one run, with an explicit base URL. |
| [Coverage warnings](examples/README.md#coverage-warnings) | Both non-fatal warning classes in one run. |
| [POC canonical run](examples/README.md#poc-canonical-run) | The happy-path config used by the quick start. |

The gallery also includes a copy-pasteable CI snippet and a feature-to-example
map. The checked-in [`samples/`](samples/) remain the canonical minimal configs.

## Install and requirements

- **Node.js >= 18** (`package.json` `engines`; verified on 18.20.8 and 22.x; CI
  uses Node 22).
- **Real `k6` v2.x on `PATH`** (verified with `k6 v2.4.0`). SpecWeaver never
  installs k6. If it is missing, SpecWeaver exits `2` before running anything
  with an actionable message. Install it from
  <https://grafana.com/docs/k6/latest/set-up/install-k6/> and verify with:

  ```sh
  k6 version
  ```

From a checkout, install the CLI globally as the `specweaver` command:

```sh
npm ci
npm run build
npm i -g .
specweaver --version
```

This checkout is the supported installation source. `npm i -g specweaver`
would only work if the package were published to the npm registry.

Contributors installing from a checkout use `npm ci`, which installs
`package-lock.json` exactly and never rewrites it. `npm install` is for
consuming the published package and can rewrite the lockfile.

If you prefer not to install globally, run the built CLI directly. Every
example in this repository uses this form:

```sh
node dist/cli.js --config examples/poc-api/specweaver.config.yaml \
  --vus 1 --duration 2s
```

## Configuration

Config input is **YAML**, supplied with `--config <path>`. TOML, a JSON-specific
config format, and config-file discovery are not supported (a JSON document is
accepted only because JSON is a YAML subset). All relative paths — `--config`,
`--out`, `specs`, and `output` — resolve against the current working directory,
so run the checked-in examples from the repository root.

A complete example:

```yaml
specs:                      # REQUIRED to execute: local path(s) and/or http(s) URL(s)
  - ./openapi.yaml
  - https://example.com/openapi.json
operations:                 # REQUIRED: selector entries, or the literal all
  - method: GET             # explicit form: exact METHOD path match
    path: /pets
  - operationId: listPets   # exact operationId match
  - tags: [pets]            # any listed tag (OR semantics)
  - path: /pets/*           # path pattern: * one segment, ** the remainder
# operations: all           # alternative: select every catalogued operation
baseUrl: https://staging.example.com  # OPTIONAL: overrides the servers[].url fallback
auth:                       # OPTIONAL: static token/headers/api keys (env-referenceable)
  token: "${API_TOKEN}"
  headers:
    X-Api-Key: "${API_KEY}"
  apiKeys:                  # securityScheme name -> credential (derived auth)
    ApiKeyAuth: "${API_KEY}"
authOperations:             # OPTIONAL: per-operation auth overrides
  - method: POST
    path: /admin
    token: "${ADMIN_TOKEN}" # replaces the whole global explicit auth surface
payloads:                   # OPTIONAL: per-operation whole-body overrides
  - method: POST
    path: /pets
    body: { name: "Rex", tag: "override" }
output: results.json        # OPTIONAL: results JSON path (--out overrides it)
load:                       # OPTIONAL: default load profile
  vus: 10
  duration: 30s
```

### Field reference

| Field | Required | Type | Contract |
| --- | --- | --- | --- |
| `specs` | **yes** to execute | string \| string[] | OpenAPI 3.0/3.1 source(s): local file path(s) or absolute `http(s)://` URLs, mixed in one list. Relative paths resolve against the current working directory. `$ref`s in a remote document resolve against that document's URL; a local document's `$ref`s stay local-only. Remote URLs must include a host; unsupported schemes and malformed URL-shaped entries are config errors naming `specs[i]`. Omitting `specs` exits `2` before k6 runs and before a results file is written. See [Remote specs](#remote-specs-network-and-error-policy). |
| `operations` | **yes** | selector entries \| all | Either a non-empty list of selector entries (`{ method, path }`, `{ operationId }`, `{ tags }`, or `{ path }`) or the exact, case-sensitive literal `all`. See [Operations](#operations-selectors). |
| `baseUrl` | no | string | Explicit request base URL. Must be a non-empty string (empty, whitespace-only, and non-string values are config errors); otherwise it is trusted verbatim and bypasses the server-URL usability gate. Overrides the fallback `servers[].url`. See [Base URL resolution](#base-url-resolution). |
| `auth` | no | mapping | Explicit global auth (`token`, `headers`) plus scheme-derived `apiKeys` (securityScheme name → credential). Explicit values apply to **every** selected operation; `apiKeys` values are used only where the operation's effective `security` references that scheme. Values support `${ENV_VAR}`. Absent `auth` means no explicit auth headers and no derived credentials. See [Auth](#auth). |
| `authOperations` | no | `{ method, path, token?, headers?, apiKeys? }[]` | Per-operation auth overrides keyed by normalized `method` + `path`. A matched entry **replaces** the global explicit `auth` wholesale (no deep merge) and must define at least one of `token`, `headers`, or `apiKeys`; unknown fields and duplicate keys are config errors. Unmatched overrides warn on stderr, including the no-`specs`/zero-selection early paths. Derived `securitySchemes` auth resolves against the override. Values support `${ENV_VAR}`. See [Auth](#auth). |
| `payloads` | no | `{ method, path, body }[]` | Per-operation JSON body overrides keyed by normalized `method` + `path`. `body` **replaces** the generated body wholesale (no deep merge). Only `method`, `path`, and `body` are accepted; other keys are config errors. Unmatched overrides warn on stderr. |
| `output` | no | string | Results JSON path (the JSON file only, never the generated k6 script/data). `--out` overrides it. Default: `specweaver-results.json` in the current working directory. |
| `load` | no | `{ vus, duration }` | Default load profile. Defaults to `vus: 1`, `duration: 30s`. `--vus` / `--duration` override it. |

### Operations: selectors

`operations` accepts either the exact YAML scalar `all` or a non-empty list of
selector entries. Each entry expands against the loaded catalog:

1. **`{ method, path }`** — explicit form. Exact match on the normalized
   `METHOD path`; methods are case-insensitive on input and normalized to
   uppercase. Accepted methods are `GET`, `POST`, `PUT`, `PATCH`, `DELETE`,
   `HEAD`, and `OPTIONS`. Duplicate explicit entries are config errors.
2. **`{ operationId: "<id>" }`** — exact, case-sensitive match on the
   operation's `operationId`. Every catalogued operation with that id is
   selected; duplicates on the same `METHOD path` keep the first occurrence.
3. **`{ tags: ["<tag>", ...] }`** — non-empty list; selects every operation
   declaring **any** listed tag (OR semantics, case-sensitive).
4. **`{ path: "<pattern>" }`** (optionally with `method`) — path pattern: `*`
   matches exactly one non-empty path segment and `**` matches any characters,
   including `/`. A trailing `/**` keeps its separator, so
   `/pets/**` does not match `/pets`. A wildcard-free value matches the exact
   path, for any method unless `method` is given. Because any `path` containing
   `*` is a pattern, a literal spec path containing `*` cannot be selected
   explicitly.

Expansion is deterministic. Each entry expands independently in catalog order
(spec order as listed in `specs`, then document path order, then canonical
method order: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`,
`TRACE`). The final selection is the union in config-entry order, deduplicated
on `METHOD path` keeping the first occurrence, so overlapping selectors never
duplicate an operation and repeated runs over identical inputs produce identical
operation order.

If every configured entry matches nothing, SpecWeaver exits `2` before k6,
lists each unmatched selector, and writes no results file. If only some match,
the matching operations still run, each unmatched entry produces a `warning:`
naming its form (`method path`, `operationId`, `tags`, or `path pattern`), and
the run returns k6's exit code.

The `all` literal is exact and case-sensitive. `operations: ALL`,
`operations: All`, `operations: "*"`, `operations: [all]`, and
`operations: { all: true }` are config errors. Any value that is neither the
literal `all` nor a valid non-empty list of selector entries is rejected with
an aggregated error naming `operations` and the accepted forms.

With `all`, selection is deterministic: spec order as listed in `specs`, then
document path order, then canonical method order (`GET`, `POST`, `PUT`,
`PATCH`, `DELETE`, `HEAD`, `OPTIONS`, `TRACE`). Cross-spec duplicates on
`METHOD path` are resolved first-wins: the first occurrence is selected and each
skip is a non-fatal `warning:` naming both spec sources. `all` never produces
unmatched entries. If the loaded specs contribute **zero** catalogued
operations, an `operations: all` run exits `2` with an `all`-specific message
and writes no results file.

Operations under `paths` are catalogued first; OpenAPI 3.1 `webhooks` entries
follow. A webhook's operations are catalogued as path operations at
`/<webhookName>` (a leading `/` is added when missing) and are exercised like
any path operation: k6 sends webhook-shaped requests to the configured base
URL — it plays the API server that sends events, and the base URL stands in for the consumer endpoint. They are selectable by
every shipped selector and treated identically by generation, `payloads`, auth
injection, emission, and the base-URL gate.

OpenAPI 3.1 still allows a valid components-only document; such a spec loads but
contributes no operations. SpecWeaver warns on stderr, naming the source and
stating that a components-only document yields none. If that leaves no
operation to run, the exit-`2` no-operations path above applies.

### Payload derivation

For every selected operation, the request body comes from the highest-priority
source that exists:

1. a matching `payloads[].body` override — **whole-body replacement**, not a
   deep merge (replaces generated **JSON** bodies only; see below);
2. an explicit `example`/`examples` (parameter, media-type, or schema level);
3. the schema's `default`;
4. a faker-generated value based on the JSON Schema `type`/`format`.

Both required **and** optional fields are always generated, and generation
recurses through nested objects and arrays. `payloads` matching normalizes the
method (so `get /pets` and `GET /pets` are equivalent) and keys on `method` +
`path`. An override supplies a body even when the operation had no generated
JSON body. An override that matches no selected operation warns on stderr and
does not fail the run. `payloads` are applied before auth injection.

When the operation's request body declares no JSON media type, a non-JSON body
is generated for `application/x-www-form-urlencoded`, `multipart/form-data`, or
`application/xml` (the first supported entry in that fixed order when several
are declared), and sent **as one wire string** with the matched media type as
the `Content-Type`:

- **urlencoded** — `key=value` pairs joined by `&`, names and values
  percent-encoded, in schema property order; array values repeat the key;
  nested objects serialize as their JSON text.
- **multipart** — one `Content-Disposition: form-data; name="<name>"` part per
  property (one part per array item) in property order, separated with the
  fixed boundary `specweaver-multipart-boundary` (`Content-Type` carries the
  same boundary) and a trailing closing boundary. A `format: binary` field
  sends the deterministic placeholder `specweaver-binary-part` — no real file
  is read or uploaded.
- **XML** — a `<root>` element wrapping one child element per property in
  property order, arrays as repeated child elements, nested objects as nested
  elements, primitives as XML-escaped text nodes. XML attributes, namespaces,
  and custom root names are not modeled.

Serialization happens in the CLI, so the emitted k6 script stays
dependency-free; each non-JSON body is computed once and sent unchanged every
iteration. A `payloads` override that matches an operation with a generated
non-JSON body is reported as not applied (with the media type named) and the
generated body is kept — overrides replace generated JSON bodies only. A
required body declaring **none** of JSON, urlencoded, multipart, and XML is
sent without a body and produces a coverage warning.

Cookie parameters (`in: cookie`) are generated with the same
example → `default` → faker chain, required and optional alike, and sent in
exactly one `Cookie` request header: `name=value; name2=value2` pairs in
parameter declaration order, with names and values percent-encoded. Array and
object values serialize non-exploded (form style, `explode` treated as `false`)
— a deliberate deviation from OpenAPI's cookie default of `explode: true`. A
cookie parameter's own `style`/`explode` is ignored and produces no warning. A
`Cookie` value configured in `auth.headers` wins over generated cookies
(case-insensitively), matching the auth collision precedence, and a declared
`Cookie` header parameter likewise suppresses the generated pairs. There is no
cookie jar: response `Set-Cookie` headers are ignored, so response-driven session
state is not tracked. Like every other generated header, the cookie pairs are
computed once at script generation and sent unchanged on every iteration.

### Base URL resolution

An explicit `baseUrl` always wins. Config validation rejects an empty,
whitespace-only, or non-string value; a valid value is otherwise trusted
**verbatim** and bypasses the server-URL usability gate. Trailing slashes are
stripped when request URLs are composed, so `https://host/` + `/pets` yields
`https://host/pets`.

Without an explicit `baseUrl`, the request base URL is the **first usable**
`servers[].url` across the configured specs, in `specs` order and then
`servers[]` document order, with server-variable defaults substituted (for
example `https://{region}.example.com` with `region.default: eu`). Entries that
are relative, empty, non-`http(s)`, whitespace-bearing, or still templated
(unresolved `{variable}`) are skipped, so an unusable earlier entry does not
block a usable later one. Each skipped entry emits a non-fatal `warning:` on
stderr naming its spec source and a redacted value; the run continues with the
first usable entry. Warnings never change the exit code.

If no usable fallback exists, the run fails at the SpecWeaver boundary instead
of emitting a broken relative URL. The diagnostic names the first string
candidate (or states that no string value exists) with one actionable `error:`,
plus both remedies: set `baseUrl`, or add an absolute `http(s)` `servers[].url`.
This happens before the k6 preflight, before any script is generated, and
before a results file is written. The gate is selector-independent: it applies
to explicit-list and `all` runs alike. Base-URL diagnostics redact values that
may contain credentials.

### Remote specs (network and error policy)

`specs` entries may be absolute `http(s)://` URLs. Each URL is fetched exactly
once per run (memoized, including on-demand external `$ref` targets), parsed as
JSON first and then YAML, and resolved like a local document. Relative external
`$ref`s in a remote document resolve against that document's URL; `../`
segments are normalized. A local document's `$ref`s keep their local-only
behavior.

The network policy is explicit:

- **Timeout:** 10 seconds per fetch, enforced with `AbortController`. A timeout
  exits `2` with an error naming the URL host and the timeout.
- **Size cap:** response bodies over **5 MiB** fail the fetch with a
  deterministic error; the body is capped while streaming.
- **Redirects:** handled manually (`redirect: "manual"`), at most 10 hops.
  Relative `Location` headers resolve against the current URL, `http -> https`
  upgrades are allowed, and an `https -> http` downgrade is rejected.
  Redirects to non-`http(s)` locations are rejected too.
- **Failures:** network errors, timeouts, non-2xx responses, oversized bodies,
  and unparsable content each fail **before k6 runs** as exit-`2` errors naming
  the redacted host and the reason — never a stack trace.
- **SSRF posture (non-goal):** URLs must be absolute `http(s)` URLs with a host,
  but there is **no** DNS/IP-based private-address filtering. The operator is
  responsible for the URLs configured. Credentials are never printed: network
  and redirect errors name the host only, while parse/`$ref` errors show the
  source URL with any userinfo masked. Node's `fetch` does not accept
  credentials embedded in a URL, so configure unauthenticated spec URLs.
- **Mix:** local and remote specs may be combined; load order, selection,
  warnings, and output determinism are unchanged.

### Auth

Auth has three layers, in descending precedence:

1. **Per-operation override** — a matching `authOperations` entry.
2. **Explicit global** — `auth.token` / `auth.headers` / `auth.apiKeys`.
3. **Scheme-derived** — `securitySchemes` mapped from the effective surface.

The **explicit global** values (`token`, `headers`) apply to every selected
operation regardless of its `security`, preserving the original contract:
`token` emits `Authorization: Bearer <token>` (and wins over an `authorization`
entry in `headers`, case-insensitively), while `headers` emits each configured
name/value pair.

A matching **per-operation override** replaces that global surface wholesale for
the operation's requests: the entry's `token`, `headers`, and `apiKeys` replace
the global counterparts (no deep merge, matching `payloads`). An override that
defines only `token` therefore does not inherit global `headers` or `apiKeys`.
Unmatched override entries warn on stderr and never change the exit code.

The **scheme-derived** layer maps the `securitySchemes` an operation's effective
`security` references onto wire values, so a zero-override run authenticates once
credentials are configured. It resolves against the effective explicit surface
(override when matched, otherwise global). `auth.apiKeys` maps a securityScheme
name to its credential:

```yaml
auth:
  token: "${API_TOKEN}"          # http/bearer schemes
  apiKeys:
    HeaderKey: "${HEADER_KEY}"   # apiKey in: header -> header named by the scheme
    QueryKey: "${QUERY_KEY}"     # apiKey in: query  -> query param named by the scheme
authOperations:
  - method: POST
    path: /admin
    token: "${ADMIN_TOKEN}"      # replaces the global explicit surface here
    apiKeys:
      HeaderKey: "${ADMIN_KEY}"  # derived auth resolves against this override
```

Supported mappings:

- `type: http` with `scheme: bearer` → `Authorization: Bearer <auth.token>`
  (or an explicit `Authorization` header).
- `type: apiKey` with `in: header` → the credential in the header named by the
  scheme.
- `type: apiKey` with `in: query` → the credential appended as the query
  parameter named by the scheme.

Precedence: explicit `auth.token`/`auth.headers` win over derived values on the
same wire target (case-insensitive for header names). Derived values are skipped
there, so no duplicate header is sent. A derived query `apiKey` replaces a
generated query parameter of the same name. An operation with empty effective
`security` (or an explicit `security: []`) gets no derived auth and no warning.

The following are **warn-only** — the request still runs, sent without that
credential, and one `warning:` per scheme per operation names the scheme:
`http` basic/digest, `apiKey` with `in: cookie`, `mutualTLS`, `openIdConnect`,
`oauth2`, a requirement naming a scheme absent from `securitySchemes`, and a
supported scheme whose credential is not configured. A warning is never emitted
for an operation that receives derived auth.

`${ENV_VAR}` references in every `auth` and `authOperations` value (including
`apiKeys`) are resolved from the process environment. An unresolved reference is
non-fatal: the placeholder is left literal, the run continues, and one
`warning:` per unresolved
variable is printed to stderr (deduplicated across fields). Resolved secrets are
never printed: k6's live stdout/stderr is scrubbed of every configured credential
before it reaches the console (query-string API keys would otherwise appear in
k6's transport-error URLs), and warnings are never written into the results JSON.

## CLI reference

```text
specweaver --config <path> [options]
```

| Option | Description |
| --- | --- |
| `--config <path>` | Path to the YAML config file (**required**). |
| `--vus <n>` | Number of virtual users (positive integer). Overrides `load.vus`. |
| `--duration <time>` | k6-style load duration, e.g. `30s` or `1m30s`. Overrides `load.duration`. |
| `--out <path>` | Path to write the results JSON file. Overrides the config `output`. |
| `--fail-on-check-failure` | Exit non-zero when any recorded check failed. Boolean; takes no value; off by default. See [Exit codes and check gating](#exit-codes-and-check-gating). |
| `--help` | Print usage and exit `0`. |
| `--version` | Print the version and exit `0`. |

Precedence is **CLI flag → YAML value → built-in default**. `load.vus` defaults
to `1` and `load.duration` to `30s`. `--config` is required; there is no config
discovery, no TOML or JSON-specific config format, and no environment-variable
config file.

`--fail-on-check-failure` is **CLI-only**. It has no YAML equivalent; adding
`failOnCheckFailure: true` to the YAML config is rejected as an unknown field,
exiting `2` before k6 runs. There is no negated form and no
`--fail-on-check-failure=true|false` value form.

`--out` and `output` name **only** the results JSON. They never name the
generated k6 script/data. Those are written to a unique per-run directory under
`os.tmpdir()` (created with `mkdtemp`) with owner-only (`0600`) permissions, and
the whole directory is deleted after the run unless `SPECWEAVER_KEEP_TEMP` is
set for inspection. Kept artifacts contain resolved auth credentials (the
generated data always, and k6's raw metrics for query-string `apiKey` schemes),
so treat them as secrets.

### Results file and console summary

The results path is resolved in this order:

1. `--out <path>` (CLI flag), else
2. the config `output` field, else
3. **`specweaver-results.json` in the current working directory** (the
   directory the CLI is invoked from).

The path is also printed in the console summary (and recorded in the file's own
`resultsFile` field). After k6 finishes, SpecWeaver writes the results file and
then prints one human-readable summary covering the run outcome, the resolved
load, one line per operation with its check pass/fail counts, the aggregate
check result, key metrics, and the results path. It is emitted only after the
run completes, so it never interleaves with the live k6 output. If writing the
results file fails, SpecWeaver exits `2` after k6 and prints neither a results
file nor the summary.

The results JSON schema:

```jsonc
{
  "tool": "specweaver",
  "version": "0.1.0",
  "timestamp": "2026-10-18T17:00:00.000Z", // ISO-8601, when results were produced
  "config": { "vus": 2, "duration": "5s" }, // resolved load profile
  "k6ExitCode": 0,                          // k6's raw exit code (null on signal)
  "outcome": "success",                     // success | run_failure | specweaver_error
  "checks": {                               // per-operation check pass/fail counts
    "GET /pets": { "pass": 10, "fail": 0 },
    "POST /pets": { "pass": 8, "fail": 2 }
  },
  "summary": {                              // k6-derived metric summary
    "checks": { "pass": 18, "fail": 2, "rate": 0.9 },
    "httpReqs": 20,
    "iterations": 10,
    "httpReqDurationMs": { "avg": 12.3, "min": 1.2, "max": 40.1, "p90": 30.0, "p95": 35.5 }
  },
  "resultsFile": "/abs/path/specweaver-results.json"
}
```

Per-operation counts are derived from k6's raw metrics, captured with
`k6 run --out json=<tempfile>`. A request whose response status is accepted by
the operation's documented 2xx status(es) is a pass; otherwise it is a fail.
This runs alongside the live-streamed k6 output, which is never buffered or
reordered.

## Recipes

Unless noted, recipes assume the POC API is running in another terminal
(`node examples/poc-api/server.js`) and that `npm ci && npm run build` has been
run. Every command is copy-pasteable from the repository root. See the
[examples gallery](examples/README.md) for expected stdout/stderr excerpts.

### Zero-override run

Supply only a spec and `operations: all`; payloads and the base URL are derived
from the OpenAPI document, and no auth is sent.

```sh
node dist/cli.js --config samples/specweaver.zero-override.yaml \
  --vus 1 --duration 2s --out /tmp/specweaver-zero.json
```

Expected: exit `0`, `Outcome: success`, three operations from the petstore
catalog (`GET /pets`, `POST /pets`, `GET /pets/{petId}`), and no `warning:`
lines. The petstore spec derives `http://localhost:8080`; if your machine
resolves `localhost` to IPv6 only, see [Troubleshooting](#troubleshooting).

### Explicit operations

List exactly the operations to run, with a global token, a static header, and a
payload override:

```sh
node dist/cli.js --config samples/specweaver.config.yaml \
  --vus 1 --duration 2s --out /tmp/specweaver-explicit.json
```

Expected: exit `0`, `Outcome: success`, and three operations. The POC server log
shows the override applied to `POST /pets`
(`body={"name":"SampleOverridePet","tag":"override"}`).

### Auth from environment variables

Keep secrets out of YAML by referencing the environment:

```sh
POC_API_TOKEN=POC-TOKEN POC_API_CLIENT=examples \
  node dist/cli.js --config examples/configs/auth.from-env.yaml \
  --vus 1 --duration 2s --out /tmp/specweaver-auth.json
```

Expected: exit `0`, three operations, and `GET /admin/stats` passing with the
bearer token. If `POC_API_TOKEN` is unset, SpecWeaver prints a `warning:` for
the unresolved variable, sends the literal placeholder, `GET /admin/stats`
fails its documented-`200` check, and the run still exits `0`.

### Payload override

Replace the generated body wholesale for one operation:

```sh
node dist/cli.js --config examples/poc-api/specweaver.config.yaml \
  --vus 1 --duration 2s --out /tmp/specweaver-payload.json
```

Expected: exit `0`; the POC request log shows
`POST /pets -> 201 body={"name":"PocOverridePet","tag":"override","age":4}`. The
override is a replacement, not a merge with the generated body.

### Multi-spec and explicit baseUrl

Load two local specs and pin requests to one origin:

```sh
node dist/cli.js --config examples/configs/multi-spec.baseurl.yaml \
  --vus 1 --duration 2s --out /tmp/specweaver-multi.json
```

Expected: exit `0`, `Loaded config: 4 operation(s), 2 spec source(s).`, and
checks for both `GET /pets` (petstore) and `GET /owners` /
`GET /owners/{ownerId}` (second resource). The explicit
`baseUrl: http://127.0.0.1:8080` overrides the specs' own `servers[].url`.

### CI

CI can run the real pipeline end to end. The live e2e starts the POC API on an
ephemeral port, runs the built CLI with real k6, asserts the results JSON and
server-observed requests, and cleans up:

```sh
CI=true npm run test:live-e2e
```

Expected: exit `0` (about 5–15 seconds including the build). `CI=true` makes k6
mandatory. The repository's own workflow,
[`.github/workflows/ci.yml`](.github/workflows/ci.yml), runs this after
`npm test` on every push and pull request. A longer, copy-pasteable CI snippet
that starts the POC server and asserts the results JSON lives in the
[examples gallery](examples/README.md#ci-and-command-snippet). Details and env
vars are in [`e2e/README.md`](e2e/README.md).

## How it works

1. **Parse the CLI and load YAML config.** Resolve `${ENV_VAR}` references and
   emit unresolved-variable warnings.
2. **Load specs.** Read local files and fetch remote `http(s)` URLs (once each,
   with the timeout/size/redirect policy), resolve `$ref`s, and catalogue
   operations under `paths`.
3. **Select operations.** Expand the exact `all` literal or the configured
   selector entries deterministically. Report duplicate-operation and
   unmatched-selector warnings; exit `2` when nothing would run.
4. **Emit coverage warnings** for the selected operations (see
   [Coverage warnings](#coverage-warnings)).
5. **Gate the base URL.** Use an explicit `baseUrl`, or the first usable
   `servers[].url`; exit `2` before k6 when neither works.
6. **Preflight k6.** Resolve `k6` on `PATH`; a missing binary exits `2`.
7. **Generate request data.** Build path/query/header/cookie parameters and JSON
   bodies, apply `payloads` overrides, then inject the effective auth (a
   matched `authOperations` override, else the global `auth`).
8. **Emit the k6 script and companion data** into a unique temporary directory.
   The script uses k6 built-ins and plain JavaScript only.
9. **Run real k6**, stream its output live, and capture raw NDJSON metrics.
10. **Write the results JSON, print the console summary, and apply the optional
    check gate.**

Nothing is hidden behind a service: the generated script, its data, and the
results file are ordinary files, and the temp directory can be kept with
`SPECWEAVER_KEEP_TEMP=1`.

## Exit codes and check gating

| Code | Meaning |
| --- | --- |
| `0` | Success — k6 ran and exited `0`, and the opt-in check gate did not trip. `--help` and `--version` also exit `0`. |
| `1` | k6 run/script failure — k6 ran but exited non-zero (or was terminated by a signal), **or** `--fail-on-check-failure` tripped because at least one recorded check failed. |
| `2` | SpecWeaver-level error — invalid/missing config, no `specs`, no selected operations, an unusable fallback base URL, a spec/validation failure, a preflight failure (including k6 not found), or an internal error. Most exit-`2` errors happen before k6 runs and write no results file; a post-run failure such as being unable to write the results file also exits `2` after k6 has run. |

By default, failing checks **do not** change the exit code: k6 can exit `0`
with failed checks and SpecWeaver still exits `0`. Pass
`--fail-on-check-failure` to opt into stricter behavior for recorded checks:

- With the flag set, a run recording at least one failing check
  (`summary.checks.fail > 0`) exits `1`.
- Zero recorded checks (`summary.checks.pass + summary.checks.fail === 0`) never
  trip the gate, even with the flag set; a k6-success run still exits `0`.
- With the flag absent, a k6-success run exits `0` even when checks failed.
- A genuine non-zero k6 exit (including termination by a signal) always yields
  exit `1`, whether or not the flag is present. The gate never masks a k6
  failure; it only promotes a k6-success run to `1`.

The gate runs last, after the results JSON has been written and the console
summary has been printed, so neither is affected by it. When it trips,
SpecWeaver emits a single stderr message naming the flag and the failing-check
count:

```text
error: --fail-on-check-failure: 2 failing checks recorded; exiting with code 1.
```

An unexpected internal error is reported as a single clean, actionable message
on stderr (never a raw stack trace and never secret material) and exits `2`, so
it cannot be mistaken for a k6 run failure (`1`). SLA `thresholds` and
pass/fail gating on arbitrary metrics are out of scope for v1; the flag gates
recorded checks only.

## Coverage warnings

v1 cannot fully model every part of an OpenAPI document. Rather than omit them
silently, SpecWeaver emits one non-fatal warning per gap per selected
operation:

- a **required request body that declares none of the supported media types**
  (JSON, urlencoded, multipart, XML — e.g. an `application/x-www-form-urlencoded`
  variant with parameters, `text/csv`, or `application/octet-stream`), which is
  sent without a body;
- **a security scheme that cannot be satisfied** — an unsupported type or
  `apiKey` location, a scheme name absent from `securitySchemes`, or a supported
  scheme with no configured credential (see [Auth](#auth)) — which is sent
  without that credential.

Warnings are `warning:`-prefixed lines on **stderr**, naming `METHOD path` and
the concrete gap. They are deduped, deterministic (selected-operation order,
then body → auth within an operation), and emitted after operation
selection but before the k6 preflight, so they still appear when a run later
aborts at the base-URL gate or at k6 preflight. They never change the exit code,
never skip an operation, and are never written into the results JSON. The
classifier is selector-independent: an explicit-list run reports the same gaps
for its selected operations that an `all` run reports across the catalog.

The
["examples/poc-api/specweaver.warnings.config.yaml"](examples/poc-api/specweaver.warnings.config.yaml)
config demonstrates both in one run. Because the unauthenticated
`GET /admin/stats` returns `401` while the operation documents `200`, its
informational check fails; the run still exits `0`. The warning demo does not
hide that real outcome. The `photo` upload itself no longer warns: its multipart
body is generated (see [Payload derivation](#payload-derivation)). To see the
body warning again, point an operation at a media type outside the four
supported ones.

## Limitations

The authoritative limitations live in
[`ROADMAP.md`](ROADMAP.md#p2-limitations) (see also
[P2 outcome](ROADMAP.md#p2-outcome) and
[P3 limitations / non-goals](ROADMAP.md#p3-limitations--non-goals)). Deferred
means **not available**, not partially supported:

- **Selectors are additive only.** `operationId`, tags, and path-pattern
  entries expand independently and cannot be composed into AND/exclude
  expressions; matching is exact and case-sensitive (no fuzzy matching). A spec
  path containing a literal `*` cannot be selected explicitly because `*`
  always means a one-segment pattern.
- **Non-JSON bodies outside the four supported media types are deferred.**
  urlencoded, multipart, and XML bodies are generated (see
  [Payload derivation](#payload-derivation)); other media types, plus
  parameterized variants of the supported ones (e.g. `; charset=utf-8`), are
  not generated. A required unsupported body is sent without a body and
  produces a warning; optional unsupported bodies are silent. Multipart sends
  a fixed placeholder for `format: binary` parts, so real file uploads are not
  exercised.
- **Unsupported security schemes are deferred.** Bearer and `apiKey`
  header/query schemes are derived from the spec (SPEC-39), and per-operation
  overrides (`authOperations`) replace the global explicit surface (SPEC-40).
  `http` basic/digest, `apiKey` in a cookie, `mutualTLS`, `openIdConnect`, and
  `oauth2` are warn-only.
- **Remote specs are fetched, not cached across runs.** `specs` accepts local
  paths and absolute `http(s)://` URLs (SPEC-41). Each URL is fetched at most
  once per run; there is no HTTP cache, proxy/auth setting, or DNS/IP-level
  SSRF filtering — the operator owns the configured URLs. See
  [Remote specs](#remote-specs-network-and-error-policy).
- **A components-only 3.1 document yields zero operations.** It loads but
  catalogues nothing, so it warns and can lead to the zero-catalog exit `2`;
  webhooks-only documents are catalogued like `paths`.
- **Unusable `servers[]` entries are skipped with a warning.** Without an
  explicit `baseUrl`, the fallback uses the first usable entry and warns on
  stderr for each distinct entry skipped before it. When none is usable, the run
  exits `2` and the diagnostic names the first string candidate; no skip warnings
  are emitted on that error path.
- **An explicit `baseUrl` is trusted verbatim** once it is a non-empty string;
  it bypasses the server-URL usability gate.
- **Warnings are warn-only.** Auth gaps and unsupported request bodies are
  surfaced, not repaired.
- **The live e2e is a functional smoke test**, not a performance, capacity, or
  SLA benchmark. The POC API is checked-in example/test infrastructure, not a
  supported production service.

## Troubleshooting

### `k6` was not found

SpecWeaver exits `2` and prints:

```text
k6 was not found on your PATH.
SpecWeaver needs the k6 binary to run generated load tests and will not install it for you.
Install k6 from https://grafana.com/docs/k6/latest/set-up/install-k6/ and make sure it is available on your PATH.
```

Install k6 and confirm `k6 version` works in the same shell.

### Base-URL gate error (exit `2`)

If the config has no `baseUrl` and no `servers[].url` is usable (all are
missing, empty, relative, non-`http(s)`, whitespace-bearing, or still templated),
the run exits `2` before k6 and writes no results. Entries are scanned in order;
when a usable entry exists, each skipped one emits a `warning:` on stderr. On the
all-unusable path the diagnostic names the first string candidate when one
exists. Fix it in one of two ways: add `baseUrl: https://host` to the config, or
give the spec an absolute `http(s)` `servers[].url`.

### `localhost` resolves to IPv6 only

The POC API listens on `127.0.0.1`, while `samples/petstore.openapi.json`
derives `http://localhost:8080`. If your machine resolves `localhost` to `::1`
only, the request cannot reach the IPv4 listener. Do not edit the sample; add an
explicit IPv4 base URL in a temporary copy:

```sh
cp samples/specweaver.zero-override.yaml /tmp/specweaver-zero-ipv4.yaml
printf '\nbaseUrl: http://127.0.0.1:8080\n' >> /tmp/specweaver-zero-ipv4.yaml
node dist/cli.js --config /tmp/specweaver-zero-ipv4.yaml --vus 1 --duration 2s
```

The explicit `baseUrl` only changes the request origin; it adds no auth,
payloads, or other overrides.

### Port 8080 is already in use

Start the POC API on another port and point the config at it. The readiness line
prints the actual bound port:

```sh
PORT=9090 node examples/poc-api/server.js
```

Copy a config and change its `baseUrl` to `http://127.0.0.1:9090` (for example
`examples/configs/multi-spec.baseurl.yaml`). An invalid, out-of-range, or
already-used port fails fast with a non-zero exit.

### Where did the generated k6 script go?

The console prints a `Generated k6 script: ...` line. The script and its
companion data live in a unique per-run directory under `os.tmpdir()` and are
deleted after the run. Set `SPECWEAVER_KEEP_TEMP=1` to keep them for inspection.
`--out`/`output` never control this directory.

### Where is the results file?

Look for the `Results file:` line in the summary. Resolution is `--out`, then
config `output`, then `specweaver-results.json` in the current working
directory. A results file is written for successful and k6-failed runs after k6
completes. Errors before k6 runs write none; a failure to write the results file
exits `2` with neither a results file nor a summary.

### Unexpected exit `2`

SpecWeaver-level errors are reported on stderr as a single actionable message
(never a raw stack trace) and usually occur before k6 runs. The exception is a
post-run results-file write failure, where k6 ran but no results file was
written. Re-read the message for the offending config field, spec value, or
output path; if it says "unexpected internal error", re-run the same command and
report the message if it persists.

## Development and testing

Prerequisites: Node.js >= 18 (verified on 18.20.8 and 22.x; CI uses Node 22),
`npm ci`, and real k6 on `PATH` for
the suites that use it.

```sh
npm ci            # install from package-lock.json
npm run build     # tsc -> dist/
npm test          # build + node --test (test/**)
npm run clean     # remove dist/
```

At the time of this README, `npm test` runs **408 tests, 0 failed, 0 skipped**.
The count grows as tests are added; treat the command's result as authoritative,
not this number.

Most suites use a fake `k6` on `PATH`, so `npm test` works without real k6.
Exceptions: `test/e2e.test.js` runs the built CLI against an in-test HTTP stub
server with real k6 and skips when k6 is absent, unless `CI` or
`SPECWEAVER_REQUIRE_K6` is truthy (then it fails); one runtime test in
`test/script-emit.test.js` also uses real k6 and skips whenever k6 is absent.

The live end-to-end suite uses real k6 from `PATH` and fails if it is missing:

```sh
npm run test:live-e2e
```

It starts the checked-in POC API on an ephemeral port, runs the built CLI with
`--vus 1 --duration 1s --fail-on-check-failure`, asserts exit `0`, the results
JSON, and the POC's own request log, then cleans up. Env vars:

| Variable | Effect |
| --- | --- |
| `CI` | Truthy makes k6 mandatory and ignores the local skip opt-out. |
| `SPECWEAVER_REQUIRE_K6` | Truthy local equivalent of `CI`. |
| `SPECWEAVER_SKIP_LIVE_E2E` | `1`/truthy is an explicit local opt-out: prints a notice and skips with exit `0` **only** when `CI` and `SPECWEAVER_REQUIRE_K6` are both falsy. Missing POC files still fail. |
| `SPECWEAVER_KEEP_TEMP` | Truthy keeps generated k6 artifacts under `os.tmpdir()`. |

"Truthy" means set to anything except unset, empty, `0`, or `false`
(case-insensitive). Full behavior, assertions, and timeouts are in
[`e2e/README.md`](e2e/README.md).

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs on Node 22,
installs real k6, then `npm ci`, `npm run build`, `npm test`, and
`npm run test:live-e2e` on every push and pull request.

### Validating README links

This README's relative links and in-page anchors are checked with a
dependency-free Node script. Run it from the repository root:

```sh
node --input-type=module <<'NODE'
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = "README.md";

function anchorsIn(text) {
  const seen = new Map();
  const anchors = new Set();
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!match) continue;
    const base = match[2]
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/ /g, "-");
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    anchors.add(count === 1 ? base : `${base}-${count - 1}`);
  }
  return anchors;
}

function checkFile(file) {
  const text = readFileSync(file, "utf8");
  const dir = dirname(file);
  const links = [...text.matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((target) => !/^(?:[a-z]+:|#)/i.test(target) || target.startsWith("#"));
  let checked = 0;
  const errors = [];
  for (const target of links) {
    const [pathPart, fragment] = target.split("#");
    const resolved = pathPart ? resolve(dir, pathPart) : resolve(file);
    checked += 1;
    if (!existsSync(resolved)) {
      errors.push(`${file}: missing target ${target}`);
      continue;
    }
    if (fragment) {
      const anchors = anchorsIn(readFileSync(resolved, "utf8"));
      if (!anchors.has(fragment)) errors.push(`${file}: missing anchor ${target}`);
    }
  }
  return { checked, errors };
}

const files = new Set([root]);
const rootText = readFileSync(root, "utf8");
for (const match of rootText.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)) {
  files.add(resolve(dirname(root), match[1]));
}
const errors = [];
let checked = 0;
for (const file of files) {
  const result = checkFile(file);
  checked += result.checked;
  errors.push(...result.errors);
}
console.log(`Checked ${files.size} Markdown files and ${checked} links/anchors.`);
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("All relative links and in-page anchors resolve.");
}
NODE
```

It validates every relative link and anchor reachable from this README,
including links into the other Markdown files it points at.

## For AI agents

Read [`AGENTS.md`](AGENTS.md) before changing code. It is the onboarding map for
AI coding agents: repo layout, canonical build/test commands, test layout,
code conventions, ticket/ROADMAP workflow, and guardrails. It links back here
for the user-facing contract, and to [`ROADMAP.md`](ROADMAP.md) for phase status
and limitations, rather than duplicating them.
