import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Engine, EventRecord } from "@onioneko/boardkit-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Feed } from "../feed.js";
import { FIN_DOC, MACBOOK_BLOCK, seedWriter } from "../shared.js";
import {
  collectEvents,
  demoClock,
  isReady,
  listenOnEphemeralPort,
  noopWatchSource,
  openEventStream,
  type StreamClient,
} from "../testing/helpers.js";
import { startWorkbench, type Workbench } from "../workbench.js";
import { attachEventStream, type EventLog } from "./sse.js";

/** The `seq` of every `commit` frame, in the order they arrived. */
function commitSeqs(client: StreamClient): number[] {
  return client.frames.filter((f) => f.event === "commit").map((f) => Number(f.id));
}

describe("attachEventStream", () => {
  let rootDir = "";
  let workbench: Workbench;
  let engine: Engine;
  let feed: Feed;
  const servers: Server[] = [];
  const clients: StreamClient[] = [];

  /** Serve one event stream over `log`, and return the url clients connect to. */
  async function serve(
    log: EventLog,
    opts: { afterSeq?: number; keepaliveMs?: number } = {},
  ): Promise<string> {
    const server = createServer((req, res) => {
      const afterSeq =
        opts.afterSeq ??
        Number(new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("afterSeq") ?? 0);
      void attachEventStream(res, {
        engine: log,
        feed,
        afterSeq,
        ...(opts.keepaliveMs !== undefined ? { keepaliveMs: opts.keepaliveMs } : {}),
      }).catch(() => res.end());
    });
    servers.push(server);
    return `http://127.0.0.1:${await listenOnEphemeralPort(server)}`;
  }

  /** Connect a client that is closed when the test ends. */
  function connect(url: string, headers?: Record<string, string>): StreamClient {
    const client = openEventStream(url, headers);
    clients.push(client);
    return client;
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "boardkit-sse-"));
    workbench = await startWorkbench({
      rootDir,
      port: 0,
      reactor: false,
      watchSource: noopWatchSource,
      clock: demoClock,
    });
    engine = workbench.engine;
    feed = workbench.feed;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await workbench.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("replays the log with the seq as the event id, then says ready", async () => {
    const url = await serve(engine, { afterSeq: 0 });

    const client = connect(url);
    await client.waitFor(isReady);

    expect(commitSeqs(client)).toEqual([1, 2, 3]);
    expect(client.frames[0]?.event).toBe("commit");
    expect(JSON.parse(client.frames[0]?.data ?? "{}")).toMatchObject({ type: "doc.created" });
    const ready = client.frames.find((f) => f.event === "ready");
    expect(JSON.parse(ready?.data ?? "{}")).toEqual({ lastSeq: 3 });
    expect(ready?.id).toBeUndefined();
  });

  it("replays only what the cursor missed", async () => {
    const url = await serve(engine, { afterSeq: 2 });

    const client = connect(url);
    await client.waitFor(isReady);

    expect(commitSeqs(client)).toEqual([3]);
  });

  it("delivers a commit that lands during replay exactly once, in order", async () => {
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // A log that stalls after its first record, so the test controls the exact
    // instant the replay and the live feed overlap.
    const paced: EventLog = {
      events(opts) {
        const inner = engine.events(opts);
        return {
          async *[Symbol.asyncIterator](): AsyncIterator<EventRecord> {
            let stalled = false;
            for await (const evt of inner) {
              yield evt;
              if (!stalled) {
                stalled = true;
                await gate;
              }
            }
          },
        };
      },
    };
    const url = await serve(paced, { afterSeq: 0 });

    const client = connect(url);
    await client.waitFor((c) => commitSeqs(c).length === 1);

    // Mid-replay: a real commit through the real engine, seen by the real feed.
    const write = await engine.patch(FIN_DOC, MACBOOK_BLOCK, {
      writer: seedWriter,
      attrs: { value: "approved" },
    });
    expect(write.ok).toBe(true);
    open();

    await client.waitFor(isReady);
    const seqs = commitSeqs(client);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(seqs).toContain(4);
    const ready = client.frames.find((f) => f.event === "ready");
    expect(JSON.parse(ready?.data ?? "{}")).toEqual({ lastSeq: Math.max(...seqs) });
  });

  it("keeps the connection alive with a ping comment", async () => {
    const url = await serve(engine, { afterSeq: 0, keepaliveMs: 15 });

    const client = connect(url);
    await client.waitFor((c) => c.raw().includes(": ping\n\n"));

    expect(client.raw()).toContain(": ping\n\n");
  });

  it("broadcasts a rejection to every connected client, without an id", async () => {
    const url = await serve(engine, { afterSeq: 0 });
    const first = connect(url);
    const second = connect(url);
    await Promise.all([first.waitFor(isReady), second.waitFor(isReady)]);

    feed.rejection({
      by: { kind: "human", id: "browser" },
      surface: "intent",
      docId: FIN_DOC,
      blockId: MACBOOK_BLOCK,
      reason: "expected-mismatch",
      current: { value: "approved" },
      diagnostics: [],
    });

    const sawRejection = (c: StreamClient): boolean =>
      c.frames.some((f) => f.event === "rejection");
    await Promise.all([first.waitFor(sawRejection), second.waitFor(sawRejection)]);

    for (const client of [first, second]) {
      const frame = client.frames.find((f) => f.event === "rejection");
      expect(frame?.id).toBeUndefined();
      expect(JSON.parse(frame?.data ?? "{}")).toMatchObject({
        by: { kind: "human", id: "browser" },
        surface: "intent",
        docId: FIN_DOC,
        blockId: MACBOOK_BLOCK,
        reason: "expected-mismatch",
        current: { value: "approved" },
        at: demoClock(),
      });
    }
  });

  it("forwards commits live once the replay is done", async () => {
    const url = await serve(engine, { afterSeq: 0 });
    const client = connect(url);
    await client.waitFor(isReady);

    await engine.patch(FIN_DOC, MACBOOK_BLOCK, {
      writer: seedWriter,
      attrs: { value: "approved" },
    });

    await client.waitFor((c) => commitSeqs(c).includes(4));
    const seqs = commitSeqs(client);
    expect(seqs.slice(0, 4)).toEqual([1, 2, 3, 4]);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  describe("through the workbench's /api/events", () => {
    it("lets Last-Event-ID beat afterSeq", async () => {
      await engine.patch(FIN_DOC, MACBOOK_BLOCK, {
        writer: seedWriter,
        attrs: { value: "approved" },
      });

      const after = await collectEvents(engine.events({ afterSeq: 3 }));
      expect(after.length).toBeGreaterThan(0);

      const client = connect(`${workbench.url}/api/events?afterSeq=0`, { "last-event-id": "3" });
      await client.waitFor(isReady);

      expect(commitSeqs(client)).toEqual(after.map((evt) => evt.seq));
      const ready = client.frames.find((f) => f.event === "ready");
      expect(JSON.parse(ready?.data ?? "{}")).toEqual({ lastSeq: workbench.feed.lastSeq() });
    });

    it("resumes from ?afterSeq when no Last-Event-ID is sent", async () => {
      const client = connect(`${workbench.url}/api/events?afterSeq=1`);
      await client.waitFor(isReady);

      expect(commitSeqs(client)).toEqual([2, 3]);
    });

    it("sets the event-stream headers", async () => {
      const res = await fetch(`${workbench.url}/api/events`);
      const reader = res.body?.getReader();
      await reader?.cancel();

      expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("connection")).toBe("keep-alive");
    });
  });
});
