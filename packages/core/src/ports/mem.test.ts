import { describe, expect, it } from "vitest";
import { asDocId } from "../model/ids.js";
import { createMemStorage } from "./mem.js";

describe("mem storage", () => {
  it("reports a document's size in bytes, undefined when missing", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("a"), "# Tée\n");
    expect(await storage.size?.(asDocId("a"))).toBe(Buffer.byteLength("# Tée\n"));
    expect(await storage.size?.(asDocId("nope"))).toBeUndefined();
  });

  it("writes, reads, and lists documents", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("a"), "# A");
    await storage.writeAtomic(asDocId("research/q3"), "## S");
    expect(await storage.read(asDocId("a"))).toBe("# A");
    expect(await storage.list()).toEqual(["a", "research/q3"]);
    expect(await storage.read(asDocId("missing"))).toBeUndefined();
  });

  it("deletes documents (missing is a no-op)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("a"), "# A");
    await storage.delete?.(asDocId("a"));
    expect(await storage.read(asDocId("a"))).toBeUndefined();
    await expect(storage.delete?.(asDocId("ghost"))).resolves.toBeUndefined();
  });

  it("event sink assigns monotonic seq and records events", async () => {
    const storage = createMemStorage();
    const sink = storage.defaultEventSink?.();
    if (sink === undefined) throw new Error("missing default sink");
    await sink.append({ t: "2026-08-21T00:00:00Z", type: "x" });
    await sink.append({ t: "2026-08-21T00:00:00Z", type: "y" });
    expect(storage.getEvents().map((e) => e.seq)).toEqual([1, 2]);
  });

  it("lock serializes per document", async () => {
    const storage = createMemStorage();
    const lock = storage.defaultLock?.(asDocId("a"));
    if (lock === undefined) throw new Error("missing default lock");
    const order: string[] = [];
    await Promise.all([
      lock.withLock(async () => {
        order.push("a1");
        await new Promise((r) => setTimeout(r, 10));
        order.push("a2");
      }),
      lock.withLock(async () => {
        order.push("b1");
        order.push("b2");
      }),
    ]);
    expect(order.join("")).toBe("a1a2b1b2");
  });

  it("separate defaultLock acquisitions for the same docId mutually exclude", async () => {
    const storage = createMemStorage();
    const lockA = storage.defaultLock?.(asDocId("a"));
    const lockB = storage.defaultLock?.(asDocId("a"));
    if (lockA === undefined || lockB === undefined) throw new Error("missing default lock");
    const order: string[] = [];
    await Promise.all([
      lockA.withLock(async () => {
        order.push("a1");
        await new Promise((r) => setTimeout(r, 10));
        order.push("a2");
      }),
      lockB.withLock(async () => {
        order.push("b1");
        order.push("b2");
      }),
    ]);
    expect(order.join("")).toBe("a1a2b1b2");
  });
});
