import { describe, expect, it } from "vitest";
import { createEngine } from "../engine/engine.js";
import type { ParsedDoc } from "../model/doc.js";
import { asDocId, type DocId } from "../model/ids.js";
import { parseDoc } from "../parse/pipeline.js";
import { createMemStorage } from "../ports/mem.js";
import type { Storage } from "../ports/ports.js";
import { resolveIncludes } from "./graph.js";
import { buildMergedTree, DEFAULT_INCLUDE_LIMITS, type MergedNode } from "./merge.js";

/**
 * A chain where each `dk` includes both `d(k+1)` and `d(k+1)#a`. The two
 * targets have distinct dedup keys and section `a` spans the whole document,
 * so every level doubles the merged tree: depth `n` holds 2^(n+1) - 1 nodes
 * when nothing bounds it.
 */
async function doublingChain(
  storage: Storage,
  depth: number,
  leaf = "# a\n\nleaf\n",
): Promise<void> {
  for (let k = depth; k >= 0; k -= 1) {
    const content =
      k === depth ? leaf : `# a\n\n{{include:d${k + 1}}}\n\n{{include:d${k + 1}#a}}\n`;
    await storage.writeAtomic(asDocId(`d${k}`), content);
  }
}

function countNodes(node: MergedNode): number {
  let n = 1;
  for (const include of node.includes) n += countNodes(include.node);
  return n;
}

describe("include expansion limit", () => {
  it("stops a doubling include chain at the node limit with E_INCLUDE_LIMIT", async () => {
    const storage = createMemStorage();
    await doublingChain(storage, 16);
    const started = performance.now();
    const link = await resolveIncludes(asDocId("d0"), storage);
    const tree = await buildMergedTree({ boardDocId: asDocId("d0"), link });
    const elapsed = performance.now() - started;

    // Unbounded, depth 16 is 131,071 merged nodes.
    expect(countNodes(tree.root)).toBeLessThanOrEqual(DEFAULT_INCLUDE_LIMITS.maxNodes + 1);
    const limit = tree.diagnostics?.filter((d) => d.code === "E_INCLUDE_LIMIT") ?? [];
    expect(limit).toHaveLength(1);
    expect(limit[0]?.message).toContain("{{include:");
    expect(elapsed).toBeLessThan(5000);
  });

  it("projects a deep doubling chain through the engine quickly, with bounded output", async () => {
    const storage = createMemStorage();
    await doublingChain(storage, 40);
    const engine = createEngine({ storage });
    const started = performance.now();
    const result = await engine.projection<string>("d0", "text", {});
    const elapsed = performance.now() - started;

    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((d) => d.code)).toContain("E_INCLUDE_LIMIT");
    // Every merged node of this chain projects to well under 100 bytes.
    expect(result.output.length).toBeLessThan((DEFAULT_INCLUDE_LIMITS.maxNodes + 1) * 100);
    expect(elapsed).toBeLessThan(5000);
  });

  it("renders a document included in several places in each place, without a limit diagnostic", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(
      asDocId("board"),
      "# Board\n\n{{include:shared}}\n\n{{include:shared#s}}\n\n{{include:mid}}\n",
    );
    await storage.writeAtomic(asDocId("mid"), "# Mid\n\n{{include:shared#t}}\n");
    await storage.writeAtomic(
      asDocId("shared"),
      "# Shared\n\n## S {#s}\nalpha-body\n\n## T {#t}\nbeta-body\n",
    );
    const engine = createEngine({ storage });
    const result = await engine.projection<string>("board", "text", {});

    expect(result.diagnostics.map((d) => d.code)).not.toContain("E_INCLUDE_LIMIT");
    expect(result.output.split("alpha-body")).toHaveLength(3); // whole doc + section s
    expect(result.output.split("beta-body")).toHaveLength(3); // whole doc + section t via mid
    expect(result.output).not.toContain("{{include:");
  });

  it("honours a configured node limit: expands up to it, then leaves includes verbatim", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(
      asDocId("board"),
      "# Board\n\n{{include:one}}\n\n{{include:two}}\n\n{{include:three}}\n",
    );
    await storage.writeAtomic(asDocId("one"), "one-body\n");
    await storage.writeAtomic(asDocId("two"), "two-body\n");
    await storage.writeAtomic(asDocId("three"), "three-body\n");
    const engine = createEngine({ storage, includeLimits: { maxNodes: 2 } });
    const result = await engine.projection<string>("board", "text", {});

    expect(result.ok).toBe(true);
    expect(result.output).toContain("one-body");
    expect(result.output).toContain("two-body");
    expect(result.output).not.toContain("three-body");
    expect(result.output).toContain("{{include:three}}");
    const limit = result.diagnostics.filter((d) => d.code === "E_INCLUDE_LIMIT");
    expect(limit).toHaveLength(1);
    expect(limit[0]?.nodeId).toBe("three");
    expect(limit[0]?.message).toContain("{{include:three}}");
    expect(limit[0]?.message).toContain("board");
  });

  it("honours a configured byte limit on included content", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(
      asDocId("board"),
      "# Board\n\n{{include:small}}\n\n{{include:big}}\n",
    );
    await storage.writeAtomic(asDocId("small"), "small-body\n");
    await storage.writeAtomic(asDocId("big"), `big-body\n${"x".repeat(1000)}\n`);
    const engine = createEngine({ storage, includeLimits: { maxBytes: 100 } });
    const result = await engine.projection<string>("board", "text", {});

    expect(result.output).toContain("small-body");
    expect(result.output).not.toContain("big-body");
    expect(result.output).toContain("{{include:big}}");
    expect(result.diagnostics.find((d) => d.code === "E_INCLUDE_LIMIT")?.nodeId).toBe("big");
  });

  it("reports the limit on every projection, including ones served from the merge cache", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "# Board\n\n{{include:one}}\n\n{{include:two}}\n");
    await storage.writeAtomic(asDocId("one"), "one-body\n");
    await storage.writeAtomic(asDocId("two"), "two-body\n");
    const engine = createEngine({ storage, includeLimits: { maxNodes: 1 } });
    for (const projectorId of ["text", "text"]) {
      const result = await engine.projection<string>("board", projectorId, {});
      expect(result.diagnostics.filter((d) => d.code === "E_INCLUDE_LIMIT")).toHaveLength(1);
      expect(result.output).not.toContain("two-body");
    }
  });

  it("rejects an invalid limit at construction", () => {
    const storage = createMemStorage();
    expect(() => createEngine({ storage, includeLimits: { maxNodes: -1 } })).toThrow(TypeError);
    expect(() => createEngine({ storage, includeLimits: { maxBytes: Number.NaN } })).toThrow(
      TypeError,
    );
    expect(() => createEngine({ storage, includeLimits: { maxNodes: 1.5 } })).toThrow(TypeError);
  });
});

/** A storage that counts reads per document id. */
function countingStorage(): { storage: Storage; reads: Map<string, number> } {
  const inner = createMemStorage();
  const reads = new Map<string, number>();
  const storage: Storage = Object.assign(Object.create(inner) as Storage, {
    read: async (id: Parameters<Storage["read"]>[0]) => {
      reads.set(id, (reads.get(id) ?? 0) + 1);
      return inner.read(id);
    },
  });
  return { storage, reads };
}

/**
 * A large document whose first ten sections are tiny and whose tail holds
 * `refs` source refs plus about `prose` characters of text and one escaped
 * reference.
 */
function bigDoc(refs: number, prose: number): string {
  let out = "";
  for (let i = 0; i < 10; i += 1) out += `# s${i}\n\nx\n\n`;
  out += "# tail\n\n";
  const parts: string[] = [];
  for (let i = 0; i < refs; i += 1) parts.push(`{{source:src${i}}}`);
  out += `${parts.join(" ")}\n\n`;
  out += "lorem ipsum dolor sit amet ".repeat(Math.ceil(prose / 27));
  return `${out} \\{{escaped}}\n`;
}

describe("include expansion limit: depth, per-node cost, and defaults", () => {
  it("has documented defaults", () => {
    expect(DEFAULT_INCLUDE_LIMITS).toEqual({ maxNodes: 1000, maxBytes: 1024 * 1024, maxDepth: 64 });
  });

  it("cuts a 2,000-document linear chain at the depth limit without a stack overflow", async () => {
    const storage = createMemStorage();
    const n = 2000;
    for (let k = n; k >= 0; k -= 1) {
      await storage.writeAtomic(
        asDocId(`c${k}`),
        k === n ? "leaf\n" : `c${k} {{include:c${k + 1}}}\n`,
      );
    }
    const engine = createEngine({ storage });
    const result = await engine.projection<string>("c0", "text", {});

    expect(result.ok).toBe(true);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).not.toContain("E_PROJECTOR_ERROR");
    const limit = result.diagnostics.filter((d) => d.code === "E_INCLUDE_LIMIT");
    expect(limit).toHaveLength(1);
    expect(limit[0]?.message).toContain("64 levels of nested includes");
    expect(limit[0]?.message).toContain("{{include:c65}} in c64");
    expect(result.output).toContain("c64 {{include:c65}}");
  });

  it("honours a configured depth limit", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("a"), "a {{include:b}}\n");
    await storage.writeAtomic(asDocId("b"), "b {{include:c}}\n");
    await storage.writeAtomic(asDocId("c"), "c-body\n");
    const engine = createEngine({ storage, includeLimits: { maxDepth: 1 } });
    const result = await engine.projection<string>("a", "text", {});
    expect(result.output).toBe("a b {{include:c}}\n\n");
    expect(result.diagnostics.find((d) => d.code === "E_INCLUDE_LIMIT")?.nodeId).toBe("c");
  });

  it("admits includes breadth-first, so one deep include cannot starve its later siblings", async () => {
    const storage = createMemStorage();
    await doublingChain(storage, 12);
    await storage.writeAtomic(asDocId("legit"), "# L\n\nIMPORTANT NOTICE\n");
    await storage.writeAtomic(asDocId("board"), "# Board\n\n{{include:d0}}\n\n{{include:legit}}\n");
    const engine = createEngine({ storage });
    const result = await engine.projection<string>("board", "text", {});
    expect(result.output).toContain("IMPORTANT NOTICE");
    expect(result.diagnostics.map((d) => d.code)).toContain("E_INCLUDE_LIMIT");
    expect(result.versions).toHaveProperty("legit");
  });

  it("counts maxBytes in UTF-8 bytes", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(
      asDocId("board"),
      "# Board\n\n{{include:ascii}}\n\n{{include:cjk}}\n",
    );
    await storage.writeAtomic(asDocId("ascii"), `${"a".repeat(40)}\n`); // 41 bytes
    await storage.writeAtomic(asDocId("cjk"), `${"字".repeat(20)}\n`); // 20 chars, 61 bytes
    const engine = createEngine({ storage, includeLimits: { maxBytes: 100 } });
    const result = await engine.projection<string>("board", "text", {});
    expect(result.output).toContain("a".repeat(40));
    expect(result.output).toContain("{{include:cjk}}");
    expect(result.diagnostics.find((d) => d.code === "E_INCLUDE_LIMIT")?.message).toContain(
      "100 bytes of included content",
    );
  });

  it("rejects malformed includeLimits with a TypeError that says what is wrong", () => {
    const storage = createMemStorage();
    const make = (includeLimits: unknown) => () =>
      createEngine({ storage, includeLimits: includeLimits as never });
    expect(make(5)).toThrow(/includeLimits must be an object, got number/);
    expect(make(null)).toThrow(/includeLimits must be an object, got null/);
    expect(make({ maxNode: 5 })).toThrow(/unknown field "maxNode"/);
    expect(make({ maxNodes: "5" })).toThrow(/got a string \("5"\)/);
    expect(make({ maxDepth: -2 })).toThrow(/includeLimits\.maxDepth/);
    expect(make({ maxNodes: Infinity, maxBytes: 0, maxDepth: 0 })).not.toThrow();
  });

  it("costs each included slice of a large document its slice, not the whole document", async () => {
    // Six levels of doubling put 64 copies of a leaf that includes ten tiny
    // sections of a ~1 MB document: 640 slice nodes, each a few bytes, while
    // the document holds 20k source refs and ~600 KB of prose.
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("big"), bigDoc(20_000, 600_000));
    const leaf = `# a\n\n${Array.from({ length: 10 }, (_, i) => `{{include:big#s${i}}}`).join("\n\n")}\n`;
    await doublingChain(storage, 6, leaf);
    // ~1 MB: lift the document size limit so the document is parsed at all.
    const engine = createEngine({ storage, maxDocumentBytes: 4 * 1024 * 1024 });
    await engine.projection<string>("d0", "text", {}); // warm the parse cache

    const started = performance.now();
    const result = await engine.projection<string>("d0", "text", {});
    const elapsed = performance.now() - started;
    expect(result.diagnostics.map((d) => d.code)).not.toContain("E_INCLUDE_LIMIT");
    expect(result.output.split("> s0: x")).toHaveLength(65);
    expect(elapsed).toBeLessThan(1500);
  });

  it("reads and parses each include target once per resolution pass", async () => {
    const { storage, reads } = countingStorage();
    await storage.writeAtomic(asDocId("big"), bigDoc(0, 1_000_000));
    const board = `${Array.from({ length: 100 }, () => "{{include:big#s0}}").join("\n\n")}\n\n${Array.from({ length: 10 }, (_, i) => `{{include:big#s${i}}}`).join("\n\n")}\n`;
    await storage.writeAtomic(asDocId("board"), board);
    reads.clear();
    const parses = new Map<string, number>();
    const parse = (docId: DocId, src: string): ParsedDoc => {
      parses.set(docId, (parses.get(docId) ?? 0) + 1);
      return parseDoc(src);
    };

    const started = performance.now();
    // ~1 MB: lift the document size limit so the document is parsed at all.
    const link = await resolveIncludes(
      asDocId("board"),
      storage,
      {},
      {
        parse,
        maxDocumentBytes: 4 * 1024 * 1024,
      },
    );
    const elapsed = performance.now() - started;
    // The property under test, counted rather than timed: one read and one
    // parse per document, however many of the 110 includes name it.
    expect(Object.fromEntries(reads)).toEqual({ board: 1, big: 1 });
    expect(Object.fromEntries(parses)).toEqual({ board: 1, big: 1 });
    expect(link.includes.filter((e) => e.status === "duplicate")).toHaveLength(100);
    // A backstop only: parsing the ~1 MB document once takes about 1 s locally
    // and up to about 3 s on a shared CI runner. Re-parsing it per include
    // would take minutes.
    expect(elapsed).toBeLessThan(15_000);
  });

  it("projects a document with 200,000 references without throwing", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("many"), `# Many\n\n${"{{source:x}} ".repeat(200_000)}\n`);
    // 2.6 MB: lift the document size limit so the document is parsed at all.
    const engine = createEngine({ storage, maxDocumentBytes: Number.POSITIVE_INFINITY });
    const result = await engine.projection<string>("many", "text", {
      source: { resolve: async () => "V" },
    });
    expect(result.ok).toBe(true);
    expect(result.output.startsWith("# Many\n\nV V V")).toBe(true);
  }, 30_000);
});

describe("include expansion limit: an oversized include", () => {
  it("skips only the include that does not fit the byte budget and keeps admitting later ones", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(
      asDocId("board"),
      "# Board\n\n{{include:huge}}\n\n{{include:legit}}\n\n{{include:huge2}}\n\n{{include:tail}}\n",
    );
    await storage.writeAtomic(asDocId("huge"), `huge-body\n${"x".repeat(500)}\n`);
    await storage.writeAtomic(asDocId("huge2"), `huge2-body\n${"y".repeat(500)}\n`);
    await storage.writeAtomic(asDocId("legit"), "IMPORTANT NOTICE\n");
    await storage.writeAtomic(asDocId("tail"), "tail-body\n");
    const engine = createEngine({ storage, includeLimits: { maxBytes: 100 } });
    const result = await engine.projection<string>("board", "text", {});

    expect(result.output).toContain("{{include:huge}}");
    expect(result.output).not.toContain("huge-body");
    expect(result.output).toContain("IMPORTANT NOTICE");
    expect(result.output).toContain("{{include:huge2}}");
    expect(result.output).toContain("tail-body");
    const limit = result.diagnostics.filter((d) => d.code === "E_INCLUDE_LIMIT");
    expect(limit).toHaveLength(1);
    expect(limit[0]?.nodeId).toBe("huge");
    expect(limit[0]?.message).toContain("{{include:huge}} in board");
    expect(limit[0]?.message).toContain("100 bytes of included content");
    expect(limit[0]?.message).toContain("1 other include");
    expect(result.versions).toHaveProperty("legit");
    expect(result.versions).not.toHaveProperty("huge");
  });

  it("still stops at the node limit after skipping an oversized include", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(
      asDocId("board"),
      "{{include:huge}}\n\n{{include:one}}\n\n{{include:two}}\n",
    );
    await storage.writeAtomic(asDocId("huge"), `${"x".repeat(500)}\n`);
    await storage.writeAtomic(asDocId("one"), "one-body\n");
    await storage.writeAtomic(asDocId("two"), "two-body\n");
    const engine = createEngine({ storage, includeLimits: { maxBytes: 100, maxNodes: 1 } });
    const result = await engine.projection<string>("board", "text", {});

    expect(result.output).toContain("one-body");
    expect(result.output).toContain("{{include:two}}");
    const limit = result.diagnostics.filter((d) => d.code === "E_INCLUDE_LIMIT");
    expect(limit.map((d) => d.nodeId)).toEqual(["huge", "two"]);
  });
});
