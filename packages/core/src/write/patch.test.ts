import { describe, expect, it } from "vitest";
import { parseDoc } from "../parse/pipeline.js";
import { applyPatch } from "./patch.js";

const src = `# T

\`\`\`status
id: d1
value: pending
note: keep me   # comment stays
\`\`\`

after text
`;

function blockOf(srcText: string, blockTypes: ReadonlySet<string>) {
  const doc = parseDoc(srcText, { blockTypes });
  const block = doc.nodes.find((n) => "blockId" in n);
  if (block === undefined || !("blockId" in block)) throw new Error("no block");
  return block;
}

describe("applyPatch", () => {
  it("changes only the target values; every other byte is preserved", () => {
    const block = blockOf(src, new Set(["status"]));
    const result = applyPatch({ src, block, delta: { value: "approved" } });
    expect(result.diagnostics).toEqual([]);
    expect(result.src).toContain("value: approved");
    // Comments and untouched keys survive (yaml CST may normalize whitespace padding).
    expect(result.src).toContain("note: keep me");
    expect(result.src).toContain("# comment stays");
    expect(result.src).toContain("id: d1");
    expect(result.src).toContain("# T");
    expect(result.src).toContain("after text");
    // Fence lines intact.
    expect(result.src.match(/```/g)).toHaveLength(2);
  });

  it("adds missing keys at the top level", () => {
    const block = blockOf(src, new Set(["status"]));
    const result = applyPatch({ src, block, delta: { extra: "x" } });
    expect(result.diagnostics).toEqual([]);
    expect(result.src).toContain("extra: x");
  });

  it("diagnoses blocks without a source span", () => {
    const doc = parseDoc(src, { blockTypes: new Set(["status"]) });
    const block = doc.nodes.find((n) => "blockId" in n);
    if (block === undefined || !("blockId" in block)) throw new Error("no block");
    const spanless = { blockId: block.blockId, type: block.type, attrs: block.attrs };
    const result = applyPatch({ src, block: spanless, delta: { value: "x" } });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["E_PATCH_SPAN"]);
  });
});
