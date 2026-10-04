import type { Diagnostic } from "../model/diagnostic.js";
import type { ParsedDoc } from "../model/doc.js";
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
   * string, otherwise the text of the first level-1 heading (ATX `#` or
   * setext `===`, with any `{#anchor}` removed). A heading inside a fence, a
   * blockquote or a list is not a document heading and is never the title.
   * Absent when there is neither, or the first level-1 heading is empty.
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
     * The section's id, as `{{include:doc#id}}` addresses it: the heading's
     * explicit `{#anchor}` when it has one, otherwise its slug.
     */
    readonly sectionId: SectionId;
    /** The heading text, without its `{#anchor}`. */
    readonly heading: string;
    /** The heading depth, 1–6. */
    readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  }[];
  /** The document's typed blocks, in document order. */
  readonly blocks: readonly {
    /** The block's id. */
    readonly blockId: BlockId;
    /** The block's registered type name. */
    readonly type: string;
  }[];
  /** The parse's diagnostics (bad frontmatter, refs or blocks); empty for a clean parse. */
  readonly diagnostics: readonly Diagnostic[];
}

/** The parser's id for the synthetic section holding content before the first heading. */
const PREAMBLE_ID = "__preamble__";

/**
 * Summarize a parse as a {@link DocInfo}, copying everything out of it so the
 * (shared, cached) parse cannot be reached through the result.
 * @param docId The document's id.
 * @param version The version of the source `parsed` was parsed from.
 * @param parsed The parse.
 * @returns The summary.
 */
export function summarizeDoc(docId: DocId, version: string, parsed: ParsedDoc): DocInfo {
  const sections: { sectionId: SectionId; heading: string; level: 1 | 2 | 3 | 4 | 5 | 6 }[] = [];
  const blocks: { blockId: BlockId; type: string }[] = [];
  for (const node of parsed.nodes) {
    if ("blockId" in node) {
      blocks.push({ blockId: node.blockId, type: node.type });
    } else if (!(node.sectionId === PREAMBLE_ID && node.position === undefined)) {
      // The preamble is the one section without a heading position; a heading
      // anchored `{#__preamble__}` has a position and stays a heading.
      sections.push({ sectionId: node.sectionId, heading: node.heading, level: node.level });
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
    diagnostics: parsed.diagnostics.map((d) => structuredClone(d)),
  };
}

/** Frontmatter `title` (a non-blank string) wins; otherwise the first level-1 heading's text. */
function titleOf(
  frontmatter: Readonly<Record<string, unknown>>,
  sections: readonly { readonly heading: string; readonly level: number }[],
): string | undefined {
  const declared = frontmatter.title;
  if (typeof declared === "string" && declared.trim() !== "") return declared;
  const heading = sections.find((s) => s.level === 1)?.heading;
  return heading === undefined || heading === "" ? undefined : heading;
}
