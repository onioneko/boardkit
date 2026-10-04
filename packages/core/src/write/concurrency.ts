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
  /**
   * The attr values the writer read for the keys it is changing (value-CAS).
   * When present it is always compared against the current attrs (strict
   * value-CAS), whatever `expectedVersion` says; see {@link PatchGuards.strictExpected}.
   */
  readonly expected?: Record<string, unknown>;
  /**
   * Strict value-CAS, on unless set to `false`. With it on, a present
   * `expected` is checked even when `expectedVersion` is absent or current, so
   * a writer holding a version and values from different snapshots is refused
   * with `expected-mismatch` instead of overwriting values it never saw. The
   * comparison is the one rule 3 uses for a stale version: a concrete delta
   * compares every key of `expected` whole; a function delta compares the keys
   * the recomputed delta changes (arrays per element), and a changed key
   * missing from `expected` is a mismatch. `false` restores the 0.1 behaviour,
   * where `expected` is only consulted once the version has moved.
   */
  readonly strictExpected?: boolean;
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
 * compare-and-set guards against the live version and attrs. Under strict
 * value-CAS (the default, see {@link PatchGuards.strictExpected}) a present
 * `expected` that disagrees with the current attrs rejects first
 * (`expected-mismatch`), even when `expectedVersion` is absent or current.
 * @param currentVersion The document's current version (content hash).
 * @param currentAttrs The block's current attrs.
 * @param guards The patch's `expectedVersion`/`expected`/`strictExpected` guards.
 * @returns `apply` (with `rebased` set when value-CAS matched after a version move) or `reject`.
 */
export function decidePatch(
  currentVersion: string,
  currentAttrs: Readonly<Record<string, unknown>>,
  guards: PatchGuards,
): PatchDecision {
  const { expectedVersion, expected } = guards;
  const matches = (exp: Readonly<Record<string, unknown>>): boolean =>
    Object.keys(exp).every((key) => equal(exp[key], currentAttrs[key]));
  // rule 0 (strict value-CAS): a present `expected` must match, whatever the version.
  if (isStrict(guards) && expected !== undefined && !matches(expected)) {
    return { kind: "reject", reason: "expected-mismatch", current: currentAttrs };
  }
  if (expectedVersion === undefined) return { kind: "apply", rebased: false }; // rule 1
  if (expectedVersion === currentVersion) return { kind: "apply", rebased: false }; // rule 2
  if (expected === undefined) {
    return { kind: "reject", reason: "stale-version", current: currentAttrs }; // rule 4 (no expected)
  }
  if (matches(expected)) return { kind: "apply", rebased: true }; // rule 3 (value-CAS rebase)
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
 * is treated as a mismatch (the client's view cannot be verified). Under
 * strict value-CAS (the default) the same comparison runs first, whatever the
 * version, so a current `expectedVersion` with a stale `expected` rejects.
 *
 * @param currentVersion The document's current version (content hash).
 * @param currentAttrs The block's current attrs (read inside the lock).
 * @param delta The delta recomputed from `currentAttrs` (already a concrete object).
 * @param guards The patch's `expectedVersion`/`expected`/`strictExpected` guards.
 * @returns `apply` (with `rebased` when value-CAS matched after a version move) or `reject`.
 */
export function decideFunctionPatch(
  currentVersion: string,
  currentAttrs: Readonly<Record<string, unknown>>,
  delta: Readonly<Record<string, unknown>>,
  guards: PatchGuards,
): PatchDecision {
  const { expectedVersion, expected } = guards;
  // rule 0 (strict value-CAS): a present `expected` must agree with the
  // current attrs wherever the recomputed delta changes them, whatever the version.
  if (
    isStrict(guards) &&
    expected !== undefined &&
    !commutesWithCurrent(currentAttrs, delta, expected)
  ) {
    return { kind: "reject", reason: "expected-mismatch", current: currentAttrs };
  }
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

/** Strict value-CAS is the default: only an explicit `strictExpected: false` turns it off. */
function isStrict(guards: PatchGuards): boolean {
  return guards.strictExpected !== false;
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
