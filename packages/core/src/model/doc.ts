import type { Diagnostic } from "./diagnostic.js";
import type { BlockId, SectionId } from "./ids.js";
import type { InlineRef } from "./refs.js";

/** 1-based source position (line and column) within a document's raw source. */
export interface SourcePosition {
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column number. */
  readonly col: number;
}

/** Raw source byte range (0-based, half-open `[start, end)`), used for span rewriting. */
export interface SourceSpan {
  /** Inclusive 0-based byte offset where the range begins. */
  readonly start: number;
  /** Exclusive 0-based byte offset where the range ends. */
  readonly end: number;
}

/** A recognized inline reference together with its raw source span. */
export interface RefSpan {
  /** Inclusive 0-based byte offset of the opening `{{`. */
  readonly start: number;
  /** Exclusive 0-based byte offset one past the closing `}}`. */
  readonly end: number;
  /** The recognized reference. */
  readonly ref: InlineRef;
}

/** A heading-scoped region of the document. Content ownership is exclusive (no overlap with nested sections). */
export interface Section {
  /** The section's id: an explicit `{#anchor}` or the heading slug. */
  readonly sectionId: SectionId;
  /** Heading text without the `{#anchor}` suffix. */
  readonly heading: string;
  /** Heading depth, 1–6. */
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  /** Verbatim markdown owned by this section (nested sections excluded). */
  readonly content: string;
  /** Inline refs whose spans fall inside this section. */
  readonly refs: readonly InlineRef[];
  /** 1-based position of the heading line, when available. */
  readonly position?: SourcePosition;
  /**
   * Exclusive source ranges (deepest-section ownership): the byte ranges whose
   * slices concatenate to {@link content}. Each range excludes nested sections,
   * so a parent's spans never overlap a child's. The merge stage uses these to
   * slice an included section without re-parsing.
   */
  readonly contentSpans?: readonly SourceSpan[];
}

/** A typed, stateful document component (fenced block). */
export interface Block {
  /** The block's `id` attr, unique within its document. */
  readonly blockId: BlockId;
  /** Registered block type name (the fenced info string). */
  readonly type: string;
  /** Parsed YAML body; schema validation happens elsewhere. */
  readonly attrs: Record<string, unknown>;
  /** 1-based position of the opening fence, when available. */
  readonly position?: SourcePosition;
  /** Raw source span of the whole fenced block, when available (for span rewriting). */
  readonly span?: SourceSpan;
}

/** A node of a parsed document: either a prose Section or a typed Block. */
export type DocNode = Section | Block;

/** The result of parsing one document. Content errors live in `diagnostics`. */
export interface ParsedDoc {
  /** The document's YAML frontmatter, parsed to a mapping (empty when absent). */
  readonly frontmatter: Record<string, unknown>;
  /**
   * Byte span of the leading YAML frontmatter block (both fences), when present.
   * The text projector uses this to omit frontmatter by default.
   */
  readonly frontmatterSpan?: SourceSpan;
  /** Sections and typed blocks, in document order. */
  readonly nodes: readonly DocNode[];
  /** All inline refs in the document, in document order (incl. those inside sections). */
  readonly refs: readonly InlineRef[];
  /** Raw source spans of every recognized reference (span-rewriting input). */
  readonly refSpans: readonly RefSpan[];
  /** Parse-time problems (bad frontmatter/refs/blocks), reported rather than thrown. */
  readonly diagnostics: readonly Diagnostic[];
}
