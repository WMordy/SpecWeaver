import assert from "node:assert/strict";
import test from "node:test";

import {
  K6_INSTALL_HINT,
  K6_SKIP_REASON,
  isK6Required,
  isTruthyEnvValue,
  k6Requirement,
} from "./support/k6-requirement.js";

// --- CI / override detection ------------------------------------------------

test("CI is required only for truthy values (SPEC-18)", () => {
  const truthy = ["true", "TRUE", "1", "yes", " true "];
  const falsey = [undefined, null, "", "   ", "0", "false", "FALSE", " False "];

  for (const value of truthy) {
    assert.equal(
      isK6Required({ CI: value }),
      true,
      `CI=${JSON.stringify(value)} should require k6`,
    );
  }
  for (const value of falsey) {
    assert.equal(
      isK6Required({ CI: value }),
      false,
      `CI=${JSON.stringify(value)} should not require k6`,
    );
  }
});

test("SPECWEAVER_REQUIRE_K6 enforces the requirement on its own", () => {
  assert.equal(isK6Required({ SPECWEAVER_REQUIRE_K6: "1" }), true);
  assert.equal(
    isK6Required({ CI: "false", SPECWEAVER_REQUIRE_K6: "1" }),
    true,
  );
  assert.equal(isK6Required({ SPECWEAVER_REQUIRE_K6: "0" }), false);
  assert.equal(isK6Required({ SPECWEAVER_REQUIRE_K6: "false" }), false);
  assert.equal(isK6Required({}), false);
});

test("isTruthyEnvValue treats unset, empty, 0, and false as off", () => {
  assert.equal(isTruthyEnvValue(undefined), false);
  assert.equal(isTruthyEnvValue(null), false);
  assert.equal(isTruthyEnvValue(""), false);
  assert.equal(isTruthyEnvValue("0"), false);
  assert.equal(isTruthyEnvValue("false"), false);
  assert.equal(isTruthyEnvValue("TRUE"), true);
  assert.equal(isTruthyEnvValue("1"), true);
});

// --- Decision matrix: available/absent x CI x require ----------------------

test("decision matrix: k6 available always runs (SPEC-18)", () => {
  const ciValues = [undefined, "true", "false", "0"];
  const requireValues = [undefined, "1"];

  for (const CI of ciValues) {
    for (const SPECWEAVER_REQUIRE_K6 of requireValues) {
      const env = { CI, SPECWEAVER_REQUIRE_K6 };
      assert.deepEqual(
        k6Requirement(true, env),
        { action: "run" },
        `available with CI=${JSON.stringify(CI)} require=${JSON.stringify(SPECWEAVER_REQUIRE_K6)}`,
      );
    }
  }
});

test("decision matrix: k6 absent + required fails with an actionable reason", () => {
  const requiredEnvs = [
    { CI: "true" },
    { CI: "TRUE" },
    { CI: "1" },
    { SPECWEAVER_REQUIRE_K6: "1" },
    { CI: "false", SPECWEAVER_REQUIRE_K6: "1" },
    { CI: "0", SPECWEAVER_REQUIRE_K6: "1" },
  ];

  for (const env of requiredEnvs) {
    const decision = k6Requirement(false, env);
    assert.equal(
      decision.action,
      "fail",
      `absent with ${JSON.stringify(env)} should fail`,
    );
    assert.match(decision.reason, /k6 is required/i);
    assert.match(decision.reason, /`k6 version` probe failed/);
    assert.ok(decision.reason.includes(K6_INSTALL_HINT));
    assert.notEqual(decision.reason, K6_SKIP_REASON);
  }
});

test("decision matrix: k6 absent + not required skips with the existing message", () => {
  const optionalEnvs = [
    {},
    { CI: undefined },
    { CI: "false" },
    { CI: "0" },
    { CI: "" },
    { CI: "false", SPECWEAVER_REQUIRE_K6: "0" },
    { CI: "0", SPECWEAVER_REQUIRE_K6: "false" },
  ];

  for (const env of optionalEnvs) {
    assert.deepEqual(
      k6Requirement(false, env),
      { action: "skip", reason: K6_SKIP_REASON },
      `absent with ${JSON.stringify(env)} should skip`,
    );
  }
});

// --- Full cross-product (16 combinations) ----------------------------------

test("decision matrix covers available/absent x CI x require completely", () => {
  const ciValues = [undefined, "true", "false", "0"];
  const requireValues = [undefined, "1"];

  for (const k6Available of [true, false]) {
    for (const CI of ciValues) {
      for (const SPECWEAVER_REQUIRE_K6 of requireValues) {
        const env = { CI, SPECWEAVER_REQUIRE_K6 };
        const decision = k6Requirement(k6Available, env);
        const required =
          isTruthyEnvValue(CI) || isTruthyEnvValue(SPECWEAVER_REQUIRE_K6);
        const expected = k6Available
          ? "run"
          : required
            ? "fail"
            : "skip";

        assert.equal(
          decision.action,
          expected,
          `k6Available=${k6Available} CI=${JSON.stringify(CI)} require=${JSON.stringify(SPECWEAVER_REQUIRE_K6)}`,
        );
      }
    }
  }
});
