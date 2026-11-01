# SpecWeaver examples gallery

Every example below is runnable **from the repository root** against the
checked-in [POC API](poc-api/README.md). The gallery teaches only behaviour that
is shipped in this repository; deferred capabilities are listed at the end and
are not demonstrated here.

## Prerequisites

Common to every example:

- Node.js 22 or newer and repository dependencies installed (`npm install`).
- A built CLI: `npm run build` (produces `dist/cli.js`).
- Real `k6` v2.x on `PATH` (verified with `k6 v2.3.0`). SpecWeaver never installs
  k6 and exits `2` if it is missing.
- The POC API running in another shell:

  ```sh
  node examples/poc-api/server.js
  # readiness line (stdout):
  # poc-api listening on http://127.0.0.1:8080
  ```

  Override the port with `PORT=9090 node examples/poc-api/server.js`; then pass an
  explicit `baseUrl` in a copy of the config. Stop it with `Ctrl+C`; it prints
  `poc-api shutting down` and exits `0`.

`--vus 1 --duration 2s` keeps every example short. Each example writes its
results JSON under `/tmp/specweaver-examples/`, so runs never dirty the
repository. The `pass`/`fail` counts in the expected stdout blocks are typical
for this load profile: exact counts depend on how many iterations complete in two
seconds. Clean all generated files with:

```sh
rm -rf /tmp/specweaver-examples
```

The POC server is example/test infrastructure, not a supported product surface.
See [its README](poc-api/README.md) for routes, seed data, and the request log.

## Index

| Example | Config / spec path | Teaches | Prerequisites |
|---|---|---|---|
| [Zero-override `operations: all`](#zero-override-operations-all) | [`samples/specweaver.zero-override.yaml`](../samples/specweaver.zero-override.yaml) (reused) | `operations: all`, derived payloads and base URL, no auth | Common |
| [Explicit operations + auth + payload](#explicit-operations--global-auth--payload-override) | [`samples/specweaver.config.yaml`](../samples/specweaver.config.yaml) (reused) | explicit `{method, path}` list, global token and headers, whole-body payload replacement | Common |
| [Auth from environment variables](#auth-from-environment-variables) | [`configs/auth.from-env.yaml`](configs/auth.from-env.yaml) (new) | `${ENV_VAR}`-only global auth, unresolved-variable warning | Common + `POC_API_TOKEN`, `POC_API_CLIENT` (set run only) |
| [Multi-spec + explicit `baseUrl`](#multi-spec--explicit-baseurl) | [`configs/multi-spec.baseurl.yaml`](configs/multi-spec.baseurl.yaml) + [`specs/second-resource.openapi.yaml`](specs/second-resource.openapi.yaml) (new) | loading two local specs, selecting operations from both, explicit `baseUrl` | Common |
| [Coverage warnings](#coverage-warnings) | [`poc-api/specweaver.warnings.config.yaml`](poc-api/specweaver.warnings.config.yaml) (SPEC-27, reused) | both non-fatal coverage warnings | Common |
| [POC canonical run](#poc-canonical-run) | [`poc-api/specweaver.config.yaml`](poc-api/specweaver.config.yaml) + [`poc-api/openapi.yaml`](poc-api/openapi.yaml) (SPEC-27, reused) | live target, explicit operations, token, payload override, request logging | Common |

## Zero-override `operations: all`

- **Path:** [`samples/specweaver.zero-override.yaml`](../samples/specweaver.zero-override.yaml)
  with [`samples/petstore.openapi.json`](../samples/petstore.openapi.json). Both
  are reused unchanged; this gallery does not copy them.
- **Teaches:** `operations: all` expands to every catalogued operation (three
  here), payloads and the base URL are derived from the OpenAPI document, and no
  auth is configured or derived.
- **Prerequisites:** common prerequisites and a running POC API.
- **Command (repository root):**

  ```sh
  node dist/cli.js --config samples/specweaver.zero-override.yaml \
    --vus 1 --duration 2s --out /tmp/specweaver-examples/zero-override.json
  ```

- **Expected stdout (typical; k6 streams its normal output between
  `Resolved specs:` and `SpecWeaver run summary`):**

  ```text
  Loaded config: operations = all, 1 spec source(s).
  Load profile: 1 virtual user(s) for 2s.
  Resolved specs: 3 operation(s) in the catalog.
  ...
  SpecWeaver run summary
  Outcome: success
  k6 exit code: 0
  Load: 1 virtual user(s) for 2s
  Checks (per operation):
    GET /pets          pass 2  fail 0
    POST /pets         pass 2  fail 0
    GET /pets/{petId}  pass 2  fail 0
  Checks total: 6 passed, 0 failed (100.0%)
  ```

- **Expected stderr:** none (`warning:` lines are not expected).
- **Expected exit code:** `0`.
- **Results path:** `/tmp/specweaver-examples/zero-override.json`.
- **Cleanup:** `rm -rf /tmp/specweaver-examples`.

The sample derives `http://localhost:8080`. If `localhost` resolves only to
IPv6 on your machine, use the documented copy-with-`baseUrl` workaround in the
[POC README](poc-api/README.md#shipped-zero-override-sample-against-this-server);
do not edit the sample.

## Explicit operations + global auth + payload override

- **Path:** [`samples/specweaver.config.yaml`](../samples/specweaver.config.yaml)
  with [`samples/petstore.openapi.json`](../samples/petstore.openapi.json). Both
  are reused unchanged.
- **Teaches:** an explicit `{method, path}` operation list, a global static bearer
  `token` plus a static `headers` entry, and a `payloads` entry that replaces the
  whole `POST /pets` JSON body (not a deep merge).
- **Prerequisites:** common prerequisites and a running POC API.
- **Command (repository root):**

  ```sh
  node dist/cli.js --config samples/specweaver.config.yaml \
    --vus 1 --duration 2s --out /tmp/specweaver-examples/explicit-auth-payload.json
  ```

- **Expected stdout (typical):**

  ```text
  Loaded config: 3 operation(s), 1 spec source(s).
  Load profile: 1 virtual user(s) for 2s.
  Resolved specs: 3 operation(s) in the catalog.
  ...
  SpecWeaver run summary
  Outcome: success
  k6 exit code: 0
  Load: 1 virtual user(s) for 2s
  Checks (per operation):
    GET /pets          pass 2  fail 0
    POST /pets         pass 2  fail 0
    GET /pets/{petId}  pass 2  fail 0
  Checks total: 6 passed, 0 failed (100.0%)
  ```

- **Expected stderr:** none.
- **Expected exit code:** `0`.
- **Expected side effect:** the POC server log shows the override applied, e.g.
  `POST /pets -> 201 body={"name":"SampleOverridePet","tag":"override"}`.
- **Results path:** `/tmp/specweaver-examples/explicit-auth-payload.json`.
- **Cleanup:** `rm -rf /tmp/specweaver-examples`.

The petstore spec derives `http://localhost:8080`, so the same IPv6-only
`localhost` caveat applies here: if `localhost` resolves only to IPv6, use the
copy-with-`baseUrl` workaround in the
[POC README](poc-api/README.md#shipped-zero-override-sample-against-this-server);
do not edit the sample.

## Auth from environment variables

- **Path:** [`configs/auth.from-env.yaml`](configs/auth.from-env.yaml) with
  [`poc-api/openapi.yaml`](poc-api/openapi.yaml).
- **Teaches:** global auth whose token and custom header values are **only**
  `${ENV_VAR}` references. No literal secret appears in the config. Unresolved
  references warn and are left literal; they never fail the run.
- **Prerequisites:** common prerequisites and a running POC API.
- **Variables:**
  - `POC_API_TOKEN` — bearer token. The POC API requires `POC-TOKEN` for
    `GET /admin/stats`.
  - `POC_API_CLIENT` — value for the `X-Client` header. The config declares a
    global static header, but the POC API ignores and does not log that header,
    so this example does **not** independently assert that it reached the
    server. Any non-empty value is fine.
- **Command with variables set (repository root):**

  ```sh
  POC_API_TOKEN=POC-TOKEN POC_API_CLIENT=examples \
    node dist/cli.js --config examples/configs/auth.from-env.yaml \
    --vus 1 --duration 2s --out /tmp/specweaver-examples/auth-from-env.json
  ```

- **Expected stdout (set run, typical):**

  ```text
  Loaded config: 3 operation(s), 1 spec source(s).
  Load profile: 1 virtual user(s) for 2s.
  Resolved specs: 9 operation(s) in the catalog.
  ...
  SpecWeaver run summary
  Outcome: success
  k6 exit code: 0
  Load: 1 virtual user(s) for 2s
  Checks (per operation):
    GET /health       pass 2  fail 0
    GET /owners       pass 2  fail 0
    GET /admin/stats  pass 2  fail 0
  Checks total: 6 passed, 0 failed (100.0%)
  ```

- **Expected stderr (set run):** none.
- **Expected exit code (set run):** `0`.
- **Results path (set run):** `/tmp/specweaver-examples/auth-from-env.json`.
- **Command with variables unset (repository root):**

  ```sh
  env -u POC_API_TOKEN -u POC_API_CLIENT \
    node dist/cli.js --config examples/configs/auth.from-env.yaml \
    --vus 1 --duration 2s --out /tmp/specweaver-examples/auth-from-env.unresolved.json
  ```

- **Expected stderr (unset run), exact lines:**

  ```text
  warning: unresolved environment variable "POC_API_TOKEN" referenced in `auth.token`
  warning: unresolved environment variable "POC_API_CLIENT" referenced in `auth.headers.X-Client`
  ```

  The warnings are non-fatal and are not written into the results JSON. The
  placeholder text is sent literally, so `GET /admin/stats` returns `401` and its
  documented-`200` check fails:

  ```text
    GET /admin/stats  pass 0  fail 2
  Checks total: 4 passed, 2 failed (66.7%)
  ```

- **Expected exit code (unset run):** `0`.
- **Results path (unset run):**
  `/tmp/specweaver-examples/auth-from-env.unresolved.json`.
- **Cleanup:** `rm -rf /tmp/specweaver-examples`.

## Multi-spec + explicit `baseUrl`

- **Path:** [`configs/multi-spec.baseurl.yaml`](configs/multi-spec.baseurl.yaml)
  with [`samples/petstore.openapi.json`](../samples/petstore.openapi.json) and
  the new [`specs/second-resource.openapi.yaml`](specs/second-resource.openapi.yaml).
- **Teaches:** loading multiple local specs in one run and selecting operations
  from both (petstore `/pets` plus owners `/owners`), with an explicit
  `baseUrl: http://127.0.0.1:8080` that overrides the specs' own `servers[].url`.
- **Prerequisites:** common prerequisites and a running POC API.
- **Command (repository root):**

  ```sh
  node dist/cli.js --config examples/configs/multi-spec.baseurl.yaml \
    --vus 1 --duration 2s --out /tmp/specweaver-examples/multi-spec.baseurl.json
  ```

- **Expected stdout (typical):**

  ```text
  Loaded config: 4 operation(s), 2 spec source(s).
  Load profile: 1 virtual user(s) for 2s.
  Resolved specs: 5 operation(s) in the catalog.
  ...
  SpecWeaver run summary
  Outcome: success
  k6 exit code: 0
  Load: 1 virtual user(s) for 2s
  Checks (per operation):
    GET /pets              pass 2  fail 0
    POST /pets             pass 2  fail 0
    GET /owners            pass 2  fail 0
    GET /owners/{ownerId}  pass 2  fail 0
  Checks total: 8 passed, 0 failed (100.0%)
  ```

- **Expected stderr:** none.
- **Expected exit code:** `0`.
- **Results path:** `/tmp/specweaver-examples/multi-spec.baseurl.json`.
- **Results check:** the JSON `checks` object contains operations from both
  specs, including `"GET /pets"` (petstore) and `"GET /owners"` /
  `"GET /owners/{ownerId}"` (second resource).
- **Cleanup:** `rm -rf /tmp/specweaver-examples`.

## Coverage warnings

- **Path:** [`poc-api/specweaver.warnings.config.yaml`](poc-api/specweaver.warnings.config.yaml)
  with [`poc-api/openapi.yaml`](poc-api/openapi.yaml). This is SPEC-27's config,
  reused and linked, not copied.
- **Teaches:** the remaining non-fatal v1 coverage warnings. `operations: all`
  with no auth selects every operation, including the deliberate gap surfaces
  (unauthenticated `GET /admin/stats` and the required multipart
  `POST /pets/{petId}/photo`). `GET /recommendations` declares a cookie
  parameter; it is generated and sent, so it produces no warning.
- **Prerequisites:** common prerequisites and a running POC API.
- **Command (repository root):**

  ```sh
  node dist/cli.js --config examples/poc-api/specweaver.warnings.config.yaml \
    --vus 1 --duration 2s --out /tmp/specweaver-examples/warnings.json
  ```

- **Expected stderr, exactly two lines in this order:**

  ```text
  warning: operation "GET /admin/stats" declares security but no auth is configured; the request will be sent without authentication.
  warning: operation "POST /pets/{petId}/photo" requires a request body but declares no JSON media type (declared: "multipart/form-data"); the request will be sent without a body.
  ```

- **Expected stdout (key lines, typical):**

  ```text
  Loaded config: operations = all, 1 spec source(s).
  Load profile: 1 virtual user(s) for 2s.
  Resolved specs: 9 operation(s) in the catalog.
  ...
  SpecWeaver run summary
  Outcome: success
  k6 exit code: 0
  Load: 1 virtual user(s) for 2s
  Checks (per operation):
    GET /health               pass 2  fail 0
    ...
    GET /admin/stats          pass 0  fail 2
    ...
  Checks total: 16 passed, 2 failed (88.9%)
  ```

  The `GET /admin/stats` failure is expected: it is sent unauthenticated and the
  POC returns `401` while the operation documents `200`. The warning demo does
  not hide that real outcome.
- **Expected exit code:** `0` (check failures are informational unless
  `--fail-on-check-failure` is passed).
- **Results path:** `/tmp/specweaver-examples/warnings.json`.
- **Cleanup:** `rm -rf /tmp/specweaver-examples`.

## POC canonical run

- **Path:** [`poc-api/specweaver.config.yaml`](poc-api/specweaver.config.yaml)
  with [`poc-api/openapi.yaml`](poc-api/openapi.yaml), against
  [`poc-api/server.js`](poc-api/server.js). Delivered by SPEC-27 and reused here.
- **Teaches:** the canonical happy-path config for the live POC target: explicit
  operations, a literal placeholder token (`POC-TOKEN`, not a real secret), and a
  `POST /pets` payload override. The POC's JSON request log shows what was sent.
- **Prerequisites:** common prerequisites and a running POC API.
- **Command (repository root):**

  ```sh
  node dist/cli.js --config examples/poc-api/specweaver.config.yaml \
    --vus 1 --duration 2s --out /tmp/specweaver-examples/poc-canonical.json
  ```

- **Expected stdout (typical):**

  ```text
  Loaded config: 6 operation(s), 1 spec source(s).
  Load profile: 1 virtual user(s) for 2s.
  Resolved specs: 9 operation(s) in the catalog.
  ...
  SpecWeaver run summary
  Outcome: success
  k6 exit code: 0
  Load: 1 virtual user(s) for 2s
  Checks (per operation):
    GET /health            pass 2  fail 0
    GET /pets              pass 2  fail 0
    POST /pets             pass 2  fail 0
    GET /pets/{petId}      pass 2  fail 0
    GET /owners            pass 2  fail 0
    GET /owners/{ownerId}  pass 2  fail 0
  Checks total: 12 passed, 0 failed (100.0%)
  ```

- **Expected stderr:** none.
- **Expected exit code:** `0`.
- **Results path:** `/tmp/specweaver-examples/poc-canonical.json`.
- **Cleanup:** `rm -rf /tmp/specweaver-examples`.

## Feature-to-example map

Every shipped feature has at least one runnable example.

| Shipped feature | Example |
|---|---|
| Zero-override `operations: all` | [Zero-override](#zero-override-operations-all) |
| Derived request payloads | [Zero-override](#zero-override-operations-all) |
| Derived base URL from `servers[].url` | [Zero-override](#zero-override-operations-all) |
| Explicit `{method, path}` operation list | [Explicit operations + auth + payload](#explicit-operations--global-auth--payload-override), [Auth from env](#auth-from-environment-variables), [Multi-spec](#multi-spec--explicit-baseurl) |
| Global static bearer token | [Explicit operations + auth + payload](#explicit-operations--global-auth--payload-override), [Auth from env](#auth-from-environment-variables) |
| Global static headers | [Explicit operations + auth + payload](#explicit-operations--global-auth--payload-override), [Auth from env](#auth-from-environment-variables) |
| Whole-body `payloads` override | [Explicit operations + auth + payload](#explicit-operations--global-auth--payload-override) |
| Multiple local `specs` | [Multi-spec + explicit `baseUrl`](#multi-spec--explicit-baseurl) |
| Explicit `baseUrl` | [Multi-spec + explicit `baseUrl`](#multi-spec--explicit-baseurl) |
| Generated `Cookie` header from cookie parameters | [Zero-override](#zero-override-operations-all), [Coverage warnings](#coverage-warnings) |
| Warning: security without configured auth | [Coverage warnings](#coverage-warnings) |
| Warning: required non-JSON body not generated | [Coverage warnings](#coverage-warnings) |
| Machine-readable results file with per-operation checks | All examples (paths above) |
| CI / command usage | [CI and command snippet](#ci-and-command-snippet) |

## CI and command snippet

This snippet is copy-pasteable from the repository root. It builds, starts the
POC API, runs one example with real k6, fails on any failed check, asserts the
results JSON, and always cleans up its server, logs, and temp files. The
repository's own workflow, [`.github/workflows/ci.yml`](../.github/workflows/ci.yml),
runs the dedicated live e2e as a separate step after `npm test`; this snippet is
the copy-pasteable equivalent for other CI systems.

```sh
set -euo pipefail

npm ci
npm run build

tmp_dir=$(mktemp -d)
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

PORT=8080 node examples/poc-api/server.js >"$tmp_dir/poc-api.log" 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 50); do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    wait "$server_pid" 2>/dev/null || true
    echo "error: POC API exited before becoming ready" >&2
    cat "$tmp_dir/poc-api.log" >&2
    exit 1
  fi
  if grep -q "poc-api listening on http://127.0.0.1:8080" "$tmp_dir/poc-api.log"; then
    ready=1
    break
  fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  echo "error: POC API did not become ready on 127.0.0.1:8080" >&2
  cat "$tmp_dir/poc-api.log" >&2
  exit 1
fi

node dist/cli.js --config examples/configs/multi-spec.baseurl.yaml \
  --vus 1 --duration 2s --fail-on-check-failure \
  --out "$tmp_dir/results.json"

node - "$tmp_dir/results.json" <<'NODE'
const fs = require("node:fs");
const resultsPath = process.argv[2];
const r = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
if (r.outcome !== "success" || r.k6ExitCode !== 0) {
  throw new Error(`run did not succeed: outcome=${r.outcome} k6ExitCode=${r.k6ExitCode}`);
}
const ops = Object.keys(r.checks);
if (!ops.includes("GET /pets") || !ops.includes("GET /owners")) {
  throw new Error("missing multi-spec operations: " + ops.join(", "));
}
const failing = Object.entries(r.checks).filter(([, counts]) => counts.fail !== 0);
if (r.summary.checks.fail !== 0 || failing.length > 0) {
  throw new Error("checks failed: " + JSON.stringify({ summary: r.summary.checks, failing }));
}
console.log("results check passed:", ops.join(", "));
NODE
```

## Shipped vs deferred

Shipped and demonstrated here: `operations: all`, explicit operation lists,
global static token/headers auth with `${ENV_VAR}` resolution, whole-body payload
overrides, multiple local specs, explicit `baseUrl`, cookie parameter generation
(the POC spec's optional `session` cookie is generated and sent), the remaining
non-fatal coverage warnings, and the results JSON. The README also documents the
shipped `operationId`, `tags`, and path-pattern selector entries; the gallery
keeps its examples on explicit lists.

Deferred and **not** demonstrated or claimed: tolerant/fuzzy method/path
matching, non-JSON (multipart/form-data, form-urlencoded, XML) body generation,
`securitySchemes`-derived auth, per-operation auth, and remote `http(s)` specs.

See the roadmap for the authoritative limitations:

- [`ROADMAP.md` P2 outcome](../ROADMAP.md#p2-outcome)
- [`ROADMAP.md` P2 limitations](../ROADMAP.md#p2-limitations)
- [`ROADMAP.md` P3 limitations / non-goals](../ROADMAP.md#p3-limitations--non-goals)

The existing samples remain the canonical minimal configs:
[`samples/specweaver.zero-override.yaml`](../samples/specweaver.zero-override.yaml)
and [`samples/specweaver.config.yaml`](../samples/specweaver.config.yaml).
