import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { asDocId } from "../model/ids.js";
import { createFsStorage } from "../ports/fs.js";
import { createMemStorage } from "../ports/mem.js";
import type { EventRecord } from "../ports/ports.js";
import { createEngine } from "./engine.js";

/**
 * Commit boundaries on events (#17): every record one commit appends carries
 * `commit: { id, index, size }`, the same `id` for the whole commit, so a
 * subscriber or a log reader can group events exactly instead of debouncing.
 */

const statusType: BlockType = {
  type: "status",
  schema: {
    type: "object",
    required: ["id", "value"],
    properties: { id: { type: "string" }, value: { type: "string" } },
  },
  transitions: [{ attr: "value", event: "status.changed" }],
};

const writer = { kind: "human", id: "u1" } as const;
const clock = () => "2026-10-04T00:00:00Z";
const before = "# A\n\n```status\nid: s\nvalue: open\n```\n\n## Gone\n\ntext\n";
// One write: a section added, a section removed, a status changed.
const after = "# A\n\n```status\nid: s\nvalue: done\n```\n\n## New\n\ntext\n";

/** Group records by commit id, asserting each group is contiguous and self-consistent. */
function assertCommitGroups(records: readonly EventRecord[]): Map<string, EventRecord[]> {
  const groups = new Map<string, EventRecord[]>();
  for (const r of records) {
    expect(r.commit).toBeDefined();
    const id = r.commit?.id ?? "";
    const group = groups.get(id) ?? [];
    group.push(r);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    const size = group.length;
    expect(group.map((r) => r.commit?.index)).toEqual([...Array(size).keys()]);
    expect(group.every((r) => r.commit?.size === size)).toBe(true);
    // Contiguous in the log: seqs are consecutive.
    const seqs = group.map((r) => r.seq);
    expect(seqs).toEqual(seqs.map((_, i) => (seqs[0] ?? 0) + i));
  }
  return groups;
}

describe("commit boundaries on events", () => {
  it("stamps one shared id, indexes 0..n-1 and the size on a multi-event write", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock, blocks: [statusType] });
    await engine.createDoc("d", { writer, content: before });
    const seen: EventRecord[] = [];
    engine.subscribe((e) => seen.push(e));
    const r = await engine.write("d", { writer, fullText: after });
    if (!r.ok) throw new Error("write failed");
    const events = r.events ?? [];
    expect(events.length).toBeGreaterThanOrEqual(3);
    const groups = assertCommitGroups(events);
    expect(groups.size).toBe(1);
    expect(events[0]?.commit?.id).toContain(`d@${r.version}`);
    // Subscribers see the same stamped records, and can tell the last one.
    expect(seen).toEqual(events);
    const last = seen.at(-1);
    expect(last?.commit?.index).toBe((last?.commit?.size ?? 0) - 1);
  });

  it("gives every commit its own id, even when content repeats", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock, blocks: [statusType] });
    await engine.createDoc("d", { writer, content: before });
    await engine.write("d", { writer, fullText: after });
    await engine.write("d", { writer, fullText: before });
    await engine.write("d", { writer, fullText: after });
    const groups = assertCommitGroups(storage.getEvents());
    expect(groups.size).toBe(4);
  });

  it("stamps single-event commits (create, remove) with index 0 and size 1", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock, blocks: [statusType] });
    const created = await engine.createDoc("d", { writer, content: before });
    const removed = await engine.removeDoc("d", { writer });
    for (const r of [created, removed]) {
      if (!r.ok) throw new Error("write failed");
      expect(r.events?.map((e) => e.commit)).toEqual([
        { id: expect.stringContaining(`d@${r.version}`), index: 0, size: 1 },
      ]);
    }
  });

  it("groups a patch's events as one commit", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock, blocks: [statusType] });
    await engine.createDoc("d", { writer, content: before });
    const patched = await engine.patch("d", "s", { writer, attrs: { value: "done" } });
    if (!patched.ok) throw new Error("patch failed");
    expect(assertCommitGroups(patched.events ?? []).size).toBe(1);
    expect(assertCommitGroups(storage.getEvents()).size).toBe(2);
  });

  it("is deterministic under a fixed clock: two engines doing the same writes mint the same ids", async () => {
    const run = async (): Promise<unknown[]> => {
      const storage = createMemStorage();
      const engine = createEngine({ storage, clock, blocks: [statusType] });
      await engine.createDoc("d", { writer, content: before });
      await engine.write("d", { writer, fullText: after });
      return storage.getEvents().map((e) => e.commit);
    };
    expect(await run()).toEqual(await run());
  });

  it("stamps events synthesized for an external write", async () => {
    const storage = createMemStorage();
    const engine = createEngine({
      storage,
      clock,
      blocks: [statusType],
      watch: { rootDir: "/ws", source: { start: async () => async () => {} } },
    });
    await engine.createDoc("d", { writer, content: before });
    await storage.writeAtomic(asDocId("d"), after);
    const outcome = await engine.externalWrite(path.join("/ws", "d.md"));
    expect(outcome?.external).toBe(true);
    const events = outcome?.events ?? [];
    expect(events.length).toBeGreaterThanOrEqual(3);
    const groups = assertCommitGroups(events);
    expect(groups.size).toBe(1);
    // A distinct commit from the engine's own create.
    expect(storage.getEvents()[0]?.commit?.id).not.toBe(events[0]?.commit?.id);
  });
});

describe("commit fields in the fs event log", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("survive a replay from a new engine, next to old records without them", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bk-commit-"));
    // A record written by 0.1 (no commit field) must still read.
    await writeFile(
      path.join(dir, "events.jsonl"),
      `${JSON.stringify({ seq: 1, t: clock(), type: "doc.created", docId: "old" })}\n`,
    );
    const first = createEngine({
      storage: createFsStorage({ root: dir }),
      clock,
      blocks: [statusType],
    });
    await first.createDoc("d", { writer, content: before });
    const w = await first.write("d", { writer, fullText: after });
    if (!w.ok) throw new Error("write failed");

    const second = createEngine({
      storage: createFsStorage({ root: dir }),
      clock,
      blocks: [statusType],
    });
    const replayed: EventRecord[] = [];
    for await (const e of second.events({ afterSeq: 0 })) replayed.push(e);
    expect(replayed[0]?.commit).toBeUndefined();
    const groups = assertCommitGroups(replayed.slice(1));
    expect(groups.size).toBe(2);
    expect(replayed.slice(-(w.events?.length ?? 0))).toEqual(w.events);
  });
});
