#!/usr/bin/env node
/**
 * Dependency-free POC API for SpecWeaver examples and the live end-to-end test.
 *
 * This is example/test infrastructure, not a product surface. It deliberately
 * implements only in-memory, non-production behaviour: no persistence, TLS,
 * rate limiting, auth flows, cookie handling, or non-JSON body parsing.
 *
 * Node 22 built-ins only (no npm install needed to run this file).
 *
 * Usage (from the repository root):
 *   node examples/poc-api/server.js
 *   PORT=9090 node examples/poc-api/server.js
 *   PORT=0 node examples/poc-api/server.js      # ephemeral port
 */
import { createServer } from "node:http";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const TOKEN = "POC-TOKEN";
const MAX_BODY_BYTES = 1024 * 1024;

const SEED_PETS = [
  { id: 1, name: "Fido", tag: "dog", age: 3 },
  { id: 2, name: "Whiskers", tag: "cat", age: 2 },
  { id: 3, name: "Bubbles", tag: "fish", age: 1 },
];

const SEED_OWNERS = [
  { id: 1, name: "Alice", email: "alice@example.com", petIds: [1, 2] },
  { id: 2, name: "Bob", email: "bob@example.com", petIds: [3] },
];

// Mutations are in-memory only and reset on every start.
const pets = SEED_PETS.map((pet) => ({ ...pet }));
const owners = SEED_OWNERS.map((owner) => ({
  ...owner,
  petIds: [...owner.petIds],
}));
let nextPetId = 4;

function fail(message) {
  process.stderr.write(`poc-api: ${message}\n`);
  process.exit(1);
}

function parsePort(raw) {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  if (!/^\d+$/.test(raw)) {
    fail(`invalid PORT "${raw}": expected an integer between 0 and 65535 (0 picks a free port).`);
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    fail(`invalid PORT "${raw}": expected an integer between 0 and 65535 (0 picks a free port).`);
  }
  return port;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function authState(request) {
  return request.headers.authorization === `Bearer ${TOKEN}` ? "ok" : "missing";
}

function logRequest({ method, path, status, auth, body, loggedBody }) {
  const record = {
    method,
    path,
    status,
    auth: auth === "ok" ? "ok" : "missing",
  };

  const lineParts = [`${method} ${path} -> ${status}`];
  if (path === "/admin/stats") {
    lineParts.push(`auth=${record.auth}`);
  }

  if (loggedBody !== undefined) {
    record.body = loggedBody;
    if (method === "POST" && path === "/pets") {
      lineParts.push(`body=${JSON.stringify(loggedBody)}`);
    }
  } else if (body !== undefined && body !== "") {
    record.body = body;
  }

  record.line = lineParts.join(" ");
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function parseId(raw) {
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  return Number(raw);
}

function route(request, pathname, searchParams, rawBody) {
  const method = request.method ?? "GET";

  if (method === "GET" && pathname === "/health") {
    return {
      status: 200,
      body: { status: "ok", service: "poc-api", version: "1.0.0" },
    };
  }

  if (method === "GET" && pathname === "/pets") {
    const limitRaw = searchParams.get("limit");
    let limit = 100;
    if (limitRaw !== null) {
      if (!/^\d+$/.test(limitRaw)) {
        return { status: 400, body: { error: "invalid_limit" } };
      }
      limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return { status: 400, body: { error: "invalid_limit" } };
      }
    }

    const tag = searchParams.get("tag");
    const filtered = tag === null ? pets : pets.filter((pet) => pet.tag === tag);
    return { status: 200, body: filtered.slice(0, limit) };
  }

  if (method === "POST" && pathname === "/pets") {
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return {
        status: 400,
        body: { error: "invalid_json", detail: "request body must be valid JSON" },
        loggedBody: rawBody,
      };
    }

    if (!isPlainObject(payload)) {
      return {
        status: 400,
        body: { error: "invalid_body", detail: "request body must be a JSON object" },
        loggedBody: payload,
      };
    }
    if (typeof payload.name !== "string" || payload.name.trim() === "") {
      return {
        status: 400,
        body: { error: "invalid_body", detail: "name must be a non-empty string" },
        loggedBody: payload,
      };
    }
    if (payload.tag !== undefined && typeof payload.tag !== "string") {
      return {
        status: 400,
        body: { error: "invalid_body", detail: "tag must be a string when provided" },
        loggedBody: payload,
      };
    }
    if (
      payload.age !== undefined &&
      (!Number.isInteger(payload.age) || payload.age < 0 || payload.age > 30)
    ) {
      return {
        status: 400,
        body: { error: "invalid_body", detail: "age must be an integer between 0 and 30" },
        loggedBody: payload,
      };
    }

    const pet = {
      id: nextPetId,
      name: payload.name,
      tag: payload.tag === undefined ? "unknown" : payload.tag,
      age: payload.age,
    };
    if (pet.age === undefined) {
      delete pet.age;
    }
    nextPetId += 1;
    pets.push(pet);
    return { status: 201, body: pet, loggedBody: payload };
  }

  const photoMatch = method === "POST" && pathname.match(/^\/pets\/([^/]+)\/photo$/);
  if (photoMatch) {
    const petId = parseId(photoMatch[1]);
    if (petId === undefined || !pets.some((pet) => pet.id === petId)) {
      return { status: 404, body: { error: "not_found" } };
    }
    return { status: 202, body: { accepted: true, petId } };
  }

  const petMatch = method === "GET" && pathname.match(/^\/pets\/([^/]+)$/);
  if (petMatch) {
    const petId = parseId(petMatch[1]);
    const pet = petId === undefined ? undefined : pets.find((entry) => entry.id === petId);
    if (pet === undefined) {
      return { status: 404, body: { error: "not_found" } };
    }
    return { status: 200, body: pet };
  }

  if (method === "GET" && pathname === "/owners") {
    return { status: 200, body: owners };
  }

  const ownerMatch = method === "GET" && pathname.match(/^\/owners\/([^/]+)$/);
  if (ownerMatch) {
    const ownerId = parseId(ownerMatch[1]);
    const owner = ownerId === undefined ? undefined : owners.find((entry) => entry.id === ownerId);
    if (owner === undefined) {
      return { status: 404, body: { error: "not_found" } };
    }
    return { status: 200, body: owner };
  }

  if (method === "GET" && pathname === "/admin/stats") {
    if (authState(request) !== "ok") {
      return {
        status: 401,
        body: { error: "unauthorized" },
        headers: { "WWW-Authenticate": "Bearer" },
      };
    }
    return {
      status: 200,
      body: {
        pets: pets.length,
        owners: owners.length,
        createdPets: pets.length - SEED_PETS.length,
      },
    };
  }

  if (method === "GET" && pathname === "/recommendations") {
    // The spec declares an optional cookie parameter. This handler deliberately
    // does not parse cookies; it always recommends a deterministic seed subset.
    return { status: 200, body: pets.filter((pet) => pet.id <= 3).slice(0, 2) };
  }

  return { status: 404, body: { error: "not_found" } };
}

const port = parsePort(process.env.PORT);
const server = createServer(async (request, response) => {
  const method = request.method ?? "GET";
  const requestPath = request.url ?? "/";
  let pathname;
  let searchParams;
  try {
    const url = new URL(requestPath, `http://${HOST}`);
    pathname = url.pathname;
    searchParams = url.searchParams;
  } catch {
    sendJson(response, 400, { error: "invalid_request" });
    logRequest({ method, path: requestPath, status: 400, auth: authState(request) });
    return;
  }

  let rawBody;
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    try {
      rawBody = await readBody(request);
    } catch {
      sendJson(response, 413, { error: "body_too_large" });
      logRequest({
        method,
        path: pathname,
        status: 413,
        auth: authState(request),
      });
      return;
    }
  }

  let result;
  try {
    result = route(request, pathname, searchParams, rawBody ?? "");
  } catch {
    result = { status: 500, body: { error: "internal_error" } };
  }

  sendJson(response, result.status, result.body, result.headers);
  logRequest({
    method,
    path: pathname,
    status: result.status,
    auth: authState(request),
    ...(rawBody !== undefined ? { body: rawBody } : {}),
    ...(result.loggedBody !== undefined ? { loggedBody: result.loggedBody } : {}),
  });
});

server.on("error", (error) => {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `poc-api: cannot listen on ${HOST}:${port}${code === "EADDRINUSE" ? " (port already in use)" : ""}: ${reason}\n`,
  );
  process.exit(1);
});

server.listen(port, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  process.stdout.write(`poc-api listening on http://${HOST}:${actualPort}\n`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  process.stdout.write("poc-api shutting down\n");
  // Do not let an idle keep-alive connection delay shutdown past the 2s bound.
  const forceExit = setTimeout(() => process.exit(0), 1500);
  forceExit.unref();
  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
  if (typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
