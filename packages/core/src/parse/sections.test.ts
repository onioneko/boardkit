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

describe("sections — heading anchors", () => {
  /** The single non-preamble section of a one-heading document. */
  function only(src: string): { sectionId: string; heading: string } {
    const [s] = sections(parseDoc(src, {})).filter((x) => x.sectionId !== "__preamble__");
    return { sectionId: String(s?.sectionId), heading: String(s?.heading) };
  }

  it("reads a trailing anchor in plain text, inside emphasis, after a link, before a closing sequence, and in a setext heading", () => {
    expect(only("## Risk limits {#risk-limits}\n")).toEqual({
      sectionId: "risk-limits",
      heading: "Risk limits",
    });
    expect(only("## *Em {#em}*\n")).toEqual({ sectionId: "em", heading: "Em" });
    expect(only("## [Link](https://example.com) {#ln}\n")).toEqual({
      sectionId: "ln",
      heading: "Link",
    });
    expect(only("## Closed {#closed} ##\n")).toEqual({ sectionId: "closed", heading: "Closed" });
    expect(only("Setext {#st}\n===\n")).toEqual({ sectionId: "st", heading: "Setext" });
    expect(only("## Spaced {#sp}   \n")).toEqual({ sectionId: "sp", heading: "Spaced" });
  });

  it("does not read an anchor written in a code span (code is literal)", () => {
    expect(only("## Code `{#c1}`\n")).toEqual({ sectionId: "code-c1", heading: "Code {#c1}" });
  });

  it("does not read an anchor split by inline formatting", () => {
    // `_x_` is emphasis: the anchor is not one literal run of text.
    expect(only("## A {#_x_}\n")).toEqual({ sectionId: "a-x", heading: "A {#x}" });
  });

  it("does not read an escaped or character-referenced brace as an anchor", () => {
    expect(only("## Esc \\{#esc}\n")).toEqual({ sectionId: "esc-esc", heading: "Esc {#esc}" });
    expect(only("## Ent &#123;#ent}\n")).toEqual({ sectionId: "ent-ent", heading: "Ent {#ent}" });
    expect(only("## Hash {\\#h}\n")).toEqual({ sectionId: "hash-h", heading: "Hash {#h}" });
  });

  it("still reads an anchor after an escaped backslash", () => {
    expect(only("## Slash \\\\{#sl}\n")).toEqual({ sectionId: "sl", heading: "Slash \\" });
  });
});
