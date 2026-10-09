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

  it("refuses a block in a list item, leaving the blocks after it in place", async () => {
    for (const indent of ["", " "]) {
      const storage = createMemStorage();
      const engine = createEngine({ storage, blocks: [open("status"), open("decision")] });
      const pad = `  ${indent}`;
      const listed = `# A\n\n- item\n\n${pad}\`\`\`status\n${pad}id: s\n${pad}value: open\n${pad}\`\`\`\n\n\`\`\`decision\nid: d\nstate: pending\n\`\`\`\n`;
      await engine.createDoc("d", { writer, content: listed });
      const patched = await engine.patch("d", "s", { writer, attrs: { value: "closed" } });
      expect(patched.ok).toBe(false);
      if (!patched.ok) {
        expect(patched.rejection.reason).toBe("patch");
        expect(patched.rejection.diagnostics.map((d) => d.code)).toEqual(["E_PATCH_SPAN"]);
      }
      expect(await storage.read(asDocId("d"))).toBe(listed);
      expect((await engine.getBlock("d", "d"))?.attrs).toEqual({ id: "d", state: "pending" });
    }
  });

  it("keeps a nested delta nested under an indented top-level fence", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, blocks: [open("status")] });
    await engine.createDoc("d", {
      writer,
      content: "  ```status\n  id: s\n  value: open\n  ```\n",
    });
    const note = { state: "approved", owner: "mallory" };
    const patched = await engine.patch("d", "s", { writer, attrs: { note } });
    expect(patched.ok).toBe(true);
    expect((await engine.getBlock("d", "s"))?.attrs).toEqual({ id: "s", value: "open", note });
  });
});
