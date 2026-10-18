import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "../dist/args.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
}

test("built CLI --help exits 0 and lists the core flags", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  for (const flag of ["--config", "--vus", "--duration", "--out"]) {
    assert.ok(result.stdout.includes(flag), `usage should list ${flag}`);
  }
});

test("built CLI --version exits 0 and prints the package version", () => {
  const result = runCli(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test("built CLI with no arguments exits non-zero and prints usage", () => {
  const result = runCli([]);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("Usage:"));
});

test("built CLI with an unknown flag exits non-zero", () => {
  const result = runCli(["--nope"]);
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("--nope"));
});

test("parseArgs produces a structured options object", () => {
  const options = parseArgs([
    "--config",
    "specweaver.yaml",
    "--vus",
    "10",
    "--duration",
    "1m30s",
    "--out",
    "results.json",
  ]);
  assert.deepEqual(options, {
    config: "specweaver.yaml",
    vus: 10,
    duration: "1m30s",
    out: "results.json",
    help: false,
    version: false,
  });
});

test("parseArgs rejects a non-positive-integer --vus", () => {
  assert.throws(() => parseArgs(["--vus", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--vus", "abc"]), /positive integer/);
});

test("parseArgs rejects a malformed --duration", () => {
  assert.throws(() => parseArgs(["--duration", "soon"]), /duration/);
});
