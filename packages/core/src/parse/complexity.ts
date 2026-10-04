import { type Diagnostic, diagnostic } from "../model/diagnostic.js";

/**
 * Bounds on markdown shapes that the markdown parser handles in superlinear
 * time or with deep recursion (`EngineOptions.complexityLimits`). Nested
 * containers are the worst case: parse time grows quadratically with nesting
 * depth, and a few thousand levels on one line overflow the call stack. A
 * document over any bound is never parsed. Each field is a non-negative
 * integer, or `Infinity` for no bound.
 */
export interface ComplexityLimits {
  /**
   * Most container markers at the start of one line: blockquote `>`, list
   * markers (`-`, `*`, `+`, `1.`, `1)`) and footnote definitions (`[^x]:`),
   * counted up to the first character of the line's content. Defaults to 32.
   */
  readonly maxContainerDepth?: number;
  /**
   * Most columns of whitespace in one line's prefix (the leading whitespace
   * plus the whitespace between its container markers), with a tab advancing
   * to the next multiple of 4. A line holding only whitespace is not counted.
   * Defaults to 160.
   */
  readonly maxIndentColumns?: number;
  /**
   * Deepest `[` nesting in one paragraph: each unescaped `[` opens a level, each
   * unescaped `]` closes one, and a blank line (or a line of only whitespace
   * and `>` markers) resets the count. Defaults to 32.
   */
  readonly maxBracketDepth?: number;
  /**
   * Longest run of one emphasis or strikethrough delimiter (`*`, `_` or `~`),
   * escaped characters excluded. A line holding only one such character (or
   * `-` or a backtick) and whitespace, a thematic break or a code fence, is not
   * counted. Defaults to 64.
   */
  readonly maxDelimiterRun?: number;
  /**
   * Deepest emphasis and strikethrough nesting in one paragraph, estimated
   * from delimiter runs with the parser's own open and close rules: a run
   * that can open (even if it could also close) adds its length to the count
   * for its marker, a run that can only close cancels up to its length of
   * openers of the same marker (and, for `~`, the same length) that could not
   * also close, and the limit applies to the sum of the counts. Paragraphs
   * reset as for `maxBracketDepth`, and fenced code is not counted. The
   * estimate is an upper bound, so some text is over-counted: `*` between
   * letters (`2*3`) or inside code spans (globs and regexes)
   * counts as opening, so a paragraph, table or tight list with more than 256
   * such runs is refused. Defaults to 256.
   */
  readonly maxEmphasisDepth?: number;
}

/**
 * The default {@link ComplexityLimits}: 32 container markers on a line, 160
 * columns of prefix indentation, `[` nesting 32 deep, delimiter runs of 64,
 * and emphasis nesting 256 deep.
 */
export const DEFAULT_COMPLEXITY_LIMITS: Readonly<Required<ComplexityLimits>> = Object.freeze({
  maxContainerDepth: 32,
  maxIndentColumns: 160,
  maxBracketDepth: 32,
  maxDelimiterRun: 64,
  maxEmphasisDepth: 256,
});

const COMPLEXITY_LIMIT_KEYS = [
  "maxContainerDepth",
  "maxIndentColumns",
  "maxBracketDepth",
  "maxDelimiterRun",
  "maxEmphasisDepth",
] as const satisfies readonly (keyof ComplexityLimits)[];

/** Longest footnote label GFM accepts. */
const MAX_FOOTNOTE_LABEL = 999;

const TAB = 9;
const LF = 10;
const CR = 13;
const SPACE = 32;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const UNICODE_WHITESPACE = /\s/u;
const UNICODE_PUNCTUATION = /[\p{P}\p{S}]/u;

/** The character (a whole code point) ending just before `i`, or `""` at `start`. */
function charBefore(src: string, i: number, start: number): string {
  if (i <= start) return "";
  const c = src.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i - 2 >= start) {
    const h = src.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return src.slice(i - 2, i);
  }
  return src.charAt(i - 1);
}

/** The character (a whole code point) starting at `i`, or `""` at a line end. */
function charAtPoint(src: string, i: number): string {
  if (i >= src.length || isLineEnd(src.charCodeAt(i))) return "";
  return String.fromCodePoint(src.codePointAt(i) ?? 0);
}

/** micromark's character classes for attention: 1 whitespace (or a line edge), 2 punctuation, 0 other. */
function classify(ch: string): 0 | 1 | 2 {
  if (ch === "" || UNICODE_WHITESPACE.test(ch)) return 1;
  if (UNICODE_PUNCTUATION.test(ch)) return 2;
  return 0;
}

/** The attention markers micromark knows with GFM: `*`, `_` and `~`. */
function isAttentionMarker(ch: string): boolean {
  return ch === "*" || ch === "_" || ch === "~";
}

/**
 * Whether a delimiter run can open and whether it can close, mirroring
 * micromark (`micromark-core-commonmark` attention and
 * `micromark-extension-gfm-strikethrough`), including the rule that a run
 * next to another attention marker can open (before it) or close (after it).
 * A tilde run longer than 2 is not a delimiter at all.
 * @param code The run's character code (`*`, `_` or `~`).
 * @param length The run's length.
 * @param before The character before the run (`""` at a line edge).
 * @param after The character after the run (`""` at a line edge).
 * @returns Whether the run can open and whether it can close.
 */
export function delimiterRunCan(
  code: number,
  length: number,
  before: string,
  after: string,
): { readonly open: boolean; readonly close: boolean } {
  const b = classify(before);
  const a = classify(after);
  if (code === 0x7e /* ~ */) {
    if (length > 2) return { open: false, close: false };
    return { open: a === 0 || (a === 2 && b !== 0), close: b === 0 || (b === 2 && a !== 0) };
  }
  const open = a === 0 || (a === 2 && b !== 0) || isAttentionMarker(after);
  const close = b === 0 || (b === 2 && a !== 0) || isAttentionMarker(before);
  if (code === 0x2a /* * */) return { open, close };
  return { open: open && (b !== 0 || !close), close: close && (a !== 0 || !open) };
}

/**
 * Whether the line content from `i` holds only one character from `*`, `_`,
 * `-`, `~` or a backtick, repeated, plus whitespace: a thematic break or a
 * code fence, never emphasis. Bounded by the line length.
 */
function isRuleOrFenceLine(src: string, i: number): boolean {
  const first = src.charCodeAt(i);
  if (first !== 0x2a && first !== 0x5f && first !== 0x2d && first !== 0x7e && first !== 0x60) {
    return false;
  }
  for (let j = i; j < src.length; j += 1) {
    const c = src.charCodeAt(j);
    if (isLineEnd(c)) break;
    if (c !== first && !isWhitespace(c)) return false;
  }
  return true;
}

function isWhitespace(c: number): boolean {
  return c === SPACE || c === TAB;
}

function isLineEnd(c: number): boolean {
  return c === LF || c === CR;
}

/** Whether `c` ends a list marker: whitespace, a line end, or the end of input (`NaN`). */
function endsMarker(c: number): boolean {
  return Number.isNaN(c) || isWhitespace(c) || isLineEnd(c);
}

/**
 * The length of the container marker starting at `i`, or 0 when there is none.
 * Bounded work: at most 10 characters for a list marker and
 * {@link MAX_FOOTNOTE_LABEL} plus 4 for a footnote definition.
 */
function markerLength(src: string, i: number): number {
  const c = src.charCodeAt(i);
  if (c === 0x3e /* > */) return 1;
  if (c === 0x2d /* - */ || c === 0x2a /* * */ || c === 0x2b /* + */) {
    return endsMarker(src.charCodeAt(i + 1)) ? 1 : 0;
  }
  if (c >= 0x30 && c <= 0x39) {
    let j = i;
    while (j - i < 9 && src.charCodeAt(j) >= 0x30 && src.charCodeAt(j) <= 0x39) j += 1;
    const d = src.charCodeAt(j);
    if ((d === 0x2e /* . */ || d === 0x29) /* ) */ && endsMarker(src.charCodeAt(j + 1))) {
      return j + 1 - i;
    }
    return 0;
  }
  if (c === 0x5b /* [ */ && src.charCodeAt(i + 1) === 0x5e /* ^ */) {
    let j = i + 2;
    while (j - i - 2 < MAX_FOOTNOTE_LABEL) {
      const d = src.charCodeAt(j);
      if (Number.isNaN(d) || isWhitespace(d) || isLineEnd(d) || d === 0x5b) return 0;
      if (d === 0x5d /* ] */) break;
      if (d === 0x5c /* \ */) j += 1;
      j += 1;
    }
    if (j === i + 2) return 0;
    if (src.charCodeAt(j) === 0x5d && src.charCodeAt(j + 1) === 0x3a /* : */) return j + 2 - i;
    return 0;
  }
  return 0;
}

const GT = 0x3e;
const BACKTICK = 0x60;
const TILDE = 0x7e;
const LT = 0x3c;
const FRONT_MATTER_FENCE = /^---[ \t]*$/;

/** A fence opened on a line: its block-quote depth, character and length. */
interface OpenFence {
  readonly quotes: number;
  readonly char: number;
  readonly length: number;
}

/** The length of the run of `char` starting at `p`, stopping at `end`. */
function runLength(src: string, p: number, end: number, char: number): number {
  let q = p;
  while (q < end && src.charCodeAt(q) === char) q += 1;
  return q - p;
}

/** Whether `src` between `p` and `end` holds a character `char`. */
function holds(src: string, p: number, end: number, char: number): boolean {
  for (let q = p; q < end; q += 1) if (src.charCodeAt(q) === char) return true;
  return false;
}

/** Whether `src` between `p` and `end` is only spaces and tabs. */
function onlyWhitespace(src: string, p: number, end: number): boolean {
  for (let q = p; q < end; q += 1) if (!isWhitespace(src.charCodeAt(q))) return false;
  return true;
}

/** Where a line's content starts after whitespace and any container markers. */
function contentAfterPrefix(src: string, start: number, end: number): number {
  let q = start;
  for (;;) {
    while (q < end && isWhitespace(src.charCodeAt(q))) q += 1;
    const len = q < end ? markerLength(src, q) : 0;
    if (len === 0) return q;
    q += len;
  }
}

/**
 * Classify a line outside fenced code: a fence opener the scan can follow
 * exactly, a fence-like line it cannot (`"unsure"`), or neither.
 *
 * Followed exactly: block-quote markers only, each straight after the last
 * (`>` and its optional space), then at most 1 space before 3 or more
 * backticks or tildes. A list item's content starts at least 2 columns in,
 * so such a line is never inside a list item or footnote: its container is
 * the block quote its markers name (or the document), and where the fence
 * ends is then known exactly.
 */
function openFence(src: string, start: number, end: number): OpenFence | "unsure" | undefined {
  let p = start;
  let quotes = 0;
  while (p < end && src.charCodeAt(p) === GT) {
    quotes += 1;
    p += 1;
    if (src.charCodeAt(p) === SPACE && p < end) p += 1;
  }
  let spaces = 0;
  while (p < end && src.charCodeAt(p) === SPACE) {
    spaces += 1;
    p += 1;
  }
  const strict = fenceRunAt(src, p, end);
  if (strict !== undefined) {
    if (strict === "not-a-fence") return undefined;
    if (spaces <= 1) return { quotes, char: strict.char, length: strict.length };
    return "unsure";
  }
  // Anywhere else (indented, after a list marker, after a tab), a fence-like
  // line may or may not open a fence, and its end depends on containers the
  // scan does not track.
  const loose = fenceRunAt(src, contentAfterPrefix(src, start, end), end);
  return loose === undefined || loose === "not-a-fence" ? undefined : "unsure";
}

/** A fence run of 3 or more at `p`, `"not-a-fence"` for a backtick run whose info has a backtick. */
function fenceRunAt(
  src: string,
  p: number,
  end: number,
): { readonly char: number; readonly length: number } | "not-a-fence" | undefined {
  const char = src.charCodeAt(p);
  if (p >= end || (char !== BACKTICK && char !== TILDE)) return undefined;
  const length = runLength(src, p, end, char);
  if (length < 3) return undefined;
  if (char === BACKTICK && holds(src, p + length, end, BACKTICK)) return "not-a-fence";
  return { char, length };
}

/**
 * Classify a line inside a fence: still `"code"`, the closing fence
 * (`"close"`, itself code), the end of the fence's block quote (`"ended"`:
 * the line is not code and is scanned as usual), or `"unsure"` when a tab
 * makes the columns ambiguous.
 */
function continueFence(
  src: string,
  start: number,
  end: number,
  fence: OpenFence,
): "code" | "close" | "ended" | "unsure" {
  let p = start;
  let tabbed = false;
  for (let q = 0; q < fence.quotes; q += 1) {
    let spaces = 0;
    while (p < end && src.charCodeAt(p) === SPACE) {
      spaces += 1;
      p += 1;
    }
    if (p < end && src.charCodeAt(p) === TAB) return "unsure";
    if (spaces > 3 || p >= end || src.charCodeAt(p) !== GT) return "ended";
    p += 1;
    if (p < end && src.charCodeAt(p) === SPACE) p += 1;
    else if (p < end && src.charCodeAt(p) === TAB) tabbed = true;
  }
  let spaces = 0;
  while (p < end && src.charCodeAt(p) === SPACE) {
    spaces += 1;
    p += 1;
  }
  if (spaces > 3) return "code";
  let r = p;
  while (r < end && isWhitespace(src.charCodeAt(r))) {
    tabbed = true;
    r += 1;
  }
  const length = runLength(src, r, end, fence.char);
  if (length < fence.length || !onlyWhitespace(src, r + length, end)) return "code";
  return tabbed ? "unsure" : "close";
}

/**
 * Which lines are fenced code, so the scan can skip their content: emphasis,
 * brackets and delimiter runs mean nothing there. A per-line flag: 0 for a
 * line the scan reads, 1 for fenced code (including a closing fence), 2 for
 * an opening fence (code too, and the end of any open paragraph).
 *
 * It follows CommonMark's fence rules (3 or more backticks or tildes, closed
 * by a run of the same character at least as long, indented at most 3
 * spaces, with nothing after it; an unclosed fence runs to the end of the
 * document or of its block quote), but only where it can follow them
 * exactly. Wherever it cannot be sure the parser reads a line as code, it
 * reads the line, and from the first line it cannot follow (a fence in a
 * list item, an indented or tab-indented fence, a line that may start an
 * HTML block) it skips nothing more. Front matter is never searched for
 * fences. Linear in the source length.
 * @param src The document source.
 * @returns One flag per line, split at LF, CR and CRLF.
 */
export function fencedCodeLines(src: string): Uint8Array {
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < src.length; ) {
    let j = i;
    while (j < src.length && !isLineEnd(src.charCodeAt(j))) j += 1;
    starts.push(i);
    ends.push(j);
    if (src.charCodeAt(j) === CR) {
      j += 1;
      if (src.charCodeAt(j) === LF) j += 1;
    } else if (src.charCodeAt(j) === LF) {
      j += 1;
    }
    i = j;
  }
  const flags = new Uint8Array(starts.length);
  let first = 0;
  if (src.startsWith("---")) {
    // Possible front matter: no fence opens before its closing line.
    first = 1;
    while (
      first < starts.length &&
      !FRONT_MATTER_FENCE.test(src.slice(starts[first], ends[first]))
    ) {
      first += 1;
    }
    first += 1;
  }
  let fence: OpenFence | undefined;
  for (let l = first; l < starts.length; l += 1) {
    const start = starts[l] ?? 0;
    const end = ends[l] ?? 0;
    if (fence !== undefined) {
      const state = continueFence(src, start, end, fence);
      if (state === "unsure") break;
      if (state === "code" || state === "close") {
        flags[l] = 1;
        if (state === "close") fence = undefined;
        continue;
      }
      fence = undefined;
    }
    const opened = openFence(src, start, end);
    if (opened === "unsure") break;
    if (opened !== undefined) {
      flags[l] = 2;
      fence = opened;
      continue;
    }
    // A line that may start an HTML block: fence-like lines inside it are
    // not fences, and the block's end is not tracked.
    if (src.charCodeAt(contentAfterPrefix(src, start, end)) === LT) break;
  }
  return flags;
}

/**
 * The `E_DOCUMENT_TOO_COMPLEX` diagnostic for a source over a complexity
 * limit. Linear passes over the source, run before any parse: it reads
 * markdown structure only approximately, erring towards counting more,
 * never less. Fenced code it can follow exactly ({@link fencedCodeLines}) is
 * not counted for brackets, delimiter runs or emphasis.
 * @param docId The document the source belongs to.
 * @param src The document source.
 * @param limits The bounds to check (every field set).
 * @param phase `"write"` for a proposed write that is not stored, `"read"` for
 *   a stored document that is not parsed.
 * @returns The diagnostic for the first bound exceeded, with its line and
 *   column, or `undefined` when the source is within every bound.
 */
export function documentComplexityDiagnostic(
  docId: string,
  src: string,
  limits: Readonly<Required<ComplexityLimits>>,
  phase: "read" | "write",
): Diagnostic | undefined {
  const fail = (line: number, col: number, what: string): Diagnostic =>
    diagnostic(
      "E_DOCUMENT_TOO_COMPLEX",
      `document ${JSON.stringify(docId)} ${what} at line ${line}; ${
        phase === "write" ? "the write was not stored" : "it was not parsed"
      }`,
      { line, col, nodeId: docId },
    );

  const n = src.length;
  const fences = fencedCodeLines(src);
  let line = 1;
  let i = 0;
  let bracketDepth = 0;
  // Emphasis nesting estimate. A closer only matches openers of its own marker
  // (and, for `~`, of its own length), and it is only sure to match an opener
  // that cannot also close (the rule of 3 can stop the others). So each
  // marker keeps open-only openers, which a close-only run may cancel, apart
  // from openers that could also close, which only a paragraph end resets.
  // Slots: `*` open-only, `*` both, `_` open-only, `_` both, `~` open-only,
  // `~~` open-only, `~` or `~~` both.
  const emphasis = [0, 0, 0, 0, 0, 0, 0];
  while (i < n) {
    const lineStart = i;
    // Prefix: whitespace and container markers, up to the line's content.
    let depth = 0;
    let indent = 0;
    let column = 0;
    let indentOverAt = -1;
    // Only whitespace and `>` markers so far: a line like that, with no
    // content, ends a paragraph. An empty list item does not.
    let quotesOnly = true;
    for (;;) {
      const c = src.charCodeAt(i);
      if (c === SPACE) {
        indent += 1;
        column += 1;
        if (indent > limits.maxIndentColumns && indentOverAt < 0) indentOverAt = i;
        i += 1;
        continue;
      }
      if (c === TAB) {
        const width = 4 - (column % 4);
        indent += width;
        column += width;
        if (indent > limits.maxIndentColumns && indentOverAt < 0) indentOverAt = i;
        i += 1;
        continue;
      }
      const len = i < n && !isLineEnd(c) ? markerLength(src, i) : 0;
      if (len === 0) break;
      if (src.charCodeAt(i) !== 0x3e /* > */) quotesOnly = false;
      depth += 1;
      if (depth > limits.maxContainerDepth) {
        return fail(
          line,
          i - lineStart + 1,
          `nests more than ${limits.maxContainerDepth} containers on one line (maxContainerDepth)`,
        );
      }
      column += len;
      i += len;
    }
    const blank = i >= n || isLineEnd(src.charCodeAt(i));
    if (!blank && indentOverAt >= 0) {
      return fail(
        line,
        indentOverAt - lineStart + 1,
        `indents a line more than ${limits.maxIndentColumns} columns (maxIndentColumns)`,
      );
    }
    const fenced = fences[line - 1] ?? 0;
    if ((blank && quotesOnly) || fenced === 2) {
      bracketDepth = 0;
      emphasis.fill(0);
    }

    // Content: bracket nesting and delimiter runs, escapes skipped. Fenced
    // code, a rule or a fence-like line holds neither.
    const contentStart = i;
    if (fenced !== 0 || (!blank && isRuleOrFenceLine(src, i))) {
      while (i < n && !isLineEnd(src.charCodeAt(i))) i += 1;
    }
    while (i < n) {
      const c = src.charCodeAt(i);
      if (isLineEnd(c)) break;
      if (c === 0x5c /* \ */) {
        const next = src.charAt(i + 1);
        i += next !== "" && ASCII_PUNCTUATION.test(next) ? 2 : 1;
        continue;
      }
      if (c === 0x2a || c === 0x5f || c === 0x7e) {
        const runStart = i;
        while (i < n && src.charCodeAt(i) === c) {
          if (i - runStart + 1 > limits.maxDelimiterRun) {
            return fail(
              line,
              i - lineStart + 1,
              `has a run of more than ${limits.maxDelimiterRun} ${String.fromCharCode(c)} delimiters (maxDelimiterRun)`,
            );
          }
          i += 1;
        }
        // Any run that can open adds its length (it may nest, even when it
        // could also close); a run that can only close cancels open-only
        // openers of its own marker (and length, for `~`).
        const length = i - runStart;
        const can = delimiterRunCan(
          c,
          length,
          charBefore(src, runStart, contentStart),
          charAtPoint(src, i),
        );
        const openOnly = c === 0x2a ? 0 : c === 0x5f ? 2 : length === 1 ? 4 : 5;
        const both = c === 0x2a ? 1 : c === 0x5f ? 3 : 6;
        if (can.open && can.close) emphasis[both] = (emphasis[both] ?? 0) + length;
        else if (can.open) emphasis[openOnly] = (emphasis[openOnly] ?? 0) + length;
        else if (can.close) emphasis[openOnly] = Math.max(0, (emphasis[openOnly] ?? 0) - length);
        let emphasisDepth = 0;
        for (const count of emphasis) emphasisDepth += count;
        if (emphasisDepth > limits.maxEmphasisDepth) {
          return fail(
            line,
            runStart - lineStart + 1,
            `nests emphasis more than ${limits.maxEmphasisDepth} deep in one paragraph (maxEmphasisDepth)`,
          );
        }
        continue;
      }
      if (c === 0x5b /* [ */) {
        bracketDepth += 1;
        if (bracketDepth > limits.maxBracketDepth) {
          return fail(
            line,
            i - lineStart + 1,
            `nests brackets more than ${limits.maxBracketDepth} deep in one paragraph (maxBracketDepth)`,
          );
        }
      } else if (c === 0x5d /* ] */ && bracketDepth > 0) {
        bracketDepth -= 1;
      }
      i += 1;
    }
    // Line end: CRLF, LF or CR.
    if (src.charCodeAt(i) === CR) {
      i += 1;
      if (src.charCodeAt(i) === LF) i += 1;
    } else if (src.charCodeAt(i) === LF) {
      i += 1;
    }
    line += 1;
  }
  return undefined;
}

/**
 * Validate a `complexityLimits` option.
 * @param value The option as passed: `undefined` takes the defaults, `false`
 *   turns the check off, and an object overrides the fields it sets.
 * @returns The resolved limits (every field set), or `false` when off.
 * @throws TypeError when the value is not `false` or an object of known fields,
 *   each a non-negative integer or `Infinity`.
 */
export function resolveComplexityLimits(
  value: ComplexityLimits | false | undefined,
): Readonly<Required<ComplexityLimits>> | false {
  if (value === undefined) return DEFAULT_COMPLEXITY_LIMITS;
  if (value === false) return false;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(
      `complexityLimits must be an object or false, got ${
        value === null ? "null" : Array.isArray(value) ? "an array" : String(value)
      }`,
    );
  }
  const known: readonly string[] = COMPLEXITY_LIMIT_KEYS;
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new TypeError(
        `complexityLimits has an unknown field ${JSON.stringify(key)} (expected ${COMPLEXITY_LIMIT_KEYS.join(", ")})`,
      );
    }
  }
  const resolved: Record<(typeof COMPLEXITY_LIMIT_KEYS)[number], number> = {
    ...DEFAULT_COMPLEXITY_LIMITS,
  };
  for (const key of COMPLEXITY_LIMIT_KEYS) {
    const field: unknown = value[key];
    if (field === undefined) continue;
    if (typeof field !== "number") {
      throw new TypeError(
        `complexityLimits.${key} must be a non-negative integer or Infinity, got a ${field === null ? "null" : typeof field} (${JSON.stringify(field)})`,
      );
    }
    if (!(field === Number.POSITIVE_INFINITY || (Number.isInteger(field) && field >= 0))) {
      throw new TypeError(
        `complexityLimits.${key} must be a non-negative integer or Infinity, got ${String(field)}`,
      );
    }
    resolved[key] = field;
  }
  return Object.freeze(resolved);
}

/**
 * The complexity diagnostic for a source under an optional, unresolved limits
 * value, as the pipeline modules receive it. The value is validated on every
 * call, the same way {@link resolveComplexityLimits} validates it.
 * @param docId The document the source belongs to.
 * @param src The document source.
 * @param limits `undefined` for the defaults, `false` for no check, or the limits.
 * @param phase `"write"` or `"read"`, as for {@link documentComplexityDiagnostic}.
 * @returns The diagnostic, or `undefined` when within the limits or unchecked.
 * @throws TypeError when `limits` is invalid (a programming error).
 */
export function complexityDiagnostic(
  docId: string,
  src: string,
  limits: ComplexityLimits | false | undefined,
  phase: "read" | "write",
): Diagnostic | undefined {
  const resolved = resolveComplexityLimits(limits);
  if (resolved === false) return undefined;
  return documentComplexityDiagnostic(docId, src, resolved, phase);
}
