/**
 * `@onioneko/boardkit-core` — the public consumer API.
 *
 * This is the stable surface for hosts and ecosystem authors: engine assembly,
 * the write and intent domains, block and model types, ports and their default
 * adapters, watch wiring, projection options, merged-tree data, middleware, and
 * events. Mechanism internals (parse/link/resolve/validate/diff/project/write
 * pipeline machinery) live under `@onioneko/boardkit-core/internal` and carry no
 * stability guarantee.
 *
 * @module Consumer API
 */

export type { AttrChange, TransitionEvent } from "./blocks/transitions.js";
// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------
export { attributeChanges, matchTransitions } from "./blocks/transitions.js";
export type {
  AffordanceDecl,
  AnyBlockType,
  BlockType,
  HtmlProjectionHook,
  JsonSchema,
  ProjectionHook,
  StateTransition,
} from "./blocks/types.js";
// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------
export type {
  Engine,
  EngineOptions,
  ProjectionInput,
  ProjectionOptions,
  ProjectionResult,
  Projector,
  RefGraph,
  WatchOptions,
} from "./engine/engine.js";
// ---------------------------------------------------------------------------
// Engine assembly
// ---------------------------------------------------------------------------
export { createEngine } from "./engine/engine.js";
// Document versioning (demo and hosts depend on it)
export { docVersion } from "./engine/version.js";
export type { Intent } from "./intent/apply.js";

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------
export { applyIntent, intentExpected } from "./intent/apply.js";
// ---------------------------------------------------------------------------
// Merge data (custom projectors receive the merged tree)
// ---------------------------------------------------------------------------
export type { ResolvedInclude } from "./link/graph.js";
export type {
  IncludeLimits,
  MergedInclude,
  MergedNode,
  MergedTree,
  Provenance,
} from "./link/merge.js";
export { DEFAULT_INCLUDE_LIMITS } from "./link/merge.js";
export type {
  ProjectionCtx,
  ProjectionMiddleware,
  WriteCtx,
  WriteMiddleware,
  WriteProposal,
} from "./middleware/compose.js";
// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
export { compose, patchProposal, WriteRejection } from "./middleware/compose.js";
export type { Diagnostic } from "./model/diagnostic.js";
export { diagnostic } from "./model/diagnostic.js";
export type {
  Block,
  DocNode,
  ParsedDoc,
  RefSpan,
  Section,
  SourcePosition,
  SourceSpan,
} from "./model/doc.js";
export type { Stability, ValidatedFrontmatter } from "./model/frontmatter.js";
export type { BlockId, DocId, SectionId } from "./model/ids.js";
// ---------------------------------------------------------------------------
// Model / data
// ---------------------------------------------------------------------------
export { asBlockId, asDocId, asSectionId } from "./model/ids.js";
export type { IncludeRef, InlineRef, SourceRef } from "./model/refs.js";
// Markdown complexity limits (EngineOptions.complexityLimits)
export type { ComplexityLimits } from "./parse/complexity.js";
export { DEFAULT_COMPLEXITY_LIMITS } from "./parse/complexity.js";
// Fence→block recognition config (EngineOptions.parseOptions / PipelineDeps.parseOptions)
export type { ParseOptions } from "./parse/options.js";
// Document size limit (EngineOptions.maxDocumentBytes)
export { DEFAULT_MAX_DOCUMENT_BYTES } from "./parse/size.js";
export type { FsStorageOptions } from "./ports/fs.js";
export { createFsEventSink, createFsStorage, createLock } from "./ports/fs.js";
export type { MemStorage, MemStorageOptions } from "./ports/mem.js";
// ---------------------------------------------------------------------------
// Default adapters
// ---------------------------------------------------------------------------
export { createMemStorage } from "./ports/mem.js";
// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------
export type {
  Clock,
  CommitInfo,
  EventDraft,
  EventRecord,
  EventSink,
  Lock,
  Source,
  SourceValue,
  Storage,
} from "./ports/ports.js";
export type { TextProjectionOptions } from "./project/text.js";
export { textProjector } from "./project/text.js";
export type {
  ProjectionNode,
  ProjectionWalkBlock,
  ProjectionWalkCache,
  ProjectionWalkContext,
  ProjectionWalkHandlers,
  ProjectionWalkOptions,
} from "./project/walk.js";
// The shared projection walk (`project/walk.ts`): the single traversal every
// span-rewriting projector runs. The built-in `text` projector is written on
// it, `@onioneko/boardkit-html` is written on it from outside the package, and so is
// every custom projector.
export {
  createProjectionWalkCache,
  documentNode,
  walkProjection,
  walkProjectionParts,
} from "./project/walk.js";
// The key every resolved value is stored under. A projector reading
// `input.values` (or `ProjectionWalkContext.values`) needs it to look up a
// param-bearing `{{source:… k=v}}` ref, which by design never reaches a block
// hook's own values record.
// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
export { canonicalKey, DEFAULT_CONCURRENCY } from "./resolve/resolve.js";
// Block-attr validation (public: @onioneko/boardkit-blocks and custom block authors use it)
export { validateBlock } from "./validate/schema.js";
export type { ChokidarLike } from "./watch/chokidar.js";
// ---------------------------------------------------------------------------
// Watch (hosts wire it manually)
// ---------------------------------------------------------------------------
export { createChokidarSource } from "./watch/chokidar.js";
export type {
  ExternalWriteDeps,
  ExternalWriteHandler,
  ExternalWriteOutcome,
} from "./watch/external-write.js";
export { createExternalWriteHandler } from "./watch/external-write.js";
export type { WatchEvent, WatchSource } from "./watch/source.js";
// Value-CAS guards for Engine.patch (host-facing)
export type { PatchGuards } from "./write/concurrency.js";
export type {
  CommitEffect,
  ImportOptions,
  PipelineDeps,
  WriteMode,
  WritePolicy,
  WriteResult,
  Writer,
} from "./write/pipeline.js";
// ---------------------------------------------------------------------------
// Write domain
// ---------------------------------------------------------------------------
export { createDoc } from "./write/pipeline.js";
