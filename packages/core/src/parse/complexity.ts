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
   * from delimiter runs with the CommonMark flanking rules: a run that can
   * only open adds its length, a run that can only close subtracts it (never
   * below 0), and paragraphs reset as for `maxBracketDepth`. Defaults to 64.
   */
  readonly maxEmphasisDepth?: number;
}

/**
 * The default {@link ComplexityLimits}: 32 container markers on a line, 160
 * columns of prefix indentation, `[` nesting 32 deep, delimiter runs of 64,
 * and emphasis nesting 64 deep.
 */
export const DEFAULT_COMPLEXITY_LIMITS: Readonly<Required<ComplexityLimits>> = Object.freeze({
  maxContainerDepth: 32,
  maxIndentColumns: 160,
  maxBracketDepth: 32,
  maxDelimiterRun: 64,
  maxEmphasisDepth: 64,
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

/** CommonMark whitespace for flanking: a line edge counts as whitespace. */
function flankWhitespace(ch: string): boolean {
  return ch === "" || UNICODE_WHITESPACE.test(ch);
}

/** CommonMark punctuation for flanking (Unicode `P` and `S`). */
function flankPunctuation(ch: string): boolean {
  return ch !== "" && UNICODE_PUNCTUATION.test(ch);
}

/**
 * How a delimiter run changes the emphasis nesting estimate: +1 per character
 * for a run that can only open, -1 per character for one that can only close,
 * 0 for a run that can do both or neither.
 */
function emphasisDelta(code: number, length: number, before: string, after: string): number {
  const left =
    !flankWhitespace(after) &&
    (!flankPunctuation(after) || flankWhitespace(before) || flankPunctuation(before));
  const right =
    !flankWhitespace(before) &&
    (!flankPunctuation(before) || flankWhitespace(after) || flankPunctuation(after));
  let open = left;
  let close = right;
  if (code === 0x5f /* _ */) {
    open = left && (!right || flankPunctuation(before));
    close = right && (!left || flankPunctuation(after));
  }
  if (open && !close) return length;
  if (close && !open) return -length;
  return 0;
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

/**
 * The `E_DOCUMENT_TOO_COMPLEX` diagnostic for a source over a complexity
 * limit. One linear pass over the source, run before any parse: it reads
 * markdown structure only approximately (it does not know about code fences,
 * for example), erring towards counting more, never less.
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
  let line = 1;
  let i = 0;
  let bracketDepth = 0;
  let emphasisDepth = 0;
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
    if (blank && quotesOnly) {
      bracketDepth = 0;
      emphasisDepth = 0;
    }

    // Content: bracket nesting and delimiter runs, escapes skipped. A rule or
    // fence line holds neither.
    const contentStart = i;
    if (!blank && isRuleOrFenceLine(src, i)) {
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
        const delta = emphasisDelta(
          c,
          i - runStart,
          charBefore(src, runStart, contentStart),
          charAtPoint(src, i),
        );
        emphasisDepth = Math.max(0, emphasisDepth + delta);
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
 * value, as the pipeline modules receive it.
 * @param docId The document the source belongs to.
 * @param src The document source.
 * @param limits `undefined` for the defaults, `false` for no check, or the limits.
 * @param phase `"write"` or `"read"`, as for {@link documentComplexityDiagnostic}.
 * @returns The diagnostic, or `undefined` when within the limits or unchecked.
 */
export function complexityDiagnostic(
  docId: string,
  src: string,
  limits: ComplexityLimits | false | undefined,
  phase: "read" | "write",
): Diagnostic | undefined {
  if (limits === false) return undefined;
  const resolved =
    limits === undefined ? DEFAULT_COMPLEXITY_LIMITS : { ...DEFAULT_COMPLEXITY_LIMITS, ...limits };
  return documentComplexityDiagnostic(docId, src, resolved, phase);
}
