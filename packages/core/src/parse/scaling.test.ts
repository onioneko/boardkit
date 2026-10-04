import GithubSlugger from "github-slugger";
import type { Heading, Root, RootContent } from "mdast";
import { describe, expect, it } from "vitest";
import type { ParsedDoc, Section } from "../model/doc.js";
import { asSectionId } from "../model/ids.js";
import { parseDoc } from "./pipeline.js";
import { extractRefs, type RefHit } from "./refs.js";
import { extractSections, refsBySection, type SectionSpan } from "./sections.js";

/**
 * BoardKit's own extraction steps (anchors, ref positions, sections, ref
 * ownership) must scale linearly. The markdown parser's cost is kept out of
 * the measurement where it would dominate: those cases run the extraction step
 * on a tree built directly, so each bound times BoardKit code alone. Inputs are
 * sized so a quadratic implementation takes seconds and a linear one a few
 * milliseconds; the bounds leave a wide margin for slow machines.
 */

function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

function sections(doc: ParsedDoc): Section[] {
  return doc.nodes.filter((n): n is Section => "sectionId" in n);
}

function point(offset: number): { line: number; column: number; offset: number } {
  return { line: 1, column: offset + 1, offset };
}

/** A root of `count` level-1 headings `# h`, one per line, as the markdown parser would build it. */
function headingTree(count: number): { root: Root; src: string } {
  const line = "# h\n";
  const children: RootContent[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * line.length;
    const heading: Heading = {
      type: "heading",
      depth: 1,
      children: [{ type: "text", value: "h" }],
      position: { start: point(start), end: point(start + 3) },
    };
    children.push(heading);
  }
  return { root: { type: "root", children }, src: line.repeat(count) };
}

describe("parse scaling", () => {
  it("extracts a heading anchor in linear time after a long run of whitespace", () => {
    const src = `# a${" ".repeat(60_000)}x {#tail}\n\nbody\n`;
    const { value: doc, ms } = timed(() => parseDoc(src));
    const [section] = sections(doc);
    expect(section?.sectionId).toBe("tail");
    expect(section?.heading).toBe(`a${" ".repeat(60_000)}x`);
    expect(ms).toBeLessThan(1000);
  }, 60_000);

  it("leaves a heading without an anchor unchanged after a long run of whitespace", () => {
    const src = `# a${" ".repeat(60_000)}x\n`;
    const { value: doc, ms } = timed(() => parseDoc(src));
    expect(sections(doc)[0]?.heading).toBe(`a${" ".repeat(60_000)}x`);
    expect(ms).toBeLessThan(1000);
  }, 60_000);

  it("positions many refs after many lines in linear time", () => {
    const lines = 400_000;
    const refs = 20_000;
    const unit = "{{source:x}} ";
    const src = `${"\n".repeat(lines)}${unit.repeat(refs)}{{source:}}`;
    const root: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "",
              position: { start: point(lines), end: point(src.length) },
            },
          ],
        },
      ],
    };
    const { value: result, ms } = timed(() => extractRefs(root, src));
    expect(result.refs).toHaveLength(refs);
    // The malformed ref at the end carries the line and column of its own `{{`.
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "E_REF_SYNTAX",
        line: lines + 1,
        col: refs * unit.length + 1,
      }),
    ]);
    expect(ms).toBeLessThan(500);
  }, 60_000);

  it("extracts many sections in linear time", () => {
    const count = 30_000;
    const { root, src } = headingTree(count);
    const { value: spans, ms } = timed(() => extractSections(root, src, new GithubSlugger()));
    expect(spans).toHaveLength(count);
    expect(spans[0]?.content).toBe("\n");
    expect(spans[count - 1]?.contentSpans).toEqual([{ start: src.length - 1, end: src.length }]);
    expect(ms).toBeLessThan(500);
  }, 60_000);

  it("assigns many refs to many sections in linear time", () => {
    const count = 50_000;
    // Top-level sections of 10 bytes each, the first two holding a nested one.
    const spans: SectionSpan[] = [];
    for (let i = 0; i < count; i += 1) {
      const start = i * 10;
      spans.push({
        sectionId: asSectionId(`s${i}`),
        heading: "h",
        level: 1,
        headingStart: start,
        startOffset: start + 2,
        endOffset: start + 10,
        content: "",
        contentSpans: [],
      });
    }
    spans.push({
      sectionId: asSectionId("inner"),
      heading: "h",
      level: 2,
      headingStart: 4,
      startOffset: 6,
      endOffset: 10,
      content: "",
      contentSpans: [],
    });
    spans.sort((a, b) => a.headingStart - b.headingStart);
    // One ref in each section's content, one in a heading line (owned by no
    // section here), and one inside the nested section.
    const hits: RefHit[] = [];
    for (let i = 0; i < count; i += 1) {
      hits.push({
        ref: { kind: "source", source: `r${i}`, params: {} },
        offset: i * 10 + 3,
        endOffset: i * 10 + 4,
      });
    }
    hits.push({ ref: { kind: "source", source: "heading", params: {} }, offset: 0, endOffset: 1 });
    hits.push({ ref: { kind: "source", source: "nested", params: {} }, offset: 7, endOffset: 8 });

    const { value: owned, ms } = timed(() => refsBySection(spans, hits));
    expect(owned.get(2)).toEqual([{ kind: "source", source: "r0", params: {} }]);
    expect(owned.get(6)).toEqual([{ kind: "source", source: "nested", params: {} }]);
    expect(owned.get((count - 1) * 10 + 2)).toEqual([
      { kind: "source", source: `r${count - 1}`, params: {} },
    ]);
    expect([...owned.values()].reduce((n, refs) => n + refs.length, 0)).toBe(count + 1);
    expect(ms).toBeLessThan(500);
  }, 60_000);

  it("parses a long ordinary table in linear time", () => {
    const rows = Array.from({ length: 4000 }, (_, i) => `| widget-${i} | 3 | shelf | team | ok |`);
    const src = `| item | qty | where | owner | state |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
    const { value: doc, ms } = timed(() => parseDoc(src));
    expect(doc.diagnostics).toEqual([]);
    expect(ms).toBeLessThan(3000);
  }, 120_000);
});
