import type { SourcePosition } from "../model/doc.js";
import type { DocInfo } from "./doc-info.js";

/** The parts of a {@link DocInfo} the position queries read. */
type QueryInfo = Pick<DocInfo, "sections" | "blocks" | "frontmatterSpan">;

/** The most hits {@link findText} returns, whatever `limit` asks for. */
export const MAX_FIND_HITS = 25;
/** The query is first cut to this many UTF-16 code units. */
export const MAX_QUERY_WINDOW = 1024;
/** After the cut and NFC, the query keeps at most this many graphemes. */
export const MAX_QUERY_GRAPHEMES = 256;
/** After the cut and NFC, the query keeps at most this many UTF-8 bytes. */
export const MAX_QUERY_BYTES = 1024;

/** The section and block that hold an offset; `null` when none does. */
export interface Located {
  /** Index in `info.sections` of the deepest section whose span holds the offset. */
  readonly section: number | null;
  /** Index in `info.blocks` whose span holds the offset. */
  readonly block: number | null;
}

/** One match of {@link findText}. */
export interface TextHit extends Located {
  /** Inclusive start of the match in `src`. */
  readonly start: number;
  /** Exclusive end of the match in `src`. */
  readonly end: number;
  /** The position of `start`, in the same line and column terms as every other position. */
  readonly position: SourcePosition;
}

/** Options of {@link findText}. */
export interface FindTextOptions {
  /** The most hits to return, clamped to `1..`{@link MAX_FIND_HITS}. */
  readonly limit: number;
  /** Match case-insensitively with Unicode simple case folding. Defaults to `true`. */
  readonly ignoreCase?: boolean;
}

/** The result of {@link findText}. */
export interface FindTextResult {
  /** The matches, in document order, never overlapping. */
  readonly hits: readonly TextHit[];
  /** `true` when there is at least one more match after the last hit. */
  readonly more: boolean;
}

/** Sections nest at most six heading levels deep. */
const MAX_LEVELS = 6;

/**
 * Find the section and block that hold an offset. Both come from binary
 * searches over the spans in `info`; the section is then found by walking up
 * from the last section starting at or before the offset (at most six levels).
 * @param info A summary of the document (`engine.docInfo`).
 * @param offset An index into the source `info` describes.
 * @returns The deepest holding section and the holding block, each `null` when none holds it.
 */
export function locateOffset(info: Pick<DocInfo, "sections" | "blocks">, offset: number): Located {
  return { section: sectionAt(info.sections, offset), block: blockAt(info.blocks, offset) };
}

function sectionAt(sections: DocInfo["sections"], offset: number): number | null {
  let lo = 0;
  let hi = sections.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sections[mid] as DocInfo["sections"][number]).span.start <= offset) lo = mid + 1;
    else hi = mid;
  }
  let i: number | null = lo - 1 >= 0 ? lo - 1 : null;
  for (let steps = 0; i !== null && steps < MAX_LEVELS; steps += 1) {
    const section = sections[i];
    if (section === undefined) return null;
    if (offset >= section.span.start && offset < section.span.end) return i;
    i = section.parent;
  }
  return null;
}

function blockAt(blocks: DocInfo["blocks"], offset: number): number | null {
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const span = (blocks[mid] as DocInfo["blocks"][number]).span;
    if (span !== undefined && span.start <= offset) lo = mid + 1;
    else hi = mid;
  }
  const span = blocks[lo - 1]?.span;
  return span !== undefined && offset >= span.start && offset < span.end ? lo - 1 : null;
}

const encoder = new TextEncoder();

/** The query, bounded: a fixed window first, then NFC, then at most the grapheme and byte caps. */
function boundedQuery(query: string): string {
  let cut = query.slice(0, MAX_QUERY_WINDOW);
  const last = cut.charCodeAt(cut.length - 1);
  if (cut.length < query.length && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  const text = cut.normalize("NFC");
  let kept = "";
  let graphemes = 0;
  let bytes = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    text,
  )) {
    const size = encoder.encode(segment).length;
    if (graphemes + 1 > MAX_QUERY_GRAPHEMES || bytes + size > MAX_QUERY_BYTES) break;
    kept += segment;
    graphemes += 1;
    bytes += size;
  }
  return kept;
}

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/**
 * Find a text in a document's source and say where each match sits.
 *
 * - The query is literal and bounded (cut to {@link MAX_QUERY_WINDOW} code
 *   units, taken in NFC, then capped at {@link MAX_QUERY_GRAPHEMES} graphemes
 *   and {@link MAX_QUERY_BYTES} bytes). `src` is not normalized, so offsets
 *   stay exact. Whitespace around the query is ignored and each run of
 *   whitespace inside it matches any run of whitespace, line breaks included.
 *   An empty or all-whitespace query has no hits.
 * - `ignoreCase` (default `true`) uses Unicode simple case folding, which
 *   keeps offsets exact.
 * - Hits do not overlap, come in document order, and never start inside the
 *   frontmatter. The search stops after `limit + 1` matches (at most
 *   {@link MAX_FIND_HITS} + 1); the extra one sets `more`.
 * - Cost is at most O(n·m) for n source characters and m query characters;
 *   positions come from one forward pass and owners from binary searches.
 *
 * `info` must describe this exact `src` (the same version).
 * @param src The document source.
 * @param info The document's summary (`engine.docInfo`).
 * @param query The text to find.
 * @param options The hit limit and case handling.
 * @returns The hits and whether more exist.
 */
export function findText(
  src: string,
  info: QueryInfo,
  query: string,
  options: FindTextOptions,
): FindTextResult {
  const none = { hits: [], more: false } as const;
  const tokens = boundedQuery(query)
    .split(/\s+/u)
    .filter((t) => t !== "");
  if (tokens.length === 0) return none;
  const limit = Math.max(1, Math.min(MAX_FIND_HITS, Math.floor(options.limit) || 1));
  const re = new RegExp(
    tokens.map(escapeRegExp).join("\\s+"),
    options.ignoreCase === false ? "gu" : "giu",
  );
  re.lastIndex = info.frontmatterSpan?.end ?? 0;

  // Line and column of `offset`, counted forward from the previous hit.
  const bom = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  const positionOf = (offset: number): SourcePosition => {
    for (; scanned < offset; scanned += 1) {
      const c = src.charCodeAt(scanned);
      if (c === 10 || (c === 13 && src.charCodeAt(scanned + 1) !== 10)) {
        line += 1;
        lineStart = scanned + 1;
      }
    }
    return { line, col: offset - lineStart + 1 - (line === 1 ? bom : 0) };
  };

  const hits: TextHit[] = [];
  let more = false;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    if (hits.length === limit) {
      more = true;
      break;
    }
    const start = m.index;
    hits.push({
      start,
      end: start + m[0].length,
      position: positionOf(start),
      ...locateOffset(info, start),
    });
  }
  return { hits, more };
}
