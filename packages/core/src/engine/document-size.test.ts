import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { DEFAULT_MAX_DOCUMENT_BYTES } from "../index.js";
import { asDocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import { createExternalWriteHandler } from "../watch/external-write.js";
import { createEngine } from "./engine.js";

const writer = { kind: "human", id: "me" } as const;

const statusType: BlockType = {
  type: "status",
  schema: {
    type: "object",
    required: ["id", "value"],
    properties: { id: { type: "string" }, value: { type: "string" } },
  },
};

/** Markdown dense in inline markup: the costliest shape for the markdown parser per byte. */
function markupDense(bytes: number): string {
  const line = "- *a* [l](http://x.y/z) `c` **b**\n";
  return line.repeat(Math.ceil(bytes / line.length));
}

function codes(diagnostics: readonly { readonly code: string }[]): string[] {
  return diagnostics.map((d) => d.code);
}

describe("document size limit", () => {
  it("defaults to 256 KiB and rejects invalid values at construction", () => {
    expect(DEFAULT_MAX_DOCUMENT_BYTES).toBe(256 * 1024);
    const storage = createMemStorage();
    for (const bad of [-1, 1.5, Number.NaN, "5", null]) {
      expect(() => createEngine({ storage, maxDocumentBytes: bad as unknown as number })).toThrow(
        TypeError,
      );
    }
    expect(() => createEngine({ storage, maxDocumentBytes: 0 })).not.toThrow();
    expect(() =>
      createEngine({ storage, maxDocumentBytes: Number.POSITIVE_INFINITY }),
    ).not.toThrow();
  });

  it("rejects a create over the limit, counted in UTF-8 bytes, and stores nothing", async () => {
    const engine = createEngine({ storage: createMemStorage(), maxDocumentBytes: 10 });
    // Five two-byte characters plus a newline: 6 characters, 11 bytes.
    const created = await engine.createDoc("big", { writer, content: "ééééé\n" });
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.rejection.reason).toBe("too-large");
      expect(codes(created.rejection.diagnostics)).toEqual(["E_DOCUMENT_TOO_LARGE"]);
    }
    expect(await engine.getDoc("big")).toBeUndefined();
    expect((await engine.createDoc("fits", { writer, content: "éééé\n" })).ok).toBe(true);
  });

  it("rejects a full-text write over the limit and keeps the stored text", async () => {
    const engine = createEngine({ storage: createMemStorage(), maxDocumentBytes: 64 });
    await engine.createDoc("d", { writer, content: "# D\n" });
    const written = await engine.write("d", { writer, fullText: `# D\n\n${"x".repeat(64)}\n` });
    expect(written.ok).toBe(false);
    if (!written.ok) expect(codes(written.rejection.diagnostics)).toEqual(["E_DOCUMENT_TOO_LARGE"]);
    expect((await engine.getDoc("d"))?.src).toBe("# D\n");
  });

  it("rejects a patch that would grow the document over the limit", async () => {
    const engine = createEngine({
      storage: createMemStorage(),
      blocks: [statusType],
      maxDocumentBytes: 80,
    });
    const src = "```status\nid: s\nvalue: a\n```\n";
    await engine.createDoc("d", { writer, content: src });
    const patched = await engine.patch("d", "s", { writer, attrs: { value: "v".repeat(80) } });
    expect(patched.ok).toBe(false);
    if (!patched.ok) {
      expect(patched.rejection.reason).toBe("too-large");
      expect(codes(patched.rejection.diagnostics)).toEqual(["E_DOCUMENT_TOO_LARGE"]);
    }
    expect((await engine.getDoc("d"))?.src).toBe(src);
  });

  it("diagnoses a stored document over the limit instead of parsing it", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, blocks: [statusType], maxDocumentBytes: 64 });
    const big = `\`\`\`status\nid: s\nvalue: a\n\`\`\`\n\n${"x".repeat(64)}\n`;
    await storage.writeAtomic(asDocId("big"), big);

    const projected = await engine.projection<string>("big", "text", {});
    expect(projected.ok).toBe(false);
    expect(projected.output).toBe("");
    expect(codes(projected.diagnostics)).toEqual(["E_DOCUMENT_TOO_LARGE"]);
    expect(projected.diagnostics[0]?.nodeId).toBe("big");

    expect(await engine.getBlock("big", "s")).toBeUndefined();
    expect(codes((await engine.refGraph("big")).diagnostics)).toEqual(["E_DOCUMENT_TOO_LARGE"]);

    const patched = await engine.patch("big", "s", { writer, attrs: { value: "b" } });
    expect(patched.ok).toBe(false);
    if (!patched.ok) expect(patched.rejection.reason).toBe("too-large");
    const intent = await engine.applyIntent(
      { docId: "big", blockId: "s", affordance: "set", params: {} },
      { writer },
    );
    expect(intent.ok).toBe(false);
    if (!intent.ok) expect(intent.rejection.reason).toBe("too-large");

    // A full-text write that fits replaces the oversized document.
    expect((await engine.write("big", { writer, fullText: "# Small\n" })).ok).toBe(true);
    expect((await engine.projection<string>("big", "text", {})).output).toContain("Small");
  });

  it("resets the document in the event log when a fitting write replaces an oversized one", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, blocks: [statusType], maxDocumentBytes: 200 });
    const block = (id: string, value: string): string =>
      `\`\`\`status\nid: ${id}\nvalue: ${value}\n\`\`\`\n`;
    await engine.createDoc("d", {
      writer,
      content: `# D\n\n${block("s", "a")}${block("gone", "x")}`,
    });
    // Oversized behind the engine's back: the engine never parses this version.
    await storage.writeAtomic(asDocId("d"), `# D\n\n${block("s", "a")}${"z".repeat(400)}\n`);

    const written = await engine.write("d", { writer, fullText: `# D\n\n${block("s", "b")}` });
    expect(written.ok).toBe(true);
    const types = (written.ok ? (written.events ?? []) : []).map(({ type, blockId }) =>
      typeof blockId === "string" ? `${type} ${blockId}` : type,
    );
    expect(types).toEqual([
      "doc.removed",
      "doc.created",
      "doc.updated",
      "section.added",
      "block.added s",
    ]);

    // Replaying the whole log leaves exactly the blocks the document now has.
    const blocks = new Set<string>();
    for await (const evt of engine.events({ afterSeq: 0 })) {
      const { blockId: id } = evt;
      if (evt.type === "doc.removed") blocks.clear();
      else if (evt.type === "block.added" && typeof id === "string") blocks.add(id);
      else if (evt.type === "block.removed" && typeof id === "string") blocks.delete(id);
    }
    expect([...blocks]).toEqual(["s"]);
  });

  it("leaves an include of an oversized document verbatim, with a diagnostic", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, maxDocumentBytes: 64 });
    await storage.writeAtomic(asDocId("big"), `# S\n\n${"x".repeat(64)}\n`);
    await storage.writeAtomic(asDocId("ok"), "# Fine\n\nfine\n");
    await storage.writeAtomic(
      asDocId("board"),
      "# B\n\n{{include:big}}\n\n{{include:big#s}}\n\n{{include:ok}}\n",
    );

    const projected = await engine.projection<string>("board", "text", {});
    expect(projected.ok).toBe(true);
    expect(projected.output).toContain("{{include:big}}");
    expect(projected.output).toContain("{{include:big#s}}");
    expect(projected.output).toContain("fine");
    expect(projected.output).not.toContain("xxxx");
    const tooLarge = projected.diagnostics.filter((d) => d.code === "E_DOCUMENT_TOO_LARGE");
    expect(tooLarge).toHaveLength(2);
    expect(tooLarge[0]?.nodeId).toBe("big");
    expect(Object.keys(projected.versions).sort()).toEqual(["board", "ok"]);

    const graph = await engine.refGraph("board");
    expect(graph.docs).toEqual(["board", "ok"]);
    expect(graph.includes.filter((e) => e.toDoc === "big").map((e) => e.status)).toEqual([
      "missing-doc",
      "missing-doc",
    ]);
  });

  it("projects an oversized document and a board including it without parsing it", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage });
    await storage.writeAtomic(asDocId("big"), markupDense(DEFAULT_MAX_DOCUMENT_BYTES + 64 * 1024));
    await storage.writeAtomic(asDocId("board"), "# B\n\n{{include:big}}\n");

    const started = performance.now();
    const direct = await engine.projection<string>("big", "text", {});
    const viaBoard = await engine.projection<string>("board", "text", {});
    const elapsed = performance.now() - started;

    expect(codes(direct.diagnostics)).toEqual(["E_DOCUMENT_TOO_LARGE"]);
    expect(viaBoard.output).toContain("{{include:big}}");
    expect(codes(viaBoard.diagnostics)).toContain("E_DOCUMENT_TOO_LARGE");
    expect(elapsed).toBeLessThan(1000);
  }, 120_000);

  it("diagnoses an external write over the limit without parsing or eventing it", async () => {
    const storage = createMemStorage();
    const handler = createExternalWriteHandler({
      storage,
      clock: () => "2026-08-21T00:00:00Z",
      blockTypes: new Map(),
      rootDir: "/ws",
      maxDocumentBytes: 64,
    });
    await storage.writeAtomic(asDocId("big"), `# Big\n\n${"x".repeat(64)}\n`);
    const outcome = await handler.handle(path.join("/ws", "big.md"));
    expect(outcome?.external).toBe(true);
    expect(outcome?.events).toEqual([]);
    expect(codes(outcome?.diagnostics ?? [])).toEqual(["E_DOCUMENT_TOO_LARGE"]);
  });
});

describe("parse cache across projections", () => {
  it("keeps a block hook from changing the cached attrs other reads see", async () => {
    const mutating: BlockType = {
      ...statusType,
      project: {
        text: (attrs) => {
          Object.assign(attrs, { value: "mutated" });
          return "never";
        },
      },
    };
    const engine = createEngine({ storage: createMemStorage(), blocks: [mutating] });
    await engine.createDoc("d", { writer, content: "```status\nid: s\nvalue: a\n```\n" });
    await engine.getBlock("d", "s"); // the parse is now cached
    const projected = await engine.projection<string>("d", "text", {});
    expect(codes(projected.diagnostics)).toEqual(["E_BLOCK_HOOK_ERROR"]);
    expect((await engine.getBlock("d", "s"))?.attrs).toMatchObject({ value: "a" });
    const again = await engine.projection<string>("d", "text", {});
    expect(codes(again.diagnostics)).toEqual(["E_BLOCK_HOOK_ERROR"]);
  });

  it("parses an included document once per content, not once per projection", async () => {
    const storage = createMemStorage();
    // A document large enough that parsing it takes seconds: above the default limit.
    const engine = createEngine({ storage, maxDocumentBytes: 1024 * 1024 });
    await engine.createDoc("lib", { writer, content: `# Lib\n\n${markupDense(256 * 1024)}` });
    await engine.createDoc("board", { writer, content: "# Board\n\n{{include:lib}}\n" });
    await engine.projection("board", "text", {}); // the first projection parses `lib`

    const started = performance.now();
    for (let i = 0; i < 3; i += 1) {
      const r = await engine.projection<string>("board", "text", {});
      expect(r.output).toContain("Lib");
    }
    expect(performance.now() - started).toBeLessThan(1000);
  }, 120_000);

  it("does not re-parse a document full of escaped refs on every projection", async () => {
    const storage = createMemStorage();
    // About 300 KB, so that parsing it takes seconds: above the default limit.
    const engine = createEngine({ storage, blocks: [statusType], maxDocumentBytes: 1024 * 1024 });
    const blocks = Array.from(
      { length: 200 },
      (_, i) => `\`\`\`status\nid: s${i}\nvalue: a\n\`\`\`\n`,
    ).join("\n");
    const content = `${"\\{{x}} ".repeat(40_000)}\n\n${blocks}`;
    await engine.createDoc("escapes", { writer, content });
    await engine.projection("escapes", "text", {}); // the first projection parses it

    const started = performance.now();
    for (let i = 0; i < 3; i += 1) {
      const r = await engine.projection<string>("escapes", "text", {});
      expect(r.output.startsWith("{{x}} {{x}} ")).toBe(true);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  }, 120_000);

  it("re-parses a document after it changes, through the engine or behind its back", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage });
    await engine.createDoc("lib", { writer, content: "# Lib\n\nfirst\n" });
    await engine.createDoc("board", { writer, content: "# Board\n\n{{include:lib}}\n" });
    expect((await engine.projection<string>("board", "text", {})).output).toContain("first");

    await engine.write("lib", { writer, fullText: "# Lib\n\nsecond\n" });
    expect((await engine.projection<string>("board", "text", {})).output).toContain("second");

    await storage.writeAtomic(asDocId("lib"), "# Lib\n\nthird\n");
    const third = await engine.projection<string>("board", "text", {});
    expect(third.output).toContain("third");
    expect(third.output).not.toContain("second");
  });
});
