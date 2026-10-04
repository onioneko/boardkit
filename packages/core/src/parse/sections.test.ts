import { describe, expect, it } from "vitest";
import type { ParsedDoc, Section } from "../model/doc.js";
import { parseDoc } from "./pipeline.js";

function sections(doc: ParsedDoc): Section[] {
  return doc.nodes.filter((n): n is Section => "sectionId" in n);
}

describe("sections", () => {
  it("uses explicit anchors over slugs", () => {
    const doc = parseDoc("# T\n\n## Holdings {#portfolio}\n\ncontent", {});
    const s = sections(doc).find((x) => x.sectionId === "portfolio");
    expect(s?.heading).toBe("Holdings");
  });

  it("slugs headings without anchors", () => {
    const doc = parseDoc("## My Section Title\n\nbody", {});
    expect(sections(doc).map((x) => x.sectionId)).toContain("my-section-title");
  });

  it("auto-suffixes duplicate slugs", () => {
    const doc = parseDoc("## Dup\n\na\n\n## Dup\n\nb", {});
    const ids = sections(doc).map((x) => x.sectionId);
    expect(ids).toContain("dup");
    expect(ids).toContain("dup-1");
  });

  it("assigns content exclusively to the deepest open section", () => {
    const doc = parseDoc("## A\n\ntext-a\n\n### B\n\ntext-b\n\n## C\n\ntext-c", {});
    const a = sections(doc).find((x) => x.sectionId === "a");
    const b = sections(doc).find((x) => x.sectionId === "b");
    const c = sections(doc).find((x) => x.sectionId === "c");
    expect(a?.content).toContain("text-a");
    expect(a?.content).not.toContain("text-b");
    expect(a?.content).not.toContain("### B");
    expect(b?.content).toContain("text-b");
    expect(c?.content).toContain("text-c");
  });

  it("preserves preamble content", () => {
    const doc = parseDoc("preamble text\n\n## A\n\nbody", {});
    const pre = sections(doc).find((x) => x.sectionId === "__preamble__");
    expect(pre?.content).toContain("preamble text");
  });

  it("closes sibling sections at same-level headings", () => {
    const doc = parseDoc("## A\n\na\n\n## B\n\nb", {});
    const a = sections(doc).find((x) => x.sectionId === "a");
    expect(a?.content).toContain("a");
    expect(a?.content).not.toContain("b");
  });

  it("contentSpans are exclusive of nested sections (no overlap with a child)", () => {
    const doc = parseDoc(
      "## Parent {#parent}\nparent body\n\n### Child {#child}\nchild body\n",
      {},
    );
    const parent = sections(doc).find((x) => x.sectionId === "parent");
    const child = sections(doc).find((x) => x.sectionId === "child");
    expect(parent?.contentSpans).toBeDefined();
    expect(parent?.contentSpans).toHaveLength(1);

    // The parent's exclusive range ends where the child begins, so the child's
    // body is owned by the child alone (deepest-section ownership).
    const span = parent?.contentSpans?.[0];
    expect(span).toBeDefined();
    if (span !== undefined) {
      // slice the parent's exclusive range and assert it excludes the child heading/body
      const src = "## Parent {#parent}\nparent body\n\n### Child {#child}\nchild body\n";
      expect(src.slice(span.start, span.end)).toContain("parent body");
      expect(src.slice(span.start, span.end)).not.toContain("### Child");
      expect(src.slice(span.start, span.end)).not.toContain("child body");
    }
    expect(child?.contentSpans).toHaveLength(1);
  });
});
