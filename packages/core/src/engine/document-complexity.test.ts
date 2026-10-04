import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { type ComplexityLimits, DEFAULT_COMPLEXITY_LIMITS } from "../index.js";
import { asDocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import type { EventRecord, Storage } from "../ports/ports.js";
import { createExternalWriteHandler } from "../watch/external-write.js";
import { createEngine } from "./engine.js";

const writer = { kind: "human", id: "me" } as const;

/** The #11 repro: about 8 KB, far below the size limit, but 8,000 containers deep. */
const deep = `# t\n\n${">".repeat(8000)} x\n`;

const statusType: BlockType = {
  type: "status",
  schema: {
    type: "object",
    required: ["id", "value"],
    properties: { id: { type: "string" }, value: { type: "string" } },
  },
};

const statusSrc = "# S\n\n```status\nid: s\nvalue: a\n```\n";

function codes(diagnostics: readonly { readonly code: string }[]): string[] {
  return diagnostics.map((d) => d.code);
}

describe("complexity limits", () => {
  it("are on by default, and reject invalid values at construction", () => {
    const storage = createMemStorage();
    expect(DEFAULT_COMPLEXITY_LIMITS.maxContainerDepth).toBe(32);
    for (const bad of [true, null, 3, { maxContainerDepth: -1 }, { nope: 1 }]) {
      expect(() =>
        createEngine({ storage, complexityLimits: bad as unknown as ComplexityLimits }),
      ).toThrow(TypeError);
    }
    expect(() => createEngine({ storage, complexityLimits: false })).not.toThrow();
    expect(() => createEngine({ storage, complexityLimits: { maxBracketDepth: 8 } })).not.toThrow();
  });

  it("still parses a document within the default limits", async () => {
    const engine = createEngine({ storage: createMemStorage() });
    const nested = [
      "# Within",
      "",
      `${">".repeat(32)} quote`,
      "",
      `${"- ".repeat(32)}item`,
      "",
      `${" ".repeat(160)}indented`,
      "",
      `${"[".repeat(32)}x${"]".repeat(32)}`,
      "",
      `a${"*".repeat(64)}b`,
      "",
    ].join("\n");
    const created = await engine.createDoc("ok", { writer, content: nested });
    expect(created.ok).toBe(true);
    const r = await engine.projection<string>("ok", "text", {});
    expect(r.ok).toBe(true);
    expect(codes(r.diagnostics)).toEqual([]);
    expect(r.output).toContain("quote");
  });

  it("createDoc of the #11 repro resolves to a too-complex rejection", async () => {
    const engine = createEngine({ storage: createMemStorage() });
    const r = await engine.createDoc("deep", { writer, content: deep });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejection.reason).toBe("too-complex");
      expect(codes(r.rejection.diagnostics)).toEqual(["E_DOCUMENT_TOO_COMPLEX"]);
      expect(r.rejection.diagnostics[0]?.line).toBe(3);
    }
    expect(await engine.getDoc("deep")).toBeUndefined();
  });

  it("with complexityLimits: false, createDoc of the repro is a validation rejection", async () => {
    const engine = createEngine({ storage: createMemStorage(), complexityLimits: false });
    const r = await engine.createDoc("deep", { writer, content: deep });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejection.reason).toBe("validation");
      expect(codes(r.rejection.diagnostics)).toEqual(["E_PARSE_FAILED"]);
    }
  });

  for (const limits of [undefined, false] as const) {
    const label = limits === false ? "limits off (parse throws)" : "default limits";

    describe(`a stored over-complex document, ${label}`, () => {
      function setup() {
        const storage = createMemStorage();
        const engine = createEngine({
          storage,
          blocks: [statusType],
          ...(limits === false ? { complexityLimits: false } : {}),
        });
        return { storage, engine };
      }
      const expected = limits === false ? "E_PARSE_FAILED" : "E_DOCUMENT_TOO_COMPLEX";

      it("projects ok: false with the diagnostic", async () => {
        const { storage, engine } = setup();
        await storage.writeAtomic(asDocId("deep"), deep);
        const r = await engine.projection("deep", "text", {});
        expect(r.ok).toBe(false);
        expect(r.output).toBe("");
        expect(codes(r.diagnostics)).toEqual([expected]);
        expect(r.versions).toEqual({});
      });

      it("stays a verbatim include in a board that projects normally", async () => {
        const { storage, engine } = setup();
        await storage.writeAtomic(asDocId("deep"), deep);
        await storage.writeAtomic(asDocId("board"), "# Board\n\n{{include:deep}}\n\nafter\n");
        const r = await engine.projection<string>("board", "text", {});
        expect(r.ok).toBe(true);
        expect(r.output).toContain("{{include:deep}}");
        expect(r.output).toContain("after");
        expect(codes(r.diagnostics)).toEqual([expected]);
        expect(Object.keys(r.versions)).toEqual(["board"]);
      });

      it("refGraph does not throw", async () => {
        const { storage, engine } = setup();
        await storage.writeAtomic(asDocId("deep"), deep);
        const g = await engine.refGraph("deep");
        expect(g.docs).toEqual([]);
        expect(codes(g.diagnostics)).toEqual([expected]);
      });

      it("getBlock treats it as absent", async () => {
        const { storage, engine } = setup();
        await storage.writeAtomic(asDocId("deep"), `${statusSrc}\n${deep}`);
        expect(await engine.getBlock("deep", "s")).toBeUndefined();
        expect((await engine.getDoc("deep"))?.src).toContain(">>>");
      });

      it("subscribing to it does not block an unrelated write (#11, #1)", async () => {
        const { storage, engine } = setup();
        await storage.writeAtomic(asDocId("deep"), deep);
        const seen: EventRecord[] = [];
        engine.subscribe("deep", (e) => seen.push(e));
        const created = await engine.createDoc("other", { writer, content: "# Other\n" });
        expect(created.ok).toBe(true);
        const written = await engine.write("other", { writer, fullText: "# Other 2\n" });
        expect(written.ok).toBe(true);
        expect(seen).toEqual([]);
      });

      it("a full-text write that fits replaces it", async () => {
        const { storage, engine } = setup();
        await storage.writeAtomic(asDocId("deep"), deep);
        const r = await engine.write("deep", { writer, fullText: "# Fixed\n" });
        expect(r.ok).toBe(true);
        expect((await engine.projection("deep", "text", {})).ok).toBe(true);
      });
    });
  }

  it("an unreadable subscribed board no longer blocks writes (#1)", async () => {
    const inner = createMemStorage();
    const storage: Storage = {
      ...inner,
      read: async (id) => {
        if (id === "loop") {
          throw Object.assign(new Error("ELOOP: too many symbolic links"), { code: "ELOOP" });
        }
        return inner.read(id);
      },
      writeAtomic: (id, content) => inner.writeAtomic(id, content),
      list: () => inner.list(),
    };
    const engine = createEngine({ storage });
    engine.subscribe("loop", () => {});
    const r = await engine.createDoc("other", { writer, content: "# Other\n" });
    expect(r.ok).toBe(true);
    const w = await engine.write("other", { writer, fullText: "# Other 2\n" });
    expect(w.ok).toBe(true);
  });

  it("a subscribed board still receives events of its includes when another subscriber is broken", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage });
    await storage.writeAtomic(asDocId("deep"), deep);
    await engine.createDoc("child", { writer, content: "# Child\n\nold\n" });
    await engine.createDoc("board", { writer, content: "# Board\n\n{{include:child}}\n" });
    const seen: string[] = [];
    engine.subscribe("deep", () => {});
    engine.subscribe("board", (e) => seen.push(`${e.type}:${String(e.docId)}`));
    const w = await engine.write("child", { writer, fullText: "# Child\n\nnew\n" });
    expect(w.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.endsWith(":child"))).toBe(true);
  });

  it("an external write of an over-complex document is not parsed or evented", async () => {
    const storage = createMemStorage();
    const handler = createExternalWriteHandler({
      storage,
      clock: () => "2026-08-21T00:00:00Z",
      blockTypes: new Map(),
      rootDir: "/ws",
    });
    await storage.writeAtomic(asDocId("deep"), deep);
    const outcome = await handler.handle(path.join("/ws", "deep.md"));
    expect(outcome?.external).toBe(true);
    expect(outcome?.events).toEqual([]);
    expect(codes(outcome?.diagnostics ?? [])).toEqual(["E_DOCUMENT_TOO_COMPLEX"]);
  });

  it("an external write whose parse throws is not evented (limits off)", async () => {
    const storage = createMemStorage();
    const handler = createExternalWriteHandler({
      storage,
      clock: () => "2026-08-21T00:00:00Z",
      blockTypes: new Map(),
      rootDir: "/ws",
      complexityLimits: false,
    });
    expect(() => handler.recordCommitted(asDocId("deep"), deep)).not.toThrow();
    await storage.writeAtomic(asDocId("deep"), `${deep}\n`);
    const outcome = await handler.handle(path.join("/ws", "deep.md"));
    expect(outcome?.external).toBe(true);
    expect(outcome?.events).toEqual([]);
    expect(codes(outcome?.diagnostics ?? [])).toEqual(["E_PARSE_FAILED"]);
  });
});

describe("createExternalWriteHandler complexityLimits", () => {
  it("throws a TypeError at construction for an invalid limits value", () => {
    for (const bad of [{ maxBracketDepth: "8" }, { nope: 1 }, null]) {
      expect(() =>
        createExternalWriteHandler({
          storage: createMemStorage(),
          clock: () => "2026-08-21T00:00:00Z",
          blockTypes: new Map(),
          rootDir: "/ws",
          complexityLimits: bad as unknown as ComplexityLimits,
        }),
      ).toThrow(TypeError);
    }
  });
});
