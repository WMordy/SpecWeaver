# SpecWeaver

Turn OpenAPI definitions plus a YAML config into [k6](https://k6.io) load tests.

SpecWeaver is a locally-installed TypeScript/Node CLI. You point it at a YAML
file (OpenAPI source(s), the operations to test, auth, payload overrides) and it
generates a dependency-free k6 script, runs it, and reports the results — no
further setup.

## Requirements

- Node.js >= 18
- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) installed and on
  your `PATH`.

SpecWeaver never installs k6 for you. It PATH-checks for the `k6` binary before
generating anything, and if it is missing it exits `2` with:

```text
k6 was not found on your PATH.
SpecWeaver needs the k6 binary to run generated load tests and will not install it for you.
Install k6 from https://grafana.com/docs/k6/latest/set-up/install-k6/ and make sure it is available on your PATH.
```

## Install

SpecWeaver is installed globally as the `specweaver` command:

```sh
git clone <this repo> && cd <this repo>
npm install
npm run build
npm i -g .            # global install; exposes the `specweaver` command
```

Once published to the npm registry it can also be installed directly with
`npm i -g specweaver`; the local `npm i -g .` above is the supported way to
install this checkout.

## Quick start

The repository ships a runnable sample — `samples/petstore.openapi.json` and
`samples/specweaver.config.yaml` — that exercises path parameters, query
parameters, and a JSON request body. From the repository root:

```sh
# 1. run the sample load test (uses a literal token; no setup required)
specweaver --config samples/specweaver.config.yaml

# 2. a machine-readable summary is written next to the console output
cat specweaver-results.json
```

To keep secrets out of the config, reference the environment instead
(`token: "${API_TOKEN}"`); an unresolved `${ENV_VAR}` is a warning, not an
error.

For a zero-override run — just a spec plus `operations: all`, with no `auth`,
`payloads`, or `baseUrl` — use `samples/specweaver.zero-override.yaml` and see
[Zero-override run](#zero-override-run):

```sh
specweaver --config samples/specweaver.zero-override.yaml
```

> Relative `specs` paths are resolved against the **current working
> directory**, so run the samples from the repository root (where `samples/`
> lives). `--config`, `--out`, and the `specs` entries are all ordinary paths
> resolved the same way.

The `--vus`, `--duration`, and `--out` flags override the sample's values, e.g.
a quick smoke run:

```sh
specweaver --config samples/specweaver.config.yaml --vus 1 --duration 2s --out /tmp/results.json
```

## Usage

```sh
specweaver --config <path> [options]
```

| Option | Description |
| --- | --- |
| `--config <path>` | Path to the YAML config file (**required**). |
| `--vus <n>` | Number of virtual users (positive integer). Overrides the config. |
| `--duration <time>` | k6-style load duration, e.g. `30s` or `1m30s`. Overrides the config. |
| `--out <path>` | Path to write the results JSON file. Overrides the config `output`. |
| `--fail-on-check-failure` | Exit non-zero when any recorded check fails. Boolean; takes no value and is off by default. See "Check gating". |
| `--help` | Print usage. |
| `--version` | Print the version. |

## Config

Config input is YAML via `--config` only (no JSON/TOML, no config discovery).

```yaml
specs:                      # REQUIRED to execute, local path(s) or list (no URLs)
  - ./openapi.yaml
operations:                 # REQUIRED: list of { method, path }, or the literal all
  - method: GET
    path: /pets
# operations: all           # zero-override alternative: select every catalogued operation
baseUrl: https://staging.example.com  # OPTIONAL, request base URL; overrides the first string servers[].url across specs
auth:                       # OPTIONAL, static token/headers (env-referenceable)
  token: "${API_TOKEN}"
  headers:
    X-Api-Key: "${API_KEY}"
payloads:                   # OPTIONAL, per-operation JSON body overrides
  - method: POST
    path: /pets
    body: { name: "Rex", tag: "override" }
output: results.json        # OPTIONAL, results JSON path (see "Results file")
load:                       # OPTIONAL, default vus/duration
  vus: 10
  duration: 30s
```

| Field | Required | Type | Description |
| --- | --- | --- | --- |
| `specs` | **yes** | string \| string[] | Local OpenAPI 3.0/3.1 file path(s) to load (JSON or YAML); URLs are **not** fetched. At least one source is required to execute, because there must be a catalog to select operations from; paths resolve against the current working directory. |
| `operations` | **yes** | `{ method, path }[] \| all` | The operations to test: either a non-empty list of `{ method, path }` entries, or the exact, case-sensitive literal `all`, which selects every catalogued operation across every configured spec. Only the selected operations are ever run. |
| `baseUrl` | no | string | Request base URL. Must be a non-empty string (config validation rejects an empty, whitespace-only, or non-string value); it is otherwise trusted verbatim and bypasses the server-URL usability gate. Overrides the fallback `servers[].url`; when omitted, an unusable fallback is a hard error (see [Base URL resolution](#base-url-resolution)). |
| `auth` | no | mapping | Static auth applied to **every** selected operation, regardless of each spec's `security`: `token` (emits `Authorization: Bearer <token>`) and/or `headers` (name → value). Values support `${ENV_VAR}`. Absent `auth` means no auth headers are sent. |
| `payloads` | no | `{ method, path, body }[]` | Per-operation JSON body overrides, keyed by `method` + `path`. `body` **replaces** the generated body wholesale (no deep merge). Method matching is case-insensitive. Overrides that match no selected operation warn on stderr; any field other than `method`, `path`, or `body` is rejected. |
| `output` | no | string | Results JSON path (see "Results file"). `--out` overrides it. |
| `load` | no | `{ vus, duration }` | Default load profile. `--vus` / `--duration` override it. Defaults to `vus: 1`, `duration: 30s`. |

`specs` is **required** to execute. `operations` must select at least one
operation (an explicit list, or `all`), and without a spec there is no catalog
to select from. A config that omits `specs` exits `2` without running k6 or
writing a results file. `specs` entries are local filesystem paths only;
SpecWeaver does not download or resolve `http(s)://` URLs.

`operations` accepts exactly two forms:

- a non-empty list of `{ method, path }` entries — the opt-in form, where only
  the listed operations are run; or
- the exact YAML scalar `all` — the zero-override selector, which selects every
  operation catalogued from every configured spec.

The `all` literal is exact and case-sensitive. `operations: ALL`,
`operations: All`, `operations: "*"`, `operations: [all]`, and
`operations: { all: true }` are config errors; any value that is neither the
literal `all` nor a valid non-empty `{ method, path }[]` list is rejected with
an aggregated error naming `operations` and the accepted forms.

With an explicit list, if every configured operation is missing from the loaded
spec(s), SpecWeaver exits `2`, lists each unmatched `{ method, path }`, and
writes no results file. If only some operations match, the matching ones still
run; each unmatched entry is reported on stderr as a warning and the run returns
k6's exit code.

With `all`, SpecWeaver selects the union of the catalogues from every configured
spec in deterministic order: spec order as listed in `specs`, then document path
order, then canonical method order (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`,
`HEAD`, `OPTIONS`, `TRACE`). Cross-spec duplicates on `METHOD path` are resolved
first-wins: the first occurrence is selected and each skipped duplicate is
reported on stderr as a non-fatal `warning:` naming both spec sources. `all`
never produces unmatched entries. If the loaded specs contribute zero catalogued
operations, an `operations: all` run exits `2` with an `all`-specific message
and writes no results file.

Only operations declared under `paths` are catalogued. OpenAPI 3.1 allows a
valid document with only `webhooks` or only `components`, so such a spec is
accepted by the loader but yields no operations. SpecWeaver warns on stderr,
naming the source and stating that 3.1 `webhooks` and components-only documents
are not catalogued in v1. If that leaves no operation for the run to execute,
the exit-`2` no-operations path (explicit-list or `all`) applies and no results
file is written.

`payloads` overrides are applied before auth injection. For an operation whose
normalized `method` + `path` matches an entry, the configured `body` becomes the
request's JSON body **in place of** the body generated from the spec — it is a
whole-value replacement, not a partial merge. If the operation produced no JSON
body, the override supplies one. `get /pets` and `GET /pets` are equivalent. An
override that matches no selected operation is reported on stderr with a
`warning:` prefix and does not fail the run. Only `method`, `path`, and `body`
are supported; other keys (e.g. `query` or `headers`) are a config error rather
than being silently ignored.

Without an override, request bodies are generated in this order: an explicit
`example`/`examples` (parameter, media-type, or schema level) → the schema's
`default` → a faker-generated value based on the JSON Schema `type`/`format`.
Both required **and** optional fields are always generated. The full chain,
including a `payloads` override as the highest-priority source, is described in
[Payload derivation](#payload-derivation).

`${ENV_VAR}` references are resolved from the process environment. An
**unresolved** variable is non-fatal: SpecWeaver prints a warning to **stderr**
prefixed with `warning:` (e.g. `warning: unresolved environment variable "API_KEY"
referenced in \`auth.headers.X-Api-Key\``), continues, and does not change a
successful exit code. One warning is emitted **per unresolved variable**, even
when that variable is referenced from several fields. Warnings are never written
into the results JSON.

### Zero-override run

A zero-override run supplies only a spec and `operations: all`: there is no
`auth`, `payloads`, or `baseUrl` to configure. Payloads and the request base URL
are then derived from the OpenAPI document(s). Auth is **not** derived: with no
`auth` configured, no auth headers are sent, and a declared `security`
requirement only produces a coverage warning — there is no `securitySchemes`
mapping (see [Auth configuration](#auth-configuration)).

```yaml
specs:
  - samples/petstore.openapi.json
operations: all
```

That is exactly `samples/specweaver.zero-override.yaml`, runnable from the
repository root:

```sh
specweaver --config samples/specweaver.zero-override.yaml
```

All three catalogued petstore operations are selected. The spec's absolute
`servers[].url` (`http://localhost:8080`) supplies the base URL, so no `baseUrl`
is needed. (A real load test still needs that server to be reachable; the k6
PATH stub used by the tests is only for offline verification.)

### Payload derivation

For every selected operation, the request body comes from the highest-priority
source that exists:

1. a matching `payloads[].body` override — **whole-body replacement**, not a
   deep merge;
2. an explicit `example`/`examples` (parameter, media-type, or schema level);
3. the schema's `default`;
4. a faker-generated value based on the JSON Schema `type`/`format`.

Both required **and** optional fields are always generated, and generation
recurses through nested objects and arrays. `payloads` matching is
case-insensitive on `method` and keyed by `method` + `path`.

### Auth configuration

With no `auth` configured, SpecWeaver sends **no auth headers**. A configured
`auth` is global: `token` and/or `headers` are applied to every selected
operation regardless of the spec's `security`. There is no
`securitySchemes`-to-header mapping and no per-operation auth in v1.

An operation whose effective `security` is non-empty while no auth is configured
still runs — it is sent without authentication and reported as a warning, not a
failure (see [Coverage warnings](#coverage-warnings)).

### Base URL resolution

An explicit `baseUrl` always wins. It must be a non-empty string — config
validation rejects an empty, whitespace-only, or non-string value — but it is otherwise trusted
**verbatim** and bypasses the server-URL usability gate. Trailing slashes are
stripped when request URLs are composed, so `https://host/` + `/pets` yields
`https://host/pets`, not `https://host//pets`.
Without one, the request base URL is the first string
`servers[].url` across the configured specs, in `specs` order, with
server-variable defaults substituted (for example `https://{region}.example.com`
with `region.default: eu`). Only that first entry is considered: a later
absolute `servers[]` entry is not a fallback.

If no usable fallback exists, the run fails at the SpecWeaver boundary instead
of emitting a broken relative URL. A missing, empty, relative, non-`http(s)`,
whitespace-bearing, or still-templated (unresolved `{variable}`) value exits `2`
with one actionable `error:` message naming the spec source and the offending
value (or stating that none exists), plus both remedies: set `baseUrl`, or add
an absolute `http(s)` `servers[].url`. This happens before the k6 preflight,
before any script is generated, and before a results file is written, and it
applies to explicit-list and `all` runs alike — the gate is
selector-independent. Base-URL diagnostics redact values that may contain
credentials.

### Coverage warnings

v1 cannot fully model three things. Rather than omit them silently, SpecWeaver
emits one non-fatal warning per gap per selected operation:

- a **required request body with no JSON media type** (e.g.
  `application/xml` or `multipart/form-data`), which is sent without a body;
- **`in: cookie` parameters**, which are not generated or sent;
- **non-empty `security` with no configured `auth`**, which is sent without
  authentication.

Warnings are `warning:`-prefixed lines on **stderr**, naming `METHOD path` and
the concrete gap. They are deduped, deterministic (selected-operation order,
then body → cookie → security within an operation), and emitted after operation
selection but before the k6 preflight, so they still appear when a run later
aborts at the base-URL gate or at k6 preflight. They never change the exit code,
never skip an operation, and are never written into the results JSON. The
classifier is selector-independent: an explicit-list run reports the same gaps
for its selected operations that an `all` run reports across the catalog.

## Results file

After k6 finishes, SpecWeaver writes a machine-readable JSON results file. Its
path is resolved in this order:

1. `--out <path>` (CLI flag), else
2. the config `output` field, else
3. the documented default: **`specweaver-results.json` in the current working
   directory** (the directory the CLI is invoked from).

The path is also printed in the console summary (and recorded in the file's own
`resultsFile` field). `--out` and `output` name **only** this results JSON; they
never name the generated k6 script/data. Those are written to a unique per-run
directory under `os.tmpdir()` (created with `mkdtemp`) with owner-only (`0600`)
permissions, and the whole directory is deleted after the run unless
`SPECWEAVER_KEEP_TEMP` is set for inspection.

### Results schema

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
the operation's documented 2xx status(es) is a pass, otherwise a fail. This runs
alongside the live-streamed k6 output, which is never buffered or reordered.

## Console summary

After k6 exits, SpecWeaver prints a single human-readable summary covering the
run outcome, the resolved load, one line per operation with its check pass/fail
counts, the aggregate check result, key metrics, and the path of the written
results file. It is emitted only after the run completes, so it never interleaves
with the live k6 output.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success — k6 ran and exited `0`, and the opt-in check gate did not trip (`--help` and `--version` also exit `0`). |
| `1` | k6 run/script failure — k6 ran but exited non-zero (or was terminated by a signal), **or** the opt-in `--fail-on-check-failure` gate tripped because at least one recorded check failed. |
| `2` | SpecWeaver-level error — invalid/missing config, a config with no `specs`, no selected operations (`all` against specs with an empty catalog, or no explicit-operation match; nothing ran), an unusable fallback base URL, a spec/validation failure, a preflight failure (including "k6 not found"), or an internal error. k6 is not run. |

For an actual run, SpecWeaver exits `0` only when it ran k6, k6 exited `0`, and
(if `--fail-on-check-failure` was set) no recorded check failed; any non-zero k6
exit yields a non-zero SpecWeaver exit and is never converted to success. A
failing `check` is informational by default, and becomes a run failure only when
you opt in with `--fail-on-check-failure`. SLA `thresholds` and pass/fail gating
on metrics are out of scope for v1; the flag gates recorded checks only.

An unexpected **internal** error is reported as a single clean, actionable
message on stderr (never a raw stack trace, and never secret material) and exits
`2`, so it can never be mistaken for a k6 run failure (`1`).

### Check gating

By default, failing checks do not change the exit code: k6 can exit `0` with
failed checks and SpecWeaver still exits `0`. Pass `--fail-on-check-failure` to
opt into the opposite behaviour for recorded checks:

- With the flag set, a run recording at least one failing check
  (`summary.checks.fail > 0`) exits `1`.
- Zero recorded checks (`summary.checks.pass + summary.checks.fail === 0`) never
  trip the gate, even with the flag set; a k6-success run still exits `0`.
- With the flag absent, exit codes are unchanged: a k6-success run exits `0`
  even when checks failed.
- A genuine non-zero k6 exit (including termination by a signal) always yields
  exit `1`, whether or not the flag is present. The gate never masks a k6
  failure; it only promotes a k6-success run to `1`.

The gate runs last, after the results JSON has been written and the console
summary has been printed, so neither is affected by it. When the flag trips the
gate, SpecWeaver emits a single stderr message naming the flag and the number of
failing checks, e.g.:

```text
error: --fail-on-check-failure: 2 failing checks recorded; exiting with code 1.
```

The flag is **CLI-only**: it has no YAML equivalent. `Config` and its validation
are unchanged, and adding a `failOnCheckFailure: true` key to the YAML config is
still rejected as an unknown field (`` unknown field `failOnCheckFailure` ``),
exiting `2` before k6 runs. There is no negated form and no
`--fail-on-check-failure=true|false` value form.

```sh
specweaver --config samples/specweaver.config.yaml --fail-on-check-failure
```

## Development

```sh
npm run build   # tsc -> dist/
npm test        # build + node --test
```
