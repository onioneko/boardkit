import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { parseDoc } from "../parse/pipeline.js";
import type { SourceValue } from "../ports/ports.js";
import { canonicalKey } from "../resolve/resolve.js";
import { projectText } from "./text.js";

const cashType: BlockType = {
  type: "cash",
  schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  project: { text: (_attrs, values) => `Cash: ${values.cash ?? "?"}` },
};

describe("projection walk — block values across direct calls", () => {
  it("shows the current value when one values map is reused and updated between calls", () => {
    const src = "prose {{source:cash}}\n\n```cash\nid: c\n```\n";
    const doc = parseDoc(src, { blockTypes: new Set(["cash"]) });
    const blockTypes = new Map([["cash", cashType]]);
    const key = canonicalKey({ kind: "source", source: "cash", params: {} });
    const values = new Map<string, SourceValue>([[key, { value: "100", stale: false }]]);

    const first = projectText(doc, src, values, { blockTypes });
    expect(first).toContain("prose 100");
    expect(first).toContain("Cash: 100");

    values.set(key, { value: "200", stale: false });
    const second = projectText(doc, src, values, { blockTypes });
    expect(second).toContain("prose 200");
    expect(second).toContain("Cash: 200");
  });
});
