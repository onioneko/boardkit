/**
 * `@onioneko/boardkit-core/internal` — mechanism internals.
 *
 * These symbols implement the engine's parse → link → validate → resolve →
 * merge → project → diff → emit → write pipeline. They are exported for
 * library authors and advanced hosts who compose the pipeline stages
 * themselves; they carry **no stability guarantee** and may change between
 * minor releases. Prefer the consumer surface (`@onioneko/boardkit-core`) unless you
 * need a specific mechanism.
 *
 * @module Internal API
 */

export type { AttrChangeOnBlock, SectionChange, StructuralDiff } from "../diff/diff.js";
// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------
export { diffDocs } from "../diff/diff.js";
export type { SynthesizeOptions } from "../diff/synthesize.js";
export { synthesizeEvents } from "../diff/synthesize.js";
export type {
  IncludeStatus,
  LinkOptions,
  LinkResult,
  LoadedDoc,
} from "../link/graph.js";
// ---------------------------------------------------------------------------
// Link internals
// ---------------------------------------------------------------------------
export { buildReverseIndex, resolveIncludes, sectionsOf } from "../link/graph.js";
export type { BuildMergedTreeOptions } from "../link/merge.js";
// MERGE is pure structure and RESOLVE is a separate per-projection stage, so a
// host composing the pipeline itself needs both: `buildMergedTree` for the tree
// and `resolveMergedValues` for the values it hands to the projector.
export { buildMergedTree, resolveMergedValues } from "../link/merge.js";
export { validateFrontmatter } from "../model/frontmatter.js";
export { extractBlocks } from "../parse/blocks.js";
export { documentComplexityDiagnostic, fencedCodeLines } from "../parse/complexity.js";
// ---------------------------------------------------------------------------
// Parse machinery
// ---------------------------------------------------------------------------
export { parseDoc, parseFailedDiagnostic, releaseMdast } from "../parse/pipeline.js";
export type { RefHit } from "../parse/refs.js";
export { extractRefs } from "../parse/refs.js";
export type { SectionSpan } from "../parse/sections.js";
export { extractSections } from "../parse/sections.js";

// ---------------------------------------------------------------------------
// Project internals
// ---------------------------------------------------------------------------
export { projectText } from "../project/text.js";
export type { ResolveOptions } from "../resolve/resolve.js";
// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------
export { canonicalKey, resolveRefs } from "../resolve/resolve.js";
export { enforceHistory } from "../validate/history.js";
// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------
export {
  validateAttrs,
  validateCrossField,
  validateParams,
} from "../validate/schema.js";
export type { PatchDecision } from "../write/concurrency.js";
export { decideFullText, decideFunctionPatch, decidePatch } from "../write/concurrency.js";
export type { PatchInput } from "../write/patch.js";
export { applyPatch } from "../write/patch.js";
export type { PatchDeltaFn } from "../write/pipeline.js";
// ---------------------------------------------------------------------------
// Write pipeline internals
// ---------------------------------------------------------------------------
export { importDoc, patchDoc, removeDoc, writeDoc } from "../write/pipeline.js";
