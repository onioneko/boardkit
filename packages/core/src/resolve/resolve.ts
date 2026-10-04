import type { InlineRef, SourceRef } from "../model/refs.js";
import type { Source, SourceValue } from "../ports/ports.js";

/** Default bounded concurrency for source resolution. */
export const DEFAULT_CONCURRENCY = 8;

/** Normalize a Source's resolution (a plain string or `{ value, stale? }`) to the internal value shape. */
function normalize(
  resolved: string | { readonly value: string; readonly stale?: boolean },
): SourceValue {
  if (typeof resolved === "string") return { value: resolved, stale: false };
  return { value: resolved.value, stale: resolved.stale ?? false };
}

/**
 * Canonical key for a source ref: its id plus params, independent of param
 * order. RESOLVE dedups by it, and it is the key every resolved value is
 * stored under — in `ProjectionInput.values`, in `ProjectionWalkContext.values`
 * and in projection middleware's `ctx.values`. A projector reads a
 * param-bearing `{{source:… k=v}}` ref with it; param-less refs also reach
 * block hooks by bare source id, which is why a hook's own values record needs
 * no key construction.
 * @param ref The source reference.
 * @returns A stable key: the source id, `?`, then `k=v` pairs joined by `&` in
 *   sorted key order — `bank_balance?` with no params, `spend?period=month`
 *   with one.
 */
export function canonicalKey(ref: SourceRef): string {
  const params = Object.entries(ref.params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${ref.source}?${params.map(([k, v]) => `${k}=${v}`).join("&")}`;
}

/** Options controlling source resolution. */
export interface ResolveOptions {
  /** Bounded concurrency, clamped to [1, 64]; default 8. */
  concurrency?: number;
}

/**
 * Resolve all source references through the Source port. Include refs are the
 * link stage's concern and are ignored here. Results are deduplicated by
 * canonical key; failures become stale values, never throws.
 * @param refs The inline refs to resolve (only `source` refs are considered).
 * @param source The Source port used to resolve each ref.
 * @param opts Concurrency bounds.
 * @returns A map from canonical key to resolved value (stale on failure).
 */
export async function resolveRefs(
  refs: readonly InlineRef[],
  source: Source,
  opts: ResolveOptions = {},
): Promise<Map<string, SourceValue>> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, 64));

  const unique = new Map<string, SourceRef>();
  for (const ref of refs) {
    if (ref.kind !== "source") continue;
    unique.set(canonicalKey(ref), ref);
  }

  const keys = [...unique.keys()];
  const results = new Map<string, SourceValue>();
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const key = keys[cursor];
      cursor += 1;
      if (key === undefined) return;
      const ref = unique.get(key);
      if (ref === undefined) continue;
      try {
        results.set(key, normalize(await source.resolve(ref)));
      } catch {
        results.set(key, { value: "", stale: true });
      }
    }
  };

  const workerCount = Math.min(concurrency, Math.max(keys.length, 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
