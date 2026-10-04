import { type AttrChange, attributeChanges } from "../blocks/transitions.js";
import type { Block, DocNode, ParsedDoc, Section, SourceSpan } from "../model/doc.js";

/**
 * Structural diff at section/block granularity, keyed by stable ids. Attrs are
 * compared by deep equality, yielding changed paths; section prose is compared
 * with registered fenced blocks excluded, yielding `section.changed`.
 */

/** Attr changes observed on one block. */
export interface AttrChangeOnBlock {
  /** The block whose attrs changed. */
  readonly block: Block;
  /** The changed attr paths and their before/after values. */
  readonly changes: readonly AttrChange[];
}

/** A section whose prose changed between two documents (neither added nor removed). */
export interface SectionChange {
  /** The section in the "after" document (carries its id, position, and spans). */
  readonly section: Section;
}

/** The result of comparing two parsed documents. */
export interface StructuralDiff {
  /** Nodes present only in the "after" document. */
  readonly added: readonly DocNode[];
  /** Nodes present only in the "before" document. */
  readonly removed: readonly DocNode[];
  /** Attr changes on blocks present in both documents. */
  readonly attrChanges: readonly AttrChangeOnBlock[];
  /** Sections present in both documents whose prose changed. */
  readonly sectionChanges: readonly SectionChange[];
}

function nodesById(doc: ParsedDoc): Map<string, DocNode> {
  const map = new Map<string, DocNode>();
  for (const node of doc.nodes) {
    map.set("sectionId" in node ? node.sectionId : node.blockId, node);
  }
  return map;
}

function isBlock(node: DocNode): node is Block {
  return "blockId" in node;
}

function isSection(node: DocNode): node is Section {
  return "sectionId" in node;
}

function blocksOf(doc: ParsedDoc): Block[] {
  return doc.nodes.filter((n): n is Block => "blockId" in n);
}

/**
 * A section's prose: its {@link Section.content} with every registered fenced
 * block's span removed and the surrounding whitespace trimmed. Blocks are
 * excluded so a block attr change (which emits `block.updated`) never also
 * counts as a `section.changed`; trimming drops the structural separators (the
 * newline after the heading and before the next heading/block), so adding or
 * removing an adjacent section/block does not mark this section changed.
 * @param section The section to reduce.
 * @param blocks The document's blocks (their absolute source spans are cut out).
 * @returns The block-free, whitespace-trimmed prose.
 */
function sectionProse(section: Section, blocks: readonly Block[]): string {
  const ranges = section.contentSpans;
  if (ranges === undefined || ranges.length === 0) return section.content.trim();
  const blockSpans = blocks
    .map((b) => b.span)
    .filter((span): span is SourceSpan => span !== undefined)
    .sort((a, b) => a.start - b.start);
  if (blockSpans.length === 0) return section.content.trim();

  let prose = "";
  let offset = 0;
  for (const range of ranges) {
    const length = range.end - range.start;
    let cursor = range.start;
    for (const span of blockSpans) {
      const cutStart = Math.max(cursor, span.start);
      const cutEnd = Math.min(range.end, span.end);
      if (cutStart >= cutEnd) continue;
      prose += section.content.slice(
        offset + (cursor - range.start),
        offset + (cutStart - range.start),
      );
      cursor = cutEnd;
    }
    prose += section.content.slice(offset + (cursor - range.start), offset + length);
    offset += length;
  }
  return prose.trim();
}

/**
 * Compare two parsed documents at section/block granularity, keyed by stable
 * ids; blocks present in both are diffed attr-by-attr, and sections present in
 * both are diffed prose-by-prose.
 * @param before The earlier parse result.
 * @param after The later parse result.
 * @returns The added/removed nodes, the block attr changes, and the section prose changes.
 */
export function diffDocs(before: ParsedDoc, after: ParsedDoc): StructuralDiff {
  const beforeById = nodesById(before);
  const afterById = nodesById(after);
  const beforeBlocks = blocksOf(before);
  const afterBlocks = blocksOf(after);

  const added: DocNode[] = [];
  const removed: DocNode[] = [];
  const attrChanges: AttrChangeOnBlock[] = [];
  const sectionChanges: SectionChange[] = [];

  for (const [id, node] of afterById) {
    if (!beforeById.has(id)) added.push(node);
  }
  for (const [id, node] of beforeById) {
    if (!afterById.has(id)) removed.push(node);
  }

  for (const [id, afterNode] of afterById) {
    const beforeNode = beforeById.get(id);
    if (beforeNode === undefined) continue;
    if (isBlock(beforeNode) && isBlock(afterNode)) {
      const changes = attributeChanges(beforeNode.attrs, afterNode.attrs);
      if (changes.length > 0) {
        attrChanges.push({ block: afterNode, changes });
      }
      continue;
    }
    if (isSection(beforeNode) && isSection(afterNode)) {
      if (sectionProse(beforeNode, beforeBlocks) !== sectionProse(afterNode, afterBlocks)) {
        sectionChanges.push({ section: afterNode });
      }
    }
  }

  return { added, removed, attrChanges, sectionChanges };
}
