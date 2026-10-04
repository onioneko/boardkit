import { describe, expect, it } from "vitest";
import { buildReverseIndex, resolveIncludes } from "../link/graph.js";
import { asDocId, type DocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import type { EventRecord } from "../ports/ports.js";
import type { WatchSource } from "../watch/source.js";
import { createEngine } from "./engine.js";

/**
 * #3: the reverse include index is kept incrementally, and the parse cache is
 * seeded by writes. Both must stay exactly as correct as rebuilding from
 * scratch. Seeded random runs of creates, writes, imports, removes, external
 * writes and deletes (through `externalWrite`), subscribes and unsubscribes
 * check after every step that:
 *
 * - a write to each document reaches exactly the subscribers a from-scratch
 *   index over current storage says it should;
 * - every projection matches that of a fresh engine (no caches) on the same
 *   storage.
 */

const DOCS = ["a", "b", "c", "d", "e"] as const;
const writer = { kind: "human", id: "u1" } as const;
const clock = () => "2026-10-04T00:00:00Z";

/** mulberry32: a small deterministic PRNG. */
function prng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function content(rand: () => number, id: string): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const lines = [`# ${id.toUpperCase()}`, "", "## s1", "", "text", ""];
  if (rand() < 0.5) lines.push("## s2", "", "more", "");
  const n = Math.floor(rand() * 3);
  for (let i = 0; i < n; i += 1) {
    const target = pick(DOCS);
    const section = pick(["", "", "#s1", "#s2", "#s3"]);
    lines.push(`{{include:${target}${section}}}`, "");
  }
  return lines.join("\n");
}

/** Toggle a trailing prose line: changes the content, never the include shape. */
function probed(src: string): string {
  return src.endsWith("probe\n") ? src.slice(0, -"probe\n".length) : `${src}probe\n`;
}

const silentSource: WatchSource = {
  async start() {
    return async () => {};
  },
};

async function run(seed: number, steps: number): Promise<void> {
  const rand = prng(seed);
  const storage = createMemStorage();
  const engine = createEngine({ storage, clock, watch: { rootDir: "/ws", source: silentSource } });
  const subscribed = new Map<DocId, () => void>();
  const delivered = new Map<DocId, EventRecord[]>();
  const exists = async (id: string) => (await storage.read(asDocId(id))) !== undefined;

  for (let step = 0; step < steps; step += 1) {
    const id = DOCS[Math.floor(rand() * DOCS.length)] as string;
    const op = Math.floor(rand() * 9);
    const label = `seed ${seed} step ${step}`;
    if (op <= 1) {
      if (await exists(id)) {
        const r = await engine.write(id, { writer, fullText: content(rand, id) });
        expect(r.ok, label).toBe(true);
      } else {
        const r = await engine.createDoc(id, { writer, content: content(rand, id) });
        expect(r.ok, label).toBe(true);
      }
    } else if (op === 2) {
      if (!(await exists(id))) {
        const r = await engine.importDoc(id, { writer, content: content(rand, id) });
        expect(r.ok, label).toBe(true);
      }
    } else if (op === 3) {
      if (await exists(id)) expect((await engine.removeDoc(id, { writer })).ok, label).toBe(true);
    } else if (op === 4) {
      // Written behind the engine's back, then reported by the watcher.
      await storage.writeAtomic(asDocId(id), content(rand, id));
      await engine.externalWrite(`/ws/${id}.md`);
    } else if (op === 5) {
      await storage.delete?.(asDocId(id));
      await engine.externalWrite(`/ws/${id}.md`);
    } else if (op <= 7) {
      if (!subscribed.has(asDocId(id))) {
        const events: EventRecord[] = [];
        delivered.set(asDocId(id), events);
        subscribed.set(
          asDocId(id),
          engine.subscribe(id, (evt) => events.push(evt)),
        );
      }
    } else {
      subscribed.get(asDocId(id))?.();
      subscribed.delete(asDocId(id));
      delivered.delete(asDocId(id));
    }

    // The reference: a from-scratch index over current storage.
    const edges = [];
    for (const s of subscribed.keys()) {
      edges.push(...(await resolveIncludes(s, storage)).includes);
    }
    const index = buildReverseIndex(edges);
    const recipients = (doc: DocId): Set<DocId> => {
      const out = new Set<DocId>([doc]);
      const stack = [doc];
      while (stack.length > 0) {
        for (const includer of index.get(stack.pop() as DocId) ?? []) {
          if (!out.has(includer)) {
            out.add(includer);
            stack.push(includer);
          }
        }
      }
      return out;
    };

    // Probe every document with a shape-preserving write.
    for (const doc of DOCS) {
      const src = await storage.read(asDocId(doc));
      if (src === undefined) continue;
      for (const events of delivered.values()) events.length = 0;
      const r = await engine.write(doc, { writer, fullText: probed(src) });
      expect(r.ok, `${label} probe ${doc}`).toBe(true);
      const want = [...subscribed.keys()].filter((s) => recipients(asDocId(doc)).has(s)).sort();
      const got = [...delivered.entries()]
        .filter(([, events]) => events.some((e) => e.docId === doc))
        .map(([s]) => s)
        .sort();
      expect(got, `${label} probe ${doc}`).toEqual(want);
    }

    // Every projection matches a cache-free engine's.
    const fresh = createEngine({ storage, clock });
    for (const doc of DOCS) {
      const mine = await engine.projection(doc, "text", {});
      const theirs = await fresh.projection(doc, "text", {});
      expect(mine, `${label} projection ${doc}`).toEqual(theirs);
    }
  }
  await engine.close();
}

describe("the incremental reverse index and the seeded parse cache match a rebuild", () => {
  for (let seed = 1; seed <= 24; seed += 1) {
    it(`random run, seed ${seed}`, async () => {
      await run(seed, 24);
    });
  }
});

describe("a commit that lands while the index is being rebuilt", () => {
  it("is not lost: the subscriber whose pass read the old content is resolved again", async () => {
    const inner = createMemStorage();
    let holdBuildReadOfX: Promise<void> | undefined;
    let buildReachedX: () => void = () => {};
    const reachedX = new Promise<void>((resolve) => {
      buildReachedX = resolve;
    });
    const storage = {
      ...inner,
      read: async (docId: DocId) => {
        const src = await inner.read(docId);
        if (docId === "x" && holdBuildReadOfX !== undefined) {
          const hold = holdBuildReadOfX;
          holdBuildReadOfX = undefined;
          buildReachedX();
          await hold;
        }
        return src;
      },
    };
    await inner.writeAtomic(asDocId("board"), "# Board\n\n{{include:x}}\n");
    await inner.writeAtomic(asDocId("x"), "# X\n");
    await inner.writeAtomic(asDocId("y"), "# Y\n");
    await inner.writeAtomic(asDocId("z"), "# Z\n");

    let releaseX: () => void = () => {};
    const xMayCommit = new Promise<void>((resolve) => {
      releaseX = resolve;
    });
    const engine = createEngine({
      storage,
      clock,
      middleware: {
        write: [
          async (ctx, next) => {
            if (ctx.docId === "x") await xMayCommit;
            await next();
          },
        ],
      },
    });

    // 1. A write to x passes the index check and waits in its middleware.
    const writeX = engine.write("x", { writer, fullText: "# X\n\n{{include:y}}\n" });
    await new Promise((r) => setTimeout(r, 0));
    // 2. A new subscriber; 3. a write to z rebuilds the index and reads x.
    const seen: string[] = [];
    engine.subscribe("board", (evt) => seen.push(String(evt.docId)));
    let releaseBuild: () => void = () => {};
    holdBuildReadOfX = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const writeZ = engine.write("z", { writer, fullText: "# Z\n\nz\n" });
    await reachedX;
    // 4. x commits (adding an include of y) while the rebuild holds x's old content.
    releaseX();
    expect((await writeX).ok).toBe(true);
    // 5. The rebuild finishes with x's old content.
    releaseBuild();
    expect((await writeZ).ok).toBe(true);

    // y is now in board's closure: a write to it must reach board's subscriber.
    seen.length = 0;
    expect((await engine.write("y", { writer, fullText: "# Y\n\ny\n" })).ok).toBe(true);
    expect(seen).toContain("y");
  });
});
