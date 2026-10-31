/**
 * Operation selection against the loaded spec catalog (SPEC-23, SPEC-36).
 *
 * `operations: all` selects the whole catalog exactly as SPEC-23 shipped it:
 * every operation from every configured spec, in spec order and within each
 * spec in the deterministic catalog order (document path order, then canonical
 * method order). Cross-spec duplicates on normalized `METHOD path` keep their
 * first occurrence and report each skipped duplicate, so nothing is dropped
 * silently.
 *
 * A config list selects with one entry per selector form (SPEC-36):
 *
 * - `{ method, path }` — exact match on normalized `METHOD path`; the first
 *   catalog occurrence across specs wins when a spec defines it twice.
 * - `{ path }` — wildcard-free values match the exact path with any method;
 *   values containing `*` are path patterns (`*` = one non-empty segment within
 *   a path, `**` = any characters, including `/`). An optional validated
 *   `method` restricts the match.
 * - `{ operationId }` — exact, case-sensitive match; every catalogued operation
 *   with that id is selected, with duplicates on the same `METHOD path` keeping
 *   the first occurrence.
 * - `{ tags }` — OR semantics over the operation's declared tags.
 *
 * Operation-id, tag, and pattern entries expand against the catalog in
 * deterministic catalog order. The final list is the union in config-entry
 * order, deduplicated on `METHOD path` keeping the first occurrence, so
 * overlapping selectors never duplicate an operation and repeated runs over
 * identical inputs produce identical output.
 */
import type { OperationConfig, OperationsSelector } from "./config.js";
import type { LoadedSpec, OperationEntry } from "./spec.js";

/** Regex metacharacters escaped before glob tokens are rewritten. */
const REGEX_SPECIAL = /[.+?^${}()|[\]\\]/g;

/** Placeholder protecting `**` while single `*` are rewritten. */
const GLOB_ANY = "\u0000any";

/**
 * Build the matcher for a `path` selector value: a catalog-order filter over
 * exact paths (wildcard-free) or a compiled pattern (`*` = one non-empty
 * segment, `**` = any characters, including `/`).
 */
function compilePathSelector(pattern: string): (path: string) => boolean {
  if (!pattern.includes("*")) {
    return (path) => path === pattern;
  }
  const source = pattern
    .replace(REGEX_SPECIAL, "\\$&")
    .replaceAll("**", GLOB_ANY)
    .replaceAll("*", "[^/]+")
    .replaceAll(GLOB_ANY, ".*");
  const expression = new RegExp(`^${source}$`);
  return (path) => expression.test(path);
}

/** Describe one configured selector entry for unmatched/no-run diagnostics. */
function describeSelector(entry: OperationConfig): string {
  if (typeof entry.operationId === "string") {
    return `operationId "${entry.operationId}"`;
  }
  if (entry.tags !== undefined) {
    return `tags [${entry.tags.map((tag) => `"${tag}"`).join(", ")}]`;
  }
  const prefix = entry.method === undefined ? "" : `${entry.method} `;
  if (entry.path !== undefined && entry.path.includes("*")) {
    return `${prefix}path pattern "${entry.path}"`;
  }
  if (entry.method === undefined) {
    return `path "${entry.path}"`;
  }
  return `${prefix}${entry.path}`;
}

/** One configured selector entry that matched no catalogued operation. */
export interface UnmatchedSelector {
  /** Human-readable selector description for diagnostics. */
  label: string;
  /** `true` for a legacy explicit `{ method, path }` entry (exact wording kept). */
  explicit: boolean;
}

/** The result of resolving the configured operation selector against the catalog. */
export interface OperationSelection {
  /** Operations present in the catalog; the ones that will be executed. */
  selected: OperationEntry[];
  /** Configured selectors absent from the catalog, in config order. */
  unmatched: UnmatchedSelector[];
  /** Non-fatal notices for cross-spec duplicates collapsed by `"all"`. */
  duplicateWarnings: string[];
}

/**
 * Select operations from the loaded spec catalog (SPEC-23, SPEC-36).
 *
 * The literal `"all"` selects the whole catalog; every other entry expands
 * against it per its selector form. Entries with no catalog match are returned
 * in `unmatched` so the caller can warn (partial match) or fail (no match at
 * all) without losing the list.
 */
export function selectOperations(
  operations: OperationsSelector,
  specs: readonly LoadedSpec[],
): OperationSelection {
  if (operations === "all") {
    const selected: OperationEntry[] = [];
    const duplicateWarnings: string[] = [];
    // Key -> the source of the first occurrence, for duplicate diagnostics.
    const firstSource = new Map<string, string>();
    for (const spec of specs) {
      for (const operation of spec.operations) {
        const key = `${operation.method} ${operation.path}`;
        const keptSource = firstSource.get(key);
        if (keptSource !== undefined) {
          duplicateWarnings.push(
            `operation "${key}" is defined in both "${keptSource}" and "${spec.source}"; keeping the first occurrence and skipping the duplicate.`,
          );
          continue;
        }
        firstSource.set(key, spec.source);
        selected.push(operation);
      }
    }
    return { selected, unmatched: [], duplicateWarnings };
  }

  // Catalog membership in deterministic order, plus the `METHOD path` map used
  // by explicit entries. The first occurrence across specs wins, matching the
  // `all` duplicate rule.
  const catalog: OperationEntry[] = [];
  const catalogMap = new Map<string, OperationEntry>();
  for (const spec of specs) {
    for (const operation of spec.operations) {
      catalog.push(operation);
      const key = `${operation.method} ${operation.path}`;
      if (!catalogMap.has(key)) {
        catalogMap.set(key, operation);
      }
    }
  }

  const selected: OperationEntry[] = [];
  const unmatched: UnmatchedSelector[] = [];
  const admitted = new Set<string>();

  const admit = (operation: OperationEntry): void => {
    const key = `${operation.method} ${operation.path}`;
    if (admitted.has(key)) {
      return;
    }
    admitted.add(key);
    selected.push(operation);
  };

  const recordUnmatched = (entry: OperationConfig, explicit: boolean): void => {
    unmatched.push({ label: describeSelector(entry), explicit });
  };

  for (const entry of operations) {
    if (typeof entry.operationId === "string") {
      const wanted = entry.operationId;
      let matched = false;
      for (const operation of catalog) {
        if (operation.operationId !== wanted) {
          continue;
        }
        // Every distinct operation sharing the id is selected; `admit` keeps the
        // first occurrence for duplicates on the same METHOD path.
        admit(operation);
        matched = true;
      }
      if (!matched) {
        recordUnmatched(entry, false);
      }
      continue;
    }

    if (entry.tags !== undefined) {
      const wanted = new Set(entry.tags);
      let matched = false;
      for (const operation of catalog) {
        const tags = operation.tags ?? [];
        if (tags.some((tag) => wanted.has(tag))) {
          admit(operation);
          matched = true;
        }
      }
      if (!matched) {
        recordUnmatched(entry, false);
      }
      continue;
    }

    if (typeof entry.path !== "string") {
      // Unreachable for a validated config; recorded as unmatched rather than
      // throwing so a selector bug can never crash the run.
      recordUnmatched(entry, false);
      continue;
    }

    const isPattern = entry.path.includes("*");
    if (entry.method !== undefined && !isPattern) {
      // Legacy explicit form: exact `METHOD path` via the catalog map.
      const operation = catalogMap.get(`${entry.method} ${entry.path}`);
      if (operation === undefined) {
        recordUnmatched(entry, true);
      } else {
        admit(operation);
      }
      continue;
    }

    const matchPath = isPattern
      ? compilePathSelector(entry.path)
      : (path: string) => path === entry.path;
    let matched = false;
    for (const operation of catalog) {
      if (entry.method !== undefined && operation.method !== entry.method) {
        continue;
      }
      if (matchPath(operation.path)) {
        admit(operation);
        matched = true;
      }
    }
    if (!matched) {
      recordUnmatched(entry, false);
    }
  }

  return { selected, unmatched, duplicateWarnings: [] };
}
