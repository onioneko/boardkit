import { describe, expect, it } from "vitest";
import type { Block, ParsedDoc, Section } from "./doc.js";
import { asBlockId, asSectionId } from "./ids.js";

describe("document model", () => {
  it("section carries identity, heading, content and refs", () => {
    const s: Section = {
      sectionId: asSectionId("now"),
      heading: "Now",
      level: 2,
      content: "- Cash: {{source:bank_balance}}",
      refs: [],
    };
    expect(s.sectionId).toBe("now");
    expect(s.heading).toBe("Now");
    expect(s.level).toBe(2);
  });

  it("block carries id, type and attrs", () => {
    const b: Block = {
      blockId: asBlockId("dec-1"),
      type: "status",
      attrs: { value: "pending" },
    };
    expect(b.attrs.value).toBe("pending");
  });

  it("empty ParsedDoc has empty defaults", () => {
    const doc: ParsedDoc = { frontmatter: {}, nodes: [], refs: [], refSpans: [], diagnostics: [] };
    expect(doc.nodes).toHaveLength(0);
    expect(doc.refs).toHaveLength(0);
    expect(doc.diagnostics).toHaveLength(0);
  });

  it("DocNode union accepts both kinds and narrows structurally", () => {
    const nodes: ParsedDoc["nodes"] = [
      { sectionId: asSectionId("a"), heading: "A", level: 2, content: "", refs: [] },
      { blockId: asBlockId("b"), type: "status", attrs: {} },
    ];
    const second = nodes[1];
    if (second === undefined) throw new Error("unreachable");
    if ("blockId" in second) {
      expect(second.blockId).toBe("b");
      expect(second.type).toBe("status");
    } else {
      throw new Error("expected a block");
    }
  });
});
