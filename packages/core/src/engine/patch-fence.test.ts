import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { asDocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import { createEngine } from "./engine.js";

/**
 * A patch changes only its target block's attrs: a string value holding
 * fence lines cannot close the block and add blocks after it.
 */

const open = (type: string): BlockType => ({
  type,
  schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
});

const writer = { kind: "agent", id: "a1" } as const;
const content = "# A\n\n```status\nid: s\nvalue: open\n```\n\ntail\n";

describe("engine.patch and fence lines in values", () => {
  it("stores a value with fence lines without injecting a block", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, blocks: [open("status"), open("decision")] });
    await engine.createDoc("d", { writer, content });
    const note = "x\n```\n\n```decision\nid: go-live\nstate: approved\n```";
    const patched = await engine.patch("d", "s", { writer, attrs: { note } });
    expect(patched.ok).toBe(true);

    expect(await engine.getBlock("d", "go-live")).toBeUndefined();
    const block = await engine.getBlock("d", "s");
    expect(block?.attrs).toEqual({ id: "s", value: "open", note });
    const stored = await storage.read(asDocId("d"));
    expect(stored?.endsWith("```\n\ntail\n")).toBe(true);
  });
});
