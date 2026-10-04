import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { asDocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import { createExternalWriteHandler } from "./external-write.js";

const clock = () => "2026-08-21T00:00:00Z";

function makeHandler(storage = createMemStorage()) {
  const handler = createExternalWriteHandler({
    storage,
    clock,
    blockTypes: new Map<string, BlockType>(),
    rootDir: "/ws",
  });
  return { handler, storage };
}

describe("createExternalWriteHandler", () => {
  it("resolves watch paths to docIds relative to root; ignores non-md and out-of-root paths", async () => {
    const { handler, storage } = makeHandler();
    await storage.writeAtomic(asDocId("fin"), "# A");
    expect(await handler.handle(path.join("/ws", "fin.md"))).toMatchObject({ docId: "fin" });
    expect(await handler.handle(path.join("/ws", "notes.txt"))).toBeUndefined();
    expect(await handler.handle(path.join("/etc", "passwd.md"))).toBeUndefined();
  });

  it("suppresses self-echoes for content recorded as committed", async () => {
    const { handler, storage } = makeHandler();
    const src = "# A";
    await storage.writeAtomic(asDocId("fin"), src);
    handler.recordCommitted(asDocId("fin"), src);
    const out = await handler.handle(path.join("/ws", "fin.md"));
    expect(out?.suppressed).toBe(true);
    expect(out?.external).toBe(false);
    expect(out?.events).toEqual([]);
  });

  it("treats unknown writes as external: diff events carry a writer and append to the sink", async () => {
    const storage = createMemStorage();
    const handler = createExternalWriteHandler({
      storage,
      clock,
      blockTypes: new Map<string, BlockType>(),
      rootDir: "/ws",
      externalWriterId: "editor-x",
    });
    await storage.writeAtomic(asDocId("fin"), "# A");
    handler.recordCommitted(asDocId("fin"), "# A");
    await storage.writeAtomic(asDocId("fin"), "# B\n");
    const out = await handler.handle(path.join("/ws", "fin.md"));
    expect(out?.external).toBe(true);
    expect(out?.events.map((e) => e.type)).toContain("doc.updated");
    expect(out?.events.every((e) => (e.by as { id: string } | undefined)?.id === "editor-x")).toBe(
      true,
    );
    expect(storage.getEvents().length).toBe(out?.events.length);
  });

  it("does not reject externally written content that violates block schemas (source is truth)", async () => {
    const statusType: BlockType = {
      type: "status",
      schema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: true,
      },
    };
    const storage = createMemStorage();
    const handler = createExternalWriteHandler({
      storage,
      clock,
      blockTypes: new Map([["status", statusType]]),
      rootDir: "/ws",
      parseOptions: { blockTypes: new Set(["status"]) },
    });
    await storage.writeAtomic(asDocId("fin"), "# A");
    handler.recordCommitted(asDocId("fin"), "# A");
    await storage.writeAtomic(asDocId("fin"), "```status\nid: 42\nvalue: x\n```\n");
    const out = await handler.handle(path.join("/ws", "fin.md"));
    expect(out?.external).toBe(true);
    expect(out?.diagnostics.map((d) => d.code)).toContain("E_BLOCK_ID");
    expect(out?.events.map((e) => e.type)).toContain("doc.updated");
  });
});
