# Live end-to-end test (real k6)

`e2e/live-e2e.mjs` is the repository's live proof that the shipped pipeline
works against the checked-in [POC API](../examples/poc-api/README.md), not an
in-test mock. It:

1. starts `examples/poc-api/server.js` with `PORT=0` and waits (bounded) for the
   real readiness line plus an HTTP probe of a real route;
2. writes a temporary SpecWeaver config derived from
   `examples/poc-api/specweaver.config.yaml`, with `baseUrl` pointed at the
   ephemeral port, `GET /admin/stats` added, and the token expressed as
   `${POC_API_TOKEN}`;
3. runs the built CLI from the repository root with **real k6 from `PATH`** and
   `--vus 1 --duration 1s --fail-on-check-failure`;
4. asserts the exit code, the results JSON, and the POC server's own request
   log;
5. always stops the server and removes its temp directories.

The file lives outside `test/` and is not named `*.test.*`, so bare
`node --test` / `npm test` never discovers it. It runs only through the
explicit script below.

## Prerequisites

- Node.js 22 or newer.
- Repository dependencies installed from the lockfile:

  ```sh
  npm ci
  ```

- A built CLI. `npm run test:live-e2e` builds it for you (`npm run build`), but a
  standalone `node --test e2e/live-e2e.mjs` expects `dist/cli.js` to exist.
- Real `k6` v2.x on `PATH` (verified with `k6 v2.3.0`). SpecWeaver never
  installs k6. Check with:

  ```sh
  k6 version
  ```

- The committed POC files under `examples/poc-api/` (`server.js`,
  `openapi.yaml`, `specweaver.config.yaml`). Missing POC files always fail.

## Command

From the repository root:

```sh
npm run test:live-e2e
```

This runs `npm run build && node --test e2e/live-e2e.mjs` in isolation. It does
not change `npm test`, which still runs only the normal pre-existing suite.

## Environment variables

| Variable | Effect |
|---|---|
| `CI` | Truthy (GitHub Actions sets `CI=true`) makes k6 mandatory: the local skip opt-out is ignored and a missing k6 fails the run. |
| `SPECWEAVER_REQUIRE_K6` | Truthy local equivalent of `CI` for the k6 prerequisite. |
| `SPECWEAVER_SKIP_LIVE_E2E` | `1`/truthy is the explicit local opt-out: prints a notice and skips (exit 0) **only** when `CI` and `SPECWEAVER_REQUIRE_K6` are both falsy. Missing POC files still fail. |

A missing k6 locally (without the opt-out) fails non-zero with the existing
install hint. There is no silent skip: invoking the live script signals intent.

## What is asserted

- **Prerequisites:** k6 is on `PATH`; `k6 version` matches `/^k6 v\d+\.\d+/`;
  the POC files exist.
- **Readiness:** the POC prints its readiness line, the bound port is `> 0`, and
  a bounded (≤10s) HTTP poll of a real, non-selected route (`/recommendations`)
  succeeds. No fixed sleep is used.
- **Ephemeral port:** the temp config's `baseUrl` is the same
  `http://127.0.0.1:<port>` the server bound, and the server later logs the CLI's
  requests.
- **Temp config:** written under `mkdtemp`, derived from the committed POC
  config, with the port override, `GET /admin/stats`, and a
  `${POC_API_TOKEN}` auth reference.
- **CLI exit:** `0`. Any assertion failure prints the full CLI stdout/stderr,
  the POC stdout/stderr, and the results JSON when it exists.
- **Results JSON:** `tool: "specweaver"`, `config.vus === 1`,
  `config.duration === "1s"`, `outcome === "success"`, `k6ExitCode === 0`, and
  `resultsFile` at the `--out` path.
- **Per-operation checks:** every operation selected by the temp config has a
  `checks["METHOD path"]` entry with `pass >= 1` and `fail === 0`;
  `summary.checks.fail === 0`. Missing/unexpected keys fail with the recorded
  keys in the message.
- **Server cross-check:** `summary.iterations >= 1`; `summary.httpReqs` equals
  the number of requests the POC logged for the CLI run. The only excluded log
  lines are readiness probes against `/recommendations` (never selected by the
  config); there is no other tolerance.
- **POC-observed behavior:** at least one request per selected operation; the
  auth-protected `GET /admin/stats` is logged with `auth: "ok"` and status `200`
  (the POC only does that for the exact configured `Authorization: Bearer`
  header, resolved from `${POC_API_TOKEN}`); `POST /pets` logs the committed
  payload-override body (`name`, `tag`, `age`).
- **Real k6, no stub:** the child `PATH` is exactly `process.env.PATH` (nothing
  prepended); `k6 version` matches real k6; the resolved binary's realpath is
  outside this test's temp/stub directories; and the CLI's `k6 found:` line
  names that same realpath.
- **Cleanup:** on success, assertion failure, or timeout the suite sends
  `SIGTERM`, waits ≤5s, escalates to `SIGKILL`, awaits exit, removes both temp
  directories with `rmSync(..., { recursive: true, force: true })`, and asserts
  the process is gone and the directories no longer exist.

### Evidence limits of the POC request log

The POC request log records `method`, `path`, `status`, `auth`, and write bodies
only (see `examples/poc-api/server.js`). It does **not** record `User-Agent` or
`Content-Type`. Modifying the POC is out of scope (SPEC-27), so:

- real-k6 proof uses the unmodified `PATH`, `k6 version`, the resolved realpath,
  and the CLI's `k6 found:` line instead of a `k6/...` `User-Agent`; and
- the JSON `Content-Type: application/json` is additionally asserted from the
  generated request data (kept with `SPECWEAVER_KEEP_TEMP=1`), while the payload
  override itself is asserted from the server's logged body.

## Expected runtime

About **5–15 seconds** end to end, including `npm run build`; the live test
itself is ~3s on the reference environment. The hard ceiling is **120 seconds**
(`{ timeout: 120_000 }`). Per-phase guards are 10s for readiness, 60s for the
CLI/k6 child, and 5s (+2s `SIGKILL` fallback) for server shutdown; timeout
messages name the hung phase.

## Cleanup

The suite creates two `mkdtemp` directories (config/results and isolated CLI
artifacts) and removes both in a `finally` block. Diagnostics, including the
results JSON when it exists, are captured **before** those directories are
removed, so failure output keeps the evidence. The POC server is stopped with
`SIGTERM` and, if needed, `SIGKILL`. After a run, no POC process, temp
directory, or results file should remain.

## Reproducing a CI failure locally

Run the same prerequisites and steps CI uses:

```sh
node --version        # expect v22.x
k6 version            # expect k6 v2.x
npm ci
npm run build
CI=true npm run test:live-e2e
```

`CI=true` (like GitHub Actions) makes k6 mandatory and ignores
`SPECWEAVER_SKIP_LIVE_E2E`. To reproduce a missing-k6 failure deliberately, run
with a `PATH` that does not contain k6:

```sh
node_bin=$(command -v node)
empty_path=$(mktemp -d)
PATH="$empty_path" CI=true "$node_bin" --test e2e/live-e2e.mjs
rmdir "$empty_path"
```

The test fails with the install hint. Without `CI`/`SPECWEAVER_REQUIRE_K6`,
`SPECWEAVER_SKIP_LIVE_E2E=1` prints an explicit notice and exits 0 instead.
