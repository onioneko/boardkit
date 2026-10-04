import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { asDocId, type DocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import type { Storage } from "../ports/ports.js";
import type { WatchSource } from "../watch/source.js";
import { createEngine, type EngineOptions } from "./engine.js";

/**
 * Review findings on #3 (task 2b): the paths on which the incremental include
 * index or the seeded parse cache could go stale and stay stale. Each test
 * here failed before its fix, and passes on a full-rebuild engine.
 */

const writer = { kind: "human", id: "u1" } as const;
const clock = () => "2026-10-04T00:00:00Z";
const silentSource: WatchSource = {
  async start() {
    return async () => {};
  },
};

/** An engine with watch on over `storage`, and a recorder for one scoped subscriber. */
function watched(storage: Storage, extra: Partial<EngineOptions> = {}) {
  const engine = createEngine({
    storage,
    clock,
    watch: { rootDir: "/ws", source: silentSource },
    ...extra,
  });
  const seen: string[] = [];
  const subscribe = (docId: string) =>
    engine.subscribe(docId, (evt) => seen.push(`${evt.type}:${String(evt.docId)}`));
  return { engine, seen, subscribe };
}

describe("C1: a document removed, then restored with the same bytes", () => {
  it("after removeDoc, an external restore is not a self-echo, and the index learns its edges", async () => {
    const storage = createMemStorage();
    const { engine, seen, subscribe } = watched(storage);
    await storage.writeAtomic(asDocId("board"), "# Board\n\n{{include:a}}\n");
    await storage.writeAtomic(asDocId("y"), "# Y\n");
    const a = "# A\n\n{{include:y}}\n";
    expect((await engine.createDoc("a", { writer, content: a })).ok).toBe(true);
    expect((await engine.removeDoc("a", { writer })).ok).toBe(true);
    subscribe("board");
    await engine.write("y", { writer, fullText: "# Y\n\n1\n" }); // the index sees `a` missing

    await storage.writeAtomic(asDocId("a"), a); // e.g. `git checkout`
    const outcome = await engine.externalWrite("/ws/a.md");
    expect(outcome?.suppressed).toBe(false);

    seen.length = 0;
    await engine.write("y", { writer, fullText: "# Y\n\n2\n" });
    expect(seen).toContain("doc.updated:y");
  });

  it("after an external delete, an external restore is not a self-echo", async () => {
    const storage = createMemStorage();
    const { engine, seen, subscribe } = watched(storage);
    await storage.writeAtomic(asDocId("board"), "# Board\n\n{{include:a}}\n");
    await storage.writeAtomic(asDocId("y"), "# Y\n");
    const a = "# A\n\n{{include:y}}\n";
    expect((await engine.createDoc("a", { writer, content: a })).ok).toBe(true);
    await storage.delete?.(asDocId("a"));
    expect(await engine.externalWrite("/ws/a.md")).toBeUndefined();
    subscribe("board");
    await engine.write("y", { writer, fullText: "# Y\n\n1\n" });

    await storage.writeAtomic(asDocId("a"), a);
    expect((await engine.externalWrite("/ws/a.md"))?.suppressed).toBe(false);

    seen.length = 0;
    await engine.write("y", { writer, fullText: "# Y\n\n2\n" });
    expect(seen).toContain("doc.updated:y");
  });
});

describe("I1: a commit is compared with the shape the index last saw", () => {
  it("an engine write that keeps a pending external edit's new include still updates the index", async () => {
    const storage = createMemStorage();
    const { engine, seen, subscribe } = watched(storage);
    await storage.writeAtomic(asDocId("board"), "# Board\n\n{{include:x}}\n");
    await storage.writeAtomic(asDocId("x"), "# X\n");
    await storage.writeAtomic(asDocId("y"), "# Y\n");
    subscribe("board");
    await engine.write("y", { writer, fullText: "# Y\n\n1\n" }); // builds the index

    // An editor adds an include; the watcher has not reported it yet.
    await storage.writeAtomic(asDocId("x"), "# X\n\n{{include:y}}\n");
    // An agent writes x, keeping the editor's include.
    await engine.write("x", { writer, fullText: "# X\n\n{{include:y}}\n\nagent\n" });
    // The watch event arrives: storage holds the engine's own bytes.
    expect((await engine.externalWrite("/ws/x.md"))?.suppressed).toBe(true);

    seen.length = 0;
    await engine.write("y", { writer, fullText: "# Y\n\n2\n" });
    expect(seen).toContain("doc.updated:y");
  });

  it("without watch, a document changed in storage is seen at its next commit", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock });
    const seen: string[] = [];
    await storage.writeAtomic(asDocId("board"), "# Board\n\n{{include:x}}\n");
    await storage.writeAtomic(asDocId("x"), "# X\n");
    await storage.writeAtomic(asDocId("y"), "# Y\n");
    engine.subscribe("board", (evt) => seen.push(String(evt.docId)));
    await engine.write("y", { writer, fullText: "# Y\n\n1\n" });

    await storage.writeAtomic(asDocId("x"), "# X\n\n{{include:y}}\n");
    await engine.patch("x", "nope", { writer, attrs: {} }); // rejected: no commit
    await engine.write("x", { writer, fullText: "# X\n\n{{include:y}}\n\nmore\n" });

    seen.length = 0;
    await engine.write("y", { writer, fullText: "# Y\n\n2\n" });
    expect(seen).toContain("y");
  });

  it("a document changed behind the engine's back is caught when another subscriber's pass reads it", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock });
    const seen: string[] = [];
    await storage.writeAtomic(asDocId("b1"), "# B1\n\n{{include:x}}\n");
    await storage.writeAtomic(asDocId("b2"), "# B2\n\n{{include:x}}\n");
    await storage.writeAtomic(asDocId("x"), "# X\n\n{{include:y}}\n");
    await storage.writeAtomic(asDocId("y"), "# Y\n");
    engine.subscribe("b1", (evt) => seen.push(`b1:${String(evt.docId)}`));
    await engine.write("y", { writer, fullText: "# Y\n\n1\n" }); // b1's pass reads x → y

    await storage.writeAtomic(asDocId("x"), "# X\n"); // the include is dropped out of band
    engine.subscribe("b2", (evt) => seen.push(`b2:${String(evt.docId)}`));
    await engine.write("y", { writer, fullText: "# Y\n\n2\n" }); // b2's pass reads the new x
    await engine.write("x", { writer, fullText: "# X\n\nmore\n" }); // keeps the new shape

    seen.length = 0;
    await engine.write("y", { writer, fullText: "# Y\n\n3\n" });
    expect(seen).toEqual([]);
  });
});

describe("I2: registerBlock while a write is in flight", () => {
  it("does not seed a parse made under the old block registry", async () => {
    const inner = createMemStorage();
    let hold: Promise<void> | undefined;
    let held: () => void = () => {};
    const reached = new Promise<void>((resolve) => {
      held = resolve;
    });
    const storage: Storage = {
      ...inner,
      writeAtomic: async (docId: DocId, content: string) => {
        if (hold !== undefined) {
          held();
          await hold;
        }
        await inner.writeAtomic(docId, content);
      },
    };
    const engine = createEngine({ storage, clock });
    await engine.createDoc("d", { writer, content: "# D\n" });
    const widget: BlockType = {
      type: "widget",
      schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    };
    let release: () => void = () => {};
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = engine.write("d", { writer, fullText: "# D\n\n```widget\nid: w1\n```\n" });
    await reached;
    engine.registerBlock(widget);
    hold = undefined;
    release();
    expect((await write).ok).toBe(true);

    const fresh = createEngine({ storage: inner, clock, blocks: [widget] });
    expect(await fresh.getBlock("d", "w1")).toBeDefined();
    expect(await engine.getBlock("d", "w1")).toEqual(await fresh.getBlock("d", "w1"));
  });
});

describe("I3: an include target that could not be read once", () => {
  it("is resolved again at the next write once it reads", async () => {
    const inner = createMemStorage();
    let failX = false;
    const storage: Storage = {
      ...inner,
      read: async (docId: DocId) => {
        if (failX && docId === "x") throw Object.assign(new Error("EIO"), { code: "EIO" });
        return inner.read(docId);
      },
    };
    const engine = createEngine({ storage, clock });
    const seen: string[] = [];
    await inner.writeAtomic(asDocId("board"), "# Board\n\n{{include:x}}\n");
    await inner.writeAtomic(asDocId("x"), "# X\n\n{{include:y}}\n");
    await inner.writeAtomic(asDocId("y"), "# Y\n");
    await inner.writeAtomic(asDocId("z"), "# Z\n");
    engine.subscribe("board", (evt) => seen.push(String(evt.docId)));

    failX = true;
    await engine.write("z", { writer, fullText: "# Z\n\n1\n" }); // the pass cannot read x
    failX = false;
    await engine.write("z", { writer, fullText: "# Z\n\n2\n" });

    seen.length = 0;
    await engine.write("y", { writer, fullText: "# Y\n\n2\n" });
    expect(seen).toContain("y");
  });
});

describe("M1: a validate hook that changes the attrs it is given", () => {
  it("cannot change the parse a write seeds", async () => {
    const normalizing: BlockType = {
      type: "tag",
      schema: {
        type: "object",
        required: ["id", "name"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
      validate: (attrs) => {
        (attrs as Record<string, unknown>).name = String(attrs.name).toUpperCase();
        return [];
      },
    };
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock, blocks: [normalizing] });
    const doc = "# T\n\n```tag\nid: t1\nname: low\n```\n";
    expect((await engine.createDoc("t", { writer, content: doc })).ok).toBe(true);
    expect((await engine.write("t", { writer, fullText: `${doc}\nmore\n` })).ok).toBe(true);
    const fresh = createEngine({ storage, clock, blocks: [normalizing] });
    expect((await engine.getBlock("t", "t1"))?.attrs).toEqual(
      (await fresh.getBlock("t", "t1"))?.attrs,
    );
    expect((await engine.getBlock("t", "t1"))?.attrs.name).toBe("low");
  });
});
