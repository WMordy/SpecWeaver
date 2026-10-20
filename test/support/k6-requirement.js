/**
 * k6 requirement decision helper (SPEC-18).
 *
 * Pure: it never probes PATH or mutates the environment. Callers pass in
 * whether `k6 version` succeeded and an env-like object, and get back one of:
 *
 *   { action: "run" }                     k6 is available; run the test.
 *   { action: "skip", reason }            k6 is absent but optional; skip.
 *   { action: "fail", reason }            k6 is absent but required; fail.
 *
 * k6 is required when either `CI` or `SPECWEAVER_REQUIRE_K6` is truthy.
 * A value is truthy unless it is unset, empty, `0`, or `false`
 * (case-insensitive, surrounding whitespace ignored). GitHub Actions sets
 * `CI=true`, and `SPECWEAVER_REQUIRE_K6=1` is the explicit local override.
 */

/** The skip message used since SPEC-9; kept verbatim for k6-less local runs. */
export const K6_SKIP_REASON =
  "k6 binary not found on PATH; skipping the end-to-end run";

/** Where to get a k6 binary, included in the failure message. */
export const K6_INSTALL_HINT =
  "Install k6 from https://grafana.com/docs/k6/latest/set-up/install-k6/ " +
  "(for example `brew install k6`, `apt install k6`, or a release binary " +
  "from https://github.com/grafana/k6/releases).";

/** True for env values that mean "on" (unset/empty/`0`/`false` are off). */
export function isTruthyEnvValue(value) {
  if (value === undefined || value === null) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/** True when CI or the explicit override makes k6 mandatory. */
export function isK6Required(env = {}) {
  return (
    isTruthyEnvValue(env.CI) || isTruthyEnvValue(env.SPECWEAVER_REQUIRE_K6)
  );
}

/**
 * Map (k6 availability, env) to the action the e2e test should take.
 * Pure by design so the whole decision matrix is unit-testable without
 * touching PATH.
 */
export function k6Requirement(k6Available, env = {}) {
  if (k6Available) {
    return { action: "run" };
  }
  if (isK6Required(env)) {
    return {
      action: "fail",
      reason:
        "k6 is required in this environment (CI is truthy or " +
        "SPECWEAVER_REQUIRE_K6=1), but the `k6 version` probe failed: the " +
        `k6 binary is not on PATH. ${K6_INSTALL_HINT}`,
    };
  }
  return { action: "skip", reason: K6_SKIP_REASON };
}
