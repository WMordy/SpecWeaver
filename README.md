# SpecWeaver

Turn OpenAPI definitions plus a YAML config into [k6](https://k6.io) load tests.

SpecWeaver is a locally-installed TypeScript/Node CLI. You point it at a YAML
file (OpenAPI source(s), the operations to test, auth, payload overrides) and it
generates a dependency-free k6 script, runs it, and reports the results — no
further setup.

## Requirements

- Node.js >= 18
- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) installed and on
  your `PATH`. SpecWeaver never installs k6 for you; if it cannot find the
  binary it exits with a clear error.

## Install

```sh
npm install
npm run build
npm install -g .
# then:
specweaver --config specweaver.yaml
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
specs:                      # OPTIONAL, string or list of strings
  - ./openapi.yaml
operations:                 # REQUIRED, non-empty list of { method, path }
  - method: GET
    path: /pets
auth:                       # OPTIONAL, static token/headers (env-referenceable)
  token: "${API_TOKEN}"
  headers:
    X-Api-Key: "${API_KEY}"
payloads:                   # OPTIONAL, per-operation payload overrides
  - method: POST
    path: /pets
    body: { name: "Fido" }
output: results.json        # OPTIONAL, results JSON path (see "Results file")
load:                       # OPTIONAL, default vus/duration
  vus: 10
  duration: 30s
```

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
never name the generated k6 script/data, which live in `os.tmpdir()`.

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
| `0` | Success — k6 exited `0`. |
| `1` | k6 run/script failure — k6 ran but exited non-zero (or was terminated by a signal). |
| `2` | SpecWeaver-level error — invalid/missing config, a spec/validation failure, a preflight failure (including "k6 not found"), or an internal error. k6 is not run. |

SpecWeaver exits `0` only when k6 exited `0`; any non-zero k6 exit yields a
non-zero SpecWeaver exit and is never converted to success. SLA `thresholds` and
pass/fail gating on metrics are out of scope for v1 — a failing `check` is
informational only.

An unexpected **internal** error is reported as a single clean, actionable
message on stderr (never a raw stack trace, and never secret material) and exits
`2`, so it can never be mistaken for a k6 run failure (`1`).

## Development

```sh
npm run build   # tsc -> dist/
npm test        # build + node --test
```
