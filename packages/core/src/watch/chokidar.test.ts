import { describe, expect, it } from "vitest";
import { type ChokidarLike, createChokidarSource } from "./chokidar.js";

/** An injectable fake watcher that records its factory argument and event handlers. */
function makeFakeWatcher() {
  const args: string[] = [];
  const handlers = new Map<string, (p: string) => void>();
  let closed = false;
  const watcher: ChokidarLike = {
    on: (event, cb) => {
      handlers.set(event, cb);
    },
    close: async () => {
      closed = true;
    },
  };
  return {
    args,
    handlers,
    isClosed: () => closed,
    factory: (dir: string): ChokidarLike => {
      args.push(dir);
      return watcher;
    },
  };
}

/**
 * These tests inject a fake `ChokidarLike` so the adapter's glob→root-dir fix
 * and `.md` filtering are deterministic (real fs events are timing-dependent).
 * Manual verification against the real chokidar v4 watcher:
 *
 *   node --input-type=module -e '
 *     import chokidar from "chokidar";
 *     const w = chokidar.watch("/tmp/bk", { ignoreInitial: true });
 *     w.on("all", (ev, p) => console.log(ev, p));
 *   '
 *
 * then `echo hi > /tmp/bk/a.md` and `echo hi > /tmp/bk/a.txt` in another shell:
 * the watcher reports both (v4 is recursive with no glob), and
 * `createChokidarSource` forwards only `a.md`.
 */
describe("createChokidarSource", () => {
  it("maps watcher events to WatchEvents and closes on demand", async () => {
    const seen: string[] = [];
    const handlers = new Map<string, (p: string) => void>();
    let closed = false;
    const fakeWatcher: ChokidarLike = {
      on: (event, cb) => {
        handlers.set(event, cb);
      },
      close: async () => {
        closed = true;
      },
    };
    const source = createChokidarSource("/ws", () => fakeWatcher);
    const closer = await source.start((evt) => seen.push(evt.path));
    handlers.get("add")?.("/ws/a.md");
    handlers.get("change")?.("/ws/b.md");
    handlers.get("unlink")?.("/ws/c.md");
    expect(seen).toEqual(["/ws/a.md", "/ws/b.md", "/ws/c.md"]);
    await closer();
    expect(closed).toBe(true);
  });

  it("watches the root directory (chokidar v4 recursive), not a **/*.md glob", async () => {
    const fake = makeFakeWatcher();
    const source = createChokidarSource("/ws", fake.factory);
    const closer = await source.start(() => {});
    expect(fake.args).toEqual(["/ws"]);
    await closer();
  });

  it("forwards only .md change events (non-.md paths are ignored)", async () => {
    const fake = makeFakeWatcher();
    const source = createChokidarSource("/ws", fake.factory);
    const seen: string[] = [];
    await source.start((evt) => seen.push(evt.path));
    fake.handlers.get("change")?.("/ws/a.md");
    fake.handlers.get("change")?.("/ws/b.txt");
    fake.handlers.get("add")?.("/ws/c.md");
    fake.handlers.get("unlink")?.("/ws/d.md");
    expect(seen).toEqual(["/ws/a.md", "/ws/c.md", "/ws/d.md"]);
  });

  it("ignores dotfiles and lock files", async () => {
    const fake = makeFakeWatcher();
    const source = createChokidarSource("/ws", fake.factory);
    const seen: string[] = [];
    await source.start((evt) => seen.push(evt.path));
    fake.handlers.get("add")?.("/ws/.hidden.md");
    fake.handlers.get("add")?.("/ws/doc.lock");
    fake.handlers.get("add")?.("/ws/ok.md");
    expect(seen).toEqual(["/ws/ok.md"]);
  });
});
