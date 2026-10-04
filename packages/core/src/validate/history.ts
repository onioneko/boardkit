import type { AnyBlockType } from "../blocks/types.js";
import { type Diagnostic, diagnostic } from "../model/diagnostic.js";

/**
 * Bounded-history enforcement: when a declared list attr exceeds `history.max`
 * on write, the oldest entries are truncated. The bound is always finite; an
 * unbounded list is ordinary content, not managed history.
 */

/**
 * Truncate a history attr to its bound; returns the attrs to persist and any
 * diagnostics.
 * @param blockType The block type declaring the history bound.
 * @param attrs The block's current attrs.
 * @returns The attrs (truncated if over bound) plus any diagnostics.
 */
export function enforceHistory(
  blockType: AnyBlockType,
  attrs: Record<string, unknown>,
): { attrs: Record<string, unknown>; diagnostics: readonly Diagnostic[] } {
  const bound = blockType.history;
  if (bound === undefined) return { attrs, diagnostics: [] };

  const value = attrs[bound.attr];
  if (!Array.isArray(value)) {
    const id = typeof attrs.id === "string" ? attrs.id : undefined;
    return {
      attrs,
      diagnostics: [
        diagnostic(
          "E_HISTORY_NOT_ARRAY",
          `${blockType.type}.${bound.attr} must be an array for bounded history`,
          id !== undefined ? { nodeId: id } : undefined,
        ),
      ],
    };
  }
  if (value.length <= bound.max) return { attrs, diagnostics: [] };

  return {
    attrs: { ...attrs, [bound.attr]: value.slice(value.length - bound.max) },
    diagnostics: [],
  };
}
