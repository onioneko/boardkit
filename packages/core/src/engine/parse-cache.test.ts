import { describe, expect, it } from "vitest";
import { parseDoc } from "../parse/pipeline.js";
import {
  createParseCache,
  PARSE_CACHE_MAX_FAILURES,
  PARSE_CACHE_MAX_SOURCE_BYTES,
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
