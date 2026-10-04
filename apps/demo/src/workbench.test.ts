import { mkdtemp, rm } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WatchSource } from "@onioneko/boardkit-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECKLIST_BLOCK, FIN_DOC, MACBOOK_BLOCK } from "./shared.js";
import {
  collectEvents,
  demoClock,
  noopWatchSource,
  readUntilReady,
  waitFor,
} from "./testing/helpers.js";
import { startWorkbench, type Workbench, type WorkbenchOptions } from "./workbench.js";

describe("startWorkbench", () => {
  let rootDir = "";
  const running: Workbench[] = [];

  /** Start a workbench on an ephemeral port over the shared temp root. */
  async function start(opts: Partial<WorkbenchOptions> = {}): Promise<Workbench> {
    const workbench = await startWorkbench({
      rootDir,
      port: 0,
      watchSource: noopWatchSource,
      clock: demoClock,
      ...opts,
    });
    running.push(workbench);
    return workbench;
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "boardkit-workbench-"));
  });

  afterEach(async () => {
    // `close()` drains the reactor, so nothing is still writing into the root
    // by the time it is removed — no retries needed.
    for (const workbench of running.splice(0)) await workbench.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("seeds the root and listens on an ephemeral loopback port", async () => {
    const workbench = await start();

    expect(workbench.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(workbench.url).not.toContain(":0");
    expect(workbench.rootDir).toBe(rootDir);
    expect(workbench.seeded).toBe(true);
    expect(workbench.flags).toEqual({ reactor: true, guard: true });
    expect(await workbench.engine.listDocs()).toEqual(["fin", "overview", "research/q3-review"]);
  });

  it("answers /api/state with the workspace, its documents, and the flags", async () => {
    const workbench = await start();

    const res = await fetch(`${workbench.url}/api/state`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      rootDir,
      docs: ["fin", "overview", "research/q3-review"],
      lastSeq: 3,
      reactor: true,
      guard: true,
    });
  });

  it("reports the flags it was started with", async () => {
    const workbench = await start({ reactor: false, guard: false });

    expect(workbench.flags).toEqual({ reactor: false, guard: false });
    const state = (await (await fetch(`${workbench.url}/api/state`)).json()) as Record<
      string,
      unknown
    >;
    expect(state.reactor).toBe(false);
    expect(state.guard).toBe(false);
  });

  it("closes twice without complaining", async () => {
    const workbench = await start();

    await workbench.close();
    await workbench.close();

    await expect(fetch(`${workbench.url}/api/state`)).rejects.toThrow();
  });

  it("closes the workspace it opened when the port is already taken", async () => {
    const first = await start({ reactor: false });
    const port = Number(new URL(first.url).port);
    const stopped: string[] = [];
    // The engine's watch source is closed by `engine.close()` and by nothing
    // else, so its closer running is the proof that the failed start cleaned up
    // after itself rather than leaking an open engine over the workspace.
    const trackingSource: WatchSource = {
      start: async () => async () => {
        stopped.push("watch");
      },
    };

    await expect(
      startWorkbench({
        rootDir,
        port,
        reactor: false,
        clock: demoClock,
        watchSource: trackingSource,
      }),
    ).rejects.toThrow(/EADDRINUSE|listen/);

    expect(stopped).toEqual(["watch"]);
  });

  it("closes while a client is still streaming events", async () => {
    const workbench = await start();
    const req = get(`${workbench.url}/api/events`, () => {});
    req.on("error", () => {});
    await new Promise<void>((resolve) => req.once("response", () => resolve()));

    await expect(workbench.close()).resolves.toBeUndefined();

    req.destroy();
  });

  // -------------------------------------------------------------------------
  // Restart and replay
  // -------------------------------------------------------------------------

  it("reopens a seeded root and replays only what a saved cursor missed", async () => {
    // No reactor: this is about the log surviving a restart, and a reaction
    // still in flight would add events nobody asked about.
    const first = await start({ reactor: false });
    // The cursor a consumer would have saved after the seeding.
    const cursor = first.feed.lastSeq();
    await fetch(`${first.url}/api/doc/${FIN_DOC}/block/${MACBOOK_BLOCK}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attrs: { value: "approved" } }),
    });
    const missed = (await collectEvents(first.engine.events({ afterSeq: cursor }))).map(
      (evt) => evt.seq,
    );
    expect(missed.length).toBeGreaterThan(0);
    await first.close();

    const second = await start({ reactor: false });

    expect(second.seeded).toBe(false);
    expect(await second.engine.getBlock(FIN_DOC, MACBOOK_BLOCK)).toMatchObject({
      attrs: { value: "approved" },
    });
    const frames = await readUntilReady(`${second.url}/api/events?afterSeq=${cursor}`);
    expect(frames.filter((f) => f.event === "commit").map((f) => Number(f.id))).toEqual(missed);
    const ready = frames.at(-1);
    expect(ready?.event).toBe("ready");
    expect(JSON.parse(ready?.data ?? "{}")).toEqual({ lastSeq: missed.at(-1) });
  });

  // -------------------------------------------------------------------------
  // The reactor
  // -------------------------------------------------------------------------

  it("subscribes the reactor, which writes through the same engine", async () => {
    const workbench = await start();

    await fetch(`${workbench.url}/api/doc/${FIN_DOC}/block/${MACBOOK_BLOCK}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attrs: { value: "approved" } }),
    });

    // The note is the reactor's second write, so waiting for it waits for the
    // whole reaction — nothing is still in flight when the root is removed.
    const reacted = await waitFor(async () => {
      const doc = await workbench.engine.getDoc(FIN_DOC);
      return doc?.src.includes("reactor-1: approval seen at seq") === true;
    });

    expect(reacted).toBe(true);
    const items = (await workbench.engine.getBlock(FIN_DOC, CHECKLIST_BLOCK))?.attrs.items as {
      id: string;
      done: boolean;
    }[];
    expect(items.find((item) => item.id === "c")?.done).toBe(true);
  });

  it("leaves the reactor unsubscribed when the flag says so", async () => {
    const workbench = await start({ reactor: false });

    await fetch(`${workbench.url}/api/doc/${FIN_DOC}/block/${MACBOOK_BLOCK}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attrs: { value: "approved" } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const doc = await workbench.engine.getDoc(FIN_DOC);
    expect(doc?.src).not.toContain("approval seen at seq");
  });
});
