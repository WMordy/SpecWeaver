/**
 * Coverage-gap warnings for operations SpecWeaver cannot fully model (SPEC-25).
 *
 * A zero-override run derives payloads, parameters, and auth from the OpenAPI
 * document. Two things are deliberately not modelled in v1, and generation
 * would otherwise omit them silently:
 *
 * 1. **Required non-JSON request bodies** — {@link generateRequestBody} only
 *    produces a JSON body (using {@link jsonMediaType}), so a required
 *    `application/xml` or `multipart/form-data` body is dropped. This classifier
 *    warns exactly when generation would return `undefined` for a required
 *    body, including a required body with an empty or missing `content` map.
 *    Optional non-JSON bodies never warn.
 * 2. **Declared security without configured auth** — auth is a single global
 *    static value (SPEC-5). If an operation's effective `security` is non-empty
 *    but the resolved auth headers are empty, no auth will be sent; warn once.
 *    An explicit `security: []` never warns, and any configured credential
 *    (including `token: ""`, which still injects a bearer header) suppresses it.
 *
 * Cookie parameters are generated and sent (SPEC-35), so they are no longer a
 * coverage gap and produce no warning.
 *
 * ## Contract
 *
 * {@link buildCoverageWarnings} is a **pure** builder: it performs no I/O and
 * accesses no process globals. It takes the already-selected operations and the
 * already-resolved auth headers, so it is unit-testable in isolation. Messages
 * follow the selected-operation order, and within one operation a fixed kind
 * order: required non-JSON body → security without auth. Repeated runs over the
 * same inputs therefore produce identical output.
 *
 * This is **warn-and-continue**: a gap never skips an operation, never changes
 * the exit code, and never changes generation. The CLI routes these messages
 * through the existing `writeWarnings` channel (stderr, `warning:` prefix,
 * de-duplicated, never written to the results JSON).
 *
 * ## Selector independence
 *
 * The warnings are properties of the selected operations, so they apply to every
 * run — not just `operations: all`. An explicit-list run reports the same gaps
 * for its selected operations that an `all` run reports for the whole catalog.
 */
import type { OperationEntry, RequestBodyObject } from "./spec.js";
import { jsonMediaType } from "./request-data.js";

/** `METHOD path`, the operation identity used in every coverage message. */
function operationLabel(operation: OperationEntry): string {
  return `${operation.method} ${operation.path}`;
}

/** The operation's request-body `content` map, when it is a real object. */
function contentMap(
  body: RequestBodyObject,
): Record<string, unknown> | undefined {
  const content = body.content;
  return typeof content === "object" && content !== null && !Array.isArray(content)
    ? (content as Record<string, unknown>)
    : undefined;
}

/**
 * Warn when a required body cannot be generated as JSON (A3).
 *
 * Mirrors generation exactly: no JSON media type means
 * `generateRequestBody` returns `undefined`, so the request is sent bodiless.
 */
function requiredNonJsonBodyWarning(
  operation: OperationEntry,
): string | undefined {
  const body = operation.requestBody;
  if (body === undefined || body.required !== true) {
    return undefined;
  }

  const content = contentMap(body);
  if (content !== undefined && jsonMediaType(content) !== undefined) {
    return undefined;
  }

  const declared =
    content === undefined || Object.keys(content).length === 0
      ? "none"
      : Object.keys(content)
          .map((mediaType) => `"${mediaType}"`)
          .join(", ");

  return `operation "${operationLabel(operation)}" requires a request body but declares no JSON media type (declared: ${declared}); the request will be sent without a body.`;
}

/**
 * Warn once when an operation declares security but no auth is configured (A5).
 *
 * `authHeaders` is the result of resolving the run's validated `auth`; empty
 * means no credential would be injected.
 */
function securityWithoutAuthWarning(
  operation: OperationEntry,
  authHeaders: Readonly<Record<string, string>>,
): string | undefined {
  if (
    operation.security.length === 0 ||
    Object.keys(authHeaders).length > 0
  ) {
    return undefined;
  }

  return `operation "${operationLabel(operation)}" declares security but no auth is configured; the request will be sent without authentication.`;
}

/**
 * Build the deterministic coverage-gap warnings for the selected operations.
 *
 * @param operations The operations selected for this run, in selection order.
 * @param authHeaders The headers resolved from the run's validated `auth`
 *   (`resolveAuthHeaders(...).headers`); an empty map means no auth configured.
 * @returns One message per gap per operation, in operation order then fixed kind
 *   order (body → security). Pure: no I/O, no process access.
 */
export function buildCoverageWarnings(
  operations: readonly OperationEntry[],
  authHeaders: Readonly<Record<string, string>>,
): string[] {
  const warnings: string[] = [];
  for (const operation of operations) {
    const warningsForOperation = [
      requiredNonJsonBodyWarning(operation),
      securityWithoutAuthWarning(operation, authHeaders),
    ];
    for (const warning of warningsForOperation) {
      if (warning !== undefined) {
        warnings.push(warning);
      }
    }
  }
  return warnings;
}
