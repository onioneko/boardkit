import equal from "fast-deep-equal";

/**
 * Concurrency decisions for the write pipeline. The unit of optimistic
 * concurrency is the document version (content hash). Value-CAS rebase compares
 * the attrs the writer read against the current block — no history needs to be
 * retained.
 */

/** Optimistic-concurrency guards carried by a patch. */
export interface PatchGuards {
  /** The document version the writer read before the change; omit to apply unconditionally. */
  readonly expectedVersion?: string;
  /** The attr values the writer read for the keys it is changing (value-CAS). */
  readonly expected?: Record<string, unknown>;
}

/** Outcome of the patch concurrency check: apply (possibly rebased) or reject. */
export type PatchDecision =
  | { readonly kind: "apply"; readonly rebased: boolean }
  | {
      readonly kind: "reject";
      readonly reason: "stale-version" | "expected-mismatch";
      readonly current: unknown;
    };

/**
 * Decide whether a patch applies (possibly rebased) or is rejected, from its
 * compare-and-set guards against the live version and attrs.
 * @param currentVersion The document's current version (content hash).
 * @param currentAttrs The block's current attrs.
 * @param guards The patch's `expectedVersion`/`expected` guards.
 * @returns `apply` (with `rebased` set when value-CAS matched after a version move) or `reject`.
 */
export function decidePatch(
  currentVersion: string,
  currentAttrs: Readonly<Record<string, unknown>>,
  guards: PatchGuards,
): PatchDecision {
  const { expectedVersion, expected } = guards;
  if (expectedVersion === undefined) return { kind: "apply", rebased: false }; // rule 1
  if (expectedVersion === currentVersion) return { kind: "apply", rebased: false }; // rule 2
  if (expected === undefined) {
    return { kind: "reject", reason: "stale-version", current: currentAttrs }; // rule 4 (no expected)
  }
  const matches = Object.keys(expected).every((key) => equal(expected[key], currentAttrs[key]));
  if (matches) return { kind: "apply", rebased: true }; // rule 3 (value-CAS rebase)
  return { kind: "reject", reason: "expected-mismatch", current: currentAttrs }; // rule 4
}

/**
 * Decide a patch whose `delta` was recomputed inside the write lock against the
 * current attrs (a function delta, rule 3'). Version and staleness rules
 * are identical to {@link decidePatch}; only the value-CAS comparison differs.
 *
 * Because the delta already reflects the current attrs, a stale
 * `expectedVersion` is safe to rebase when the client's `expected` still
 * matches the current attrs on exactly the parts the recomputed delta changes:
 * a concurrent change disjoint from those parts commutes (`rebased: true`), and
 * one that overlaps them rejects. Comparison granularity: array attrs are
 * compared per element (at the indices the delta changes); every other attr is
 * compared as a whole value. A missing `expected` for a key the delta changes
 * is treated as a mismatch (the client's view cannot be verified).
 *
 * @param currentVersion The document's current version (content hash).
 * @param currentAttrs The block's current attrs (read inside the lock).
 * @param delta The delta recomputed from `currentAttrs` (already a concrete object).
 * @param guards The patch's `expectedVersion`/`expected` guards.
 * @returns `apply` (with `rebased` when value-CAS matched after a version move) or `reject`.
 */
export function decideFunctionPatch(
  currentVersion: string,
  currentAttrs: Readonly<Record<string, unknown>>,
  delta: Readonly<Record<string, unknown>>,
  guards: PatchGuards,
): PatchDecision {
  const { expectedVersion, expected } = guards;
  if (expectedVersion === undefined) return { kind: "apply", rebased: false }; // rule 1
  if (expectedVersion === currentVersion) return { kind: "apply", rebased: false }; // rule 2
  if (expected === undefined) {
    return { kind: "reject", reason: "stale-version", current: currentAttrs }; // rule 4 (no expected)
  }
  if (commutesWithCurrent(currentAttrs, delta, expected)) {
    return { kind: "apply", rebased: true }; // rule 3 (value-CAS rebase, scoped to the delta's changes)
  }
  return { kind: "reject", reason: "expected-mismatch", current: currentAttrs }; // rule 4
}

/**
 * True when the recomputed delta's changes are disjoint from the concurrent
 * change implied by `expected` (i.e. the client's stale view still agrees with
 * current attrs wherever the delta would rewrite them).
 */
function commutesWithCurrent(
  currentAttrs: Readonly<Record<string, unknown>>,
  delta: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  for (const key of Object.keys(delta)) {
    const currentVal = currentAttrs[key];
    const nextVal = delta[key];
    if (equal(currentVal, nextVal)) continue; // the recompute did not change this key
    if (!valueCommutes(expected[key], currentVal, nextVal)) return false;
  }
  return true;
}

/**
 * True when the part of `nextVal` that differs from `currentVal` agrees with
 * `expectedVal`. Arrays compare per element at the indices the delta changes;
 * any other value compares whole.
 */
function valueCommutes(expectedVal: unknown, currentVal: unknown, nextVal: unknown): boolean {
  if (Array.isArray(currentVal) && Array.isArray(nextVal)) {
    const expectedArr = Array.isArray(expectedVal) ? expectedVal : [];
    const len = Math.max(currentVal.length, nextVal.length);
    for (let i = 0; i < len; i += 1) {
      if (equal(currentVal[i], nextVal[i])) continue;
      if (!equal(expectedArr[i], currentVal[i])) return false;
    }
    return true;
  }
  return equal(expectedVal, currentVal);
}

/**
 * Decide whether a full-text write applies or is rejected. There is no
 * text-level merge: a provided `expectedVersion` that mismatches the current
 * version rejects; otherwise the write is last-writer-wins.
 * @param currentVersion The document's current version (content hash).
 * @param guards The write's optional `expectedVersion`.
 * @returns `"apply"` or `"reject"`.
 */
export function decideFullText(
  currentVersion: string,
  guards: { readonly expectedVersion?: string },
): "apply" | "reject" {
  if (guards.expectedVersion !== undefined && guards.expectedVersion !== currentVersion) {
    return "reject"; // rule 5
  }
  return "apply"; // rule 6 (last-writer-wins)
}
