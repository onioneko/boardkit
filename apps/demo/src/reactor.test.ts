import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Engine, EventRecord, WriteMiddleware, Writer } from "@onioneko/boardkit-core";
import { WriteRejection } from "@onioneko/boardkit-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RejectionNotice } from "./feed.js";
import {
  type ReactorHandle,
  type ReactorReaction,
  reactorNoteLine,
  subscribeReactor,
} from "./reactor.js";
import {
  byOf,
  CHECKLIST_BLOCK,
  FIN_DOC,
  isPlainRecord,
  MACBOOK_ITEM_ID,
  reactorWriter,
} from "./shared.js";
import { collectEvents, demoClock, noopWatchSource, sleep } from "./testing/helpers.js";
import { openWorkspace } from "./workspace.js";

/** How long a "nothing should happen" assertion waits before it is believed. */
const QUIET_MS = 200;

/** The human driving the test's own setup writes. */
const tester: Writer = { kind: "human", id: "tester" };

/** A second status block, so an approval on a block the reactor ignores can be staged. */
const OTHER_BLOCK_ID = "dec-other";
const OTHER_STATUS_BLOCK = [
  "## Other decisions",
  "```status",
  `id: ${OTHER_BLOCK_ID}`,
  "title: Other decision",
  "states: [pending, approved]",
  "value: pending",
  "```",
  "",
].join("\n");

/** Collects the reactor's reactions so a test can await the next one. */
function reactionQueue(): {
  readonly onReaction: (reaction: ReactorReaction) => void;
  readonly received: readonly ReactorReaction[];
  next(): Promise<ReactorReaction>;
} {
  const received: ReactorReaction[] = [];
  const pending: ReactorReaction[] = [];
  let waiting: ((reaction: ReactorReaction) => void) | undefined;
  return {
    onReaction: (reaction) => {
      received.push(reaction);
      const resolve = waiting;
      if (resolve !== undefined) {
        waiting = undefined;
        resolve(reaction);
        return;
      }
      pending.push(reaction);
    },
    received,
    next() {
      const head = pending.shift();
      if (head !== undefined) return Promise.resolve(head);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
  };
}

describe("subscribeReactor", () => {
  let rootDir = "";
  let finPath = "";
  let engine: Engine;
  let reactor: ReactorHandle | undefined;

  /** Edit `fin.md` on disk the way an editor would, then hand the path to the engine. */
  async function externalTransition(from: string, to: string): Promise<EventRecord> {
    const src = (await engine.getDoc(FIN_DOC))?.src ?? "";
    await writeFile(finPath, src.replace(`value: ${from}`, `value: ${to}`), "utf8");
    const outcome = await engine.externalWrite(finPath);
    const changed = outcome?.events.find((evt) => evt.type === "status.changed");
    if (changed === undefined)
      throw new Error(`reactor.test: no status.changed for ${from} → ${to}`);
    return changed;
  }

  /** The committed source of `fin.md`. */
  async function finSrc(): Promise<string> {
    return (await engine.getDoc(FIN_DOC))?.src ?? "";
  }

  /** Whether the "Buy MacBook" checklist item is ticked. */
  async function macbookDone(): Promise<boolean> {
    const block = await engine.getBlock(FIN_DOC, CHECKLIST_BLOCK);
    const items = block?.attrs.items;
    if (!Array.isArray(items)) return false;
    return items.some(
      (item) => isPlainRecord(item) && item.id === MACBOOK_ITEM_ID && item.done === true,
    );
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "boardkit-reactor-"));
    finPath = path.join(rootDir, "fin.md");
    const workspace = await openWorkspace({
      rootDir,
      watchSource: noopWatchSource,
      clock: demoClock,
    });
    engine = workspace.engine;
  });

  afterEach(async () => {
    reactor?.unsubscribe();
    // Unsubscribing stops the *next* reaction; a reaction already queued is
    // still writing, and the root is about to be removed underneath it.
    await reactor?.drain();
    reactor = undefined;
    await engine.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("ticks the checklist item and appends its note when the decision is approved", async () => {
    const queue = reactionQueue();
    reactor = subscribeReactor(engine, { onReaction: queue.onReaction });

    const approval = await externalTransition("pending", "approved");
    const reaction = await queue.next();

    expect(reaction.seq).toBe(approval.seq);
    expect(reaction.tick).not.toBe("already-done");
    expect(reaction.tick === "already-done" ? false : reaction.tick.ok).toBe(true);
    expect(reaction.note.ok).toBe(true);
    expect(await macbookDone()).toBe(true);
    expect(await finSrc()).toContain(`\n${reactorNoteLine(approval.seq, "ticked")}\n`);

    const written = await collectEvents(engine.events({ afterSeq: approval.seq }));
    expect(written.map((evt) => evt.type)).toContain("checklist.item.done");
    expect(written.map((evt) => evt.type)).toContain("doc.updated");
    for (const evt of written) expect(byOf(evt)).toEqual({ kind: "program", id: "reactor-1" });
  });

  it("reports already-done on a second approval and still appends a note", async () => {
    const queue = reactionQueue();
    reactor = subscribeReactor(engine, { onReaction: queue.onReaction });

    const first = await externalTransition("pending", "approved");
    await queue.next();
    await externalTransition("approved", "pending");
    const second = await externalTransition("pending", "approved");
    const reaction = await queue.next();

    expect(reaction.seq).toBe(second.seq);
    expect(reaction.tick).toBe("already-done");
    expect(reaction.note.ok).toBe(true);
    expect(await macbookDone()).toBe(true);
    const src = await finSrc();
    expect(src).toContain(reactorNoteLine(first.seq, "ticked"));
    expect(src).toContain(reactorNoteLine(second.seq, "already-done"));
  });

  it("says so in the note when the tick itself was rejected", async () => {
    const notices: Omit<RejectionNotice, "at">[] = [];
    const queue = reactionQueue();
    // A host policy that refuses checklist toggles. Rejecting from write
    // middleware is exactly what middleware is for: the reactor's tick comes
    // back as a value, and the note has to tell the truth about it.
    const noToggles: WriteMiddleware = async (ctx, next) => {
      const proposed = ctx.proposed as { affordance?: string };
      if (ctx.mode === "patch" && proposed.affordance === "toggle") {
        throw new WriteRejection("no-toggles", [
          { code: "E_NO_TOGGLE", message: "checklist toggles are disabled" },
        ]);
      }
      await next();
    };
    engine.use({ write: noToggles });
    reactor = subscribeReactor(engine, {
      onReaction: queue.onReaction,
      onRejection: (notice) => notices.push(notice),
    });

    const approval = await externalTransition("pending", "approved");
    const reaction = await queue.next();

    expect(reaction.tick === "already-done" ? true : reaction.tick.ok).toBe(false);
    expect(reaction.note.ok).toBe(true);
    expect(await macbookDone()).toBe(false);
    expect(await finSrc()).toContain(`\n${reactorNoteLine(approval.seq, "rejected")}\n`);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.reason).toBe("no-toggles");
    expect(notices[0]?.blockId).toBe(CHECKLIST_BLOCK);
  });

  it("does not react to an approval on another block", async () => {
    const seeded = await engine.write(FIN_DOC, {
      writer: tester,
      fullText: `${await finSrc()}\n${OTHER_STATUS_BLOCK}`,
    });
    expect(seeded.ok).toBe(true);
    const queue = reactionQueue();
    reactor = subscribeReactor(engine, { onReaction: queue.onReaction });

    const other = await engine.applyIntent(
      {
        docId: FIN_DOC,
        blockId: OTHER_BLOCK_ID,
        affordance: "transition",
        params: { to: "approved" },
      },
      { writer: tester },
    );
    expect(other.ok).toBe(true);
    await sleep(QUIET_MS);

    expect(queue.received).toHaveLength(0);
    expect(await macbookDone()).toBe(false);

    // The same reactor still reacts to the block it does watch.
    const approval = await externalTransition("pending", "approved");
    expect((await queue.next()).seq).toBe(approval.seq);
    expect(queue.received).toHaveLength(1);
  });

  it("does not react to a transition into another state", async () => {
    const queue = reactionQueue();
    reactor = subscribeReactor(engine, { onReaction: queue.onReaction });

    await externalTransition("pending", "rejected");
    await sleep(QUIET_MS);

    expect(queue.received).toHaveLength(0);
    expect(await macbookDone()).toBe(false);
  });

  it("reports a stale note write to the rejection handler", async () => {
    const rival: Writer = { kind: "human", id: "rival" };
    const notices: Omit<RejectionNotice, "at">[] = [];
    const queue = reactionQueue();
    let competed = false;
    // The reactor reads the document, then writes it back with the version it
    // read. This wrapper slips a real competing commit between those two steps,
    // so the reactor's `expectedVersion` is genuinely stale by the time it writes.
    const wrapped: Engine = {
      ...engine,
      async getDoc(docId: string) {
        const snapshot = await engine.getDoc(docId);
        if (!competed && docId === FIN_DOC && snapshot !== undefined) {
          competed = true;
          await engine.write(FIN_DOC, {
            writer: rival,
            fullText: `${snapshot.src}\n> rival was here\n`,
          });
        }
        return snapshot;
      },
    };
    reactor = subscribeReactor(wrapped, {
      onReaction: queue.onReaction,
      onRejection: (notice) => notices.push(notice),
    });

    await externalTransition("pending", "approved");
    const reaction = await queue.next();

    expect(reaction.note.ok).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.surface).toBe("reactor");
    expect(notices[0]?.reason).toBe("stale-version");
    expect(notices[0]?.by).toEqual(reactorWriter);
    expect(notices[0]?.docId).toBe(FIN_DOC);
    expect(await finSrc()).not.toContain("approval seen at seq");
  });

  it("survives a host callback that throws and keeps reacting", async () => {
    const notices: Omit<RejectionNotice, "at">[] = [];
    const queue = reactionQueue();
    let poisoned = true;
    reactor = subscribeReactor(engine, {
      onRejection: (notice) => notices.push(notice),
      onReaction: (reaction) => {
        queue.onReaction(reaction);
        if (poisoned) {
          poisoned = false;
          throw new Error("boom");
        }
      },
    });

    await externalTransition("pending", "approved");
    await queue.next();
    await externalTransition("approved", "pending");
    const second = await externalTransition("pending", "approved");
    const reaction = await queue.next();

    expect(reaction.seq).toBe(second.seq);
    const errors = notices.filter((notice) => notice.reason === "reactor-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.surface).toBe("reactor");
    expect(errors[0]?.docId).toBe(FIN_DOC);
    expect(errors[0]?.by).toEqual(reactorWriter);
    expect(errors[0]?.diagnostics.map((d) => d.code)).toEqual(["E_REACTOR_THREW"]);
    expect(errors[0]?.diagnostics[0]?.message).toContain("boom");
  });

  it("drains the reactions it has already queued", async () => {
    const queue = reactionQueue();
    reactor = subscribeReactor(engine, { onReaction: queue.onReaction });

    const approval = await externalTransition("pending", "approved");
    // The handle is what `Workbench.close()` holds: unsubscribing stops the
    // next reaction, and `drain()` is the only way to know this one is done.
    reactor.unsubscribe();
    await reactor.drain();

    expect(queue.received).toHaveLength(1);
    expect(await macbookDone()).toBe(true);
    expect(await finSrc()).toContain(reactorNoteLine(approval.seq, "ticked"));
  });

  it("drains a queue whose reaction threw, without rejecting", async () => {
    reactor = subscribeReactor(engine, {
      onReaction: () => {
        throw new Error("boom");
      },
    });

    await externalTransition("pending", "approved");
    reactor.unsubscribe();

    // A poisoned queue would make closing the workbench reject; it never does.
    await expect(reactor.drain()).resolves.toBeUndefined();
  });

  it("stops reacting once unsubscribed", async () => {
    const queue = reactionQueue();
    reactor = subscribeReactor(engine, { onReaction: queue.onReaction });

    reactor.unsubscribe();
    await externalTransition("pending", "approved");
    await sleep(QUIET_MS);

    expect(queue.received).toHaveLength(0);
    expect(await macbookDone()).toBe(false);
    expect(await finSrc()).not.toContain("approval seen at seq");
  });
});

describe("reactorNoteLine", () => {
  it("names the seq it saw and what became of the tick", () => {
    expect(reactorNoteLine(12, "ticked")).toBe(
      '> reactor-1: approval seen at seq 12 — ticked "Buy MacBook"',
    );
    expect(reactorNoteLine(31, "rejected")).toBe(
      '> reactor-1: approval seen at seq 31 — tick of "Buy MacBook" rejected',
    );
    expect(reactorNoteLine(31, "already-done")).toBe(
      '> reactor-1: approval seen at seq 31 — "Buy MacBook" already ticked',
    );
  });
});
