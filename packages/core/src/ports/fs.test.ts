import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { asDocId } from "../model/ids.js";
import { createDoc, type PipelineDeps } from "../write/pipeline.js";
import { createFsEventSink, createFsStorage, createLock } from "./fs.js";

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "boardkit-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("fs storage", () => {
  it("sets rootDir so `watch: true` can resolve its watch root", async () => {
    await withTmp(async (dir) => {
      const storage = createFsStorage({ root: dir });
      expect(storage.rootDir).toBe(dir);
    });
  });

  it("writes, reads, and lists documents", async () => {
    await withTmp(async (dir) => {
      const storage = createFsStorage({ root: dir });
      await storage.writeAtomic(asDocId("fin"), "# T");
      await storage.writeAtomic(asDocId("research/q3"), "## S");
      expect(await storage.read(asDocId("fin"))).toBe("# T");
      expect(await storage.list()).toEqual(["fin", "research/q3"]);
    });
  });

  it("returns undefined for missing documents", async () => {
    await withTmp(async (dir) => {
      const storage = createFsStorage({ root: dir });
      expect(await storage.read(asDocId("nope"))).toBeUndefined();
    });
  });

  it("deletes documents (missing is a no-op)", async () => {
    await withTmp(async (dir) => {
      const storage = createFsStorage({ root: dir });
      await storage.writeAtomic(asDocId("fin"), "# T");
      await storage.delete?.(asDocId("fin"));
      expect(await storage.read(asDocId("fin"))).toBeUndefined();
      await expect(storage.delete?.(asDocId("ghost"))).resolves.toBeUndefined();
    });
  });

  it("event sink assigns monotonic seq, persists JSONL, and re-seeds on reopen", async () => {
    await withTmp(async (dir) => {
      const storage = createFsStorage({ root: dir });
      const sink = storage.defaultEventSink?.();
      if (sink === undefined) throw new Error("missing default sink");
      const a = await sink.append({ t: "2026-08-21T00:00:00Z", type: "doc.created" });
      const b = await sink.append({ t: "2026-08-21T00:00:00Z", type: "doc.updated" });
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      const raw = await readFile(path.join(dir, "events.jsonl"), "utf8");
      expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
      const reopened = createFsStorage({ root: dir });
      const sink2 = reopened.defaultEventSink?.();
      if (sink2 === undefined) throw new Error("missing default sink");
      const c = await sink2.append({ t: "2026-08-21T00:00:00Z", type: "doc.updated" });
      expect(c.seq).toBe(3);
    });
  });

  it("read replays records with seq > afterSeq, in order", async () => {
    await withTmp(async (dir) => {
      const storage = createFsStorage({ root: dir });
      const sink = storage.defaultEventSink?.();
      if (sink === undefined) throw new Error("missing default sink");
      await sink.append({ t: "2026-08-21T00:00:00Z", type: "a" });
      await sink.append({ t: "2026-08-21T00:00:00Z", type: "b" });
      await sink.append({ t: "2026-08-21T00:00:00Z", type: "c" });
      const read = sink.read;
      if (read === undefined) throw new Error("missing read");
      const tail = await read({ afterSeq: 1 });
      expect(tail.map((e) => e.type)).toEqual(["b", "c"]);
      const none = await read({ afterSeq: 3 });
      expect(none).toEqual([]);
    });
  });

  it("lock serializes concurrent critical sections (mutual exclusion, order unspecified)", async () => {
    await withTmp(async (dir) => {
      const storage = createFsStorage({ root: dir });
      const lock = storage.defaultLock?.(asDocId("fin"));
      if (lock === undefined) throw new Error("missing default lock");
      const order: string[] = [];
      await Promise.all([
        lock.withLock(async () => {
          order.push("a1");
          await new Promise((r) => setTimeout(r, 30));
          order.push("a2");
        }),
        lock.withLock(async () => {
          order.push("b1");
          order.push("b2");
        }),
      ]);
      // proper-lockfile acquisition order is not guaranteed; the guarantee is
      // that critical sections never interleave (each a1→a2 and b1→b2 is contiguous).
      const joined = order.join("");
      expect(["a1a2b1b2", "b1b2a1a2"]).toContain(joined);
    });
  });

  it("createLock exposes mutual exclusion directly", async () => {
    await withTmp(async (dir) => {
      const lock = createLock(path.join(dir, "x.lock"));
      const order: string[] = [];
      await Promise.all([
        lock.withLock(async () => {
          order.push("a1");
          await new Promise((r) => setTimeout(r, 20));
          order.push("a2");
        }),
        lock.withLock(async () => {
          order.push("b1");
          order.push("b2");
        }),
      ]);
      expect(["a1a2b1b2", "b1b2a1a2"]).toContain(order.join(""));
    });
  });

  it("createLock mkdirs a nested lock path's parent directory", async () => {
    await withTmp(async (dir) => {
      // `research/` does not exist; createLock must create it before
      // proper-lockfile can place the lock file (recursive, like writeAtomic).
      const lock = createLock(path.join(dir, "research", "q3-review.lock"));
      let ran = false;
      await lock.withLock(async () => {
        ran = true;
      });
      expect(ran).toBe(true);
      const created = await stat(path.join(dir, "research"));
      expect(created.isDirectory()).toBe(true);
    });
  });

  it("createDoc writes a nested doc into a fresh root (lock parent auto-created)", async () => {
    await withTmp(async (dir) => {
      const storage = createFsStorage({ root: dir });
      // Fresh root: `research/` is not pre-created, so the LOCK stage must
      // create it before writeAtomic's own mkdir runs.
      const deps: PipelineDeps = {
        storage,
        clock: () => "2026-08-21T00:00:00Z",
        blockTypes: new Map<string, BlockType>(),
      };
      const created = await createDoc(
        deps,
        asDocId("research/q3-review"),
        { kind: "human", id: "u1" },
        "# Q3 review",
      );
      expect(created.ok).toBe(true);
      expect(await storage.read(asDocId("research/q3-review"))).toBe("# Q3 review");
    });
  });

  it("createFsEventSink appends records with monotonic seq directly (no clock of its own)", async () => {
    await withTmp(async (dir) => {
      // The sink takes only the path: every record's `t` comes from the draft
      // the engine's clock stamped, so the sink never invents a timestamp.
      const sink = createFsEventSink(path.join(dir, "events.jsonl"));
      const a = await sink.append({ t: "2026-08-21T00:00:00Z", type: "x" });
      const b = await sink.append({ t: "2027-01-02T03:04:05Z", type: "y" });
      expect([a.seq, b.seq]).toEqual([1, 2]);
      expect([a.t, b.t]).toEqual(["2026-08-21T00:00:00Z", "2027-01-02T03:04:05Z"]);
      const raw = await readFile(path.join(dir, "events.jsonl"), "utf8");
      expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    });
  });

  describe("containment", () => {
    it("refuses ids that resolve outside the root, with no read or write", async () => {
      await withTmp(async (dir) => {
        const root = path.join(dir, "ws");
        await mkdir(root);
        await writeFile(path.join(dir, "secret.md"), "SECRET");
        const storage = createFsStorage({ root });
        for (const id of ["../secret", "a/../../secret", "/abs/secret", "..\\secret"]) {
          await expect(storage.read(asDocId(id))).rejects.toThrow(
            /outside the storage root|invalid document id/,
          );
          await expect(storage.writeAtomic(asDocId(id), "x")).rejects.toThrow(
            /outside|invalid document id/,
          );
          await expect(storage.delete?.(asDocId(id))).rejects.toThrow(
            /outside|invalid document id/,
          );
          expect(() => storage.defaultLock?.(asDocId(id))).toThrow(/outside|invalid document id/);
        }
        expect(await readFile(path.join(dir, "secret.md"), "utf8")).toBe("SECRET");
      });
    });

    it("refuses a symlinked directory inside the root that points outside", async () => {
      await withTmp(async (dir) => {
        const root = path.join(dir, "ws");
        const outside = path.join(dir, "outside");
        await mkdir(root);
        await mkdir(outside);
        await writeFile(path.join(outside, "secret.md"), "SECRET");
        await symlink(outside, path.join(root, "link"));
        const storage = createFsStorage({ root });
        await expect(storage.read(asDocId("link/secret"))).rejects.toThrow(
          /outside the storage root/,
        );
        await expect(storage.writeAtomic(asDocId("link/new"), "x")).rejects.toThrow(/outside/);
        await expect(stat(path.join(outside, "new.md"))).rejects.toThrow();
        await expect(storage.delete?.(asDocId("link/secret"))).rejects.toThrow(/outside/);
        expect(await readFile(path.join(outside, "secret.md"), "utf8")).toBe("SECRET");
      });
    });

    it("refuses a symlinked document file that points outside the root", async () => {
      await withTmp(async (dir) => {
        const root = path.join(dir, "ws");
        await mkdir(root);
        await writeFile(path.join(dir, "secret.md"), "SECRET");
        await symlink(path.join(dir, "secret.md"), path.join(root, "doc.md"));
        const storage = createFsStorage({ root });
        await expect(storage.read(asDocId("doc"))).rejects.toThrow(/outside the storage root/);
      });
    });

    it("works when the root itself is a symlink, including nested ids", async () => {
      await withTmp(async (dir) => {
        const real = path.join(dir, "real");
        const linked = path.join(dir, "linked");
        await mkdir(real);
        await symlink(real, linked);
        const storage = createFsStorage({ root: linked });
        await storage.writeAtomic(asDocId("research/q3-review"), "# Q3");
        expect(await storage.read(asDocId("research/q3-review"))).toBe("# Q3");
        expect(await readFile(path.join(real, "research", "q3-review.md"), "utf8")).toBe("# Q3");
        expect(await storage.read(asDocId("missing"))).toBeUndefined();
        await storage.defaultLock?.(asDocId("research/q3-review"))?.withLock(async () => undefined);
      });
    });

    it("keeps nested valid ids working", async () => {
      await withTmp(async (dir) => {
        const storage = createFsStorage({ root: dir });
        await storage.writeAtomic(asDocId("research/q3-review"), "# Q3");
        expect(await storage.read(asDocId("research/q3-review"))).toBe("# Q3");
      });
    });

    it("refuses with E_PATH_OUTSIDE_ROOT for escapes and E_INVALID_ID for malformed ids", async () => {
      await withTmp(async (dir) => {
        const root = path.join(dir, "ws");
        await mkdir(root);
        await symlink(dir, path.join(root, "up"));
        const storage = createFsStorage({ root });
        await expect(storage.read(asDocId("up/secret"))).rejects.toMatchObject({
          code: "E_PATH_OUTSIDE_ROOT",
        });
        await expect(storage.read(asDocId("/abs/secret"))).rejects.toMatchObject({
          code: "E_INVALID_ID",
        });
        await expect(storage.read(asDocId("../secret"))).rejects.toMatchObject({
          code: "E_INVALID_ID",
        });
        await expect(storage.read(asDocId("x.md"))).rejects.toMatchObject({ code: "E_INVALID_ID" });
        expect(() => storage.defaultLock?.(asDocId("../x"))).toThrow(
          expect.objectContaining({ code: "E_INVALID_ID" }),
        );
        await expect(
          storage.defaultLock?.(asDocId("up/x"))?.withLock(async () => undefined),
        ).rejects.toMatchObject({ code: "E_PATH_OUTSIDE_ROOT" });
      });
    });

    it("list() skips symlinks that resolve outside the root and lists nested ids with /", async () => {
      await withTmp(async (dir) => {
        const root = path.join(dir, "ws");
        await mkdir(path.join(root, "research"), { recursive: true });
        await writeFile(path.join(dir, "secret.md"), "SECRET");
        await writeFile(path.join(root, "research", "q3-review.md"), "# Q3");
        await writeFile(path.join(root, "ok.md"), "# ok");
        await symlink(path.join(dir, "secret.md"), path.join(root, "evil.md"));
        await symlink(path.join(root, "ok.md"), path.join(root, "inner.md"));
        const storage = createFsStorage({ root });
        expect(await storage.list()).toEqual(["inner", "ok", "research/q3-review"]);
      });
    });

    it("resolves a dangling symlink's relative target against the link's real directory", async () => {
      await withTmp(async (dir) => {
        const root = path.join(dir, "ws");
        await mkdir(path.join(root, "b"), { recursive: true });
        await mkdir(path.join(root, "x", "y"), { recursive: true });
        // ws/x/y/a -> ../../b (real dir ws/b); ws/b/L.md -> ../../outside/new.md (dangling, outside)
        await symlink("../../b", path.join(root, "x", "y", "a"));
        await symlink("../../outside/new.md", path.join(root, "b", "L.md"));
        const storage = createFsStorage({ root });
        await expect(storage.writeAtomic(asDocId("x/y/a/L"), "x")).rejects.toMatchObject({
          code: "E_PATH_OUTSIDE_ROOT",
        });
        await expect(storage.read(asDocId("b/L"))).rejects.toMatchObject({
          code: "E_PATH_OUTSIDE_ROOT",
        });
      });
    });
  });
});
