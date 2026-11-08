/**
 * Coverage-gap warnings for operations SpecWeaver cannot fully model (SPEC-25).
 *
 * A zero-override run derives payloads, parameters, and auth from the OpenAPI
 * document. Two things are deliberately not modelled in v1, and generation
 * would otherwise omit them silently:
 *
 * 1. **Required unsupported request bodies** — generation now produces a body
 *    for `application/json` (generalizing to any `*json*` media type), plus
 *    the three SPEC-38 media types (`application/x-www-form-urlencoded`,
 *    `multipart/form-data`, `application/xml`). This classifier warns exactly
 *    when a required body declares none of those four, so the request is sent
 *    bodiless, including a required body with an empty or missing `content`
 *    map. Optional unsupported bodies never warn.
 * 2. **Declared security that cannot be satisfied** — auth comes from the
 *    explicit global `auth` plus `securitySchemes`-derived credentials
 *    (SPEC-39). {@link resolveOperationAuth} classifies every scheme the
 *    operation's effective `security` references: unsupported types/locations,
 *    undefined scheme names, and supported-but-unconfigured credentials are
 *    reported warn-only. An operation that no longer needs a warning (its
 *    requirement is satisfied, or it declares no security) stays silent, and an
 *    operation never both warns and receives derived auth.
 *
 * Cookie parameters are generated and sent (SPEC-35), so they are no longer a
 * coverage gap and produce no warning.
 *
 * ## Contract
 *
 * {@link buildCoverageWarnings} is a **pure** builder: it performs no I/O and
 * accesses no process globals. It takes the already-selected operations and
 * their already-resolved per-operation auth, so it is unit-testable in
 * isolation. Messages follow the selected-operation order, and within one
 * operation a fixed kind order: required non-JSON body → resolved-auth
 * warnings. Repeated runs over the same inputs therefore produce identical
 * output.
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
import type { ResolvedOperationAuth } from "./auth.js";
import {
  MULTIPART_MEDIA_TYPE,
  URLENCODED_MEDIA_TYPE,
  XML_MEDIA_TYPE,
  jsonMediaType,
  nonJsonMediaType,
} from "./request-data.js";

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
 * Warn when a required body cannot be generated (A3).
 *
 * Mirrors generation exactly: no JSON media type and none of the three
 * SPEC-38 media types means no generator applies, so the request is sent
 * bodiless.
 */
function requiredUnsupportedBodyWarning(
  operation: OperationEntry,
): string | undefined {
  const body = operation.requestBody;
  if (body === undefined || body.required !== true) {
    return undefined;
  }

  const content = contentMap(body);
  if (content !== undefined) {
    if (jsonMediaType(content) !== undefined) {
      return undefined;
    }
    // SPEC-38: the three non-JSON generators apply whenever their media type
    // is declared, mirroring generateNonJsonBody's fixed match order.
    if (nonJsonMediaType(content) !== undefined) {
      return undefined;
    }
  }

  const declared =
    content === undefined || Object.keys(content).length === 0
      ? "none"
      : Object.keys(content)
          .map((mediaType) => `"${mediaType}"`)
          .join(", ");

  return `operation "${operationLabel(operation)}" requires a request body but declares none of the supported media types — JSON, ${URLENCODED_MEDIA_TYPE}, ${MULTIPART_MEDIA_TYPE}, ${XML_MEDIA_TYPE} (declared: ${declared}); the request will be sent without a body.`;
}

/**
 * Build the deterministic coverage-gap warnings for the selected operations.
 *
 * @param operations The operations selected for this run, in selection order.
 * @param authStates The effective per-operation auth (explicit +
 *   `securitySchemes`-derived, SPEC-39), aligned with `operations` by index.
 *   A missing entry is treated as an empty state.
 * @returns One message per gap per operation, in operation order then fixed kind
 *   order (body → auth). Pure: no I/O, no process access.
 */
export function buildCoverageWarnings(
  operations: readonly OperationEntry[],
  authStates: readonly ResolvedOperationAuth[],
): string[] {
  const warnings: string[] = [];
  operations.forEach((operation, index) => {
    const authState = authStates[index];
    const warningsForOperation = [
      requiredUnsupportedBodyWarning(operation),
      ...(authState === undefined ? [] : authState.warnings),
    ];
    for (const warning of warningsForOperation) {
      if (warning !== undefined) {
        warnings.push(warning);
      }
    }
  });
  return warnings;
}
