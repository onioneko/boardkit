import { describe, expect, it } from "vitest";
import type {
  Block,
  BlockId,
  Diagnostic,
  DocId,
  DocNode,
  IncludeRef,
  InlineRef,
  ParsedDoc,
  Section,
  SectionId,
  SourcePosition,
  SourceRef,
  Stability,
  ValidatedFrontmatter,
} from "./index.js";
import { asBlockId, asDocId, asSectionId, diagnostic, validateFrontmatter } from "./index.js";

describe("model barrel (public surface)", () => {
  it("exposes ids, diagnostics, refs, doc model, and frontmatter validation", () => {
    const docId: DocId = asDocId("fin");
    const sectionId: SectionId = asSectionId("now");
    const blockId: BlockId = asBlockId("d1");
    expect([docId, sectionId, blockId]).toEqual(["fin", "now", "d1"]);

    const d: Diagnostic = diagnostic("E_X", "msg");
    expect(d.code).toBe("E_X");

    const ref: InlineRef = { kind: "include", docId: asDocId("a") };
    expect(ref.kind).toBe("include");
    const sourceRef: SourceRef = { kind: "source", source: "x", params: {} };
    expect(sourceRef.source).toBe("x");
    const includeRef: IncludeRef = { kind: "include", docId: asDocId("a") };
    expect(includeRef.docId).toBe("a");

    const pos: SourcePosition = { line: 3, col: 7 };
    const section: Section = {
      sectionId: asSectionId("s"),
      heading: "S",
      level: 2,
      content: "",
      refs: [],
      position: pos,
    };
    expect(section.position?.line).toBe(3);
    const block: Block = { blockId: asBlockId("b"), type: "status", attrs: {} };
    const node: DocNode = section;
    expect("sectionId" in node).toBe(true);
    const doc: ParsedDoc = {
      frontmatter: {},
      nodes: [section, block],
      refs: [],
      refSpans: [],
      diagnostics: [],
    };
    expect(doc.nodes).toHaveLength(2);

    const fm: ValidatedFrontmatter = validateFrontmatter({ stability: "stable" });
    const stability: Stability | undefined = fm.stability;
    expect(stability).toBe("stable");
    expect(fm.diagnostics).toEqual([]);
  });
});
