import type { AnyBlockType } from "../blocks/types.js";
import { blockSourceRefs, type MergedInclude, type Provenance } from "../link/merge.js";
import { type Diagnostic, diagnostic } from "../model/diagnostic.js";
import type { Block, ParsedDoc, SourceSpan } from "../model/doc.js";
import type { SourceRef } from "../model/refs.js";
import type { SourceValue } from "../ports/ports.js";
import { canonicalKey } from "../resolve/resolve.js";

/**
 * The projection walk: the one traversal every span-rewriting projector runs.
 *
 * A BoardKit projection is a rewrite of the source's bytes. Four things are
 * replaced — a `{{source:…}}` reference by its resolved value, a typed block by
 * its projection hook's output, an expanded `{{include:…}}` by the referenced
 * content, and nothing else — while every untouched byte flows through
 * verbatim. {@link walkProjectionParts} owns that traversal: which byte ranges
 * the node projects, which spans inside them are rewrites, in what order, which
 * block hook each block dispatches to, and the document-wide values record
 * those hooks receive. The caller supplies only what each piece *becomes*.
 *
 * Both built-in projectors are written against it (`text` in this package,
 * `html` in `@onioneko/boardkit-html`), and so is every custom projector: a walk is the
 * supported way to reach block hooks and include provenance without
 * reimplementing the splice.
 *
 * ## Pieces are whatever the projector wants
 *
 * The handlers turn each piece of the document into a value of the projector's
 * own type. {@link walkProjectionParts} returns those values in document order,
 * so a projector whose output is a react tree, an mdast document, or a list of
 * structured records builds them directly. {@link walkProjection} is the
 * string specialization — the common case, and what both built-ins use: it
 * concatenates the pieces for you.
 *
 * ## One node per call
 *
 * A walk renders exactly one {@link ProjectionNode} — the merged tree's root,
 * an include child, or a standalone document ({@link documentNode}). It does
 * not recurse: {@link ProjectionWalkHandlers.onInclude} receives the child node
 * and the caller decides what to do with it, normally by walking it in turn.
 * That is deliberate. A projector whose output needs a post-pass per node — the
 * html projector runs each node's rewritten markdown through remark/rehype
 * before its children's HTML can be spliced in, and that pass is async — could
 * not exist if the walk owned recursion. Recursion is one line per projector;
 * the splice is not.
 *
 * ## Fail-soft, by construction
 *
 * A stale or unresolved reference never reaches `onSource`: its span is left
 * verbatim, so a projector cannot fabricate data by accident. A projector that
 * needs to key every reference (a live view that fills a value in later)
 * supplies {@link ProjectionWalkHandlers.onUnresolvedSource}, which receives
 * such a span with its state instead; block hooks still never see it. A block whose
 * type is unregistered or declares no hook for this projector reaches `onBlock`
 * with `hooked: false` and the block's verbatim source in `raw`, which is what
 * lets each projector render its own fallback.
 */

/**
 * One unit of projection: a merged node, or a standalone document standing in
 * for one. `MergedNode` satisfies this interface, so the merged tree's root and
 * its include children are walked directly; {@link documentNode} builds one for
 * a document projected on its own.
 */
export interface ProjectionNode {
  /** The parsed document owning this node's source. */
  readonly doc: ParsedDoc;
  /** Raw source bytes of the owning document. */
  readonly src: string;
  /**
   * Exclusive byte ranges `[start, end)` of `src` this node projects, in
   * document order. A whole document is `[{start: 0, end: src.length}]`; a
   * section slice is its exclusive content spans.
   */
  readonly ranges: readonly SourceSpan[];
  /** Include children whose spans this node expands, in document order. */
  readonly includes: readonly MergedInclude[];
  /**
   * Where this node's content came from. Absent for a standalone document,
   * which has no document identity to attribute content to — the html
   * projector's `data-intent` enrichment, for one, is skipped without it.
   */
  readonly provenance?: Provenance;
  /** Heading text when this node is a section slice. */
  readonly heading?: string;
}

/**
 * A standalone document as a walkable node: its whole source, no includes, no
 * provenance. This is what a projector walks when it is handed a document
 * without a merged tree (`projectText(doc, src, values)` and friends).
 * @param doc The parsed document.
 * @param src The document's raw source.
 * @returns A node covering the entire source.
 */
export function documentNode(doc: ParsedDoc, src: string): ProjectionNode {
  return { doc, src, ranges: [{ start: 0, end: src.length }], includes: [] };
}

/** What every handler is told about the node being walked. */
export interface ProjectionWalkContext {
  /** The node currently being walked. */
  readonly node: ProjectionNode;
  /**
   * Source id → resolved value, the record this node's block hooks receive.
   * It holds the node document's prose `{{source:…}}` refs plus the refs *any*
   * of its blocks declare through `BlockType.sources`. Param-bearing refs are
   * absent (hooks look values up by source id alone; a param-bearing ref
   * reaches a projector through {@link ProjectionWalkContext.values} instead),
   * and so are stale and failed resolutions — an absent entry is what makes a
   * hook render its own fallback. When the walk has a
   * {@link ProjectionWalkOptions.cache}, the record is built once per document
   * for that cache and shared, frozen, by every node walked from that document.
   */
  readonly hookValues: Readonly<Record<string, string>>;
  /**
   * Every resolved value for this projection, keyed by canonical key. Build the
   * key for a ref with `canonicalKey(ref)`, exported from `@onioneko/boardkit-core`
   * alongside this module — that is how a projector reads a param-bearing ref,
   * which by design never lands in {@link ProjectionWalkContext.hookValues}.
   */
  readonly values: ReadonlyMap<string, SourceValue>;
}

/**
 * A typed block, with this walk's projection hook already dispatched.
 *
 * `hooked` and `output` together say what happened, in three distinguishable
 * cases:
 *
 * | `hooked` | `output` | meaning |
 * |---|---|---|
 * | `false` | `undefined` | the type is unregistered, or declares no hook for this projector id |
 * | `true` | the hook's return | the hook rendered something |
 * | `true` | `undefined` | the hook ran and returned nothing |
 * | `true` | `undefined`, with `hookError` set | the hook threw |
 *
 * The built-in projectors treat every `undefined` case the same (render
 * `raw`); a projector that wants to tell "nobody rendered this" from "the hook
 * opted out" reads `hooked`. A throwing hook fails soft for its block alone:
 * the walk catches the error, hands over `output: undefined`, and describes
 * the failure in `hookError` for the projector to report.
 */
export interface ProjectionWalkBlock {
  /** The block node: its id, type, attrs, and span. */
  readonly block: Block;
  /**
   * True when the block's type declares a hook for
   * {@link ProjectionWalkOptions.projectorId} and the walk called it — whatever
   * that hook then returned.
   */
  readonly hooked: boolean;
  /**
   * What the hook returned, or `undefined` when there was no hook to call.
   * `unknown` because the id ↔ output contract belongs to the projector:
   * narrow it here, at the one call site that owns it (`string` for `text`, a
   * hast subtree for `html`, whatever a custom projector defines for itself).
   */
  readonly output: unknown;
  /** The block's verbatim source, which is what a projector without a hook falls back to. */
  readonly raw: string;
  /**
   * Set when the hook threw: an `E_BLOCK_HOOK_ERROR` diagnostic naming the
   * block (`nodeId` is its block id) and the error message. `output` is then
   * `undefined`.
   */
  readonly hookError?: Diagnostic;
}

/**
 * What each piece of a document becomes.
 * @typeParam T The projector's piece type. `string` for a projector that emits
 *   text (markdown, HTML, anything serialized); any other type for a projector
 *   that builds structure — react elements, mdast nodes, records — which
 *   {@link walkProjectionParts} hands back in document order.
 */
export interface ProjectionWalkHandlers<T = string> {
  /**
   * A verbatim run of source between two rewrites (never empty).
   * @param prose The verbatim run, with ref escapes already stripped when
   *   {@link ProjectionWalkOptions.unescapeRefs} is set.
   * @param ctx The node being walked.
   * @returns What to emit for that run — the identity, for a projector that
   *   preserves untouched bytes.
   */
  onProse(prose: string, ctx: ProjectionWalkContext): T;
  /**
   * A `{{source:…}}` span whose value resolved and is not stale. Stale and
   * unresolved refs never reach here: they go to
   * {@link ProjectionWalkHandlers.onUnresolvedSource} when it is supplied, and
   * otherwise their spans stay verbatim.
   * @param value The resolved value text.
   * @param ref The reference as parsed (source id and params).
   * @param ctx The node being walked.
   * @returns What to emit in the reference's place.
   */
  onSource(value: string, ref: SourceRef, ctx: ProjectionWalkContext): T;
  /**
   * A `{{source:…}}` span whose value is stale or did not resolve at all.
   * Optional: when omitted, such a span stays verbatim prose (part of the
   * surrounding `onProse` run), exactly as before this handler existed.
   *
   * Supply it when the projector needs a keyed piece for every reference — a
   * live view that fills a value in later, for one — and must tell a stale
   * reference from prose that happens to read `{{source:x}}`. It changes only
   * what this span becomes: {@link ProjectionWalkContext.hookValues} still
   * omits stale and missing values, so block hooks keep rendering their own
   * fallback and never see a placeholder.
   * @param ref The reference as parsed (source id and params, param-bearing
   *   refs included).
   * @param state `{ stale: true, value }` when the resolution degraded, where
   *   `value` is the source's degradation marker (not real data);
   *   `{ stale: false }` with no `value` when the projection's values hold no
   *   entry for this ref.
   * @param raw The reference's verbatim source, `{{` to `}}`.
   * @param ctx The node being walked.
   * @returns What to emit in the reference's place; `raw` reproduces the
   *   output a walk without this handler gives.
   * @example
   * ```ts
   * onUnresolvedSource: (ref, state) =>
   *   h("span", { "data-source": ref.source, "data-stale": String(state.stale) }),
   * ```
   */
  onUnresolvedSource?(
    ref: SourceRef,
    state: { readonly value?: string; readonly stale: boolean },
    raw: string,
    ctx: ProjectionWalkContext,
  ): T;
  /**
   * A typed block, with its hook already dispatched.
   * @param block The block, whether it had a hook, that hook's output, and its
   *   verbatim source.
   * @param ctx The node being walked.
   * @returns What to emit in the block's place.
   */
  onBlock(block: ProjectionWalkBlock, ctx: ProjectionWalkContext): T;
  /**
   * An expanded `{{include:…}}` edge. `include.node` is the merged child (with
   * its own provenance and heading); walk it to project it.
   * @param include The include's span in this node's source and its child node.
   * @param ctx The node being walked (the parent).
   * @returns What to emit in the include's place.
   */
  onInclude(include: MergedInclude, ctx: ProjectionWalkContext): T;
}

/** What to walk, and how. */
export interface ProjectionWalkOptions {
  /** The node to render: a merged node, or {@link documentNode} of a standalone document. */
  readonly node: ProjectionNode;
  /** Resolved live values for the projection, keyed by canonical key. */
  readonly values: ReadonlyMap<string, SourceValue>;
  /**
   * The projector id whose `BlockType.project[id]` hook each block is
   * dispatched to — the same id the projector registers under.
   */
  readonly projectorId: string;
  /** Registered block types, keyed by type name; without them no block has a hook. */
  readonly blockTypes?: ReadonlyMap<string, AnyBlockType>;
  /**
   * Keep the document's leading YAML frontmatter in the walked ranges. Defaults
   * to `false`: frontmatter is metadata, not body content, so the walk clips it
   * (and the blank lines after it) out of the ranges it renders. A projector
   * that hands the source to a markdown pipeline which drops frontmatter itself
   * — the html projector does — sets this to `true` and lets it through.
   */
  readonly frontmatter?: boolean;
  /**
   * Strip the escaping backslash from `\{{` in prose. A `\{{` in the source
   * suppresses reference recognition and is meant to read as a literal `{{`;
   * a markdown parser consumes that backslash on its own, so a projector that
   * builds on one leaves this `false` (the default), while a projector that
   * emits raw source bytes sets it to `true` so its readers see `{{`. Verbatim
   * regions the reader must get byte-for-byte are respected: backslashes inside
   * a typed block's span, and a `\\{{` (an escaped backslash), are left alone.
   */
  readonly unescapeRefs?: boolean;
  /**
   * A per-projection cache from {@link createProjectionWalkCache}. Pass the same
   * cache to every walk of one projection call (the root and every include
   * node) so document-wide work — such as the values record block hooks
   * receive — is done once per document rather than once per node, which
   * matters when a document is included in many places. Create a new cache
   * for each projection call: it assumes `values` and `blockTypes` do not
   * change while it is in use. Without one, every node computes that work
   * itself.
   */
  readonly cache?: ProjectionWalkCache;
}

/**
 * An opaque per-projection cache for {@link walkProjectionParts}; create one per
 * projection call with {@link createProjectionWalkCache}.
 */
export interface ProjectionWalkCache {
  /** Brand: the cache's contents are internal to the walk. */
  readonly kind: "projection-walk-cache";
}

/** Per-cache memo of each document's block-hook values record. */
const hookValuesByCache = new WeakMap<
  ProjectionWalkCache,
  WeakMap<
    ParsedDoc,
    {
      readonly values: ReadonlyMap<string, SourceValue>;
      readonly blockTypes: ReadonlyMap<string, AnyBlockType> | undefined;
      readonly record: Readonly<Record<string, string>>;
    }
  >
>();

/**
 * Create a cache for one projection call; pass it as
 * {@link ProjectionWalkOptions.cache} to every walk of that call and drop it
 * afterwards. Both built-in projectors do this.
 * @returns A fresh, empty cache.
 * @example
 * ```ts
 * const cache = createProjectionWalkCache();
 * const out = walkProjection({ node: tree.root, values, projectorId: "md", cache }, handlers);
 * ```
 */
export function createProjectionWalkCache(): ProjectionWalkCache {
  const cache: ProjectionWalkCache = Object.freeze({ kind: "projection-walk-cache" as const });
  hookValuesByCache.set(cache, new WeakMap());
  return cache;
}

/** A span this walk replaces, resolved against a handler once it reaches the output. */
type Rewrite =
  | { readonly start: number; readonly end: number; readonly include: MergedInclude }
  | {
      readonly start: number;
      readonly end: number;
      readonly ref: SourceRef;
      readonly value: string;
    }
  | {
      readonly start: number;
      readonly end: number;
      readonly ref: SourceRef;
      readonly unresolved: { readonly value?: string; readonly stale: boolean };
    }
  | { readonly start: number; readonly end: number; readonly block: Block };

/**
 * Document-wide lookups a walk needs, computed once per parsed document and
 * shared by every node projected from it. A document included in many places
 * (or a small section of a large document) then costs each node only the
 * spans inside its own ranges, not a scan of the whole source.
 */
interface DocIndex {
  /** `{{source:…}}` ref spans, sorted by start. */
  readonly sources: readonly {
    readonly start: number;
    readonly end: number;
    readonly ref: SourceRef;
  }[];
  /** Typed blocks with a source span, sorted by start. */
  readonly blocks: readonly {
    readonly start: number;
    readonly end: number;
    readonly block: Block;
  }[];
  /** The source the escapes below were computed for. */
  escapesSrc?: string;
  /** Offsets of escaping backslashes (see {@link escapeOffsets}), sorted. */
  escapes?: readonly number[];
}

const docIndexes = new WeakMap<ParsedDoc, DocIndex>();

function indexOf(doc: ParsedDoc): DocIndex {
  let index = docIndexes.get(doc);
  if (index === undefined) {
    const sources: { start: number; end: number; ref: SourceRef }[] = [];
    for (const span of doc.refSpans) {
      if (span.ref.kind === "source")
        sources.push({ start: span.start, end: span.end, ref: span.ref });
    }
    sources.sort((a, b) => a.start - b.start);
    const blocks: { start: number; end: number; block: Block }[] = [];
    for (const node of doc.nodes) {
      if (!("blockId" in node) || node.span === undefined) continue;
      blocks.push({ start: node.span.start, end: node.span.end, block: node });
    }
    blocks.sort((a, b) => a.start - b.start);
    index = { sources, blocks };
    docIndexes.set(doc, index);
  }
  return index;
}

/** Index of the first element of `items` (sorted ascending) that is ≥ `at`. */
function lowerBound<T>(items: readonly T[], at: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(items[mid] as T) < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The items (sorted by start) fully contained in one of `ranges`, in document order. */
function inRanges<T extends { readonly start: number; readonly end: number }>(
  items: readonly T[],
  ranges: readonly SourceSpan[],
): T[] {
  const out: T[] = [];
  for (const r of ranges) {
    for (let i = lowerBound(items, r.start, (x) => x.start); i < items.length; i += 1) {
      const item = items[i] as T;
      if (item.start >= r.end) break;
      if (item.end <= r.end) out.push(item);
    }
  }
  return out;
}

/**
 * Source-id → resolved value for block hooks: the document's prose refs plus
 * the refs its blocks declare through their types (`BlockType.sources`). Refs
 * with params are skipped — hooks look values up by source id alone, and a
 * param-bearing ref reaches custom projectors through the values map's
 * canonical keys instead. Stale and failed resolutions are skipped too: an
 * absent entry is what makes a hook render its own fallback.
 */
function hookValuesFor(
  doc: ParsedDoc,
  values: ReadonlyMap<string, SourceValue>,
  blockTypes: ReadonlyMap<string, AnyBlockType> | undefined,
  cache: ProjectionWalkCache | undefined,
): Readonly<Record<string, string>> {
  // Document-wide, so with a per-projection cache it is computed once per
  // document and shared — frozen, as hooks receive it read-only — by every
  // node of that document in the projection.
  const byDoc = cache === undefined ? undefined : hookValuesByCache.get(cache);
  if (byDoc === undefined) return computeHookValues(doc, values, blockTypes);
  const memo = byDoc.get(doc);
  if (memo !== undefined && memo.values === values && memo.blockTypes === blockTypes) {
    return memo.record;
  }
  const record = Object.freeze(computeHookValues(doc, values, blockTypes));
  byDoc.set(doc, { values, blockTypes, record });
  return record;
}

function computeHookValues(
  doc: ParsedDoc,
  values: ReadonlyMap<string, SourceValue>,
  blockTypes: ReadonlyMap<string, AnyBlockType> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (ref: SourceRef): void => {
    if (Object.keys(ref.params).length > 0) return;
    const value = values.get(canonicalKey(ref));
    if (value !== undefined && !value.stale) out[ref.source] = value.value;
  };
  for (const span of doc.refSpans) {
    if (span.ref.kind === "source") add(span.ref);
  }
  if (blockTypes !== undefined) {
    for (const ref of blockSourceRefs(doc, blockTypes)) add(ref);
  }
  return out;
}

/**
 * The node's ranges with the leading frontmatter clipped out (the default), or
 * verbatim when the walk asked to keep it. When clipped, the frontmatter span
 * and any immediately-following newlines are skipped so the body starts cleanly.
 */
function bodyRanges(walk: ProjectionWalkOptions): readonly SourceSpan[] {
  const { node } = walk;
  if (walk.frontmatter === true) return node.ranges;
  const span = node.doc.frontmatterSpan;
  if (span === undefined) return node.ranges;
  const src = node.src;
  let start = span.end;
  while (start < src.length && (src[start] === "\n" || src[start] === "\r")) start += 1;
  const out: SourceSpan[] = [];
  for (const r of node.ranges) {
    if (r.end <= span.start || r.start >= start) {
      out.push(r);
      continue;
    }
    const clipped = Math.max(r.start, start);
    if (clipped < r.end) out.push({ start: clipped, end: r.end });
  }
  return out;
}

/**
 * Byte offsets of the backslashes that escape a `{{` in the raw source. The
 * markdown parser consumes such a backslash (so a projector built on one
 * renders it correctly), but a projector reading raw bytes must strip it itself
 * so its reader sees the literal `{{`. Typed-block spans are excluded (their
 * content is verbatim code), and a `\\{{` (an escaped backslash) is left alone.
 */
function escapeOffsets(doc: ParsedDoc, src: string): readonly number[] {
  const index = indexOf(doc);
  if (index.escapes !== undefined && index.escapesSrc === src) return index.escapes;
  const blocks = index.blocks;
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const i = src.indexOf("\\{{", from);
    if (i === -1) break;
    from = i + 1;
    if (i > 0 && src[i - 1] === "\\") continue;
    // Inside a typed block? Blocks are sorted and disjoint: check the last one starting at or before i.
    const b = lowerBound(blocks, i + 1, (x) => x.start) - 1;
    const block = b >= 0 ? blocks[b] : undefined;
    if (block !== undefined && i >= block.start && i < block.end) continue;
    offsets.push(i);
  }
  index.escapesSrc = src;
  index.escapes = offsets;
  return offsets;
}

/** The verbatim run `[start, end)`, with any escaping backslashes inside it removed. */
function proseSlice(src: string, start: number, end: number, escapes: readonly number[]): string {
  let out = "";
  let cursor = start;
  for (let i = lowerBound(escapes, start, (x) => x); i < escapes.length; i += 1) {
    const offset = escapes[i] as number;
    if (offset >= end) break;
    out += src.slice(cursor, offset);
    cursor = offset + 1;
  }
  return out + src.slice(cursor, end);
}

/**
 * Every span this node replaces, in document order. A stale or missing ref is
 * a rewrite only when `unresolved` is set (the projector supplied
 * `onUnresolvedSource`); otherwise its span stays in the surrounding prose.
 */
function planRewrites(
  walk: ProjectionWalkOptions,
  ranges: readonly SourceSpan[],
  unresolved: boolean,
): Rewrite[] {
  const { doc } = walk.node;
  const rewrites: Rewrite[] = [];

  // Include spans are not range-filtered here: the merge stage already scoped
  // them to the node, and the splice below drops any that fall outside anyway.
  for (const include of walk.node.includes) {
    rewrites.push({ start: include.span.start, end: include.span.end, include });
  }

  // Only the spans inside this node's ranges are visited (binary search over
  // the document's sorted spans), so a small slice of a large document costs
  // the slice, not the document.
  const index = indexOf(doc);
  for (const span of inRanges(index.sources, ranges)) {
    const value = walk.values.get(canonicalKey(span.ref));
    if (value === undefined || value.stale) {
      if (!unresolved) continue; // stale → verbatim (fail-soft)
      const state = value === undefined ? { stale: false } : { value: value.value, stale: true };
      rewrites.push({ start: span.start, end: span.end, ref: span.ref, unresolved: state });
      continue;
    }
    rewrites.push({ start: span.start, end: span.end, ref: span.ref, value: value.value });
  }

  for (const { start, end, block } of inRanges(index.blocks, ranges)) {
    rewrites.push({ start, end, block });
  }

  rewrites.sort((a, b) => a.start - b.start);
  return rewrites;
}

/**
 * Walk one node of a projection and collect its pieces, in document order.
 *
 * The walk decides *what* each byte of the node is — prose, a resolved
 * reference, a typed block, an expanded include — and the handlers decide what
 * each becomes; the pieces come back in the order they appear in the source,
 * across the node's exclusive ranges. Pure: it reads the node, the values, and
 * the block registry, calls the handlers, and returns an array.
 *
 * Use this when the projector's output is not a string. When it is, prefer
 * {@link walkProjection}, which concatenates for you.
 * @typeParam T The projector's piece type.
 * @param walk The node to render, its resolved values, and the projector id
 *   whose block hooks to dispatch to.
 * @param handlers What prose, a reference, a block, and an include each become.
 * @returns The node's pieces, in document order.
 * @example
 * ```ts
 * // A projector whose output is structured, not text.
 * type Piece = { kind: string; text: string };
 * const pieces = walkProjectionParts<Piece>(
 *   { node: tree.root, values, projectorId: "json", blockTypes },
 *   {
 *     onProse: (text) => ({ kind: "prose", text }),
 *     onSource: (value, ref) => ({ kind: `source:${ref.source}`, text: value }),
 *     onBlock: ({ block, raw }) => ({ kind: `block:${block.type}`, text: raw }),
 *     onInclude: (include) => ({ kind: "include", text: include.node.provenance.docId }),
 *   },
 * );
 * ```
 */
export function walkProjectionParts<T>(
  walk: ProjectionWalkOptions,
  handlers: ProjectionWalkHandlers<T>,
): T[] {
  const { node, values, blockTypes, projectorId } = walk;
  const { doc, src } = node;
  const ranges = bodyRanges(walk);
  const rewrites = planRewrites(walk, ranges, handlers.onUnresolvedSource !== undefined);
  const escapes = walk.unescapeRefs === true ? escapeOffsets(doc, src) : [];
  const ctx: ProjectionWalkContext = {
    node,
    hookValues: hookValuesFor(doc, values, blockTypes, walk.cache),
    values,
  };

  const parts: T[] = [];
  const pushProse = (start: number, end: number): void => {
    if (start >= end) return; // an empty run is not a piece
    parts.push(handlers.onProse(proseSlice(src, start, end, escapes), ctx));
  };

  for (const range of ranges) {
    let cursor = range.start;
    for (const rewrite of rewrites) {
      if (rewrite.start < range.start || rewrite.end > range.end) continue; // not in this range
      if (rewrite.start < cursor) continue; // defensive: skip overlapping rewrites
      pushProse(cursor, rewrite.start);
      if ("include" in rewrite) {
        parts.push(handlers.onInclude(rewrite.include, ctx));
      } else if ("unresolved" in rewrite) {
        const raw = src.slice(rewrite.start, rewrite.end);
        // Defined: an unresolved rewrite is planned only when the handler is.
        const onUnresolved = handlers.onUnresolvedSource as NonNullable<
          ProjectionWalkHandlers<T>["onUnresolvedSource"]
        >;
        parts.push(onUnresolved.call(handlers, rewrite.ref, rewrite.unresolved, raw, ctx));
      } else if ("ref" in rewrite) {
        parts.push(handlers.onSource(rewrite.value, rewrite.ref, ctx));
      } else {
        const { block } = rewrite;
        const hook = blockTypes?.get(block.type)?.project?.[projectorId];
        const raw = src.slice(rewrite.start, rewrite.end);
        let piece: ProjectionWalkBlock;
        try {
          const output = hook === undefined ? undefined : hook(block.attrs, ctx.hookValues);
          piece = { block, hooked: hook !== undefined, output, raw };
        } catch (err) {
          // Fail soft per block: one hook that cannot handle its attrs (an
          // external write is never validated away) must not take the rest of
          // the document down with it.
          const message = err instanceof Error ? err.message : String(err);
          const hookError = diagnostic(
            "E_BLOCK_HOOK_ERROR",
            `${block.type} block "${block.blockId}": "${projectorId}" hook threw: ${message}`,
            { nodeId: block.blockId },
          );
          piece = { block, hooked: true, output: undefined, raw, hookError };
        }
        parts.push(handlers.onBlock(piece, ctx));
      }
      cursor = rewrite.end;
    }
    pushProse(cursor, range.end);
  }
  return parts;
}

/**
 * Walk one node of a projection and splice its pieces into a string — the
 * string specialization of {@link walkProjectionParts}, and what both built-in
 * projectors use.
 * @param walk The node to render, its resolved values, and the projector id
 *   whose block hooks to dispatch to.
 * @param handlers What prose, a reference, a block, and an include each become.
 * @returns The node's rendered output.
 * @example
 * ```ts
 * // A projector that keeps the markdown and renders blocks through its own hooks.
 * const out = walkProjection(
 *   { node: tree.root, values, projectorId: "text", blockTypes },
 *   {
 *     onProse: (prose) => prose,
 *     onSource: (value) => value,
 *     onBlock: ({ output, raw }) => (output === undefined ? raw : String(output)),
 *     onInclude: (include) => `> ${include.node.heading ?? ""}`,
 *   },
 * );
 * ```
 */
export function walkProjection(
  walk: ProjectionWalkOptions,
  handlers: ProjectionWalkHandlers<string>,
): string {
  return walkProjectionParts(walk, handlers).join("");
}
