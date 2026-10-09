import { describe, expect, it, vi } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { type WriteMiddleware, WriteRejection } from "../middleware/compose.js";
import type { ParsedDoc } from "../model/doc.js";
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
 * The reads of one full include-index rebuild in the realistic setup: every
 * subscribed board's closure (board, `common`, leaf, deep), so `common` four
 * times. The rebuild reads; it parses and scans nothing it has seen.
 */
const REBUILD_READS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(
    [0, 1, 2, 3].flatMap((i) => [
      [`board${i}`, 1],
      [`leaf${i}`, 1],
      [`deep${i}`, 1],
    ]),
  ),
  common: 4,
};

/** The rebuild's reads plus `extra` reads per document by the write itself. */
const rebuildPlus = (extra: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = { ...REBUILD_READS };
  for (const [doc, n] of Object.entries(extra)) out[doc] = (out[doc] ?? 0) + n;
  return out;
};

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
  it("a full-text write parses and scans once; the index rebuild before it re-reads but parses nothing", async () => {
    const r = await realistic();
    const w = await r.engine.write("leaf1", { writer, fullText: leaf(1, "prose edit") });
    expect(w.ok).toBe(true);
    expect(r.snapshot()).toEqual({
      parses: 1,
      scans: 1,
      reads: 17,
      readsByDoc: rebuildPlus({ leaf1: 1 }),
    });
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
    expect(r.snapshot()).toEqual({
      parses: 1,
      scans: 1,
      reads: 17,
      readsByDoc: rebuildPlus({ leaf2: 1 }),
    });
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
    expect(r.snapshot()).toEqual({
      parses: 1,
      scans: 1,
      reads: 18,
      readsByDoc: rebuildPlus({ leaf3: 2 }),
    });
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

describe("the reverse include index is rebuilt through the seeded parse cache (#3)", () => {
  it("each write rebuilds the index from every closure, and parses only its own content", async () => {
    const r = await realistic();
    await r.engine.write("common", { writer, fullText: "# Common\n\nShared, edited.\n" });
    await r.engine.write("deep3", { writer, fullText: deep(3).replace("prose", "words") });
    const both = rebuildPlus({ common: 1, deep3: 1 });
    for (const [doc, n] of Object.entries(REBUILD_READS)) both[doc] = (both[doc] ?? 0) + n;
    expect(r.snapshot()).toEqual({ parses: 2, scans: 2, reads: 34, readsByDoc: both });
    expect(r.seen.board3).toContain("doc.updated:deep3");
    for (const b of ["board0", "board1", "board2", "board3"]) {
      expect(r.seen[b]).toContain("doc.updated:common");
    }
  });

  it("a write that adds an include is seen by the next write's rebuild", async () => {
    const r = await realistic();
    await r.storage.writeAtomic(asDocId("extra"), "# Extra\n\nx\n");
    const added = `${leaf(1, "v0")}\n{{include:extra}}\n`;
    expect((await r.engine.write("leaf1", { writer, fullText: added })).ok).toBe(true);
    r.reset();
    const probe = await r.engine.write("extra", { writer, fullText: "# Extra\n\ny\n" });
    expect(probe.ok).toBe(true);
    // The rebuild reads `extra` for board1's closure and parses it (it was
    // never read before); the write parses its new content.
    expect(r.snapshot()).toEqual({
      parses: 2,
      scans: 2,
      reads: 18,
      readsByDoc: rebuildPlus({ extra: 2 }),
    });
    expect(r.seen.board1).toContain("doc.updated:extra");
    for (const b of ["board0", "board2", "board3"]) {
      expect(r.seen[b]).not.toContain("doc.updated:extra");
    }
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

/**
 * #41: a write middleware that needs the proposed text's structure parses it
 * through `ctx.parse`, which goes through the engine's parse cache, and the
 * pipeline then reuses that parse instead of making its own.
 */
describe("write middleware shares the write's parse (#41)", () => {
  /** The proposed text of a full-text write or a create, if the write has one. */
  const proposedText = (proposed: object): string | undefined =>
    "fullText" in proposed
      ? (proposed.fullText as string)
      : "content" in proposed
        ? (proposed.content as string)
        : undefined;

  /** A middleware that parses every proposed text through `ctx.parse`. */
  function inspecting(times = 1): { middleware: WriteMiddleware; seen: ParsedDoc[] } {
    const seen: ParsedDoc[] = [];
    const middleware: WriteMiddleware = async (ctx, next) => {
      const text = proposedText(ctx.proposed);
      if (text !== undefined) {
        for (let i = 0; i < times; i += 1) {
          const r = ctx.parse(text);
          if (!r.ok) throw new WriteRejection(r.rejection.reason, r.rejection.diagnostics);
          seen.push(r.parsed);
        }
      }
      await next();
    };
    return { middleware, seen };
  }

  it("a full-text write parses and scans its new text exactly once", async () => {
    const m = inspecting();
    const r = await realistic({ middleware: { write: [m.middleware] } });
    m.seen.length = 0;
    const w = await r.engine.write("leaf1", { writer, fullText: leaf(1, "prose edit") });
    expect(w.ok).toBe(true);
    expect(m.seen).toHaveLength(1);
    expect(r.snapshot()).toEqual({
      parses: 1,
      scans: 1,
      reads: 17,
      readsByDoc: rebuildPlus({ leaf1: 1 }),
    });
    // The parse the middleware saw is the one the write seeded.
    r.reset();
    expect((await r.engine.projection("board1", "text", {})).output).toContain("prose edit");
    expect({ parses: counts.parses, scans: counts.scans }).toEqual({ parses: 0, scans: 0 });
  });

  it("a create parses and scans its content exactly once", async () => {
    const m = inspecting();
    const r = await realistic({ middleware: { write: [m.middleware] } });
    const w = await r.engine.createDoc("fresh", { writer, content: "# Fresh\n\nx\n" });
    expect(w.ok).toBe(true);
    expect({ parses: counts.parses, scans: counts.scans }).toEqual({ parses: 1, scans: 1 });
  });

  it("parsing the same text again, or in a second middleware, costs nothing more", async () => {
    const a = inspecting(2);
    const b = inspecting();
    const r = await realistic({ middleware: { write: [a.middleware, b.middleware] } });
    a.seen.length = 0;
    b.seen.length = 0;
    const w = await r.engine.write("leaf1", { writer, fullText: leaf(1, "prose edit") });
    expect(w.ok).toBe(true);
    expect({ parses: counts.parses, scans: counts.scans }).toEqual({ parses: 1, scans: 1 });
    const first = a.seen[0];
    expect([...a.seen, ...b.seen].every((p) => p === first)).toBe(true);
  });

  it("a middleware that amends the text after parsing it leaves the new text to the pipeline", async () => {
    const amend: WriteMiddleware = async (ctx, next) => {
      const text = proposedText(ctx.proposed);
      if (ctx.mode === "full" && text !== undefined) {
        expect(ctx.parse(text).ok).toBe(true);
        ctx.proposed = { fullText: text.replace("draft", "final") };
      }
      await next();
    };
    const r = await realistic({ middleware: { write: [amend] } });
    const w = await r.engine.write("leaf1", { writer, fullText: leaf(1, "draft") });
    expect(w.ok).toBe(true);
    // One parse for what the middleware read, one for what the write stored.
    expect(counts.parses).toBe(2);
    expect(await r.storage.read(asDocId("leaf1"))).toBe(leaf(1, "final"));
  });

  it("a write whose bounded history is truncated still truncates from the shared parse", async () => {
    const logType: BlockType = {
      type: "log",
      schema: {
        type: "object",
        required: ["id", "entries"],
        properties: { id: { type: "string" }, entries: { type: "array" } },
      },
      history: { attr: "entries", max: 2 },
    };
    const m = inspecting();
    const storage = createMemStorage();
    const engine = createEngine({
      storage,
      clock,
      blocks: [logType],
      middleware: { write: [m.middleware] },
    });
    const doc = (entries: string) => `# L\n\n\`\`\`log\nid: l\nentries: [${entries}]\n\`\`\`\n`;
    await engine.createDoc("l", { writer, content: doc("a") });
    counts.parses = 0;
    const w = await engine.write("l", { writer, fullText: doc("a, b, c") });
    expect(w.ok).toBe(true);
    // The shared parse of the proposed text, then the parse of the truncated text.
    expect(counts.parses).toBe(2);
    expect((await engine.getBlock("l", "l"))?.attrs.entries).toEqual(["b", "c"]);
  });

  it("checks the size limit before parsing, and rejects as the pipeline would", async () => {
    const big = `# Big\n\n${"x".repeat(200)}\n`;
    const results = [];
    for (const write of [[inspecting().middleware], []]) {
      const engine = createEngine({
        storage: createMemStorage(),
        clock,
        maxDocumentBytes: 100,
        middleware: { write },
      });
      counts.parses = 0;
      counts.scans = 0;
      results.push(await engine.createDoc("big", { writer, content: big }));
      expect({ parses: counts.parses, scans: counts.scans }).toEqual({ parses: 0, scans: 0 });
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.ok === false && results[0].rejection.reason).toBe("too-large");
  });

  it("checks the complexity limits before parsing, and rejects as the pipeline would", async () => {
    const deep = `# Deep\n\n${"[".repeat(10)}x${"]".repeat(10)}\n`;
    const results = [];
    for (const write of [[inspecting().middleware], []]) {
      const engine = createEngine({
        storage: createMemStorage(),
        clock,
        complexityLimits: { maxBracketDepth: 4 },
        middleware: { write },
      });
      counts.parses = 0;
      results.push(await engine.createDoc("deep", { writer, content: deep }));
      expect(counts.parses).toBe(0);
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.ok === false && results[0].rejection.reason).toBe("too-complex");
  });

  it("leaves the results, the stored text and the events unchanged", async () => {
    const logType: BlockType = {
      type: "log",
      schema: {
        type: "object",
        required: ["id", "entries"],
        properties: { id: { type: "string" }, entries: { type: "array" } },
      },
      history: { attr: "entries", max: 2 },
    };
    const doc = (entries: string, note: string) =>
      `# L\n\n${note}\n\n\`\`\`log\nid: l\nentries: [${entries}]\n\`\`\`\n`;
    const run = async (write: WriteMiddleware[]) => {
      const storage = createMemStorage();
      const engine = createEngine({
        storage,
        clock,
        blocks: [logType, checklistType],
        commitIdPrefix: "same",
        middleware: { write },
      });
      const results = [
        await engine.createDoc("l", { writer, content: doc("a", "one") }),
        await engine.write("l", { writer, fullText: doc("a, b", "two") }),
        await engine.write("l", { writer, fullText: doc("a, b, c, d", "three") }),
        await engine.write("l", { writer, fullText: doc("x", "four").replace("id: l", "") }),
        await engine.patch("l", "l", { writer, attrs: { entries: ["p", "q", "r"] } }),
      ];
      return { results, stored: await storage.read(asDocId("l")), events: storage.getEvents() };
    };
    const plain = await run([]);
    const shared = await run([inspecting().middleware]);
    expect(shared).toEqual(plain);
    expect(plain.results.map((r) => r.ok)).toEqual([true, true, true, false, true]);
  });
});
