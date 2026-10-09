import { describe, expect, it } from "vitest";
import { mdastOf, parseDoc } from "../parse/pipeline.js";
import {
  createParseCache,
  PARSE_CACHE_MAX_FAILURES,
  PARSE_CACHE_MAX_SOURCE_BYTES,
  PARSE_CACHE_MAX_TREE_SOURCE_BYTES,
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
  const docOf = (i: number, size: number): string => `# Doc ${i}\n\n${"x".repeat(size - 20)}\n`;
  const kept = (cache: ReturnType<typeof createParseCache>, src: string): boolean => {
    const hit = cache.peek(src);
    return hit !== undefined && mdastOf(hit.doc, src) !== undefined;
  };

  it("defaults to a 4 MiB tree budget", () => {
    expect(PARSE_CACHE_MAX_TREE_SOURCE_BYTES).toBe(4 * 1024 * 1024);
  });

  it("keeps the trees of the most recently used parses within the tree budget", () => {
    const cache = createParseCache((src) => parseDoc(src), {
      maxSourceBytes: 64 * 1024,
      maxTreeSourceBytes: 16 * 1024,
    });
    const docs = Array.from({ length: 6 }, (_, i) => docOf(i, 4 * 1024));
    for (const src of docs) {
      cache.parse(src);
      expect(cache.treeSourceBytes).toBeLessThanOrEqual(16 * 1024);
    }
    // Every parse stays cached; only the four most recent keep their tree.
    expect(cache.size).toBe(6);
    expect(docs.map((src) => kept(cache, src))).toEqual([false, false, true, true, true, true]);
  });

  it("counts a hit as a use, so a document read again keeps its tree", () => {
    const cache = createParseCache((src) => parseDoc(src), { maxTreeSourceBytes: 8 * 1024 });
    const [a, b, c] = [docOf(0, 4 * 1024), docOf(1, 4 * 1024), docOf(2, 4 * 1024)];
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
    expect(cache.treeSourceBytes).toBe(0);
  });

  it("caches a source larger than the tree budget without its tree", () => {
    const cache = createParseCache((src) => parseDoc(src), { maxTreeSourceBytes: 1024 });
    const src = docOf(0, 4 * 1024);
    const seeded = parseDoc(src);
    cache.seed(src, seeded);
    expect(cache.peek(src)?.doc).toBe(seeded);
    expect(mdastOf(seeded, src)).toBeUndefined();
    expect(cache.treeSourceBytes).toBe(0);
  });
});
