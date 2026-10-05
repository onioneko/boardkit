import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { asDocId, type DocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import type { Storage } from "../ports/ports.js";
import { createEngine } from "./engine.js";

/**
 * #3: with `Storage.size`, a stored document over `maxDocumentBytes` is
 * refused on its size alone and never read into memory. Without it, or when
 * it cannot tell, the engine reads and measures the source as before.
 */

const checklistType: BlockType = {
  type: "checklist",
  schema: {
    type: "object",
    required: ["id", "items"],
    properties: { id: { type: "string" }, items: { type: "array" } },
  },
  affordances: [{ name: "clear", patch: () => ({ items: [] }) }],
};
const writer = { kind: "human", id: "u1" } as const;
const clock = () => "2026-10-04T00:00:00Z";
const MAX = 200;
const big = `# Big\n\n\`\`\`checklist\nid: c\nitems: [a]\n\`\`\`\n\n${"x".repeat(400)}\n`;

type SizeMode = "exact" | "absent" | "throws" | "unknown" | "too-small";

/** Mem storage whose `size` behaves per `mode`, counting reads and sizes per document. */
function storageWith(mode: SizeMode) {
  const inner = createMemStorage();
  const reads = new Map<string, number>();
  const sizes = new Map<string, number>();
  const bump = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1);
  const storage: Storage = {
    ...inner,
    read: (docId: DocId) => {
      bump(reads, docId);
      return inner.read(docId);
    },
  };
  const innerSize = inner.size as (d: DocId) => Promise<number | undefined>;
  const withSize: Storage =
    mode === "absent"
      ? (({ size: _drop, ...rest }) => rest)(storage)
      : {
          ...storage,
          size: async (docId: DocId) => {
            bump(sizes, docId);
            if (mode === "throws") throw new Error("stat failed");
            if (mode === "unknown") return undefined;
            const n = await innerSize(docId);
            return mode === "too-small" && n !== undefined ? 1 : n;
          },
        };
  return { inner, storage: withSize, reads, sizes };
}

async function setup(mode: SizeMode) {
  const s = storageWith(mode);
  await s.inner.writeAtomic(asDocId("big"), big);
  await s.inner.writeAtomic(asDocId("board"), "# Board\n\n{{include:big}}\n\ntext\n");
  const engine = createEngine({
    storage: s.storage,
    clock,
    blocks: [checklistType],
    maxDocumentBytes: MAX,
  });
  return { ...s, engine };
}

const codes = (ds: readonly { code: string }[]) => ds.map((d) => d.code);

describe("Storage.size: an oversized document is refused before it is read", () => {
  it("projection of it", async () => {
    const { engine, reads } = await setup("exact");
    const r = await engine.projection("big", "text", {});
    expect(r.ok).toBe(false);
    expect(codes(r.diagnostics)).toEqual(["E_DOCUMENT_TOO_LARGE"]);
    expect(r.diagnostics[0]?.message).toContain(`over the limit of ${MAX} bytes`);
    expect(reads.get("big")).toBeUndefined();
  });

  it("an include of it", async () => {
    const { engine, reads } = await setup("exact");
    const r = await engine.projection("board", "text", {});
    expect(r.ok).toBe(true);
    expect(codes(r.diagnostics)).toContain("E_DOCUMENT_TOO_LARGE");
    expect(r.output).toContain("{{include:big}}");
    expect(r.versions).not.toHaveProperty("big");
    expect(reads.get("big")).toBeUndefined();
  });

  it("refGraph, getBlock, docInfo, patch and intent on it", async () => {
    const { engine, reads } = await setup("exact");
    const g = await engine.refGraph("big");
    expect(g.docs).toEqual([]);
    expect(codes(g.diagnostics)).toEqual(["E_DOCUMENT_TOO_LARGE"]);
    expect(await engine.getBlock("big", "c")).toBeUndefined();
    expect(await engine.docInfo("big")).toBeUndefined();
    expect(reads.get("big")).toBeUndefined();
    const p = await engine.patch("big", "c", { writer, attrs: { items: [] } });
    expect(p.ok ? undefined : p.rejection.reason).toBe("too-large");
    const i = await engine.applyIntent(
      { docId: "big", blockId: "c", affordance: "clear" },
      { writer },
    );
    expect(i.ok ? undefined : i.rejection.reason).toBe("too-large");
    expect(reads.get("big")).toBeUndefined();
  });

  it("a scoped subscriber's include closure", async () => {
    const { engine, reads } = await setup("exact");
    engine.subscribe("board", () => {});
    await engine.createDoc("other", { writer, content: "# O\n" });
    expect(reads.get("board")).toBe(1);
    expect(reads.get("big")).toBeUndefined();
  });

  it("a document within the limit is sized before each read, then read as usual", async () => {
    const { engine, reads, sizes } = await setup("exact");
    await engine.createDoc("small", { writer, content: "# S\n" });
    reads.clear();
    sizes.clear();
    const r = await engine.projection("small", "text", {});
    expect(r.ok).toBe(true);
    expect(Object.fromEntries(sizes)).toEqual({ small: 2 });
    expect(Object.fromEntries(reads)).toEqual({ small: 2 });
  });
});

describe("Storage.size: falling back to a read", () => {
  for (const mode of ["absent", "throws", "unknown", "too-small"] as const) {
    it(`reads and measures the source when size is ${mode}`, async () => {
      const { engine, reads } = await setup(mode);
      const r = await engine.projection("big", "text", {});
      expect(r.ok).toBe(false);
      expect(codes(r.diagnostics)).toEqual(["E_DOCUMENT_TOO_LARGE"]);
      const b = await engine.projection("board", "text", {});
      expect(b.ok).toBe(true);
      expect(b.output).toContain("{{include:big}}");
      expect(await engine.getBlock("big", "c")).toBeUndefined();
      expect(await engine.docInfo("big")).toBeUndefined();
      const p = await engine.patch("big", "c", { writer, attrs: { items: [] } });
      expect(p.ok ? undefined : p.rejection.reason).toBe("too-large");
      expect(reads.get("big")).toBeGreaterThan(0);
    });
  }

  it("never calls size when the limit is Infinity", async () => {
    const s = storageWith("exact");
    await s.inner.writeAtomic(asDocId("big"), big);
    const engine = createEngine({ storage: s.storage, clock, maxDocumentBytes: Infinity });
    expect((await engine.projection("big", "text", {})).ok).toBe(true);
    expect(s.sizes.size).toBe(0);
  });
});
