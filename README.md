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

> Relative `specs` paths are resolved against the **current working
> directory**, so run the sample from the repository root (where `samples/`
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
| `--help` | Print usage. |
| `--version` | Print the version. |

## Config

Config input is YAML via `--config` only (no JSON/TOML, no config discovery).

```yaml
specs:                      # REQUIRED to execute, local path(s) or list (no URLs)
  - ./openapi.yaml
operations:                 # REQUIRED, non-empty list of { method, path }
  - method: GET
    path: /pets
baseUrl: https://staging.example.com  # OPTIONAL, request base URL; overrides the spec's first servers[].url
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
| `specs` | **yes** | string \| string[] | Local OpenAPI 3.0/3.1 file path(s) to load (JSON or YAML); URLs are **not** fetched. At least one source is required because `operations` is always non-empty; paths resolve against the current working directory. |
| `operations` | **yes** | `{ method, path }[]` | The opt-in operations to test. Must be non-empty; only these are ever run. |
| `baseUrl` | no | string | Request base URL. Overrides the spec's first `servers[].url`. |
| `auth` | no | mapping | Static auth applied to **every** selected operation: `token` (emits `Authorization: Bearer <token>`) and/or `headers` (name → value). Values support `${ENV_VAR}`. |
| `payloads` | no | `{ method, path, body }[]` | Per-operation JSON body overrides, keyed by `method` + `path`. `body` **replaces** the generated body wholesale (no deep merge). Method matching is case-insensitive. Overrides that match no selected operation warn on stderr; any field other than `method`, `path`, or `body` is rejected. |
| `output` | no | string | Results JSON path (see "Results file"). `--out` overrides it. |
| `load` | no | `{ vus, duration }` | Default load profile. `--vus` / `--duration` override it. Defaults to `vus: 1`, `duration: 30s`. |

`${ENV_VAR}` references are resolved from the process environment. An
**unresolved** variable is non-fatal: SpecWeaver prints a warning to **stderr**
prefixed with `warning:` (e.g. `warning: unresolved environment variable "API_KEY"
referenced in \`auth.headers.X-Api-Key\``), continues, and does not change a
successful exit code. One warning is emitted **per unresolved variable**, even
when that variable is referenced from several fields. Warnings are never written
into the results JSON.

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
| `0` | Success — k6 ran and exited `0` (`--help` and `--version` also exit `0`). |
| `1` | k6 run/script failure — k6 ran but exited non-zero (or was terminated by a signal). |
| `2` | SpecWeaver-level error — invalid/missing config, a config with no `specs` or no matching operations (nothing ran), a spec/validation failure, a preflight failure (including "k6 not found"), or an internal error. k6 is not run. |

For an actual run, SpecWeaver exits `0` only when it ran k6 and k6 exited `0`;
any non-zero k6 exit yields a non-zero SpecWeaver exit and is never converted to
success. SLA `thresholds` and pass/fail gating on metrics are out of scope for
v1 — a failing `check` is informational only.

An unexpected **internal** error is reported as a single clean, actionable
message on stderr (never a raw stack trace, and never secret material) and exits
`2`, so it can never be mistaken for a k6 run failure (`1`).

## Development

```sh
npm run build   # tsc -> dist/
npm test        # build + node --test
```
