import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { asDocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import { createEngine } from "./engine.js";

/**
 * Patches on a document that starts with a byte order mark: each block is
 * patched in place, and every other byte, the BOM included, is unchanged.
 */

const status: BlockType = {
  type: "status",
  schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
};

const writer = { kind: "agent", id: "a1" } as const;
const BOM = "﻿";
const content = [
  "---",
  "title: T",
  "---",
  "",
  "# A {#a}",
  "",
  "```status",
  "id: s1",
  "value: open",
  "```",
  "",
  "## B",
  "",
  "```status",
  "id: s2",
  "value: open",
  "```",
  "",
  "# C",
  "",
  "```status",
  "id: s3",
  "value: open",
  "```",
  "",
].join("\n");

async function patched(src: string, blockId: string): Promise<string | undefined> {
  const storage = createMemStorage();
  const engine = createEngine({ storage, blocks: [status] });
  await engine.createDoc("d", { writer, content: src });
  const result = await engine.patch("d", blockId, { writer, attrs: { value: "closed" } });
  expect(result.ok).toBe(true);
  return storage.read(asDocId("d"));
}

describe("engine.patch on a document that starts with a BOM", () => {
  for (const blockId of ["s1", "s2", "s3"]) {
    it(`patches ${blockId} and leaves every other byte unchanged, the BOM included`, async () => {
      const plain = await patched(content, blockId);
      const bommed = await patched(`${BOM}${content}`, blockId);
      expect(plain).toBeDefined();
      expect(plain).not.toBe(content);
      expect(bommed).toBe(`${BOM}${plain}`);
    });
  }
});
