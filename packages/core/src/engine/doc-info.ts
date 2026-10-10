import type { Diagnostic } from "../model/diagnostic.js";
import type { ParsedDoc, SourcePosition, SourceSpan } from "../model/doc.js";
import type { BlockId, DocId, SectionId } from "../model/ids.js";

/**
 * A summary of one parsed document, for hosts that list or label documents
 * (`engine.docInfo(docId)`). Every field is a copy: the engine's cached parse
 * stays private and unchanged whatever the caller does with it.
 */
export interface DocInfo {
  /** The document's id. */
  readonly docId: DocId;
  /** The committed version of the content summarized, as `getDoc` reports it. */
  readonly version: string;
  /**
   * The document's title: the frontmatter `title` when it is a non-blank
   * string (trimmed), otherwise the text of the first non-empty level-1
   * heading (ATX `#` or setext `===`, with any `{#anchor}` removed). A heading
   * inside a fence, a blockquote or a list is not a document heading and is
   * never the title. Absent when there is neither.
   *
   * Heading text is plain text, not rendered markdown: emphasis and link
   * markup are dropped, an image contributes nothing (its alt text is not
   * kept), and a `{{source:…}}` ref stays as its raw, unresolved token.
   */
  readonly title?: string;
  /** The document's YAML frontmatter, parsed to a mapping (empty when absent or invalid). */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /**
   * The document's headings, in document order: the top-level headings that
   * open sections. Content before the first heading has no heading and is not
   * listed.
   */
  readonly sections: readonly {
    /**
     * The section's id: the heading's explicit `{#anchor}` when it has one,
     * otherwise its slug. Ids are not guaranteed unique or non-empty: two
     * headings may carry the same explicit anchor (or an anchor equal to
     * another heading's slug), and an empty heading has an empty id. Key a
     * list by position, not by this id, and expect `{{include:doc#id}}` to
     * address the first section with that id.
     */
    readonly sectionId: SectionId;
    /**
     * The heading text, without its `{#anchor}`: plain text with markup
     * dropped and `{{source:…}}` refs left unresolved (see {@link DocInfo.title}).
     */
    readonly heading: string;
    /** The heading depth, 1–6. */
    readonly level: 1 | 2 | 3 | 4 | 5 | 6;
    /**
     * The section's whole extent in the source as given (a BOM counts):
     * from the start of its heading to where the section closes, subsections
     * included.
     */
    readonly span: SourceSpan;
    /** The index in `sections` of the nearest enclosing section, or `null` for a top-level one. */
    readonly parent: number | null;
    /** The 1-based position of the heading line. */
    readonly position?: SourcePosition;
    /**
     * `true` when {@link sectionId} is a literal `{#anchor}`; absent when it is
     * the heading's slug (which changes with the heading text).
     */
    readonly anchored?: true;
  }[];
  /** The document's typed blocks, in document order. */
  readonly blocks: readonly {
    /** The block's id. */
    readonly blockId: BlockId;
    /** The block's registered type name. */
    readonly type: string;
    /** The extent of the whole fenced block in the source as given. */
    readonly span?: SourceSpan;
    /** The 1-based position of the opening fence. */
    readonly position?: SourcePosition;
  }[];
  /** The extent of the YAML frontmatter (delimiters included) in the source as given; absent without one. */
  readonly frontmatterSpan?: SourceSpan;
  /** The parse's diagnostics (bad frontmatter, refs or blocks); empty for a clean parse. */
  readonly diagnostics: readonly Diagnostic[];
}

/** The parser's id for the synthetic section holding content before the first heading. */
const PREAMBLE_ID = "__preamble__";

/**
 * Summarize a parse as a {@link DocInfo}, copying everything out of it so the
 * (shared, cached) parse cannot be reached through the result. The copy can
 * throw on pathological frontmatter (nesting deeper than `structuredClone`'s
 * stack), so callers treat a throw as an unreadable document.
 * @param docId The document's id.
 * @param version The version of the source `parsed` was parsed from.
 * @param parsed The parse.
 * @returns The summary.
 */
export function summarizeDoc(docId: DocId, version: string, parsed: ParsedDoc): DocInfo {
  const sections: DocInfo["sections"][number][] = [];
  const blocks: DocInfo["blocks"][number][] = [];
  // Indexes in `sections` of the sections open at the current heading.
  const open: number[] = [];
  for (const node of parsed.nodes) {
    if ("blockId" in node) {
      blocks.push({
        blockId: node.blockId,
        type: node.type,
        ...(node.span !== undefined ? { span: { ...node.span } } : {}),
        ...(node.position !== undefined ? { position: { ...node.position } } : {}),
      });
    } else if (!(node.sectionId === PREAMBLE_ID && node.position === undefined)) {
      // The preamble is the one section without a heading position; a heading
      // anchored `{#__preamble__}` has a position and stays a heading.
      // Sections nest strictly, so the parent is the nearest open section that
      // still holds this one.
      const span = node.span === undefined ? { start: 0, end: 0 } : { ...node.span };
      while (open.length > 0) {
        const top = sections[open[open.length - 1] as number]?.span;
        if (top !== undefined && span.start >= top.start && span.end <= top.end) break;
        open.pop();
      }
      const parent = open.length > 0 ? (open[open.length - 1] as number) : null;
      open.push(sections.length);
      sections.push({
        sectionId: node.sectionId,
        heading: node.heading,
        level: node.level,
        span,
        parent,
        ...(node.position !== undefined ? { position: { ...node.position } } : {}),
        ...(node.anchored === true ? { anchored: true as const } : {}),
      });
    }
  }
  const frontmatter = structuredClone(parsed.frontmatter);
  const title = titleOf(frontmatter, sections);
  return {
    docId,
    version,
    ...(title !== undefined ? { title } : {}),
    frontmatter,
    sections,
    blocks,
    ...(parsed.frontmatterSpan !== undefined
      ? { frontmatterSpan: { ...parsed.frontmatterSpan } }
      : {}),
    diagnostics: parsed.diagnostics.map((d) => structuredClone(d)),
  };
}

/**
 * Frontmatter `title` (a non-blank string, trimmed) wins; otherwise the text of
 * the first non-empty level-1 heading.
 */
function titleOf(
  frontmatter: Readonly<Record<string, unknown>>,
  sections: readonly { readonly heading: string; readonly level: number }[],
): string | undefined {
  const declared = frontmatter.title;
  if (typeof declared === "string" && declared.trim() !== "") return declared.trim();
  return sections.find((s) => s.level === 1 && s.heading !== "")?.heading;
}
