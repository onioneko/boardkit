import type GithubSlugger from "github-slugger";
import type { Heading, Root } from "mdast";
import type { Section, SourcePosition, SourceSpan } from "../model/doc.js";
import { asSectionId } from "../model/ids.js";
import type { InlineRef } from "../model/refs.js";
import type { RefHit } from "./refs.js";

/**
 * Section extraction: every heading opens a Section. Content ownership is
 * exclusive — a parent section's content excludes the heading lines and bodies
 * of nested (deeper) sections, so projected content never renders twice.
 *
 * Content before the first heading ("preamble") has no natural owner; it is
 * preserved as a synthetic section with sectionId `__preamble__`.
 */

// Matched against the heading text with trailing whitespace already trimmed,
// and anchored at the end with no leading `\s*`, so a long run of whitespace
// cannot make the match quadratic (a leading `\s*` retries the whole run from
// every whitespace character).
const ANCHOR_RE = /\{#([A-Za-z0-9_-]+)\}$/;

/** Split a trailing `{#anchor}` off heading text: the anchor and the heading before it. */
function splitAnchor(text: string): { anchor?: string; heading: string } {
  const trimmed = text.trimEnd();
  const match = ANCHOR_RE.exec(trimmed);
  const anchor = match?.[1];
  if (match === null || anchor === undefined) return { heading: text };
  return { anchor, heading: trimmed.slice(0, match.index).trimEnd() };
}

/** A positioned section span; the pipeline assembles the final Section (refs included). */
export interface SectionSpan {
  readonly sectionId: Section["sectionId"];
  readonly heading: string;
  readonly level: Section["level"];
  readonly position?: SourcePosition;
  /** Offset of the heading line start (used to exclude nested sections from parents). */
  readonly headingStart: number;
  /** Offset where the section's own content begins (heading line end). */
  readonly startOffset: number;
  readonly endOffset: number;
  readonly content: string;
  /**
   * Exclusive source ranges (deepest-section ownership) whose slices
   * concatenate to `content`. Unlike `[startOffset, endOffset)`, these exclude
   * nested sections, so a parent's spans never overlap a child's.
   */
  readonly contentSpans: readonly SourceSpan[];
}

/** Extract the plain text of a heading (text + inline code, recursing through phrasing containers). */
function headingText(heading: Heading): string {
  let out = "";
  for (const child of heading.children) {
    if (child.type === "text" || child.type === "inlineCode") {
      out += child.value;
    } else if ("children" in child) {
      for (const grand of child.children) {
        if (grand.type === "text" || grand.type === "inlineCode") out += grand.value;
      }
    }
  }
  return out;
}

/** Offset where document content begins (after the leading YAML frontmatter node, if any). */
function contentStartOffset(root: Root): number {
  const first = root.children[0];
  if (first?.type === "yaml") return first.position?.end.offset ?? 0;
  return 0;
}

/**
 * Extract positioned section spans from a parsed mdast tree, with exclusive
 * (deepest-ownership) content ranges.
 * @param root The parsed markdown tree.
 * @param src The raw source text, used for byte-offset slicing.
 * @param slugger A heading-slug generator used when a heading has no `{#anchor}`.
 * @returns Section spans, each with the byte ranges that make up its content.
 */
export function extractSections(root: Root, src: string, slugger: GithubSlugger): SectionSpan[] {
  const spans: SectionSpan[] = [];
  const stack: {
    sectionId: Section["sectionId"];
    heading: string;
    level: Section["level"];
    position?: SourcePosition;
    headingStart: number;
    startOffset: number;
  }[] = [];

  const closeSection = (endOffset: number, stopLevel: number): void => {
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= stopLevel) {
      const open = stack.pop();
      if (open === undefined) return;
      spans.push({ ...open, endOffset, content: "", contentSpans: [] });
    }
  };

  for (const child of root.children) {
    if (child.type !== "heading") continue;
    const pos = child.position;
    const depth = child.depth;
    if (pos === undefined) continue;
    const headingStart = pos.start.offset;
    const contentStart = pos.end.offset;
    if (headingStart === undefined || contentStart === undefined) continue;

    const text = headingText(child);
    const { anchor, heading } = splitAnchor(text);
    const sectionId = anchor !== undefined ? asSectionId(anchor) : asSectionId(slugger.slug(text));
    const level = (depth >= 1 && depth <= 6 ? depth : 6) as 1 | 2 | 3 | 4 | 5 | 6;

    closeSection(headingStart, depth);
    stack.push({
      sectionId,
      heading,
      level,
      position: { line: pos.start.line, col: pos.start.column },
      headingStart,
      startOffset: contentStart,
    });
  }
  closeSection(src.length, 1);

  // Preamble: content before the first heading, preserved verbatim.
  const docStart = contentStartOffset(root);
  const firstHeading = spans.reduce<number>((min, s) => Math.min(min, s.headingStart), src.length);
  if (src.slice(docStart, firstHeading).trim().length > 0) {
    spans.push({
      sectionId: asSectionId("__preamble__"),
      heading: "",
      level: 6,
      headingStart: docStart,
      startOffset: docStart,
      endOffset: firstHeading,
      content: "",
      contentSpans: [],
    });
  }

  spans.sort((a, b) => a.headingStart - b.headingStart);

  // Exclusive content: each section's content excludes nested sections' spans.
  // `contentSpans` are the byte ranges whose slices concatenate to `content`,
  // so a parent's ranges never overlap a nested child's (deepest-section
  // ownership — projected content renders exactly once).
  //
  // Spans nest strictly (a section closes no later than its parent) and are
  // sorted by start, so the sections nested in `span` are exactly the spans
  // after it that start before it ends. Each span is visited once per section
  // enclosing it, and sections nest at most six heading levels deep, so the
  // whole pass is linear in the number of sections.
  const withContent = spans.map((span, index) => {
    const contentSpans: SourceSpan[] = [];
    let cursor = span.startOffset;
    for (let i = index + 1; i < spans.length; i += 1) {
      const n = spans[i] as SectionSpan;
      if (n.headingStart >= span.endOffset) break;
      if (n.endOffset > span.endOffset) continue;
      if (cursor < n.headingStart) contentSpans.push({ start: cursor, end: n.headingStart });
      cursor = n.endOffset;
    }
    if (cursor < span.endOffset) contentSpans.push({ start: cursor, end: span.endOffset });
    const content = contentSpans.map((s) => src.slice(s.start, s.end)).join("");
    return { ...span, content, contentSpans };
  });

  return withContent;
}

/**
 * Group refs by the section that owns them. Section spans nest, so a ref
 * belongs to the DEEPEST (smallest) span whose content range
 * (`startOffset <= offset < endOffset`) contains it; a ref outside every span
 * belongs to none.
 *
 * Content ranges either nest or are disjoint, so the ranges containing an
 * offset form a chain: the deepest is the last range starting at or before the
 * offset if it still contains it, otherwise the nearest enclosing range that
 * does. A binary search plus a walk of at most six enclosing levels keeps each
 * lookup logarithmic in the number of sections.
 * @param spans The section spans of one document.
 * @param hits The document's recognized refs with their offsets.
 * @returns The refs of each owning span, keyed by the span's `startOffset`, in hit order.
 */
export function refsBySection(
  spans: readonly SectionSpan[],
  hits: readonly RefHit[],
): Map<number, InlineRef[]> {
  const byStart = [...spans].sort((a, b) => a.startOffset - b.startOffset);
  // parents[i]: the index in `byStart` of the nearest range enclosing byStart[i], or -1.
  const parents: number[] = [];
  const open: number[] = [];
  for (let i = 0; i < byStart.length; i += 1) {
    const span = byStart[i] as SectionSpan;
    while (open.length > 0) {
      const top = byStart[open[open.length - 1] as number] as SectionSpan;
      if (span.startOffset >= top.startOffset && span.endOffset <= top.endOffset) break;
      open.pop();
    }
    parents.push(open.length > 0 ? (open[open.length - 1] as number) : -1);
    open.push(i);
  }

  const ownerOf = (offset: number): SectionSpan | undefined => {
    let lo = 0;
    let hi = byStart.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((byStart[mid] as SectionSpan).startOffset <= offset) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo - 1; i >= 0; i = parents[i] as number) {
      const span = byStart[i] as SectionSpan;
      if (offset < span.endOffset) return span;
    }
    return undefined;
  };

  const refsBySpan = new Map<number, InlineRef[]>();
  for (const hit of hits) {
    const owner = ownerOf(hit.offset);
    if (owner === undefined) continue;
    let list = refsBySpan.get(owner.startOffset);
    if (list === undefined) {
      list = [];
      refsBySpan.set(owner.startOffset, list);
    }
    list.push(hit.ref);
  }
  return refsBySpan;
}
