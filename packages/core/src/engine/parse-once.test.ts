import { describe, expect, it, vi } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { asDocId, type DocId } from "../model/ids.js";
import type { ParseOptions } from "../parse/options.js";
import { createMemStorage } from "../ports/mem.js";
import type { Storage } from "../ports/ports.js";
import type { WatchSource } from "../watch/source.js";
import { createEngine, type EngineOptions } from "./engine.js";

/**
 * #3: the work one write costs, counted. Every parse, every complexity scan and
 * every storage read is counted, so these tests pin how many of each a write,
 * the reverse-index upkeep behind it and the next projection take. Counts, not
 * timings: they are deterministic.
 */
const counts = vi.hoisted(() => ({ parses: 0, scans: 0 }));

vi.mock("../parse/pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../parse/pipeline.js")>();
  return {
    ...actual,
    parseDoc: (src: string, options?: ParseOptions) => {
      counts.parses += 1;
      return actual.parseDoc(src, options);
    },
  };
});

vi.mock("../parse/complexity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../parse/complexity.js")>();
  return {
    ...actual,
    complexityDiagnostic: (...args: Parameters<typeof actual.complexityDiagnostic>) => {
      counts.scans += 1;
      return actual.complexityDiagnostic(...args);
    },
    documentComplexityDiagnostic: (
      ...args: Parameters<typeof actual.documentComplexityDiagnostic>
    ) => {
      counts.scans += 1;
      return actual.documentComplexityDiagnostic(...args);
    },
  };
});

const checklistType: BlockType = {
  type: "checklist",
  schema: {
    type: "object",
    required: ["id", "items"],
    properties: { id: { type: "string" }, items: { type: "array" } },
  },
  affordances: [
    {
      name: "add",
      params: { type: "object", required: ["item"], properties: { item: { type: "string" } } },
      patch: (attrs, params) => ({
        items: [...(attrs.items as unknown[]), (params as { item: string }).item],
      }),
    },
  ],
};

const writer = { kind: "human", id: "u1" } as const;
const clock = () => "2026-10-04T00:00:00Z";

/** A storage that counts reads (and size calls) per document. */
function countingStorage(): {
  storage: Storage & { getEvents(): unknown[] };
  reads: Map<string, number>;
  sizes: Map<string, number>;
  totalReads(): number;
} {
  const inner = createMemStorage();
  const reads = new Map<string, number>();
  const sizes = new Map<string, number>();
  const storage = {
    ...inner,
    read: (docId: DocId) => {
      reads.set(docId, (reads.get(docId) ?? 0) + 1);
      return inner.read(docId);
    },
    ...(inner.size !== undefined
      ? {
          size: (docId: DocId) => {
            sizes.set(docId, (sizes.get(docId) ?? 0) + 1);
            return (inner.size as (d: DocId) => Promise<number | undefined>)(docId);
          },
        }
      : {}),
  };
  return {
    storage,
    reads,
    sizes,
    totalReads: () => [...reads.values()].reduce((a, b) => a + b, 0),
  };
}

const leaf = (i: number, note: string) =>
  `# Leaf ${i}\n\n${note}\n\n{{include:deep${i}}}\n\n\`\`\`checklist\nid: c${i}\nitems: [a]\n\`\`\`\n`;
const deep = (i: number) => `# Deep ${i}\n\nDeep prose ${i}.\n`;
const board = (i: number) => `# Board ${i}\n\n{{include:common}}\n\n{{include:leaf${i}}}\n`;

/**
 * Four subscribed boards. Each includes `common` and its own `leaf<i>`, which
 * includes `deep<i>`: four documents per closure, ten documents in all.
 */
async function realistic(extra: Partial<EngineOptions> = {}) {
  const c = countingStorage();
  const engine = createEngine({ storage: c.storage, clock, blocks: [checklistType], ...extra });
  await c.storage.writeAtomic(asDocId("common"), "# Common\n\nShared.\n");
  for (let i = 0; i < 4; i += 1) {
    await c.storage.writeAtomic(asDocId(`deep${i}`), deep(i));
    await c.storage.writeAtomic(asDocId(`leaf${i}`), leaf(i, "v0"));
    await c.storage.writeAtomic(asDocId(`board${i}`), board(i));
  }
  const seen: Record<string, string[]> = {};
  for (let i = 0; i < 4; i += 1) {
    seen[`board${i}`] = [];
    engine.subscribe(`board${i}`, (evt) => seen[`board${i}`]?.push(`${evt.type}:${evt.docId}`));
    // Every board has been read once, so the parse cache is warm.
    await engine.projection(`board${i}`, "text", {});
  }
  // A first write builds the reverse index for the four subscribers.
  const warm = await engine.write("leaf0", { writer, fullText: leaf(0, "warm") });
  expect(warm.ok).toBe(true);
  await engine.projection("board0", "text", {});
  const reset = () => {
    counts.parses = 0;
    counts.scans = 0;
    c.reads.clear();
    c.sizes.clear();
  };
  const snapshot = () => ({
    parses: counts.parses,
    scans: counts.scans,
    reads: c.totalReads(),
    readsByDoc: Object.fromEntries(c.reads),
  });
  reset();
  return { ...c, engine, seen, reset, snapshot };
}

/** A watch source the test drives by hand. */
function manualSource(): WatchSource {
  return {
    async start() {
      return async () => {};
    },
  };
}

describe("one write parses its content once (#3)", () => {
  it("a full-text write parses and scans once and reads only its own document", async () => {
    const r = await realistic();
    const w = await r.engine.write("leaf1", { writer, fullText: leaf(1, "prose edit") });
    expect(w.ok).toBe(true);
    expect(r.snapshot()).toEqual({ parses: 1, scans: 1, reads: 1, readsByDoc: { leaf1: 1 } });
    // Delivery still reaches the board that includes the written document.
    expect(r.seen.board1).toContain("doc.updated:leaf1");
    expect(r.seen.board0).not.toContain("doc.updated:leaf1");
  });

  it("seeds the parse cache: the next projection parses and scans nothing", async () => {
    const r = await realistic();
    await r.engine.write("leaf1", { writer, fullText: leaf(1, "prose edit") });
    r.reset();
    const p = await r.engine.projection("board1", "text", {});
    expect(p.ok).toBe(true);
    expect(p.output).toContain("prose edit");
    expect({ parses: counts.parses, scans: counts.scans }).toEqual({ parses: 0, scans: 0 });
  });

  it("a patch parses and scans once, and the next projection parses nothing", async () => {
    const r = await realistic();
    const w = await r.engine.patch("leaf2", "c2", { writer, attrs: { items: ["a", "b"] } });
    expect(w.ok).toBe(true);
    expect(r.snapshot()).toEqual({ parses: 1, scans: 1, reads: 1, readsByDoc: { leaf2: 1 } });
    r.reset();
    const p = await r.engine.projection("board2", "text", {});
    expect(p.ok).toBe(true);
    expect({ parses: counts.parses, scans: counts.scans }).toEqual({ parses: 0, scans: 0 });
  });

  it("an intent parses and scans once (its pre-lock read included)", async () => {
    const r = await r0();
    const w = await r.engine.applyIntent(
      { docId: "leaf3", blockId: "c3", affordance: "add", params: { item: "z" } },
      { writer },
    );
    expect(w.ok).toBe(true);
    expect(r.snapshot()).toEqual({ parses: 1, scans: 1, reads: 2, readsByDoc: { leaf3: 2 } });
  });

  it("a create parses and scans once, and the next projection of it parses nothing", async () => {
    const r = await realistic();
    const w = await r.engine.createDoc("fresh", { writer, content: "# Fresh\n\nx\n" });
    expect(w.ok).toBe(true);
    expect({ parses: counts.parses, scans: counts.scans }).toEqual({ parses: 1, scans: 1 });
    r.reset();
    const p = await r.engine.projection("fresh", "text", {});
    expect(p.ok).toBe(true);
    expect({ parses: counts.parses, scans: counts.scans }).toEqual({ parses: 0, scans: 0 });
  });

  it("with watch on, recording the self-echo costs no parse", async () => {
    const r = await realistic({ watch: { rootDir: "/ws", source: manualSource() } });
    await r.engine.write("leaf1", { writer, fullText: leaf(1, "prose edit") });
    expect({ parses: counts.parses, scans: counts.scans }).toEqual({ parses: 1, scans: 1 });
    r.reset();
    await r.engine.write("leaf2", { writer, fullText: leaf(2, "prose edit") });
    expect({ parses: counts.parses, scans: counts.scans }).toEqual({ parses: 1, scans: 1 });
  });

  it("a write whose bounded history is truncated seeds the stored, truncated content", async () => {
    const logType: BlockType = {
      type: "log",
      schema: {
        type: "object",
        required: ["id", "entries"],
        properties: { id: { type: "string" }, entries: { type: "array" } },
      },
      history: { attr: "entries", max: 2 },
    };
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock, blocks: [logType] });
    const doc = (entries: string) => `# L\n\n\`\`\`log\nid: l\nentries: [${entries}]\n\`\`\`\n`;
    await engine.createDoc("l", { writer, content: doc("a") });
    const w = await engine.write("l", { writer, fullText: doc("a, b, c") });
    expect(w.ok).toBe(true);
    counts.parses = 0;
    expect((await engine.getBlock("l", "l"))?.attrs.entries).toEqual(["b", "c"]);
    expect(counts.parses).toBe(0);
  });
});

/** The realistic setup, under its own name for the intent test. */
const r0 = realistic;

describe("the reverse include index is kept incrementally (#3)", () => {
  it("a write that changes no include edge reads no other document", async () => {
    const r = await realistic();
    await r.engine.write("common", { writer, fullText: "# Common\n\nShared, edited.\n" });
    await r.engine.write("deep3", { writer, fullText: deep(3).replace("prose", "words") });
    expect(r.snapshot().readsByDoc).toEqual({ common: 1, deep3: 1 });
    expect(r.seen.board3).toContain("doc.updated:deep3");
    for (const b of ["board0", "board1", "board2", "board3"]) {
      expect(r.seen[b]).toContain("doc.updated:common");
    }
  });

  it("a write that adds an include re-reads only the subscribers that read the document", async () => {
    const r = await realistic();
    await r.storage.writeAtomic(asDocId("extra"), "# Extra\n\nx\n");
    r.reset();
    const added = `${leaf(1, "v0")}\n{{include:extra}}\n`;
    expect((await r.engine.write("leaf1", { writer, fullText: added })).ok).toBe(true);
    expect(r.snapshot().readsByDoc).toEqual({ leaf1: 1 });
    r.reset();
    const probe = await r.engine.write("extra", { writer, fullText: "# Extra\n\ny\n" });
    expect(probe.ok).toBe(true);
    // board1's closure is re-resolved (5 reads); the other boards are not read.
    expect(r.snapshot().readsByDoc).toEqual({
      extra: 2,
      board1: 1,
      common: 1,
      leaf1: 1,
      deep1: 1,
    });
    expect(r.seen.board1).toContain("doc.updated:extra");
    for (const b of ["board0", "board2", "board3"]) {
      expect(r.seen[b]).not.toContain("doc.updated:extra");
    }
  });

  it("a write to a document no subscriber reads re-reads nothing", async () => {
    const r = await realistic();
    await r.engine.createDoc("loose", { writer, content: "# Loose\n" });
    r.reset();
    await r.engine.write("loose", { writer, fullText: "# Loose\n\n{{include:common}}\n" });
    await r.engine.write("loose", { writer, fullText: "# Loose\n" });
    expect(r.snapshot().readsByDoc).toEqual({ loose: 2 });
  });
});

describe("a shared, frozen parse never leaks out of the cache (#3)", () => {
  it("event payloads are the subscriber's own, even when the parse is cached", async () => {
    const r = await realistic();
    const got: Record<string, unknown>[] = [];
    r.engine.subscribe((evt) => got.push(evt));
    const withMeta = (n: number) =>
      leaf(1, "v1").replace("items: [a]", `items: [a]\nmeta: {n: ${n}}`);
    await r.engine.write("leaf1", { writer, fullText: withMeta(1) });
    await r.engine.write("leaf1", { writer, fullText: withMeta(2) });
    await r.engine.patch("leaf1", "c1", { writer, attrs: { meta: { n: 3 } } });
    const metas = got
      .filter((e) => e.type === "block.updated")
      .map((e) => (e.values as Record<string, unknown>).meta);
    expect(metas).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    for (const m of metas) expect(Object.isFrozen(m)).toBe(false);
  });

  it("an affordance that mutates the attrs it is given does not throw", async () => {
    const mutating: BlockType = {
      ...checklistType,
      type: "todo",
      affordances: [
        {
          name: "push",
          patch: (attrs) => {
            (attrs.items as unknown[]).push("z");
            return { items: attrs.items };
          },
        },
      ],
    };
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock, blocks: [mutating] });
    await engine.createDoc("t", { writer, content: "# T\n\n```todo\nid: t\nitems: [a]\n```\n" });
    await engine.projection("t", "text", {}); // the parse is cached and frozen
    const r = await engine.applyIntent(
      { docId: "t", blockId: "t", affordance: "push" },
      { writer },
    );
    expect(r.ok).toBe(true);
  });
});
