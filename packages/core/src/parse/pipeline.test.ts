import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Block, ParsedDoc, Section } from "../model/doc.js";
import { parseDoc } from "./pipeline.js";

const fin = readFileSync(
  fileURLToPath(new URL("../../test/fixtures/fin.md", import.meta.url)),
  "utf8",
);

function sectionsOf(doc: ParsedDoc): Section[] {
  return doc.nodes.filter((n): n is Section => "sectionId" in n);
}

function blocksOf(doc: ParsedDoc): Block[] {
  return doc.nodes.filter((n): n is Block => "blockId" in n);
}

describe("parseDoc (fin.md fixture)", () => {
  const doc = parseDoc(fin, { blockTypes: new Set(["status", "checklist"]) });

  it("parses without diagnostics", () => {
    expect(doc.diagnostics).toEqual([]);
  });

  it("keeps unknown frontmatter keys and validates shape", () => {
    expect(doc.frontmatter.title).toBe("Family Finance");
  });

  it("extracts sections with anchors and slugs", () => {
    const sections = sectionsOf(doc);
    expect(sections.map((s) => s.sectionId)).toEqual([
      "family-finance",
      "now",
      "reference",
      "large-purchases",
      "subscriptions",
    ]);
    const now = sections.find((s) => s.sectionId === "now");
    expect(now?.heading).toBe("Now"); // {#now} anchor stripped
    expect(now?.level).toBe(2);
  });

  it("collects refs in document order", () => {
    expect(doc.refs).toHaveLength(3);
    expect(doc.refs[0]).toEqual({ kind: "source", source: "bank_balance", params: {} });
    expect(doc.refs[1]).toEqual({ kind: "source", source: "monthly_spend", params: {} });
    expect(doc.refs[2]).toMatchObject({
      kind: "include",
      docId: "research/q3-review",
      sectionId: "summary",
    });
  });

  it("buckets refs into their owning sections", () => {
    const now = sectionsOf(doc).find((s) => s.sectionId === "now");
    expect(now?.refs).toHaveLength(2);
  });

  it("extracts typed blocks with parsed attrs", () => {
    const blocks = blocksOf(doc);
    expect(blocks).toHaveLength(2);
    const status = blocks.find((b) => b.blockId === "dec-macbook");
    expect(status?.type).toBe("status");
    expect(status?.attrs.value).toBe("pending");
    const checklist = blocks.find((b) => b.blockId === "subs");
    expect(checklist?.attrs.items).toHaveLength(2);
  });
});

describe("parseDoc frontmatter failures", () => {
  it("diagnoses invalid frontmatter YAML", () => {
    const doc = parseDoc("---\ntitle: [unclosed\n---\n\n# X", {});
    expect(doc.diagnostics.some((d) => d.code === "E_FRONTMATTER_YAML")).toBe(true);
  });

  it("diagnoses invalid stability value", () => {
    const doc = parseDoc("---\nstability: sometimes\n---\n\n# X", {});
    expect(doc.diagnostics.some((d) => d.code === "E_FRONTMATTER_STABILITY")).toBe(true);
  });
});
