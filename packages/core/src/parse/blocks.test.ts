import { describe, expect, it } from "vitest";
import type { Block, ParsedDoc } from "../model/doc.js";
import { parseDoc } from "./pipeline.js";

const types = new Set(["status"]);

function blocks(doc: ParsedDoc): Block[] {
  return doc.nodes.filter((n): n is Block => "blockId" in n);
}

describe("typed blocks", () => {
  it("extracts registered fences as blocks", () => {
    const doc = parseDoc("```status\nid: d1\nvalue: pending\n```", { blockTypes: types });
    expect(blocks(doc)[0]).toMatchObject({
      blockId: "d1",
      type: "status",
      attrs: { value: "pending" },
    });
    expect(doc.diagnostics).toEqual([]);
  });

  it("leaves unregistered fences as ordinary code", () => {
    const doc = parseDoc("```other\nid: d1\n```", { blockTypes: types });
    expect(blocks(doc)).toHaveLength(0);
    expect(doc.diagnostics).toEqual([]);
  });

  it("diagnoses invalid YAML bodies", () => {
    const doc = parseDoc("```status\nid: [unclosed\n```", { blockTypes: types });
    expect(doc.diagnostics.some((d) => d.code === "E_BLOCK_YAML")).toBe(true);
  });

  it("diagnoses missing ids", () => {
    const doc = parseDoc("```status\nvalue: x\n```", { blockTypes: types });
    expect(doc.diagnostics.some((d) => d.code === "E_BLOCK_ID")).toBe(true);
  });

  it("diagnoses non-string ids", () => {
    const doc = parseDoc("```status\nid: 42\nvalue: x\n```", { blockTypes: types });
    expect(doc.diagnostics.some((d) => d.code === "E_BLOCK_ID")).toBe(true);
  });

  it("diagnoses non-mapping bodies", () => {
    const doc = parseDoc("```status\n- a\n- b\n```", { blockTypes: types });
    expect(doc.diagnostics.some((d) => d.code === "E_BLOCK_YAML")).toBe(true);
  });
});
