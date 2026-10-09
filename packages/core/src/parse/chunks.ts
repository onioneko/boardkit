import { Buffer } from "node:buffer";
import { LRUCache } from "lru-cache";
import type { Nodes, Root, RootContent } from "mdast";
import { parseMarkdown } from "./markdown.js";

type Position = NonNullable<Root["position"]>;
type Point = Position["start"];

/**
 * Section-level incremental markdown parsing: the same mdast as one
 * {@link parseMarkdown} of the whole source, positions included, while an
 * edit re-parses only the sections it touches.
 *
 * - **Chunks.** The source is cut before every line that starts, in column 1,
 *   with an ATX heading opener (`#` to `######` followed by a space, a tab or
 *   the line's end), never inside a leading YAML frontmatter block. Such a
 *   line closes every open container and paragraph, so the markdown before it
 *   parses the same on its own, unless it ends in a leaf block that the line
 *   would continue.
 * - **Cache.** Each chunk is parsed alone and cached by its exact text, with
 *   positions relative to the chunk. Assembly copies its nodes with positions
 *   moved by the chunk's offset and line. Columns never move: chunks start at
 *   line starts.
 * - **Open leaves.** A chunk whose last block (or the last block of its last
 *   container, at any depth) is a fenced code block, an HTML block or a table
 *   that a following heading line could continue or end elsewhere is merged
 *   with the chunks after it, 1, 2, 4… more at a time, until it is closed or
 *   reaches the end. Merging is always exact; when in doubt a chunk counts as
 *   open.
 * - **Definitions.** Link reference definitions and footnote definitions are
 *   document-wide: a reference parses as one only when its label is defined
 *   somewhere. When a chunk may use a label defined only in another chunk, the
 *   whole source is parsed in one go instead.
 *
 * The rules encode block-structure facts about this markdown parser, so the
 * differential tests (`chunks.test.ts`, `scripts/parse-differential.ts`) must
 * pass again after any upgrade of `remark-parse`, `remark-gfm`,
 * `remark-frontmatter` or the micromark packages under them.
 * @module
 */

/** How many chunks the cache keeps, and how much of them, at most; and how it cuts. */
export interface ChunkCacheOptions {
  /** Most chunks. */
  readonly maxEntries: number;
  /** Most mdast nodes, over all the chunk trees. */
  readonly maxNodes: number;
  /** Most source, over all the chunks, in UTF-16 code units. */
  readonly maxSourceBytes: number;
  /**
   * Skip heading lines inside what a line scan takes for a fenced code block.
   * Default `true`. The result is the same either way; `false` makes merging
   * do the work, which the differential tests use to exercise it.
   */
  readonly fenceScan?: boolean;
}

/** What one {@link ChunkCache.parse} did. */
export interface ChunkParseStats {
  /** Chunks the result was assembled from (`1` for a whole parse). */
  readonly chunks: number;
  /** Markdown parses run. */
  readonly parsed: number;
  /** Characters handed to the markdown parser. */
  readonly parsedChars: number;
  /** Chunks taken from the cache. */
  readonly reused: number;
  /** Times an open chunk was extended over more chunks. */
  readonly merges: number;
  /**
   * Why the whole source was parsed in one go: `"single"` when it is one
   * chunk, `"definitions"` when a chunk may use a label another chunk defines.
   */
  readonly whole?: "single" | "definitions";
}

/** A bounded cache of parsed chunks, and the parse that uses it. */
export interface ChunkCache {
  /**
   * Parse `src`, re-using the chunks of earlier sources.
   * @param src The markdown source.
   * @returns A tree deep-equal to `parseMarkdown(src)`, positions included.
   *   It is a fresh tree, except for frozen leaf data it shares with the cache.
   */
  parse(src: string): Root;
  /** What the last parse did, or `undefined` before the first. */
  readonly last: ChunkParseStats | undefined;
  /** Chunks cached. */
  readonly size: number;
  /** Total mdast nodes of the cached chunks. */
  readonly nodes: number;
  /** Total source of the cached chunks, in UTF-16 code units. */
  readonly sourceBytes: number;
  /** Drop every cached chunk. */
  clear(): void;
}

/** A parsed chunk, positions relative to its own text. */
interface Chunk {
  /** The tree, deeply frozen; `undefined` for an open chunk kept only as such. */
  readonly root: Root | undefined;
  /** It ends in a leaf block a following heading line could change. */
  readonly open: boolean;
  /** Label keys ({@link labelKey}) of its link and footnote definitions. */
  readonly labels: readonly string[];
  /** Line endings in its text. */
  readonly lineEndings: number;
  /** Its size in mdast nodes, at least 1. */
  readonly nodes: number;
}

const LF = 10;
const CR = 13;
const HASH = 35;
const SPACE = 32;
const TAB = 9;
const BOM = 0xfeff;

/** End of the line starting at `at`, before its line ending. */
function lineEnd(src: string, at: number): number {
  let i = at;
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === LF || c === CR) break;
    i += 1;
  }
  return i;
}

/** Start of the line after the one ending at `end` (past its line ending). */
function nextLine(src: string, end: number): number {
  if (end >= src.length) return src.length;
  return end + (src.charCodeAt(end) === CR && src.charCodeAt(end + 1) === LF ? 2 : 1);
}

const FRONTMATTER_FENCE = /^---[ \t]*$/;

/**
 * Where cutting may start: past a leading YAML frontmatter block, as
 * `remark-frontmatter` finds it (an opening `---` on the first line, after a
 * byte order mark, and a closing `---` on a later line, each followed only by
 * spaces or tabs). `0` when the source does not open one. The length of the
 * source when it opens one that never closes: the parser's failed attempt
 * then changes how the rest of the document parses (block quotes and lists
 * are not recognized), so nothing may be cut.
 */
function frontmatterEnd(src: string, bom: number): number {
  const openEnd = lineEnd(src, bom);
  // The opening fence must be followed by a line ending.
  if (openEnd >= src.length || !FRONTMATTER_FENCE.test(src.slice(bom, openEnd))) return 0;
  for (let at = nextLine(src, openEnd); at < src.length; ) {
    const end = lineEnd(src, at);
    if (FRONTMATTER_FENCE.test(src.slice(at, end))) return nextLine(src, end);
    at = nextLine(src, end);
  }
  return src.length;
}

/** Is a column-1 ATX heading opener at `at` (a line start)? */
function headingLineAt(src: string, at: number): boolean {
  let i = at;
  while (i < src.length && i - at < 7 && src.charCodeAt(i) === HASH) i += 1;
  const hashes = i - at;
  if (hashes === 0 || hashes > 6) return false;
  if (i === src.length) return true;
  const c = src.charCodeAt(i);
  return c === SPACE || c === TAB || c === LF || c === CR;
}

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/;

/**
 * The chunk starts of `src`: `0`, then every heading line start at or after
 * `from`, except inside what a line scan takes for a fenced code block (a
 * `# comment` line in a shell fence, say). Skipping a cut only makes a chunk
 * larger, so the scan needs no precision: merging keeps the result exact
 * whatever is cut. It saves re-parsing the merged chunks on every edit.
 */
function chunkStarts(src: string, from: number, fenceScan: boolean): number[] {
  const starts = [0];
  let fence: string | undefined;
  for (let at = 0; at < src.length; ) {
    const end = lineEnd(src, at);
    const c = src.charCodeAt(at);
    if (c === HASH) {
      if (fence === undefined && at > 0 && at >= from && headingLineAt(src, at)) starts.push(at);
    } else if (fenceScan && (c === SPACE || c === 96 || c === 126)) {
      const m = FENCE_LINE.exec(src.slice(at, end));
      if (m !== null) {
        const run = m[1] as string;
        if (fence === undefined) {
          if (!(run[0] === "`" && (m[2] as string).includes("`"))) fence = run;
        } else if (
          run[0] === fence[0] &&
          run.length >= fence.length &&
          /^[ \t]*$/.test(m[2] as string)
        ) {
          fence = undefined;
        }
      }
    }
    at = nextLine(src, end);
  }
  return starts;
}

function countLineEndings(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === LF) n += 1;
    else if (c === CR) {
      n += 1;
      if (text.charCodeAt(i + 1) === LF) i += 1;
    }
  }
  return n;
}

const EOL = /\r\n|\r|\n/;

/** Does a whitespace-only line, ended by a line ending, follow `end` in `text`? */
function blankLineAfter(text: string, end: number): boolean {
  for (let at = nextLine(text, lineEnd(text, end)); at < text.length; ) {
    const e = lineEnd(text, at);
    if (e < text.length && /^[ \t]*$/.test(text.slice(at, e))) return true;
    at = nextLine(text, e);
  }
  return false;
}

/**
 * Could a heading line after `text` change this fenced code block? Unless its
 * last line is provably its closing fence: a fence run at least as long as
 * the opening one, of the same character, and not the end of its value (where
 * it would be content).
 */
function fenceOpen(node: { readonly value: string }, raw: string): boolean {
  const opening = /^[ \t]*(`{3,}|~{3,})/.exec(raw);
  // Indented code ends at the first line that is not indented.
  if (opening === null) return false;
  const fence = opening[1] as string;
  const lines = raw.split(EOL);
  if (lines.length < 2) return true;
  const closing = /^[ \t>]*(`+|~+)[ \t]*$/.exec(lines[lines.length - 1] as string);
  if (closing === null) return true;
  const run = closing[1] as string;
  if (run[0] !== fence[0] || run.length < fence.length) return true;
  return node.value.replace(/[ \t]+$/, "").endsWith(run);
}

/** HTML blocks of kinds 1 to 5: each ends at the line holding its end marker. */
const HTML_ENDS: readonly (readonly [RegExp, RegExp])[] = [
  [/^[ \t]*<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^[ \t]*<!--/, /-->/],
  [/^[ \t]*<\?/, /\?>/],
  [/^[ \t]*<!\[CDATA\[/, /\]\]>/],
  [/^[ \t]*<![A-Za-z]/, />/],
];

/** Could a heading line after `text` continue this HTML block? */
function htmlOpen(raw: string, text: string, end: number): boolean {
  for (const [open, close] of HTML_ENDS) {
    const m = open.exec(raw);
    // Only a marker after the opener counts (conservative for `<!-->`).
    if (m !== null) return !close.test(raw.slice(m[0].length));
  }
  // Kinds 6 and 7 end only at a blank line.
  return !blankLineAfter(text, end);
}

/** Does the chunk end in a leaf block, at any depth, that a following heading line could change? */
function endsOpen(root: Root, text: string): boolean {
  // Offsets do not count a byte order mark.
  const bom = text.charCodeAt(0) === BOM ? 1 : 0;
  let node: Nodes | undefined = root.children.at(-1);
  while (node !== undefined) {
    const startOffset = node.position?.start.offset;
    const endOffset = node.position?.end.offset;
    if (startOffset === undefined || endOffset === undefined) return true;
    const start = startOffset + bom;
    const end = endOffset + bom;
    if (node.type === "code" && fenceOpen(node, text.slice(start, end))) return true;
    if (node.type === "html" && htmlOpen(text.slice(start, end), text, end)) return true;
    // A table runs to a blank line (conservative: whether a heading ends it is not relied on).
    if (node.type === "table" && !blankLineAfter(text, end)) return true;
    node = "children" in node ? (node.children.at(-1) as Nodes | undefined) : undefined;
  }
  return false;
}

/**
 * The key a definition label and the text of a possible reference to it are
 * compared by: case-folded like the parser's label matching, with all
 * whitespace and `>` removed so that a label broken over block quote lines
 * still matches. Labels the parser treats as equal always get equal keys.
 */
function labelKey(label: string): string {
  return label
    .replace(/[\s>]+/g, "")
    .toLowerCase()
    .toUpperCase();
}

/** Label keys of the definitions and footnote definitions in a tree, and its node count. */
function scan(root: Root): { labels: string[]; nodes: number } {
  const labels: string[] = [];
  let nodes = 0;
  const stack: Nodes[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    nodes += 1;
    if (node.type === "definition" || node.type === "footnoteDefinition") {
      labels.push(labelKey(node.label ?? node.identifier));
    }
    if ("children" in node) for (const child of node.children) stack.push(child as Nodes);
  }
  return { labels, nodes };
}

/** Longest label text the parser accepts. */
const MAX_LABEL = 999;

/**
 * Keys of every bracketed run of `text` (between an unescaped `[` and the next
 * unescaped `]`, with no unescaped `[` inside): the labels a reference in the
 * text could use.
 */
function bracketKeys(text: string): Set<string> {
  const keys = new Set<string>();
  let open = -1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "\\") i += 1;
    else if (c === "[") open = i + 1;
    else if (c === "]" && open >= 0) {
      if (i - open <= MAX_LABEL * 2) keys.add(labelKey(text.slice(open, i)));
      open = -1;
    }
  }
  return keys;
}

function deepFreeze(root: object): void {
  const stack: object[] = [root];
  for (let value = stack.pop(); value !== undefined; value = stack.pop()) {
    if (Object.isFrozen(value)) continue;
    Object.freeze(value);
    for (const child of Object.values(value)) {
      if (typeof child === "object" && child !== null) stack.push(child);
    }
  }
}

function movePoint(p: Point, offset: number, lines: number): Point {
  return { line: p.line + lines, column: p.column, offset: (p.offset ?? 0) + offset };
}

/** A copy of `node` and its descendants with positions moved by `offset` characters and `lines` lines. */
function moved<T extends Nodes>(node: T, offset: number, lines: number): T {
  const copy: Record<string, unknown> = { ...node };
  const p: Position | undefined = node.position;
  if (p !== undefined) {
    copy.position = {
      start: movePoint(p.start, offset, lines),
      end: movePoint(p.end, offset, lines),
    };
  }
  if ("children" in node) {
    copy.children = (node.children as Nodes[]).map((child) => moved(child, offset, lines));
  }
  return copy as T;
}

/**
 * A copy of `text` that shares no memory with the source it was sliced from,
 * so a cached chunk (and the strings its tree slices from it) does not keep
 * the whole document it came from alive.
 */
function detached(text: string): string {
  return Buffer.from(text, "utf16le").toString("utf16le");
}

/** One chunk of the source being parsed. */
interface Part {
  readonly start: number;
  readonly end: number;
  readonly chunk: Chunk;
}

/**
 * Create a chunk cache: an LRU bounded by chunk count, by the mdast nodes of
 * the chunk trees and by the chunks' source. A chunk larger than either size
 * budget is parsed but not kept, and a source that is one chunk is parsed
 * whole and never kept (the parse cache already keeps whole parses).
 * @param limits The bounds.
 * @returns The cache.
 */
export function createChunkCache(limits: ChunkCacheOptions): ChunkCache {
  let sourceBytes = 0;
  const cache = new LRUCache<string, Chunk>({
    max: limits.maxEntries,
    maxSize: limits.maxNodes,
    dispose: (_chunk, text) => {
      sourceBytes -= text.length;
    },
  });
  let last: ChunkParseStats | undefined;

  const parse = (src: string): Root => {
    let parsed = 0;
    let parsedChars = 0;
    let reused = 0;
    let merges = 0;
    const whole = (why: "single" | "definitions", chunks: number): Root => {
      parsed += 1;
      parsedChars += src.length;
      last = { chunks, parsed, parsedChars, reused, merges, whole: why };
      return parseMarkdown(src);
    };

    const bom = src.charCodeAt(0) === BOM ? 1 : 0;
    const starts = chunkStarts(src, frontmatterEnd(src, bom), limits.fenceScan ?? true);
    if (starts.length === 1) return whole("single", 1);
    starts.push(src.length);
    if (showsForeignLabel(src, starts)) return whole("definitions", starts.length - 1);

    /** The chunk `[start, end)`: cached, or parsed (and cached unless it is the whole source). */
    const chunkAt = (start: number, end: number): Chunk => {
      const text = src.slice(start, end);
      const isWhole = start === 0 && end === src.length;
      // The tree of an open chunk is used only when it ends the source.
      const needTree = end === src.length;
      const hit = isWhole ? undefined : cache.get(text);
      if (hit !== undefined && (hit.root !== undefined || !needTree)) {
        reused += 1;
        return hit;
      }
      parsed += 1;
      parsedChars += text.length;
      const own = isWhole ? text : detached(text);
      const root = parseMarkdown(own);
      const open = endsOpen(root, own);
      const { labels, nodes } = scan(root);
      const keep = open && !needTree ? undefined : root;
      const chunk: Chunk = {
        root: keep,
        open,
        labels,
        lineEndings: countLineEndings(own),
        nodes: keep === undefined ? 1 : nodes,
      };
      if (!isWhole && chunk.nodes <= limits.maxNodes && own.length <= limits.maxSourceBytes) {
        if (keep !== undefined) deepFreeze(keep);
        cache.delete(own);
        cache.set(own, chunk, { size: chunk.nodes });
        if (cache.has(own)) {
          sourceBytes += own.length;
          while (sourceBytes > limits.maxSourceBytes && cache.size > 0) cache.pop();
        }
      }
      return chunk;
    };

    const parts: Part[] = [];
    const lastIndex = starts.length - 1;
    for (let i = 0; i < lastIndex; ) {
      const start = starts[i] as number;
      let j = i + 1;
      let chunk = chunkAt(start, starts[j] as number);
      // Grow an open chunk 1, 2, 4… chunks at a time, so that an unclosed
      // fence near the top costs a bounded multiple of one whole parse.
      for (let step = 1; chunk.open && j < lastIndex; step *= 2) {
        j = Math.min(lastIndex, j + step);
        merges += 1;
        chunk = chunkAt(start, starts[j] as number);
      }
      parts.push({ start, end: starts[j] as number, chunk });
      i = j;
    }

    const only = parts[0] as Part;
    if (parts.length === 1) {
      // Merged into one chunk spanning the source: it was parsed whole, not shared.
      last = { chunks: 1, parsed, parsedChars, reused, merges };
      return only.chunk.root as Root;
    }
    if (usesForeignLabel(src, parts)) return whole("definitions", parts.length);

    const children: RootContent[] = [];
    let lines = 0;
    for (const part of parts) {
      // Offsets do not count a byte order mark.
      const offset = part.start === 0 ? 0 : part.start - bom;
      for (const child of (part.chunk.root as Root).children) {
        children.push(moved(child, offset, lines));
      }
      if (part !== parts[parts.length - 1]) lines += part.chunk.lineEndings;
    }
    const tail = parts[parts.length - 1] as Part;
    const end = (tail.chunk.root as Root).position?.end;
    const root: Root = { type: "root", children };
    if (end !== undefined) {
      root.position = {
        start: { line: 1, column: 1, offset: 0 },
        end: movePoint(end, tail.start - bom, lines),
      };
    }
    last = { chunks: parts.length, parsed, parsedChars, reused, merges };
    return root;
  };

  return {
    parse,
    get last() {
      return last;
    },
    get size() {
      return cache.size;
    },
    get nodes() {
      return cache.calculatedSize;
    },
    get sourceBytes() {
      return sourceBytes;
    },
    clear() {
      cache.clear();
      sourceBytes = 0;
    },
  };
}

/** May some chunk use a definition label that only another chunk defines? */
function usesForeignLabel(src: string, parts: readonly Part[]): boolean {
  const all = new Set<string>();
  for (const part of parts) for (const label of part.chunk.labels) all.add(label);
  if (all.size === 0) return false;
  for (const part of parts) {
    const own = new Set(part.chunk.labels);
    if (own.size === all.size) continue;
    const keys = bracketKeys(src.slice(part.start, part.end));
    for (const label of all) {
      if (!own.has(label) && (keys.has(label) || keys.has(`^${label}`))) return true;
    }
  }
  return false;
}

/** A line that looks like a link or footnote definition: its label, without a footnote's `^`. */
const DEFINITION_LINE = /^[ \t>]*\[\^?((?:[^\\[\]\r\n]|\\.){1,999})\]:/gm;

/**
 * Does the text already show that some chunk uses a label another chunk
 * defines? Checked before any chunk is parsed, so that a document whose
 * definitions sit in a footer section is parsed whole once, not in chunks
 * and then whole. Only a shortcut: a definition the line pattern misses is
 * caught after parsing by {@link usesForeignLabel}.
 * @param src The source.
 * @param starts The chunk starts, then the source's length.
 */
function showsForeignLabel(src: string, starts: readonly number[]): boolean {
  // Label key → the chunks that define it.
  const definedIn = new Map<string, Set<number>>();
  let chunk = 0;
  for (let m = DEFINITION_LINE.exec(src); m !== null; m = DEFINITION_LINE.exec(src)) {
    while (m.index >= (starts[chunk + 1] as number)) chunk += 1;
    const key = labelKey(m[1] as string);
    const chunks = definedIn.get(key) ?? new Set<number>();
    chunks.add(chunk);
    definedIn.set(key, chunks);
  }
  DEFINITION_LINE.lastIndex = 0;
  if (definedIn.size === 0) return false;
  for (let k = 0; k < starts.length - 1; k += 1) {
    const used = bracketKeys(src.slice(starts[k], starts[k + 1]));
    for (const [key, chunks] of definedIn) {
      if (!chunks.has(k) && (used.has(key) || used.has(`^${key}`))) return true;
    }
  }
  return false;
}
