import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { buildReverseIndex, resolveIncludes } from "../link/graph.js";
import { asDocId, type DocId } from "../model/ids.js";
import { createMemStorage, type MemStorage } from "../ports/mem.js";
import type { EventRecord, Storage } from "../ports/ports.js";
import type { WatchSource } from "../watch/source.js";
import { createEngine } from "./engine.js";

/**
 * #3: the parse cache is seeded by writes, and the reverse include index is
 * rebuilt through it. Both must stay exactly as correct as rebuilding from
 * scratch with no caches. Seeded random runs of creates, writes, imports,
 * removes, external writes and deletes (through `externalWrite`), subscribes
 * and unsubscribes check:
 *
 * - after every step with no edit pending, that the engine's include index
 *   (a read-only snapshot) equals one built from scratch over current storage;
 * - after every step (some steps in `pending` mode), that a write to each
 *   document reaches exactly the subscribers the from-scratch index says it
 *   should, and that every projection matches that of a fresh engine (no
 *   caches) on the same storage.
 *
 * This harness and its snapshot oracle are the bar for any future incremental
 * include index.
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

/** A block type with an affordance, so runs can patch and apply intents. */
const boxType: BlockType = {
  type: "box",
  schema: {
    type: "object",
    required: ["id", "n"],
    properties: { id: { type: "string" }, n: { type: "number" } },
  },
  affordances: [{ name: "bump", patch: (attrs) => ({ n: Number(attrs.n) + 1 }) }],
};
/** Registered part-way through a run. */
const lateType: BlockType = {
  type: "late",
  schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
};
/** The size limit in `full` runs: small enough for documents to cross it. */
const FULL_MAX_BYTES = 600;

/** `full` runs: documents may carry blocks, a `late` fence, or padding past the size limit. */
function contentFull(rand: () => number, id: string, mayBeBig: boolean, s3 = false): string {
  let base = content(rand, id);
  // Includes of `s3`, a section only pending edits add: missing-section until then.
  if (s3 && rand() < 0.9) {
    base += `{{include:${DOCS[Math.floor(rand() * DOCS.length)]}#s3}}\n\n`;
  }
  const extra: string[] = [];
  if (rand() < 0.3) extra.push("```box", `id: ${id}box`, `n: ${Math.floor(rand() * 5)}`, "```", "");
  if (rand() < 0.2) extra.push("```late", `id: ${id}late`, "```", "");
  if (mayBeBig && rand() < 0.2) extra.push("pad ".repeat(200), "");
  return `${base}${extra.join("\n")}`;
}

/** Storage whose reads of the documents in `failing` throw, as a flaky disk would. */
function flaky(inner: MemStorage): { storage: Storage; failing: Set<string> } {
  const failing = new Set<string>();
  return {
    failing,
    storage: {
      ...inner,
      read: async (docId: DocId) => {
        if (failing.has(docId)) throw Object.assign(new Error("EIO"), { code: "EIO" });
        return inner.read(docId);
      },
    },
  };
}

type Mode = "v1" | "full" | "pending";

/**
 * One seeded run. `v1` is the original generator, kept unchanged so that the
 * seeds a review found keep replaying the same steps. `full` adds removal and
 * same-bytes restore, out-of-band edits under an engine write, patches and
 * intents, a block registered mid-run, documents past the size limit,
 * interleaved writes, and transient read errors. `pending` adds to `full`
 * edits made in storage and left unreported for one or more steps, as a watch
 * event still in flight, so other subscribers' passes can read them first.
 * Checks run only while no edit is pending: until it is reported or
 * committed, the engine cannot know of it. They also run on only some steps
 * (and always at the end): a check's probes commit every document, which
 * would otherwise reset what the engine knows of each one every step.
 */
async function run(seed: number, steps: number, mode: Mode = "v1"): Promise<void> {
  const rand = prng(seed);
  const storage = createMemStorage();
  const { storage: engineStorage, failing } = flaky(storage);
  const blocks: BlockType[] = mode === "v1" ? [] : [boxType];
  const limits = mode === "v1" ? {} : { maxDocumentBytes: FULL_MAX_BYTES };
  /** Documents edited in storage whose watch event has not arrived yet. */
  const pending = new Set<string>();
  const engine = createEngine({
    storage: engineStorage,
    clock,
    blocks: [...blocks],
    ...limits,
    watch: { rootDir: "/ws", source: silentSource },
  });
  const subscribed = new Map<DocId, () => void>();
  const delivered = new Map<DocId, EventRecord[]>();
  const exists = async (id: string) => (await storage.read(asDocId(id))) !== undefined;
  const pickDoc = () => DOCS[Math.floor(rand() * DOCS.length)] as string;

  for (let step = 0; step < steps; step += 1) {
    const id = pickDoc();
    const label = `${mode} seed ${seed} step ${step}`;
    if (mode === "v1") {
      const op = Math.floor(rand() * 9);
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
        subscribe(id);
      } else {
        unsubscribe(id);
      }
    } else {
      if (mode === "pending") await settlePending();
      await fullStep(id, label);
    }
    if (mode !== "pending") await check(label);
    else if (pending.size === 0 && rand() < 0.1) await check(label);
  }
  if (mode === "pending") {
    await settlePending(true);
    await check(`${mode} seed ${seed} end`);
  }
  await engine.close();

  function subscribe(id: string): void {
    if (subscribed.has(asDocId(id))) return;
    const events: EventRecord[] = [];
    delivered.set(asDocId(id), events);
    subscribed.set(
      asDocId(id),
      engine.subscribe(id, (evt) => events.push(evt)),
    );
  }

  function unsubscribe(id: string): void {
    subscribed.get(asDocId(id))?.();
    subscribed.delete(asDocId(id));
    delivered.delete(asDocId(id));
  }

  /** Each pending edit's watch event arrives now or later, sometimes after an engine write. */
  async function settlePending(all = false): Promise<void> {
    for (const doc of [...pending]) {
      if (!all && rand() < 0.6) continue; // still in flight
      const src = await storage.read(asDocId(doc));
      if (src !== undefined && rand() < 0.6) {
        // An agent writes the document first, keeping the editor's shape.
        await engine.write(doc, { writer, fullText: probed(src) });
      }
      await engine.externalWrite(`/ws/${doc}.md`);
      pending.delete(doc);
    }
  }

  async function fullStep(id: string, label: string): Promise<void> {
    // `pending` mode draws 16–19 as a pending edit: a quarter of its steps.
    const op = Math.min(16, Math.floor(rand() * (mode === "pending" ? 20 : 16)));
    const src = await storage.read(asDocId(id));
    if (op === 16) {
      // Edited in storage; the watch event is still in flight. Usually an
      // editor's edit that adds the section `s3` (which the generator never
      // writes, so includes of it resolve as missing-section until then).
      const edit =
        src !== undefined && !src.includes("## s3") && rand() < 0.7
          ? `${src}\n## s3\n\n{{include:${pickDoc()}}}\n`
          : contentFull(rand, id, true, mode === "pending");
      await storage.writeAtomic(asDocId(id), edit);
      pending.add(id);
      return;
    }
    if (op <= 1) {
      const text = contentFull(rand, id, false, mode === "pending");
      const r =
        src === undefined
          ? await engine.createDoc(id, { writer, content: text })
          : await engine.write(id, { writer, fullText: text });
      expect(r.ok || (!r.ok && r.rejection.reason === "too-large"), label).toBe(true);
    } else if (op === 2) {
      if (src === undefined) {
        const r = await engine.importDoc(id, {
          writer,
          content: contentFull(rand, id, true, mode === "pending"),
          ignoreSizeLimit: true,
        });
        expect(r.ok, label).toBe(true);
      }
    } else if (op === 3) {
      if (src !== undefined) expect((await engine.removeDoc(id, { writer })).ok, label).toBe(true);
    } else if (op === 4) {
      await storage.writeAtomic(asDocId(id), contentFull(rand, id, true, mode === "pending"));
      await engine.externalWrite(`/ws/${id}.md`);
    } else if (op === 5) {
      await storage.delete?.(asDocId(id));
      await engine.externalWrite(`/ws/${id}.md`);
    } else if (op <= 7) {
      subscribe(id);
    } else if (op === 8) {
      unsubscribe(id);
    } else if (op === 9) {
      // Removed, then put back byte for byte from outside (git checkout, undo).
      if (src !== undefined) {
        expect((await engine.removeDoc(id, { writer })).ok, label).toBe(true);
        await storage.writeAtomic(asDocId(id), src);
        await engine.externalWrite(`/ws/${id}.md`);
      }
    } else if (op === 10) {
      // An edit in storage the watcher has not reported, then an engine write
      // that keeps its shape; the report (a self-echo by then) may follow.
      if (src !== undefined) {
        const pending = contentFull(rand, id, false, mode === "pending");
        await storage.writeAtomic(asDocId(id), pending);
        await engine.write(id, { writer, fullText: probed(pending) });
        if (rand() < 0.5) await engine.externalWrite(`/ws/${id}.md`);
      }
    } else if (op === 11) {
      if (rand() < 0.5) {
        await engine.patch(id, `${id}box`, { writer, attrs: { n: Math.floor(rand() * 9) } });
      } else {
        await engine.applyIntent(
          { docId: id, blockId: `${id}box`, affordance: "bump" },
          { writer },
        );
      }
    } else if (op === 12) {
      if (!blocks.includes(lateType)) {
        blocks.push(lateType);
        engine.registerBlock(lateType);
      }
    } else if (op === 13) {
      const other = pickDoc();
      await Promise.all([
        engine.write(id, { writer, fullText: contentFull(rand, id, false, mode === "pending") }),
        engine.write(other, {
          writer,
          fullText: contentFull(rand, other, false, mode === "pending"),
        }),
      ]);
    } else {
      // A transient read error during a rebuild, which a write to another
      // document triggers; reads recover before the checks.
      const other = pickDoc();
      const otherSrc = await storage.read(asDocId(other));
      failing.add(id);
      if (other !== id && otherSrc !== undefined) {
        await engine.write(other, { writer, fullText: probed(otherSrc) });
      }
      failing.clear();
    }
  }

  async function check(label: string): Promise<void> {
    // The reference: a from-scratch index over current storage.
    const parseOptions = { blockTypes: new Set(blocks.map((b) => b.type)) };
    const edges = [];
    for (const s of subscribed.keys()) {
      edges.push(...(await resolveIncludes(s, storage, parseOptions, limits)).includes);
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
      if (!r.ok) {
        // Only a document past the size limit may refuse its probe.
        expect(r.rejection.reason, `${label} probe ${doc}`).toBe("too-large");
        continue;
      }
      const want = [...subscribed.keys()].filter((s) => recipients(asDocId(doc)).has(s)).sort();
      const got = [...delivered.entries()]
        .filter(([, events]) => events.some((e) => e.docId === doc))
        .map(([s]) => s)
        .sort();
      expect(got, `${label} probe ${doc}`).toEqual(want);
    }

    // Every projection and block matches a cache-free engine's.
    const fresh = createEngine({ storage, clock, blocks: [...blocks], ...limits });
    for (const doc of DOCS) {
      const mine = await engine.projection(doc, "text", {});
      const theirs = await fresh.projection(doc, "text", {});
      expect(mine, `${label} projection ${doc}`).toEqual(theirs);
      for (const blockId of [`${doc}box`, `${doc}late`]) {
        expect(await engine.getBlock(doc, blockId), `${label} block ${blockId}`).toEqual(
          await fresh.getBlock(doc, blockId),
        );
      }
    }
  }
}

/**
 * Seeds a review found failing (C1, a removed document restored with the
 * same bytes), at the step count it used. They replay the `v1` generator.
 */
const REGRESSION_SEEDS = [26, 41, 158, 216, 499, 606, 805, 893];

/**
 * Seeds of the `full` generator found failing, at 60 steps: 900 (R1-1, a
 * pass that loads a document another pass saw unloaded) and 194 (a rebuild
 * that could not read a document, before a write that was then rejected).
 */
const FULL_REGRESSION_SEEDS = [900, 194];

/**
 * Seeds of the `pending` generator a review's finding fails (R2-1, a
 * document read only behind a missing-section include), at 60 steps.
 */
const PENDING_REGRESSION_SEEDS = [914];

/**
 * How many `full` seeds CI runs, and how many steps each. A step takes a few
 * milliseconds. Some failures need many steps to set up (seed 900 first fails
 * at step 40), so CI runs 60. The `pending` run uses twice the seeds. Set
 * BOARDKIT_SEQUENCE_SEEDS and BOARDKIT_SEQUENCE_STEPS for a longer soak (for
 * example 3000 seeds).
 */
const FULL_SEEDS = Number(process.env.BOARDKIT_SEQUENCE_SEEDS ?? 200);
const FULL_STEPS = Number(process.env.BOARDKIT_SEQUENCE_STEPS ?? 60);

describe("the reverse include index and the seeded parse cache match a rebuild", () => {
  for (const seed of FULL_REGRESSION_SEEDS) {
    it(`regression seed ${seed} (full, 60 steps)`, async () => {
      await run(seed, 60, "full");
    });
  }
  for (const seed of PENDING_REGRESSION_SEEDS) {
    it(`regression seed ${seed} (pending, 60 steps)`, async () => {
      await run(seed, 60, "pending");
    });
  }
  for (const seed of REGRESSION_SEEDS) {
    it(`regression seed ${seed} (v1, 40 steps)`, async () => {
      await run(seed, 40, "v1");
    });
  }
  it(
    `random runs, ${FULL_SEEDS} seeds of ${FULL_STEPS} steps, all operations`,
    async () => {
      for (let seed = 1; seed <= FULL_SEEDS; seed += 1) await run(seed, FULL_STEPS, "full");
    },
    Math.max(120_000, FULL_SEEDS * FULL_STEPS * 10),
  );
  // Pending runs check only some steps, so they are cheaper: twice the seeds.
  it(
    `random runs, ${2 * FULL_SEEDS} seeds of ${FULL_STEPS} steps, with pending watch events`,
    async () => {
      for (let seed = 1; seed <= 2 * FULL_SEEDS; seed += 1) {
        await run(seed, FULL_STEPS, "pending");
      }
    },
    Math.max(120_000, 2 * FULL_SEEDS * FULL_STEPS * 10),
  );
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
