import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { asDocId, type DocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import type { Storage } from "../ports/ports.js";
import type { WatchSource } from "../watch/source.js";
import { createEngine, type EngineOptions } from "./engine.js";

/**
 * Review findings on #3 (task 2b): the paths on which the incremental include
 * index or the seeded parse cache could go stale and stay stale. Each test
 * here failed before its fix, and passes on a full-rebuild engine.
 */

const writer = { kind: "human", id: "u1" } as const;
const clock = () => "2026-10-04T00:00:00Z";
const silentSource: WatchSource = {
  async start() {
    return async () => {};
  },
};

/** An engine with watch on over `storage`, and a recorder for one scoped subscriber. */
function watched(storage: Storage, extra: Partial<EngineOptions> = {}) {
  const engine = createEngine({
    storage,
    clock,
    watch: { rootDir: "/ws", source: silentSource },
    ...extra,
  });
  const seen: string[] = [];
  const subscribe = (docId: string) =>
    engine.subscribe(docId, (evt) => seen.push(`${evt.type}:${String(evt.docId)}`));
  return { engine, seen, subscribe };
}

describe("C1: a document removed, then restored with the same bytes", () => {
  it("after removeDoc, an external restore is not a self-echo, and the index learns its edges", async () => {
    const storage = createMemStorage();
    const { engine, seen, subscribe } = watched(storage);
    await storage.writeAtomic(asDocId("board"), "# Board\n\n{{include:a}}\n");
    await storage.writeAtomic(asDocId("y"), "# Y\n");
    const a = "# A\n\n{{include:y}}\n";
    expect((await engine.createDoc("a", { writer, content: a })).ok).toBe(true);
    expect((await engine.removeDoc("a", { writer })).ok).toBe(true);
    subscribe("board");
    await engine.write("y", { writer, fullText: "# Y\n\n1\n" }); // the index sees `a` missing

    await storage.writeAtomic(asDocId("a"), a); // e.g. `git checkout`
    const outcome = await engine.externalWrite("/ws/a.md");
    expect(outcome?.suppressed).toBe(false);

    seen.length = 0;
    await engine.write("y", { writer, fullText: "# Y\n\n2\n" });
    expect(seen).toContain("doc.updated:y");
  });

  it("after an external delete, an external restore is not a self-echo", async () => {
    const storage = createMemStorage();
    const { engine, seen, subscribe } = watched(storage);
    await storage.writeAtomic(asDocId("board"), "# Board\n\n{{include:a}}\n");
    await storage.writeAtomic(asDocId("y"), "# Y\n");
    const a = "# A\n\n{{include:y}}\n";
    expect((await engine.createDoc("a", { writer, content: a })).ok).toBe(true);
    await storage.delete?.(asDocId("a"));
    expect(await engine.externalWrite("/ws/a.md")).toBeUndefined();
    subscribe("board");
    await engine.write("y", { writer, fullText: "# Y\n\n1\n" });

    await storage.writeAtomic(asDocId("a"), a);
    expect((await engine.externalWrite("/ws/a.md"))?.suppressed).toBe(false);

    seen.length = 0;
    await engine.write("y", { writer, fullText: "# Y\n\n2\n" });
    expect(seen).toContain("doc.updated:y");
  });
});
