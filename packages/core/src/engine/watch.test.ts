import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BlockType } from "../blocks/types.js";
import type { ParsedDoc } from "../model/doc.js";
import { asDocId } from "../model/ids.js";
import { createMemStorage, type MemStorage } from "../ports/mem.js";
import type { EventRecord, Source, Storage } from "../ports/ports.js";
import type { WatchEvent, WatchSource } from "../watch/source.js";
import { createEngine } from "./engine.js";

/**
 * chokidar is mocked so the `watch: true` branch (default source) never opens a
 * real watcher. Only the default-source path reaches it; every other test here
 * injects a manual WatchSource or leaves watching off.
 */
const chokidarState = vi.hoisted(() => ({
  globs: [] as string[],
}));

vi.mock("chokidar", () => ({
  default: {
    watch: (glob: string) => {
      chokidarState.globs.push(glob);
      return { on: () => {}, close: async () => {} };
    },
  },
}));

const clock = () => "2026-08-21T00:00:00Z";
const writer = { kind: "human", id: "u1" } as const;
/** A no-op Source for projections whose content carries no source refs. */
const noopSource: Source = { resolve: async () => ({ value: "—", stale: false }) };

const statusType: BlockType = {
  type: "status",
  schema: {
    type: "object",
    required: ["id", "states", "value"],
    properties: {
      id: { type: "string" },
      states: { type: "array", items: { type: "string" } },
      value: { type: "string" },
    },
    additionalProperties: true,
  },
  validate: (attrs: unknown) => {
    if (typeof attrs !== "object" || attrs === null) return [];
    const { value, states } = attrs as { value?: unknown; states?: unknown };
    if (Array.isArray(states) && typeof value === "string" && !states.includes(value)) {
      return [{ code: "E_STATUS_VALUE", message: `value "${value}" is not in states` }];
    }
    return [];
  },
  transitions: [{ attr: "value", event: "status.changed" }],
  affordances: [
    {
      name: "transition",
      params: {
        type: "object",
        required: ["to"],
        properties: { to: { type: "string" } },
        additionalProperties: false,
      },
      patch: (_attrs, params) => ({ value: (params as { to: string }).to }),
    },
  ],
};

/**
 * A manual WatchSource that captures its callback so tests can emit events.
 * `delivered()` counts the events the engine's own watch callback received, so
 * a test asserting that *no* external event was synthesized can show the
 * watcher was live rather than silently disconnected.
 */
function manualSource(): {
  source: WatchSource;
  emit: (p: string) => void;
  delivered: () => number;
} {
  let onChange: ((evt: WatchEvent) => void) | undefined;
  let delivered = 0;
  const source: WatchSource = {
    async start(cb) {
      onChange = (evt) => {
        cb(evt);
        delivered += 1;
      };
      return async () => {
        onChange = undefined;
      };
    },
  };
  return {
    source,
    emit(p) {
      onChange?.({ path: p });
    },
    delivered: () => delivered,
  };
}

function makeEngineWithWatch(watch: {
  readonly rootDir: string;
  readonly externalWriterId?: string;
  readonly source?: WatchSource;
}) {
  const storage = createMemStorage();
  const engine = createEngine({ storage, clock, blocks: [statusType], watch });
  return { storage, engine };
}

describe("engine external-write watching", () => {
  it("suppresses self-echoes after createDoc and write", async () => {
    const { storage, engine } = makeEngineWithWatch({ rootDir: "/ws" });
    await engine.createDoc("fin", { writer, content: "# A" });
    expect(await engine.externalWrite(path.join("/ws", "fin.md"))).toMatchObject({
      suppressed: true,
      external: false,
    });

    await engine.write("fin", { writer, fullText: "# A2" });
    expect(await engine.externalWrite(path.join("/ws", "fin.md"))).toMatchObject({
      suppressed: true,
      external: false,
    });

    expect(await storage.read(asDocId("fin"))).toBe("# A2");
  });

  it("suppresses self-echoes after patch", async () => {
    const storage = createMemStorage();
    const engine = createEngine({
      storage,
      clock,
      blocks: [statusType],
      parseOptions: { blockTypes: new Set(["status"]) },
      watch: { rootDir: "/ws" },
    });
    const src = "```status\nid: d\nstates: [pending, approved]\nvalue: pending\n```\n";
    await engine.createDoc("fin", { writer, content: src });
    await engine.patch("fin", "d", { writer, attrs: { value: "approved" } });
    expect(await engine.externalWrite(path.join("/ws", "fin.md"))).toMatchObject({
      suppressed: true,
      external: false,
    });
  });

  it("suppresses self-echoes after applyIntent", async () => {
    const storage = createMemStorage();
    const engine = createEngine({
      storage,
      clock,
      blocks: [statusType],
      parseOptions: { blockTypes: new Set(["status"]) },
      watch: { rootDir: "/ws" },
    });
    const src = "```status\nid: d\nstates: [pending, approved]\nvalue: pending\n```\n";
    await engine.createDoc("fin", { writer, content: src });

    const applied = await engine.applyIntent(
      { docId: "fin", blockId: "d", affordance: "transition", params: { to: "approved" } },
      { writer },
    );
    expect(applied.ok).toBe(true);

    expect(await engine.externalWrite(path.join("/ws", "fin.md"))).toMatchObject({
      suppressed: true,
      external: false,
    });
  });

  it("events external writes with the configured writer id and notifies subscribers", async () => {
    const storage = createMemStorage();
    const engine = createEngine({
      storage,
      clock,
      blocks: [statusType],
      watch: { rootDir: "/ws", externalWriterId: "editor-x" },
    });
    await engine.createDoc("fin", { writer, content: "# A" });

    const received: EventRecord[] = [];
    engine.subscribe((evt) => received.push(evt));

    await storage.writeAtomic(asDocId("fin"), "# B\n");
    const out = await engine.externalWrite(path.join("/ws", "fin.md"));

    expect(out?.external).toBe(true);
    expect(out?.suppressed).toBe(false);
    const types = out?.events.map((e) => e.type) ?? [];
    expect(types).toContain("doc.updated");
    expect(out?.events.every((e) => (e.by as { id: string } | undefined)?.id === "editor-x")).toBe(
      true,
    );
    // Subscribers are reached through the decorated sink, not the raw storage.
    expect(received.map((e) => e.type)).toEqual(expect.arrayContaining(types));
  });

  it("ignores non-markdown and out-of-root paths", async () => {
    const { engine } = makeEngineWithWatch({ rootDir: "/ws" });
    await engine.createDoc("fin", { writer, content: "# A" });
    expect(await engine.externalWrite(path.join("/ws", "notes.txt"))).toBeUndefined();
    expect(await engine.externalWrite(path.join("/etc", "fin.md"))).toBeUndefined();
  });

  it("resolves undefined when watching is disabled", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock, blocks: [statusType] });
    await engine.createDoc("fin", { writer, content: "# A" });
    expect(await engine.externalWrite(path.join("/ws", "fin.md"))).toBeUndefined();
  });

  it("auto-starts an injected WatchSource and routes its events to externalWrite", async () => {
    const { source, emit } = manualSource();
    const storage = createMemStorage();
    const engine = createEngine({
      storage,
      clock,
      blocks: [statusType],
      watch: { rootDir: "/ws", source, externalWriterId: "editor" },
    });
    await engine.createDoc("fin", { writer, content: "# A" });

    const received: string[] = [];
    engine.subscribe((evt) => received.push(evt.type));

    await storage.writeAtomic(asDocId("fin"), "# C\n");
    emit(path.join("/ws", "fin.md"));

    await vi.waitFor(() => expect(received).toContain("doc.updated"));
  });

  it("close() runs the injected watch source's closer", async () => {
    let closed = false;
    const source: WatchSource = {
      start: async () => async () => {
        closed = true;
      },
    };
    const storage = createMemStorage();
    const engine = createEngine({
      storage,
      clock,
      blocks: [statusType],
      watch: { rootDir: "/ws", source },
    });
    await engine.close();
    expect(closed).toBe(true);
  });

  it("close() is a no-op when watching was never enabled", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock, blocks: [statusType] });
    await expect(engine.close()).resolves.toBeUndefined();
  });

  it("watch: true throws a TypeError for storage without rootDir (mem storage)", () => {
    const storage = createMemStorage();
    expect(() => createEngine({ storage, clock, blocks: [statusType], watch: true })).toThrow(
      TypeError,
    );
  });

  it("watch: true resolves rootDir from storage.rootDir via the default source", () => {
    chokidarState.globs.length = 0;
    const storage: Storage = {
      read: async () => undefined,
      writeAtomic: async () => {},
      list: async () => [],
      rootDir: "/ws",
    };
    createEngine({ storage, clock, blocks: [statusType], watch: true });
    expect(chokidarState.globs).toEqual(["/ws"]);
  });

  it("invalidates the parse cache after an external write changes content", async () => {
    const storage = createMemStorage();
    const engine = createEngine({
      storage,
      clock,
      blocks: [statusType],
      parseOptions: { blockTypes: new Set(["status"]) },
      watch: { rootDir: "/ws" },
    });
    await engine.createDoc("fin", { writer, content: "# A" });
    const parsed: ParsedDoc[] = [];
    engine.registerProjector({
      id: "capture-doc",
      project: (input) => {
        parsed.push(input.doc);
        return "P";
      },
    });
    await engine.projection("fin", "capture-doc", { source: noopSource });
    await engine.projection("fin", "capture-doc", { source: noopSource });
    expect(parsed[0]).toBe(parsed[1]);

    await storage.writeAtomic(asDocId("fin"), "# B\n");
    const out = await engine.externalWrite(path.join("/ws", "fin.md"));
    expect(out?.external).toBe(true);

    await engine.projection("fin", "capture-doc", { source: noopSource });
    expect(parsed[2]).not.toBe(parsed[0]);
  });
});

/**
 * Let the engine's fire-and-forget watch path (`void externalWrite(…)`) settle.
 * That path awaits `ensureReverseIndex()` → the handler's `handle()` → a
 * `storage.read` → one event-sink `append` per synthesized draft: a handful of
 * promise hops over in-memory adapters, which the first `setTimeout(0)` already
 * drains, so five ticks are margin rather than a tuned number. A *positive*
 * expectation on a genuine external event still uses `vi.waitFor`, not this.
 */
async function settleWatch(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The writer ids stamped on the collected events (`""` when an event carries none). */
function writerIds(events: readonly EventRecord[]): string[] {
  return events.map((e) => (e.by as { id?: string } | undefined)?.id ?? "");
}

/**
 * A storage whose `writeAtomic` performs the write and then, before returning,
 * fires the watch callback: the shipped chokidar source delivers in 1–5 ms, so
 * a real watcher lands while the pipeline is still emitting events and still
 * holding the document lock.
 */
function racingStorage(base: MemStorage, emit: (watchPath: string) => void): Storage {
  return {
    ...base,
    async writeAtomic(docId, content) {
      await base.writeAtomic(docId, content);
      emit(path.join("/ws", `${docId}.md`));
    },
  };
}

describe("self-echo suppression records at write time", () => {
  const blockSrc = "```status\nid: d\nstates: [pending, approved]\nvalue: pending\n```\n";
  const blockParse = { blockTypes: new Set(["status"]) };

  it("suppresses a watcher that fires while the commit is still emitting (patch)", async () => {
    const mem = createMemStorage();
    const { source, emit, delivered } = manualSource();
    const landings: string[] = [];
    const engine = createEngine({
      storage: racingStorage(mem, (p) => {
        landings.push(p);
        emit(p);
      }),
      clock,
      blocks: [statusType],
      parseOptions: blockParse,
      watch: { rootDir: "/ws", source },
    });
    const received: EventRecord[] = [];
    engine.subscribe((evt) => received.push(evt));

    await engine.createDoc("fin", { writer, content: blockSrc });
    const patched = await engine.patch("fin", "d", { writer, attrs: { value: "approved" } });
    expect(patched.ok).toBe(true);
    await settleWatch();

    // The watcher really did land inside both commits, the engine's watch
    // callback received both, and the engine's own events were collected — the
    // absence below is not a vacuous pass.
    expect(landings).toEqual([path.join("/ws", "fin.md"), path.join("/ws", "fin.md")]);
    expect(delivered()).toBe(2);
    expect(writerIds(received)).toContain("u1");
    expect(writerIds(received)).not.toContain("external");
    expect(await engine.externalWrite(path.join("/ws", "fin.md"))).toMatchObject({
      suppressed: true,
      external: false,
    });
  });

  it("suppresses a watcher that fires while the commit is still emitting (applyIntent)", async () => {
    const mem = createMemStorage();
    const { source, emit, delivered } = manualSource();
    const landings: string[] = [];
    const engine = createEngine({
      storage: racingStorage(mem, (p) => {
        landings.push(p);
        emit(p);
      }),
      clock,
      blocks: [statusType],
      parseOptions: blockParse,
      watch: { rootDir: "/ws", source },
    });
    const received: EventRecord[] = [];
    engine.subscribe((evt) => received.push(evt));

    await engine.createDoc("fin", { writer, content: blockSrc });
    const applied = await engine.applyIntent(
      { docId: "fin", blockId: "d", affordance: "transition", params: { to: "approved" } },
      { writer },
    );
    expect(applied.ok).toBe(true);
    await settleWatch();

    // As above: two landings, both delivered to the engine's watch callback.
    expect(landings).toEqual([path.join("/ws", "fin.md"), path.join("/ws", "fin.md")]);
    expect(delivered()).toBe(2);
    expect(writerIds(received)).toContain("u1");
    expect(writerIds(received)).not.toContain("external");
    expect(await engine.externalWrite(path.join("/ws", "fin.md"))).toMatchObject({
      suppressed: true,
      external: false,
    });
  });

  it("still events a genuine external edit made after the commit", async () => {
    const mem = createMemStorage();
    const { source, emit } = manualSource();
    const engine = createEngine({
      storage: racingStorage(mem, emit),
      clock,
      blocks: [statusType],
      watch: { rootDir: "/ws", source, externalWriterId: "editor-x" },
    });
    const received: EventRecord[] = [];
    engine.subscribe((evt) => received.push(evt));

    await engine.createDoc("fin", { writer, content: "# A\n" });
    await settleWatch();
    expect(writerIds(received)).toContain("u1");
    expect(writerIds(received)).not.toContain("editor-x");

    // Out of band: writing straight to the base storage bypasses the engine's
    // wrapper, so nothing is recorded and the watch event is a genuine edit.
    await mem.writeAtomic(asDocId("fin"), "# B\n");
    emit(path.join("/ws", "fin.md"));
    await vi.waitFor(() => expect(writerIds(received)).toContain("editor-x"));

    await mem.writeAtomic(asDocId("fin"), "# C\n");
    expect(await engine.externalWrite(path.join("/ws", "fin.md"))).toMatchObject({
      external: true,
      suppressed: false,
    });
  });

  it("issues no storage read once the committed bytes have landed", async () => {
    const mem = createMemStorage();
    const { source } = manualSource();
    let landed = false;
    let readsAfterLanding = 0;
    const storage: Storage = {
      ...mem,
      read(docId) {
        if (landed) readsAfterLanding += 1;
        return mem.read(docId);
      },
      async writeAtomic(docId, content) {
        await mem.writeAtomic(docId, content);
        landed = true;
      },
    };
    const engine = createEngine({
      storage,
      clock,
      blocks: [statusType],
      parseOptions: blockParse,
      watch: { rootDir: "/ws", source },
    });
    await engine.createDoc("fin", { writer, content: blockSrc });

    landed = false;
    readsAfterLanding = 0;
    const patched = await engine.patch("fin", "d", { writer, attrs: { value: "approved" } });
    expect(patched.ok).toBe(true);
    // Recording uses the bytes that landed, so the commit re-reads nothing.
    expect(readsAfterLanding).toBe(0);
  });

  it("records nothing and never throws when watching is disabled", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock, blocks: [statusType] });
    await expect(engine.createDoc("fin", { writer, content: "# A\n" })).resolves.toMatchObject({
      ok: true,
    });
    await expect(engine.write("fin", { writer, fullText: "# B\n" })).resolves.toMatchObject({
      ok: true,
    });
    expect(await engine.externalWrite(path.join("/ws", "fin.md"))).toBeUndefined();
  });
});
