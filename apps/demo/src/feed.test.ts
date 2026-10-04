import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Engine, Intent, WriteResult, Writer } from "@onioneko/boardkit-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFeed, type Feed, type FeedMessage, noticeFromRejection } from "./feed.js";
import { FIN_DOC, MACBOOK_BLOCK, reactorWriter } from "./shared.js";
import { demoClock, lastEventSeq } from "./testing/helpers.js";
import { openWorkspace } from "./workspace.js";

/** The human approval every commit-driven test uses. */
const approve: Intent = {
  docId: FIN_DOC,
  blockId: MACBOOK_BLOCK,
  affordance: "transition",
  params: { to: "approved" },
};
const editor: Writer = { kind: "human", id: "editor" };

/** A rejected write result with the given rejection body. */
function rejected(rejection: {
  reason: string;
  current?: unknown;
  diagnostics: { code: string; message: string }[];
}): WriteResult & {
  ok: false;
} {
  return { ok: false, rejection };
}

describe("createFeed", () => {
  let rootDir = "";
  let engine: Engine;
  let feed: Feed;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "boardkit-feed-"));
    const workspace = await openWorkspace({ rootDir, watch: false, clock: demoClock });
    engine = workspace.engine;
    feed = await createFeed(engine, demoClock);
  });

  afterEach(async () => {
    feed.close();
    await engine.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("starts at the seeded log's last seq and follows new commits", async () => {
    const seeded = await lastEventSeq(engine.events({ afterSeq: 0 }));
    expect(feed.lastSeq()).toBe(seeded);

    await engine.applyIntent(approve, { writer: editor });

    expect(feed.lastSeq()).toBe(await lastEventSeq(engine.events({ afterSeq: 0 })));
    expect(feed.lastSeq()).toBeGreaterThan(seeded);
  });

  it("fans commits and rejections out to every subscriber", async () => {
    const first: FeedMessage[] = [];
    const second: FeedMessage[] = [];
    feed.subscribe((msg) => first.push(msg));
    feed.subscribe((msg) => second.push(msg));

    await engine.applyIntent(approve, { writer: editor });
    feed.rejection({
      by: reactorWriter,
      surface: "reactor",
      docId: FIN_DOC,
      reason: "stale-version",
      diagnostics: [],
    });

    for (const received of [first, second]) {
      const commits = received.filter((msg) => msg.kind === "commit");
      expect(commits.map((msg) => msg.event.type)).toContain("status.changed");
      const rejections = received.filter((msg) => msg.kind === "rejection");
      expect(rejections).toHaveLength(1);
      expect(rejections[0]?.notice).toEqual({
        at: demoClock(),
        by: reactorWriter,
        surface: "reactor",
        docId: FIN_DOC,
        reason: "stale-version",
        diagnostics: [],
      });
    }
    expect(first).toEqual(second);
  });

  it("keeps fanning out when one subscriber throws", async () => {
    const received: FeedMessage[] = [];
    feed.subscribe(() => {
      throw new Error("a bad surface");
    });
    feed.subscribe((msg) => received.push(msg));

    const result = await engine.applyIntent(approve, { writer: editor });
    feed.rejection({
      by: reactorWriter,
      surface: "reactor",
      docId: FIN_DOC,
      reason: "stale-version",
      diagnostics: [],
    });

    // The throw neither unwound into the commit nor starved the next subscriber.
    expect(result.ok).toBe(true);
    expect(received.filter((msg) => msg.kind === "commit").length).toBeGreaterThan(0);
    expect(received.filter((msg) => msg.kind === "rejection")).toHaveLength(1);
  });

  it("stops delivering to a subscriber that unsubscribed", async () => {
    const kept: FeedMessage[] = [];
    const dropped: FeedMessage[] = [];
    feed.subscribe((msg) => kept.push(msg));
    const unsubscribe = feed.subscribe((msg) => dropped.push(msg));

    unsubscribe();
    await engine.applyIntent(approve, { writer: editor });

    expect(kept.length).toBeGreaterThan(0);
    expect(dropped).toHaveLength(0);
  });

  it("stops listening to the engine once closed", async () => {
    const received: FeedMessage[] = [];
    feed.subscribe((msg) => received.push(msg));

    feed.close();
    await engine.applyIntent(approve, { writer: editor });

    expect(received).toHaveLength(0);
  });

  it("drops its subscribers when closed", async () => {
    const received: FeedMessage[] = [];
    feed.subscribe((msg) => received.push(msg));

    feed.close();
    // A closed feed holds nothing: a rejection posted after the close reaches
    // nobody, and the handlers (an open SSE response, among them) are released.
    feed.rejection({
      by: reactorWriter,
      surface: "reactor",
      docId: FIN_DOC,
      reason: "stale-version",
      diagnostics: [],
    });

    expect(received).toHaveLength(0);
  });
});

describe("noticeFromRejection", () => {
  it("carries the rejection's reason, current value, and diagnostics", () => {
    const notice = noticeFromRejection({
      by: reactorWriter,
      surface: "reactor",
      docId: FIN_DOC,
      blockId: MACBOOK_BLOCK,
      result: rejected({
        reason: "expected-mismatch",
        current: { value: "approved" },
        diagnostics: [{ code: "E_X", message: "boom" }],
      }),
    });

    expect(notice).toEqual({
      by: reactorWriter,
      surface: "reactor",
      docId: FIN_DOC,
      blockId: MACBOOK_BLOCK,
      reason: "expected-mismatch",
      current: { value: "approved" },
      diagnostics: [{ code: "E_X", message: "boom" }],
    });
  });

  it("omits current when the rejection carries none and keeps diagnostics an array", () => {
    const notice = noticeFromRejection({
      by: reactorWriter,
      surface: "write",
      docId: FIN_DOC,
      result: rejected({ reason: "stale-version", diagnostics: [] }),
    });

    expect(notice).toEqual({
      by: reactorWriter,
      surface: "write",
      docId: FIN_DOC,
      reason: "stale-version",
      diagnostics: [],
    });
    expect("current" in notice).toBe(false);
    expect("blockId" in notice).toBe(false);
  });
});
