import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { asDocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import type { EventRecord, Lock } from "../ports/ports.js";
import type { WatchEvent, WatchSource } from "../watch/source.js";
import { createEngine, type EngineOptions } from "./engine.js";

/**
 * `engine.importDoc` (#18): restore a document's bytes as they were, through
 * the engine, so the lock, the self-echo record, the reverse include index
 * and the caches all see the commit.
 */

const checklistType: BlockType = {
  type: "checklist",
  schema: {
    type: "object",
    required: ["id", "items"],
    properties: { id: { type: "string" }, items: { type: "array" } },
  },
};

const writer = { kind: "human", id: "u1" } as const;
const clock = () => "2026-10-04T00:00:00Z";
/** `items: nope` fails the checklist schema: createDoc refuses it. */
const broken = "# Trash\n\n```checklist\nid: c\nitems: nope\n```\n";

function makeEngine(extra: Partial<EngineOptions> = {}) {
  const storage = createMemStorage();
  const engine = createEngine({ storage, clock, blocks: [checklistType], ...extra });
  return { storage, engine };
}

/** A watch source the test drives by hand. */
function manualSource(): { source: WatchSource; emit: (p: string) => void } {
  let cb: ((evt: WatchEvent) => void) | undefined;
  return {
    source: {
      async start(onChange) {
        cb = onChange;
        return async () => {
          cb = undefined;
        };
      },
    },
    emit: (p) => cb?.({ path: p }),
  };
}

describe("engine.importDoc", () => {
  it("restores a document createDoc rejects, byte for byte", async () => {
    const { engine } = makeEngine();
    const created = await engine.createDoc("t", { writer, content: broken });
    expect(created.ok ? undefined : created.rejection.reason).toBe("validation");

    const r = await engine.importDoc("t", { writer, content: broken });
    expect(r.ok).toBe(true);
    expect((await engine.getDoc("t"))?.src).toBe(broken);
    // The projection reports the schema violation instead of refusing the doc.
    const p = await engine.projection("t", "text", {});
    expect(p.ok).toBe(true);
  });

  it("emits doc.created with imported: true to subscribers", async () => {
    const { engine } = makeEngine();
    const seen: EventRecord[] = [];
    engine.subscribe((e) => seen.push(e));
    await engine.importDoc("t", { writer, content: broken });
    expect(seen).toMatchObject([{ type: "doc.created", docId: "t", imported: true, by: writer }]);
  });

  it("stores content over maxDocumentBytes only with ignoreSizeLimit, and then never parses it", async () => {
    const { engine } = makeEngine({ maxDocumentBytes: 32 });
    const big = `${broken}\n${"x".repeat(64)}\n`;
    const refused = await engine.importDoc("big", { writer, content: big });
    expect(refused.ok ? undefined : refused.rejection.reason).toBe("too-large");

    const r = await engine.importDoc("big", { writer, content: big, ignoreSizeLimit: true });
    expect(r.ok).toBe(true);
    expect((await engine.getDoc("big"))?.src).toBe(big);
    const p = await engine.projection("big", "text", {});
    expect(p.ok).toBe(false);
    expect(p.diagnostics.map((d) => d.code)).toEqual(["E_DOCUMENT_TOO_LARGE"]);
  });

  it("stores content over a complexity limit, which then degrades on read", async () => {
    const { engine } = makeEngine({ complexityLimits: { maxContainerDepth: 2 } });
    const deep = "# Deep\n\n> > > > deep\n";
    const created = await engine.createDoc("deep", { writer, content: deep });
    expect(created.ok ? undefined : created.rejection.reason).toBe("too-complex");

    const r = await engine.importDoc("deep", { writer, content: deep });
    expect(r.ok).toBe(true);
    expect((await engine.getDoc("deep"))?.src).toBe(deep);
    const p = await engine.projection("deep", "text", {});
    expect(p.ok).toBe(false);
    expect(p.diagnostics.map((d) => d.code)).toEqual(["E_DOCUMENT_TOO_COMPLEX"]);
    expect(await engine.getBlock("deep", "x")).toBeUndefined();
  });

  it("rejects an invalid id fail-soft", async () => {
    const { engine } = makeEngine();
    const r = await engine.importDoc("../x", { writer, content: broken });
    expect(r.ok ? undefined : r.rejection.reason).toBe("invalid-id");
  });

  it("goes through the engine's lock", async () => {
    let entered = 0;
    const lock: Lock = {
      async withLock(fn) {
        entered += 1;
        return fn();
      },
    };
    const { engine } = makeEngine({ lock });
    await engine.importDoc("t", { writer, content: broken });
    expect(entered).toBe(1);
  });

  it("records the self-echo: the watcher's event for the import is suppressed", async () => {
    const { source, emit } = manualSource();
    const { storage, engine } = makeEngine({ watch: { rootDir: "/ws", source } });
    await engine.importDoc("t", { writer, content: broken });
    const outcome = await engine.externalWrite(path.join("/ws", "t.md"));
    expect(outcome).toMatchObject({ suppressed: true, external: false, events: [] });
    emit(path.join("/ws", "t.md"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.getEvents().map((e) => e.type)).toEqual(["doc.created"]);
    await engine.close();
  });

  it("invalidates the reverse include index: a board's subscriber gets the next write's events", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("board", { writer, content: "# Board\n\n{{include:t}}\n" });
    const seen: EventRecord[] = [];
    engine.subscribe("board", (e) => seen.push(e));
    // Build the index while `t` does not exist yet: the include has no edge.
    await engine.write("board", { writer, fullText: "# Board\n\n{{include:t}}\n\nmore\n" });
    seen.length = 0;

    await engine.importDoc("t", { writer, content: broken });
    await engine.write("t", { writer, fullText: "# Trash\n\nfixed\n" });
    expect(seen.some((e) => e.docId === "t" && e.type !== "doc.created")).toBe(true);
  });

  it("invalidates the caches: a projection after remove and import shows the imported bytes", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("board", { writer, content: "# Board\n\n{{include:t}}\n" });
    await engine.createDoc("t", { writer, content: "# Old\n\nbefore\n" });
    const first = await engine.projection<string>("board", "text", {});
    expect(first.output).toContain("before");
    await engine.removeDoc("t", { writer });
    await engine.importDoc("t", { writer, content: "# Restored\n\nafter\n" });
    const second = await engine.projection<string>("board", "text", {});
    expect(second.output).toContain("after");
    expect(second.output).not.toContain("before");
    expect(second.versions[asDocId("t")]).toBe((await engine.getDoc("t"))?.version);
  });
});
