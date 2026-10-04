import type { Root, Text } from "mdast";
import { visit } from "unist-util-visit";
import { type Diagnostic, diagnostic } from "../model/diagnostic.js";
import { asSectionId, tryDocId } from "../model/ids.js";
import type { InlineRef } from "../model/refs.js";

/**
 * Inline reference recognition. The ONLY recognized references are the two
 * reserved prefixes `{{source:…}}` and `{{include:docId[#sectionId]}}`; every
 * other `{{…}}` (Jinja, Handlebars, Vue/Angular, Go templates, GitHub-Actions
 * `${{ }}`, LLM prompt templates, …) is literal text — no diagnostic, preserved
 * verbatim by projection, accepted by writes. Malformed *reserved* refs
 * (`{{source:}}`, `{{include:a#b#c}}`) are still diagnosed as `E_REF_SYNTAX`
 * because the writer clearly meant a ref. Whitespace inside the braces is
 * tolerated (`{{ source:bank_balance }}`). Recognition applies only to ordinary
 * text nodes (code spans and fenced code are different node types and are exempt
 * by construction). `\{{` escapes render a literal `{{` and suppress recognition
 * — checked against the RAW source, because the CommonMark parser consumes the
 * backslash itself. A document's frontmatter `refs` opt-out narrows which kinds
 * are recognized; a kind that is opted out is literal text, not an error.
 */

export interface RefHit {
  readonly ref: InlineRef;
  /** Absolute offset of the `{{` in the raw source. */
  readonly offset: number;
  /** Absolute offset one past the closing `}}`. */
  readonly endOffset: number;
}

const REF_RE = /\{\{([^{}\n]*)\}\}/g;
const SOURCE_RE = /^source:([^\s]+)(?:\s+(.*))?$/;
const INCLUDE_RE = /^include:([^#\s]+)(?:#([^#\s]+))?$/;
const DEFAULT_REF_KINDS: ReadonlySet<"source" | "include"> = new Set(["source", "include"]);

/** Split params on whitespace, honoring single-quoted spans (which may contain spaces). */
function splitParams(rest: string): { tokens: string[]; unterminated: boolean } {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of rest) {
    if (inQuote) {
      if (ch === "'") inQuote = false;
      else current += ch;
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return { tokens, unterminated: inQuote };
}

function parseRefInner(
  inner: string,
  line: number,
  col: number,
  kinds: ReadonlySet<"source" | "include">,
): { ref?: InlineRef; diagnostic?: Diagnostic } {
  const fail = (message: string): { diagnostic: Diagnostic } => ({
    diagnostic: diagnostic("E_REF_SYNTAX", message, { line, col }),
  });

  const trimmed = inner.trim();
  let kind: "source" | "include" | undefined;
  if (trimmed.startsWith("source:")) kind = "source";
  else if (trimmed.startsWith("include:")) kind = "include";

  // Not a reserved prefix → literal text (templating languages, plain braces).
  if (kind === undefined) return {};
  // Opted out by frontmatter (`refs: false` / `refs: [include]`) → literal text.
  if (!kinds.has(kind)) return {};

  if (kind === "source") {
    const sourceMatch = SOURCE_RE.exec(trimmed);
    if (sourceMatch === null) return fail("source reference requires an id");
    const source = sourceMatch[1];
    if (source === undefined || source.length === 0) {
      return fail("source reference requires an id");
    }
    const { tokens, unterminated } = splitParams(sourceMatch[2] ?? "");
    if (unterminated) return fail("unterminated single-quoted parameter value");
    const params: Record<string, string> = {};
    for (const token of tokens) {
      const eq = token.indexOf("=");
      if (eq <= 0) return fail(`malformed parameter "${token}"`);
      params[token.slice(0, eq)] = token.slice(eq + 1);
    }
    return { ref: { kind: "source", source, params } };
  }

  const includeMatch = INCLUDE_RE.exec(trimmed);
  if (includeMatch === null) return fail("include reference requires a docId");
  const docId = includeMatch[1];
  if (docId === undefined || docId.length === 0) {
    return fail("include reference requires a docId");
  }
  // An include target is a document id like any other: path-shaped targets
  // (`../x`, `/abs`, backslashes, `.`/`..`/empty segments, `.md`) never become refs.
  const target = tryDocId(docId);
  if (!target.ok) {
    return {
      diagnostic: diagnostic(
        "E_INCLUDE_INVALID_TARGET",
        `include target ${JSON.stringify(docId)} is not a valid document id: ${target.diagnostic.message}`,
        { line, col },
      ),
    };
  }
  const section = includeMatch[2];
  const sectionId = section !== undefined && section.length > 0 ? asSectionId(section) : undefined;
  return {
    ref: {
      kind: "include",
      docId: target.id,
      ...(sectionId !== undefined ? { sectionId } : {}),
    },
  };
}

/** Absolute offset of a 1-based line/column position in the raw source. */
// (Kept for potential fallback use; recognition itself scans raw spans.)

/**
 * Extract inline references from a parsed tree by scanning the raw source spans
 * of its text nodes (so escape handling sees the original backslashes).
 * @param root The parsed markdown tree.
 * @param src The raw source text.
 * @param kinds The ref kinds to recognize (defaults to both `"source"` and `"include"`).
 * @returns Recognized refs, their raw spans, and any reference-syntax diagnostics.
 */
export function extractRefs(
  root: Root,
  src: string,
  kinds: ReadonlySet<"source" | "include"> = DEFAULT_REF_KINDS,
): { refs: InlineRef[]; hits: RefHit[]; diagnostics: Diagnostic[] } {
  const refs: InlineRef[] = [];
  const hits: RefHit[] = [];
  const diagnostics: Diagnostic[] = [];

  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === "\n") lineStarts.push(i + 1);
  }
  // Binary search over the sorted line starts: the line is the last one that
  // starts at or before `offset`.
  const lineColOf = (offset: number): { line: number; col: number } => {
    let lo = 0;
    let hi = lineStarts.length;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if ((lineStarts[mid] as number) <= offset) lo = mid;
      else hi = mid;
    }
    return { line: lo + 1, col: offset - (lineStarts[lo] as number) + 1 };
  };

  visit(root, "text", (node: Text) => {
    const pos = node.position;
    const rawStart = pos?.start.offset;
    const rawEnd = pos?.end.offset;
    if (rawStart === undefined || rawEnd === undefined) return;
    // Scan the RAW source span: the markdown parser already consumed escape
    // backslashes, so recognition must read the original bytes.
    const rawSpan = src.slice(rawStart, rawEnd);
    if (!rawSpan.includes("{{")) return;

    REF_RE.lastIndex = 0;
    for (let match = REF_RE.exec(rawSpan); match !== null; match = REF_RE.exec(rawSpan)) {
      // Escaped `\{{` renders literally and is not a reference.
      if (match.index > 0 && rawSpan[match.index - 1] === "\\") continue;

      const abs = rawStart + match.index;
      const { line, col } = lineColOf(abs);
      const inner = match[1];
      if (inner === undefined) continue;
      const { ref, diagnostic: d } = parseRefInner(inner, line, col, kinds);
      if (d !== undefined) {
        diagnostics.push(d);
        continue;
      }
      if (ref === undefined) continue;
      refs.push(ref);
      hits.push({ ref, offset: abs, endOffset: abs + match[0].length });
    }
  });

  return { refs, hits, diagnostics };
}
