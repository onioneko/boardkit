import type { AnyBlockType } from "../blocks/types.js";
import type { Diagnostic } from "../model/diagnostic.js";
import { diagnostic } from "../model/diagnostic.js";
import type { ParsedDoc, SourceSpan } from "../model/doc.js";
import type { DocId, SectionId } from "../model/ids.js";
import type { InlineRef, SourceRef } from "../model/refs.js";
import type { Source, SourceValue } from "../ports/ports.js";
import { resolveRefs } from "../resolve/resolve.js";
import { type LinkResult, type LoadedDoc, type ResolvedInclude, sectionsOf } from "./graph.js";

/**
 * The merge stage: builds the merged projection tree from a LINK result. Each
 * node carries provenance `{docId, sectionId}`; include spans are replaced by
 * child nodes; cycles and missing targets are already broken/reported at LINK
 * and simply render as skipped edges here. Source files are never copied.
 *
 * MERGE and RESOLVE are separate stages and this module keeps them
 * strictly apart. MERGE ({@link buildMergedTree}) is pure structure —
 * provenance, ranges, srcs — and resolves nothing, so the tree is safe to
 * cache. RESOLVE ({@link resolveMergedValues}) is a separate per-projection
 * call the engine runs against the call-scoped Source; its values are passed
 * to projectors alongside the tree and never stored on it.
 */

/** Provenance of one merged node: the source doc and, for a section slice, its section. */
export interface Provenance {
  /** The document this node's content came from. */
  readonly docId: DocId;
  /** The section, when this node is a section slice. */
  readonly sectionId?: SectionId;
}

/** A node of the merged projection tree: one document, or one section slice of it. */
export interface MergedNode {
  /** Where this node's content came from. */
  readonly provenance: Provenance;
  /** The parsed document owning this node's source. */
  readonly doc: ParsedDoc;
  /** Raw source bytes of the owning document. */
  readonly src: string;
  /**
   * Exclusive byte ranges `[start, end)` in `src` that this node projects. For
   * a whole document this is `[{start: 0, end: src.length}]`; for a section it
   * is the section's exclusive `contentSpans` (deepest-section ownership —
   * nested sections are excluded, so nothing renders twice).
   */
  readonly ranges: readonly SourceSpan[];
  /** Heading text when this node is a section slice (surfaced by the text projector's blockquote). */
  readonly heading?: string;
  /** Include children, in document order. */
  readonly includes: readonly MergedInclude[];
}

/** One expanded include edge: the include span in the parent source and its merged child. */
export interface MergedInclude {
  /** The `{{include:…}}` span in the parent's source. */
  readonly span: SourceSpan;
  /** The merged child node that replaces the span. */
  readonly node: MergedNode;
}

/** The merged include tree, passed to projectors via `options.merged`. */
export interface MergedTree {
  /** The board document node (the projection root). */
  readonly root: MergedNode;
  /**
   * Problems found while building the tree — currently only `E_INCLUDE_LIMIT`
   * when expansion stopped at an {@link IncludeLimits} bound. They belong to
   * the tree, so a tree reused from a cache reports them again. Absent or
   * empty when the tree is complete.
   */
  readonly diagnostics?: readonly Diagnostic[];
}

/**
 * Bounds on include expansion for one merged tree. A document can be reached
 * through many include paths (`{{include:x}}` and `{{include:x#s}}` are
 * distinct includes, and a document reached through two includers is expanded
 * under each), and each path expands its own copy, so without a bound a few
 * small documents can multiply into an arbitrarily large tree. The bounds
 * count only included content — the board document itself is never cut.
 *
 * Includes are admitted breadth-first: every include of the board is
 * considered before any include nested inside them, and siblings in document
 * order. An include too large for what is left of `maxBytes` is skipped on
 * its own: it stays verbatim `{{include:…}}` text and later includes that fit
 * are still admitted. When an include would go past `maxNodes` or `maxDepth`,
 * expansion stops there: that include and every include not yet admitted stay
 * verbatim. Each kind of miss adds one `E_INCLUDE_LIMIT` diagnostic to the
 * tree, naming the first include it left out and the bound it hit.
 */
export interface IncludeLimits {
  /**
   * Most include expansions (merged nodes below the board) in one tree.
   * Bounds the tree's memory and the projectors' per-node work. Defaults to
   * {@link DEFAULT_INCLUDE_LIMITS}`.maxNodes` (1,000). A non-negative integer,
   * or `Infinity` for no bound.
   */
  readonly maxNodes?: number;
  /**
   * Most bytes of source text (UTF-8) that included documents and sections may
   * contribute to one tree, summed over every expansion. Bounds the projected
   * output when large documents are included many times. Defaults to
   * {@link DEFAULT_INCLUDE_LIMITS}`.maxBytes` (1 MiB). A non-negative integer,
   * or `Infinity` for no bound.
   */
  readonly maxBytes?: number;
  /**
   * Deepest include nesting: the board's own includes are depth 1, theirs
   * depth 2, and so on. Projectors render nested includes recursively, so
   * this keeps a long include chain from exhausting the call stack. Defaults
   * to {@link DEFAULT_INCLUDE_LIMITS}`.maxDepth` (64). A non-negative integer,
   * or `Infinity` for no bound.
   */
  readonly maxDepth?: number;
}

/** The default {@link IncludeLimits}: 1,000 included nodes, 1 MiB of included source, nesting depth 64. */
export const DEFAULT_INCLUDE_LIMITS: Readonly<Required<IncludeLimits>> = Object.freeze({
  maxNodes: 1_000,
  maxBytes: 1024 * 1024,
  maxDepth: 64,
});

const INCLUDE_LIMIT_KEYS = ["maxNodes", "maxBytes", "maxDepth"] as const;

/**
 * Fill in defaults and check {@link IncludeLimits} values.
 * @param limits The caller's limits; absent fields take their defaults.
 * @returns Every limit, defaults applied.
 * @throws {TypeError} When `limits` is not an object, names an unknown field,
 * or holds a value that is not a non-negative integer or `Infinity` (a
 * programming error, reported at construction rather than per projection).
 */
export function resolveIncludeLimits(limits?: IncludeLimits): Required<IncludeLimits> {
  if (limits === undefined) return { ...DEFAULT_INCLUDE_LIMITS };
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
    throw new TypeError(
      `includeLimits must be an object, got ${limits === null ? "null" : Array.isArray(limits) ? "an array" : typeof limits}`,
    );
  }
  const known: readonly string[] = INCLUDE_LIMIT_KEYS;
  for (const key of Object.keys(limits)) {
    if (!known.includes(key)) {
      throw new TypeError(
        `includeLimits has an unknown field ${JSON.stringify(key)} (expected ${INCLUDE_LIMIT_KEYS.join(", ")})`,
      );
    }
  }
  const resolved = { ...DEFAULT_INCLUDE_LIMITS };
  for (const key of INCLUDE_LIMIT_KEYS) {
    const value: unknown = limits[key];
    if (value === undefined) continue;
    if (typeof value !== "number") {
      throw new TypeError(
        `includeLimits.${key} must be a non-negative integer or Infinity, got a ${value === null ? "null" : typeof value} (${JSON.stringify(value)})`,
      );
    }
    if (!(value === Infinity || (Number.isInteger(value) && value >= 0))) {
      throw new TypeError(
        `includeLimits.${key} must be a non-negative integer or Infinity, got ${String(value)}`,
      );
    }
    resolved[key] = value;
  }
  return resolved;
}

/** Inputs for building a merged tree. */
export interface BuildMergedTreeOptions {
  /** The board document being projected. */
  readonly boardDocId: DocId;
  /** The LINK stage result (reachable docs, resolved edges, diagnostics). */
  readonly link: LinkResult;
  /** Expansion bounds; absent fields take {@link DEFAULT_INCLUDE_LIMITS}. */
  readonly limits?: IncludeLimits;
}

/** UTF-8 byte length of `src[start, end)`, without allocating. */
function utf8Length(src: string, start: number, end: number): number {
  let bytes = 0;
  for (let i = start; i < end; i += 1) {
    const c = src.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < end) {
      const next = src.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Index of the first element of `items` (sorted by `start`) whose start is ≥ `at`. */
function lowerBound<T extends { readonly start: number }>(items: readonly T[], at: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((items[mid] as T).start < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One include ref of a document, paired with LINK's resolved edge for it. */
interface IncludeSlot {
  readonly start: number;
  readonly end: number;
  readonly edge: ResolvedInclude;
}

/** What an include projects: the owning document, its section, ranges, and their UTF-8 size. */
interface Slice {
  readonly docId: DocId;
  readonly sectionId: SectionId | undefined;
  readonly doc: ParsedDoc;
  readonly src: string;
  readonly heading: string | undefined;
  readonly ranges: readonly SourceSpan[];
  readonly bytes: number;
}

/** A merged node under construction (its `includes` fill in as children are admitted). */
interface Pending {
  readonly node: MergedNode & { readonly includes: MergedInclude[] };
  readonly docId: DocId;
  readonly depth: number;
}

/**
 * Build the merged projection tree from a LINK result. This is the MERGE stage:
 * it does not re-run graph resolution — it consumes the already-resolved edges
 * (ok/missing/cycle/duplicate) and assembles the tree of {@link MergedNode}s.
 * It resolves nothing: the tree is pure structure, so callers pair it with a
 * separate {@link resolveMergedValues} call per projection and hand both to the
 * projector. Cycles and missing targets are skipped (their diagnostics are
 * LINK's); duplicate edges are skipped (their informational diagnostics are
 * LINK's too).
 *
 * Expansion is bounded by {@link IncludeLimits}: includes are admitted
 * breadth-first, siblings in document order. An include too large for the
 * remaining byte budget stays verbatim on its own; the first include past the
 * node or depth bound stays verbatim together with every include not yet
 * admitted. Each kind of miss is reported by one `E_INCLUDE_LIMIT` diagnostic
 * on the returned tree.
 * Per-document lookups (sections, include positions, slice sizes) are indexed
 * once per document, so building costs time proportional to the reachable
 * documents plus the admitted nodes, never to the number of include paths.
 * @param opts The board id, the LINK result, and optional expansion bounds.
 * @returns The merged tree rooted at the board document.
 * @throws {TypeError} When `opts.limits` holds an invalid value.
 */
export async function buildMergedTree(opts: BuildMergedTreeOptions): Promise<MergedTree> {
  const { boardDocId, link } = opts;
  const limits = resolveIncludeLimits(opts.limits);

  const docs = new Map<DocId, LoadedDoc>(link.docs.map((d) => [d.docId, d]));
  const edgesByFrom = new Map<DocId, ResolvedInclude[]>();
  for (const edge of link.includes) {
    const list = edgesByFrom.get(edge.fromDoc);
    if (list === undefined) edgesByFrom.set(edge.fromDoc, [edge]);
    else list.push(edge);
  }

  function loaded(docId: DocId): LoadedDoc {
    const doc = docs.get(docId);
    if (doc === undefined) {
      // Programming error: LINK resolved an ok edge to a doc it did not load.
      throw new Error(`merge: reachable doc not loaded: ${docId}`);
    }
    return doc;
  }

  // A document's include refs zipped with LINK's resolved edges (both are in
  // document order, one edge per include ref), sorted by position so a node
  // finds the includes inside its ranges by binary search.
  const slotsByDoc = new Map<DocId, readonly IncludeSlot[]>();
  function slotsOf(docId: DocId): readonly IncludeSlot[] {
    let slots = slotsByDoc.get(docId);
    if (slots === undefined) {
      const edges = edgesByFrom.get(docId) ?? [];
      const spans = loaded(docId).parsed.refSpans.filter((s) => s.ref.kind === "include");
      const list: IncludeSlot[] = [];
      for (let i = 0; i < edges.length && i < spans.length; i += 1) {
        const span = spans[i] as (typeof spans)[number];
        list.push({ start: span.start, end: span.end, edge: edges[i] as ResolvedInclude });
      }
      list.sort((a, b) => a.start - b.start);
      slots = list;
      slotsByDoc.set(docId, slots);
    }
    return slots;
  }

  const slices = new Map<string, Slice>();
  function sliceOf(docId: DocId, sectionId: SectionId | undefined): Slice {
    const key = `${docId}#${sectionId ?? ""}`;
    let slice = slices.get(key);
    if (slice === undefined) {
      const { parsed: doc, src } = loaded(docId);
      const section =
        sectionId === undefined
          ? undefined
          : sectionsOf(doc).find((s) => s.sectionId === sectionId);
      const ranges: readonly SourceSpan[] = section?.contentSpans ?? [
        { start: 0, end: src.length },
      ];
      let bytes = 0;
      for (const r of ranges) bytes += utf8Length(src, r.start, r.end);
      slice = { docId, sectionId, doc, src, heading: section?.heading, ranges, bytes };
      slices.set(key, slice);
    }
    return slice;
  }

  function nodeOf(slice: Slice): Pending["node"] {
    const { docId, sectionId, doc, src, heading, ranges } = slice;
    return {
      provenance: sectionId === undefined ? { docId } : { docId, sectionId },
      ...(heading !== undefined && sectionId !== undefined ? { heading } : {}),
      doc,
      src,
      ranges,
      includes: [],
    };
  }

  // Expansion budget, spent breadth-first. An include too large for the
  // remaining byte budget is skipped on its own (`oversized` records the first
  // one, `oversizedCount` all of them) and later includes that fit are still
  // admitted. Once an include hits the node or depth bound, `cut` records it
  // and every include not yet admitted is only counted (in `skipped`), never
  // built.
  let nodes = 0;
  let bytes = 0;
  let cut: { readonly edge: ResolvedInclude; readonly reason: string } | undefined;
  let skipped = 0;
  let oversized: ResolvedInclude | undefined;
  let oversizedCount = 0;

  function admit(edge: ResolvedInclude, slice: Slice, depth: number): boolean {
    if (depth > limits.maxDepth) {
      cut = { edge, reason: `${limits.maxDepth} levels of nested includes` };
      skipped += 1;
      return false;
    }
    if (nodes + 1 > limits.maxNodes) {
      cut = { edge, reason: `${limits.maxNodes} included nodes` };
      skipped += 1;
      return false;
    }
    if (bytes + slice.bytes > limits.maxBytes) {
      oversized ??= edge;
      oversizedCount += 1;
      return false;
    }
    nodes += 1;
    bytes += slice.bytes;
    return true;
  }

  const rootSlice = sliceOf(boardDocId, undefined);
  const root = nodeOf(rootSlice);
  const queue: Pending[] = [{ node: root, docId: boardDocId, depth: 0 }];
  for (let q = 0; q < queue.length; q += 1) {
    const { node, docId, depth } = queue[q] as Pending;
    const slots = slotsOf(docId);
    // Keep ok edges within the node's exclusive ranges (nested sections are
    // not owned by this node). Ranges are disjoint, so walking them in order
    // visits the slots in document order.
    const ranges = [...node.ranges].sort((a, b) => a.start - b.start);
    for (const r of ranges) {
      for (let i = lowerBound(slots, r.start); i < slots.length; i += 1) {
        const slot = slots[i] as IncludeSlot;
        if (slot.start >= r.end) break;
        if (slot.end > r.end) continue;
        const { edge } = slot;
        if (edge.status !== "ok") continue; // missing/cycle/duplicate → skip edge
        if (cut !== undefined) {
          skipped += 1; // past the limit: nothing more is expanded
          continue;
        }
        const slice = sliceOf(edge.toDoc, edge.sectionId);
        if (!admit(edge, slice, depth + 1)) continue;
        const child = nodeOf(slice);
        node.includes.push({ span: { start: slot.start, end: slot.end }, node: child });
        queue.push({ node: child, docId: edge.toDoc, depth: depth + 1 });
      }
    }
  }

  const diagnostics: Diagnostic[] = [];
  const includeText = (edge: ResolvedInclude): string =>
    `{{include:${edge.toDoc}${edge.sectionId !== undefined ? `#${edge.sectionId}` : ""}}}`;
  const tooLarge = oversized as ResolvedInclude | undefined;
  if (tooLarge !== undefined) {
    const others = oversizedCount - 1;
    diagnostics.push(
      diagnostic(
        "E_INCLUDE_LIMIT",
        `include did not fit the limit of ${limits.maxBytes} bytes of included content: ${includeText(tooLarge)} in ${tooLarge.fromDoc}` +
          (others > 0 ? ` and ${others} other include${others === 1 ? "" : "s"}` : "") +
          (others > 0 ? " were" : " was") +
          " not expanded",
        { nodeId: tooLarge.toDoc },
      ),
    );
  }
  const limitCut = cut as { readonly edge: ResolvedInclude; readonly reason: string } | undefined;
  if (limitCut !== undefined) {
    const { edge, reason } = limitCut;
    const further = skipped - 1;
    diagnostics.push(
      diagnostic(
        "E_INCLUDE_LIMIT",
        `include expansion stopped at the limit of ${reason}: ${includeText(edge)} in ${edge.fromDoc}` +
          (further > 0 ? ` and ${further} later include${further === 1 ? "" : "s"}` : "") +
          (further > 0 ? " were" : " was") +
          " not expanded",
        { nodeId: edge.toDoc },
      ),
    );
  }
  return { root, diagnostics };
}

/**
 * True for a well-formed {@link SourceRef}. `sources` is host-supplied and its
 * return type is only a compile-time promise, so each element is checked before
 * it reaches RESOLVE (where a missing `params` would throw in `canonicalKey`).
 * @param value The element a block type's `sources` returned.
 * @returns True when the element carries `kind`, `source`, and `params`.
 */
function isSourceRef(value: unknown): value is SourceRef {
  if (value === null || typeof value !== "object") return false;
  const ref = value as {
    readonly kind?: unknown;
    readonly source?: unknown;
    readonly params?: unknown;
  };
  return (
    ref.kind === "source" &&
    typeof ref.source === "string" &&
    typeof ref.params === "object" &&
    ref.params !== null
  );
}

/**
 * The live-value refs a document's blocks declare through their registered
 * types ({@link BlockType.sources}) — the block-side counterpart of prose
 * `{{source:…}}` refs, so a block type that knows its own fields need not
 * repeat them in prose. A block whose type is unregistered or declares no
 * `sources` contributes nothing; a `sources` that throws, returns a
 * non-iterable, or yields a malformed element contributes nothing either (the
 * bad element is skipped, its well-formed siblings are kept). One bad block
 * type degrades locally and the projection is never rejected (fail-soft).
 * @param doc The parsed document whose block nodes are inspected.
 * @param blockTypes The registered block types, keyed by type name.
 * @returns The declared source refs in document order (empty when there are none).
 */
export function blockSourceRefs(
  doc: ParsedDoc,
  blockTypes: ReadonlyMap<string, AnyBlockType>,
): readonly SourceRef[] {
  const refs: SourceRef[] = [];
  for (const node of doc.nodes) {
    if (!("blockId" in node)) continue;
    const declare = blockTypes.get(node.type)?.sources;
    if (declare === undefined) continue;
    try {
      for (const ref of declare(node.attrs)) {
        if (isSourceRef(ref)) refs.push(ref);
      }
    } catch {
      // A throwing `sources` (or a non-iterable result) contributes no refs.
    }
  }
  return refs;
}

/**
 * RESOLVE: resolve every source ref reachable in a LINK result through
 * the call-scoped Source port. This is a separate, per-projection stage that
 * runs alongside MERGE — its output is injected at projection time and is
 * never persisted on the merged tree. Refs come from every reachable document's
 * prose plus, when `blockTypes` is passed, its blocks' own declarations
 * ({@link blockSourceRefs}); the two are deduped together, so a source named by
 * both prose and a block is fetched once. Dedup by canonical key and bounded
 * concurrency (≤8) come from {@link resolveRefs}.
 * @param link The LINK result (reachable docs and their parsed refs).
 * @param source The call-scoped Source port.
 * @param blockTypes The registered block types, read per call so a block type
 * registered at runtime is picked up; omit it to resolve prose refs only.
 * @returns A fresh values map per call — each projection gets its own object,
 * so concurrent projections with different Sources cannot cross-contaminate.
 */
export async function resolveMergedValues(
  link: LinkResult,
  source: Source,
  blockTypes?: ReadonlyMap<string, AnyBlockType>,
): Promise<Map<string, SourceValue>> {
  const refs: InlineRef[] = [];
  for (const { parsed } of link.docs) {
    // Element-wise: a spread into push() overflows the stack on very large arrays.
    for (const ref of parsed.refs) refs.push(ref);
    if (blockTypes !== undefined)
      for (const ref of blockSourceRefs(parsed, blockTypes)) refs.push(ref);
  }
  return resolveRefs(refs, source);
}
