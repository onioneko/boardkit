import { describe, expect, it } from "vitest";
import { parseDoc } from "../parse/pipeline.js";
import { createParseCache, PARSE_CACHE_MAX_SOURCE_BYTES } from "./parse-cache.js";

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
