import { describe, expect, it } from "vitest";
import type { ParseOptions } from "../parse/options.js";
import { bindChunkCache, mdastNodeCount, mdastOf, parseDoc } from "../parse/pipeline.js";
import {
  createParseCache,
  PARSE_CACHE_MAX_CHUNK_NODES,
  PARSE_CACHE_MAX_CHUNK_SOURCE_BYTES,
  PARSE_CACHE_MAX_CHUNKS,
  PARSE_CACHE_MAX_FAILURES,
  PARSE_CACHE_MAX_SOURCE_BYTES,
  PARSE_CACHE_MAX_TREE_NODES,
} from "./parse-cache.js";
import { docVersion } from "./version.js";

describe("parse cache", () => {
  it("holds at most its source-byte budget however many documents pass through it", () => {
    const budget = 64 * 1024;
    const cache = createParseCache((src) => parseDoc(src), { maxSourceBytes: budget });
    const docSize = 8 * 1024;
    for (let i = 0; i < (2 * budget) / docSize; i += 1) {
      cache.parse(`# Doc ${i}\n\n${"x".repeat(docSize - 20)}\n`);
      expect(cache.sourceBytes).toBeLessThanOrEqual(budget);
    }
    expect(cache.sourceBytes).toBeGreaterThan(budget / 2);
    expect(cache.size).toBeLessThanOrEqual(budget / docSize);
  });

  it("parses one content once and returns the same parse", () => {
    let parses = 0;
    const cache = createParseCache((src) => {
      parses += 1;
      return parseDoc(src);
    });
    const first = cache.parse("# A\n");
    const second = cache.parse("# A\n");
    expect(second.doc).toBe(first.doc);
    expect(second.hash).toBe(first.hash);
    expect(parses).toBe(1);
  });

  it("defaults to a 16 MiB source budget", () => {
    expect(PARSE_CACHE_MAX_SOURCE_BYTES).toBe(16 * 1024 * 1024);
  });
});

describe("parse cache: failures", () => {
  function failing() {
    const calls: string[] = [];
    const cache = createParseCache((src) => {
      calls.push(src);
      if (src.includes("BOOM")) throw new RangeError("Maximum call stack size exceeded");
      return parseDoc(src);
    });
    return { cache, calls };
  }

  it("remembers a parse that threw and rethrows it without parsing again", () => {
    const { cache, calls } = failing();
    const first = (() => {
      try {
        cache.parse("# BOOM\n");
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(first).toBeInstanceOf(RangeError);
    expect(() => cache.parse("# BOOM\n")).toThrow(first as Error);
    expect(() => cache.parse("# BOOM\n")).toThrow("Maximum call stack");
    expect(calls).toEqual(["# BOOM\n"]);
    expect(cache.size).toBe(0);
    // Other content still parses.
    cache.parse("# fine\n");
    expect(calls).toEqual(["# BOOM\n", "# fine\n"]);
  });

  it("forgets failures on delete and clear", () => {
    const { cache, calls } = failing();
    expect(() => cache.parse("# BOOM\n")).toThrow();
    const hash = docVersion("# BOOM\n");
    cache.delete(hash);
    expect(() => cache.parse("# BOOM\n")).toThrow();
    cache.clear();
    expect(() => cache.parse("# BOOM\n")).toThrow();
    expect(calls.length).toBe(3);
  });

  it("keeps a bounded number of failures", () => {
    const { cache, calls } = failing();
    for (let i = 0; i < PARSE_CACHE_MAX_FAILURES + 10; i += 1) {
      expect(() => cache.parse(`# BOOM ${i}\n`)).toThrow();
    }
    // The oldest failure was evicted, so it is parsed again.
    expect(() => cache.parse("# BOOM 0\n")).toThrow();
    expect(calls.length).toBe(PARSE_CACHE_MAX_FAILURES + 11);
  });
});

describe("parse cache: peek and seed", () => {
  it("peek returns a cached parse without parsing, and nothing on a miss", () => {
    let parses = 0;
    const cache = createParseCache((src) => {
      parses += 1;
      return parseDoc(src);
    });
    expect(cache.peek("# A\n")).toBeUndefined();
    const first = cache.parse("# A\n");
    expect(cache.peek("# A\n")).toEqual(first);
    expect(parses).toBe(1);
  });

  it("seed caches a parse made elsewhere, frozen, so parse does not parse again", () => {
    let parses = 0;
    const cache = createParseCache((src) => {
      parses += 1;
      return parseDoc(src);
    });
    const src = "# A\n\n```t\nid: b\nitems: [1]\n```\n";
    const doc = parseDoc(src, { blockTypes: new Set(["t"]) });
    const hash = cache.seed(src, doc);
    expect(hash).toBe(docVersion(src));
    expect(cache.parse(src).doc).toBe(doc);
    expect(parses).toBe(0);
    const block = doc.nodes.find((n) => "blockId" in n);
    expect(block !== undefined && "attrs" in block && Object.isFrozen(block.attrs)).toBe(true);
  });

  it("seed replaces a remembered failure for the same content", () => {
    const cache = createParseCache(() => {
      throw new RangeError("boom");
    });
    expect(() => cache.parse("# A\n")).toThrow("boom");
    expect(cache.peek("# A\n")).toBeUndefined();
    const doc = parseDoc("# A\n");
    cache.seed("# A\n", doc);
    expect(cache.parse("# A\n").doc).toBe(doc);
  });
});

describe("parse cache: mdast trees", () => {
  // Five mdast nodes each: root, heading and its text, paragraph and its text.
  const docOf = (i: number, size = 64): string => `# Doc ${i}\n\n${"x".repeat(size)}\n`;
  const kept = (cache: ReturnType<typeof createParseCache>, src: string): boolean => {
    const hit = cache.peek(src);
    return hit !== undefined && mdastOf(hit.doc, src) !== undefined;
  };

  it("defaults to a budget of 200,000 tree nodes", () => {
    expect(PARSE_CACHE_MAX_TREE_NODES).toBe(200_000);
  });

  it("counts a tree by its nodes, however long its source", () => {
    expect(mdastNodeCount(parseDoc(docOf(0)))).toBe(5);
    expect(mdastNodeCount(parseDoc(docOf(0, 100_000)))).toBe(5);
    expect(mdastNodeCount(parseDoc("- a\n- b\n"))).toBe(8);
  });

  it("keeps the trees of the most recently used parses within the node budget", () => {
    const cache = createParseCache((src) => parseDoc(src), { maxTreeNodes: 20 });
    const docs = Array.from({ length: 6 }, (_, i) => docOf(i));
    for (const src of docs) {
      cache.parse(src);
      expect(cache.treeNodes).toBeLessThanOrEqual(20);
    }
    // Every parse stays cached; only the four most recent keep their tree.
    expect(cache.size).toBe(6);
    expect(cache.treeNodes).toBe(20);
    expect(docs.map((src) => kept(cache, src))).toEqual([false, false, true, true, true, true]);
  });

  it("charges a tree its nodes, not its source: one long document fits beside small ones", () => {
    const cache = createParseCache((src) => parseDoc(src), { maxTreeNodes: 15 });
    const [long, a, b] = [docOf(0, 200_000), docOf(1), docOf(2)];
    for (const src of [long, a, b]) cache.parse(src);
    expect([long, a, b].map((src) => kept(cache, src))).toEqual([true, true, true]);
  });

  it("counts a hit as a use, so a document read again keeps its tree", () => {
    const cache = createParseCache((src) => parseDoc(src), { maxTreeNodes: 10 });
    const [a, b, c] = [docOf(0), docOf(1), docOf(2)];
    cache.parse(a);
    cache.parse(b);
    cache.parse(a); // a is now the most recent
    cache.parse(c);
    expect([a, b, c].map((src) => kept(cache, src))).toEqual([true, false, true]);
  });

  it("releases the tree of a parse that leaves the cache", () => {
    const cache = createParseCache((src) => parseDoc(src), { maxSourceBytes: 8 * 1024 });
    const first = cache.parse(docOf(0, 4 * 1024)).doc;
    const second = cache.parse(docOf(1, 4 * 1024));
    cache.parse(docOf(2, 4 * 1024)); // evicts the first
    expect(mdastOf(first, docOf(0, 4 * 1024))).toBeUndefined();
    cache.delete(second.hash);
    expect(mdastOf(second.doc, docOf(1, 4 * 1024))).toBeUndefined();
    const third = cache.peek(docOf(2, 4 * 1024));
    expect(third).toBeDefined();
    cache.clear();
    expect(mdastOf(third?.doc ?? parseDoc(""), docOf(2, 4 * 1024))).toBeUndefined();
    expect(cache.treeNodes).toBe(0);
  });

  it("caches a parse whose tree is larger than the whole budget without its tree", () => {
    const cache = createParseCache((src) => parseDoc(src), { maxTreeNodes: 4 });
    const src = docOf(0);
    const seeded = parseDoc(src);
    cache.seed(src, seeded);
    expect(cache.peek(src)?.doc).toBe(seeded);
    expect(mdastOf(seeded, src)).toBeUndefined();
    expect(cache.treeNodes).toBe(0);
  });
});

describe("parse cache: chunks (#43)", () => {
  /** A cache whose parse goes through its chunks, as the engine wires it. */
  function chunked(opts: Parameters<typeof createParseCache>[1] = {}) {
    const options: ParseOptions = {};
    const cache = createParseCache((src) => parseDoc(src, options), opts);
    bindChunkCache(options, cache.chunks);
    return cache;
  }

  const doc = (edit: string) => `# A\n\nOne ${edit}.\n\n## B\n\nTwo *b*.\n\n## C\n\nThree.\n`;

  it("defaults to 8,192 chunks, 100,000 nodes and 4 MiB of source", () => {
    expect(PARSE_CACHE_MAX_CHUNKS).toBe(8192);
    expect(PARSE_CACHE_MAX_CHUNK_NODES).toBe(100_000);
    expect(PARSE_CACHE_MAX_CHUNK_SOURCE_BYTES).toBe(4 * 1024 * 1024);
  });

  it("parses an edited document through the chunks of the version before it", () => {
    const cache = chunked();
    const before = cache.parse(doc("x")).doc;
    expect(cache.chunks.last).toMatchObject({ chunks: 3, parsed: 3 });
    const after = cache.parse(doc("y")).doc;
    expect(cache.chunks.last).toMatchObject({ chunks: 3, parsed: 1, reused: 2 });
    // Same parse as without chunks, tree included.
    expect(after).toEqual(parseDoc(doc("y")));
    expect(mdastOf(after, doc("y"))).toEqual(mdastOf(parseDoc(doc("y")), doc("y")));
    expect(before.nodes).toHaveLength(3);
  });

  it("counts the chunks' nodes and source, apart from the whole parses' trees", () => {
    const cache = chunked();
    cache.parse(doc("x"));
    // Root, heading, text, paragraph and text per section; B's paragraph has
    // three more ("Two ", emphasis and its text, ".").
    expect(cache.chunks.nodes).toBe(18);
    expect(cache.chunks.sourceBytes).toBe(doc("x").length);
    expect(cache.treeNodes).toBe(mdastNodeCount(cache.parse(doc("x")).doc));
  });

  it("bounds the chunks by its chunk budgets", () => {
    const cache = chunked({ maxChunks: 2, maxChunkNodes: 8, maxChunkSourceBytes: 40 });
    for (let i = 0; i < 5; i += 1) {
      cache.parse(doc(String(i)));
      expect(cache.chunks.size).toBeLessThanOrEqual(2);
      expect(cache.chunks.nodes).toBeLessThanOrEqual(8);
      expect(cache.chunks.sourceBytes).toBeLessThanOrEqual(40);
    }
  });

  it("drops the chunks on clear", () => {
    const cache = chunked();
    cache.parse(doc("x"));
    cache.clear();
    expect([cache.chunks.size, cache.chunks.nodes, cache.chunks.sourceBytes]).toEqual([0, 0, 0]);
  });

  it("a parse with other options does not use the chunks", () => {
    const cache = chunked();
    parseDoc(doc("x"));
    parseDoc(doc("x"), {});
    expect(cache.chunks.size).toBe(0);
  });
});
