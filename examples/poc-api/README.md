# POC API for SpecWeaver examples

A small, deterministic, **dependency-free** HTTP API intended for the
repository's SpecWeaver examples and the live end-to-end test. It starts with one
Node command and needs no `npm install` for the POC itself.

> **This is example/test infrastructure, not a production service.** It has no
> persistence (all mutations reset on restart), TLS, rate limiting, auth flows,
> cookie handling, or non-JSON (multipart/form-data) body parsing. Do not deploy
> it. It exists only to give examples and tests a local target.

All commands below are meant to be run **from the repository root**
(`kanban-demo/`).

## Files

| File | Purpose |
|---|---|
| `server.js` | Node 22 built-in `http` server, in-memory seed data, request logging, graceful shutdown. |
| `openapi.yaml` | OpenAPI 3.0.3 document for all nine operations, including the three v1 coverage-gap surfaces. |
| `specweaver.config.yaml` | Canonical happy-path run: explicit operations, static `POC-TOKEN`, `POST /pets` payload override, no `baseUrl`. |
| `specweaver.warnings.config.yaml` | `operations: all` with no auth to demonstrate exactly three coverage warnings. |
| `README.md` | This file. |

## Start the server

```sh
node examples/poc-api/server.js
```

It binds `127.0.0.1:8080` by default and prints one readiness line:

```text
poc-api listening on http://127.0.0.1:8080
```

Override the port (the readiness line prints the actual bound port):

```sh
PORT=9090 node examples/poc-api/server.js
# poc-api listening on http://127.0.0.1:9090

PORT=0 node examples/poc-api/server.js
# poc-api listening on http://127.0.0.1:<ephemeral-port>
```

Invalid, out-of-range, or already-used ports fail fast on stderr with a non-zero
exit, for example:

```text
poc-api: invalid PORT "abc": expected an integer between 0 and 65535 (0 picks a free port).
poc-api: cannot listen on 127.0.0.1:8080 (port already in use): listen EADDRINUSE: address already in use 127.0.0.1:8080
```

Stop it with `Ctrl+C` (SIGINT) or SIGTERM. It prints
`poc-api shutting down` and exits 0 within two seconds.

## Seed data

The store is reset on every start:

- Pets, in insertion order: `1 Fido/dog/3`, `2 Whiskers/cat/2`,
  `3 Bubbles/fish/1`.
- Owners: `1 Alice/alice@example.com/[1,2]`, `2 Bob/bob@example.com/[3]`.
- Created pets get ids from `4` upward.

## Request log

Every request writes **one JSON line** to stdout with `method`, `path`,
`status`, an `auth` value (`ok` or `missing`), and a human-readable `line`
containing `<METHOD> <path> -> <status>`. Write requests also include the body
text/parsed JSON, and `/admin/stats` appends `auth=ok` or `auth=missing` to
`line`. The bearer token value is never logged.

```json
{"method":"GET","path":"/health","status":200,"auth":"missing","line":"GET /health -> 200"}
{"method":"POST","path":"/pets","status":201,"auth":"missing","body":{"name":"Rex","tag":"dog","age":5},"line":"POST /pets -> 201 body={\"name\":\"Rex\",\"tag\":\"dog\",\"age\":5}"}
{"method":"GET","path":"/admin/stats","status":200,"auth":"ok","line":"GET /admin/stats -> 200 auth=ok"}
```

## Endpoint smoke tests

Start the server first, then run these from the repository root:

```sh
# Health: 200 {"status":"ok","service":"poc-api","version":"1.0.0"}
curl -sS http://127.0.0.1:8080/health

# Pets: seeded pets in insertion order; limit 1-100 (default 100), optional tag
curl -sS 'http://127.0.0.1:8080/pets?limit=2&tag=dog'

# Invalid limit: 400 {"error":"invalid_limit"}
curl -sS -i 'http://127.0.0.1:8080/pets?limit=0'

# Create a pet: 201 with a new id; tag defaults to "unknown" when omitted
curl -sS -X POST http://127.0.0.1:8080/pets \
  -H 'Content-Type: application/json' \
  -d '{"name":"Rex","tag":"dog","age":5}'

# Get a pet: 200 Pet, or 404 {"error":"not_found"}
curl -sS http://127.0.0.1:8080/pets/1
curl -sS -i http://127.0.0.1:8080/pets/999

# Owners: 200 Owner array / single Owner, or 404 {"error":"not_found"}
curl -sS http://127.0.0.1:8080/owners
curl -sS http://127.0.0.1:8080/owners/2
curl -sS -i http://127.0.0.1:8080/owners/999

# Admin stats: 401 without the token, 200 with Authorization: Bearer POC-TOKEN
curl -sS -i http://127.0.0.1:8080/admin/stats
curl -sS -H 'Authorization: Bearer POC-TOKEN' http://127.0.0.1:8080/admin/stats

# Recommendations: 200 seed-pet subset; the spec declares an optional cookie,
# but the server does not parse cookies
curl -sS http://127.0.0.1:8080/recommendations

# Photo upload: 202 {"accepted":true,"petId":1}; the server does not parse the
# multipart body. Unknown pets return 404 {"error":"not_found"}.
curl -sS -X POST http://127.0.0.1:8080/pets/1/photo \
  -F 'photo=@/dev/null;filename=photo.png'
curl -sS -i -X POST http://127.0.0.1:8080/pets/999/photo \
  -F 'photo=@/dev/null;filename=photo.png'
```

## SpecWeaver / k6 smoke run

The POC server itself needs no install. The SpecWeaver CLI needs the repository
dependencies and a built `dist/`, plus real `k6` on `PATH`:

```sh
npm install        # once, for the repository (not for the POC)
npm run build      # produces dist/cli.js
k6 version         # confirm real k6 is available
node examples/poc-api/server.js
```

In a second shell (still in the repository root), run the canonical config:

```sh
node dist/cli.js --config examples/poc-api/specweaver.config.yaml --vus 1 --duration 2s
```

It exits `0` and writes `specweaver-results.json` in the repository root by
default (pass `--out <path>` to change it). The config selects the happy-path
operations, sends `Authorization: Bearer POC-TOKEN`, omits `baseUrl` so the
spec's absolute `http://127.0.0.1:8080` server URL is used, and replaces the
`POST /pets` body with `{"name":"PocOverridePet","tag":"override","age":4}`.

## Coverage warnings (expected P3 limitations)

The warnings config selects every operation with no auth. It exits `0` but emits
exactly these three `warning:` lines on stderr (order follows the spec):

```text
warning: operation "GET /admin/stats" declares security but no auth is configured; the request will be sent without authentication.
warning: operation "GET /recommendations" declares cookie parameter(s) "session" that are not generated; the request will be sent without them.
warning: operation "POST /pets/{petId}/photo" requires a request body but declares no JSON media type (declared: "multipart/form-data"); the request will be sent without a body.
```

Run it with:

```sh
node dist/cli.js --config examples/poc-api/specweaver.warnings.config.yaml --vus 1 --duration 2s
```

Because `/admin/stats` is unauthenticated in this run, its response is `401`
while the operation documents `200`, so its informational k6 check fails. That
is expected and intentional: the warning demo must not hide the real outcome.
The run still exits `0` (k6 treats check failures as informational by default).

## Shipped zero-override sample against this server

The POC also implements the routes in `samples/petstore.openapi.json` so the
shipped zero-override sample can run live on port 8080:

```sh
node dist/cli.js --config samples/specweaver.zero-override.yaml --vus 1 --duration 2s
```

That sample derives `http://localhost:8080` from its spec; on the reference
verification environment the direct command passes. If your machine resolves
`localhost` to IPv6 (`::1`) only while the POC listens on IPv4, run the same
sample with an explicit IPv4 `baseUrl` (verified working) instead of editing the
sample:

```sh
cp samples/specweaver.zero-override.yaml /tmp/specweaver-zero-ipv4.yaml
printf '\nbaseUrl: http://127.0.0.1:8080\n' >> /tmp/specweaver-zero-ipv4.yaml
node dist/cli.js --config /tmp/specweaver-zero-ipv4.yaml --vus 1 --duration 2s
```

Both forms run from the repository root. The explicit `baseUrl` only changes the
request origin; it does not add auth, payloads, or any other override.

## Limitations

- In-memory only: created pets disappear on restart; no persistence.
- No TLS, rate limiting, production auth flow, cookie handling, or multipart body
  parsing. The cookie and photo handlers acknowledge requests without reading
  those inputs.
- `GET /admin/stats` checks a single literal bearer token (`POC-TOKEN`) and
  returns `401` with `WWW-Authenticate: Bearer` otherwise.
- This API is not part of the published SpecWeaver package or its supported
  surface; it is checked-in example/test infrastructure.
