import type { Root } from "mdast";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editParagraph, generateBoard } from "../../test/markdown-gen.js";
import { type ChunkCache, createChunkCache } from "./chunks.js";

/** Every markdown parse run, by input. */
const parsed = vi.hoisted(() => [] as string[]);

vi.mock("./markdown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./markdown.js")>();
  return {
    parseMarkdown: (src: string): Root => {
      parsed.push(src);
      return actual.parseMarkdown(src);
    },
  };
});

const { parseMarkdown: whole } =
  await vi.importActual<typeof import("./markdown.js")>("./markdown.js");

function newCache(): ChunkCache {
  return createChunkCache({ maxEntries: 4096, maxNodes: 100_000, maxSourceBytes: 4 * 1024 * 1024 });
}

/** Parse `src` through `cache`, require the whole parse's tree, and return the parse's stats. */
function same(cache: ChunkCache, src: string): NonNullable<ChunkCache["last"]> {
  expect(cache.parse(src)).toStrictEqual(whole(src));
  return cache.last as NonNullable<ChunkCache["last"]>;
}

beforeEach(() => {
  parsed.length = 0;
});

describe("chunked parse", () => {
  it("parses each section once, then re-parses only the section a one-paragraph edit touches", () => {
    const cache = newCache();
    const doc = generateBoard(64 * 1024, 1);
    const first = same(cache, doc);
    expect(first.chunks).toBeGreaterThan(50);
    expect(first.parsed).toBe(first.chunks);
    expect(first.merges).toBe(0);

    const edited = editParagraph(doc, 0.5, 1);
    parsed.length = 0;
    const second = same(cache, edited);
    expect(second).toEqual({
      chunks: first.chunks,
      parsed: 1,
      parsedChars: parsed[0]?.length,
      reused: first.chunks - 1,
      merges: 0,
    });
    // The one parse is the edited section: it starts with its heading and holds the edit.
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatch(/^## /);
    expect(parsed[0]).toContain("Edited 1.");
    expect(edited).toContain(parsed[0]);
    expect((parsed[0] as string).length).toBeLessThan(edited.length / 20);
  });

  it("parses nothing for a source it has seen in pieces (a revert)", () => {
    const cache = newCache();
    const doc = generateBoard(16 * 1024, 2);
    same(cache, doc);
    same(cache, editParagraph(doc, 0.3, 1));
    parsed.length = 0;
    expect(same(cache, doc).parsed).toBe(0);
    expect(parsed).toEqual([]);
  });

  it("does not cut at a heading line inside a shell fence", () => {
    const cache = newCache();
    const doc = "# A\n\n```sh\n# comment\nls\n# more\n```\n\n# B\n\ntext\n";
    expect(same(cache, doc)).toMatchObject({ chunks: 2, parsed: 2, merges: 0 });
  });

  it("parses a source with no heading line whole, and does not keep it", () => {
    const cache = newCache();
    expect(same(cache, "just a paragraph\n\n- and a list\n")).toMatchObject({ whole: "single" });
    expect(cache.size).toBe(0);
  });

  describe("open leaf blocks merge with the next chunk", () => {
    it("an unclosed fence swallows the headings after it", () => {
      const cache = newCache();
      // The line scan already sees the fence: nothing is cut after it.
      expect(same(cache, "# A\n\n```\ncode\n\n# B\n\n## C\n\n# D\n\ntext\n")).toMatchObject({
        whole: "single",
      });
      // An unclosed fence in a list item, which the line scan does not see.
      expect(same(cache, "# A\n\n- ```\n  code\n# B\n\ntext\n").merges).toBeGreaterThan(0);
    });

    it("an unclosed fence nested in a list or a quote ends where the heading ends its container (regression)", () => {
      const cache = newCache();
      // Not swallowed, but the fence's end position differs from the chunk's end.
      for (const doc of [
        "# A\n\n- ```\n  code\n\n# B\n\ntext\n",
        "# A\n\n> ```\n> code\n# B\n\ntext\n",
        "# A\n\n> - ```\n>   code\n>\n# B\n",
        "# A\n\n1. x\n   > ~~~\n   > y\n\n\n# B\n",
      ]) {
        expect(same(cache, doc).merges).toBeGreaterThan(0);
      }
    });

    it("a content line that looks like a closing fence does not close it", () => {
      const cache = newCache();
      // In the list item, `> ```` is content, not the closing fence.
      expect(same(cache, "# A\n\n- ```\n  > ```\n# B\n\n```\n\n# C\n").merges).toBeGreaterThan(0);
      // Here it is the closing fence (inside the quote): nothing to merge.
      expect(same(cache, "# A\n\n> ```\n> code\n> ```\n\n# B\n").merges).toBe(0);
    });

    it("HTML blocks: kinds 1 to 5 until their end marker, kinds 6 and 7 until a blank line", () => {
      const cache = newCache();
      for (const doc of [
        "# A\n\n<script>\nlet x;\n# B\n</script>\n\n# C\n",
        "# A\n\n<!-- open\n# B\n-->\n# C\n",
        "# A\n\n<?php\n# B\n?>\n# C\n",
        "# A\n\n<!DOCTYPE\n# B\n>\n# C\n",
        "# A\n\n<![CDATA[\n# B\n]]>\n# C\n",
        "# A\n\n<div>\n# B\n\n# C\n",
        "# A\n\n<custom-tag>\n# B\n\n# C\n",
      ]) {
        expect(same(cache, doc).merges).toBeGreaterThan(0);
      }
      expect(same(cache, "# A\n\n<!-- closed -->\n# B\n\n<div>\n\n# C\n").merges).toBe(0);
    });

    it("a table without a blank line after it", () => {
      const cache = newCache();
      expect(same(cache, "# A\n\n| a |\n| - |\n| 1 |\n# B\n").merges).toBeGreaterThan(0);
    });

    it("grows a merge 1, 2, 4… chunks at a time", () => {
      const cache = newCache();
      const sections = Array.from({ length: 64 }, (_, i) => `## S${i}\n\ntext ${i}\n`).join("\n");
      const stats = same(cache, `# Top\n\n<!-- never closed\n${sections}`);
      // log2(64) attempts, not 64.
      expect(stats.merges).toBeLessThanOrEqual(8);
      expect(stats.parsedChars).toBeLessThan(3 * (sections.length + 12));
    });
  });

  describe("frontmatter", () => {
    it("never cuts inside it (regression)", () => {
      const cache = newCache();
      const stats = same(cache, "---\ntitle: x\n# not a heading\n---\n# H\n\ntext\n\n# I\n");
      expect(stats.chunks).toBe(3);
    });

    it("an edit that creates it re-cuts the source (regression)", () => {
      const cache = newCache();
      const before = "# A\n\ntext\n\n# B\n---\n\n# C\n";
      same(cache, before);
      const after = `---\n${before}`;
      const stats = same(cache, after);
      expect(stats.chunks).toBe(2);
    });

    it("an edit that ends it early or removes it", () => {
      const cache = newCache();
      const doc = "---\na: 1\n# x\nb: 2\n---\n\n# A\n";
      same(cache, doc);
      same(cache, doc.replace("b: 2", "---"));
      same(cache, doc.replace("---\na", "a"));
    });

    it("an opening fence that never closes changes the whole source: no cuts", () => {
      const cache = newCache();
      expect(same(cache, "---\n> quote\n\n# A\n\n003. item\n\n# B\n")).toMatchObject({
        whole: "single",
      });
    });

    it("after a byte order mark", () => {
      const cache = newCache();
      same(cache, "﻿---\ntitle: x\n# no\n---\n# A\n\ntext\n\n# B\n");
    });
  });

  it("offsets after a byte order mark, which the parser does not count", () => {
    const cache = newCache();
    expect(same(cache, "﻿# A\n\ntext\n\n# B\n\nmore\n").chunks).toBe(2);
    same(cache, "﻿# A\n\n```\nopen\n# B\n");
  });

  it("CRLF and CR line endings", () => {
    const cache = newCache();
    const doc = "# A\n\ntext\n\n## B\n\n- a\n- b\n\n# C\n";
    expect(same(cache, doc.replace(/\n/g, "\r\n")).chunks).toBe(3);
    expect(same(cache, doc.replace(/\n/g, "\r")).chunks).toBe(3);
  });

  describe("definitions are document-wide", () => {
    it("parses the whole source when a chunk uses a label another chunk defines", () => {
      const cache = newCache();
      expect(same(cache, "# A\n\nSee [spec].\n\n# Links\n\n[spec]: /s\n")).toMatchObject({
        whole: "definitions",
      });
      expect(same(cache, "# A\n\nNote[^1].\n\n# Notes\n\n[^1]: A note.\n")).toMatchObject({
        whole: "definitions",
      });
    });

    it("sees a footer of definitions in the text: one whole parse, no chunk parses", () => {
      const cache = newCache();
      const doc = "# A\n\nSee [spec].\n\n# B\n\nText.\n\n# Links\n\n[spec]: /s\n";
      parsed.length = 0;
      expect(same(cache, doc)).toMatchObject({ whole: "definitions", parsed: 1 });
      expect(parsed).toEqual([doc]);
      expect(cache.size).toBe(0);
    });

    it("catches after parsing a definition the text scan misses (in a list item)", () => {
      const cache = newCache();
      expect(same(cache, "# A\n\nSee [spec].\n\n# Links\n\n- [spec]: /s\n")).toMatchObject({
        whole: "definitions",
        parsed: 3,
      });
    });

    it("a label broken over block quote lines still counts as used", () => {
      const cache = newCache();
      expect(
        same(cache, "# A\n\n> See [the\n> Spec] here.\n\n# Links\n\n[THE  spec]: /s\n"),
      ).toMatchObject({ whole: "definitions" });
    });

    it("a long label spread over many quoted lines still counts as used", () => {
      const cache = newCache();
      const words = Array.from({ length: 180 }, (_, i) => `w${i}`);
      const quoted = words.join("\n> > > > ");
      const doc = `# A\n\n> > > > [${quoted}]\n\n# Links\n\n- [${words.join(" ")}]: /s\n`;
      expect(same(cache, doc).whole).toBe("definitions");
    });

    it("chunks whose labels are all their own are kept apart", () => {
      const cache = newCache();
      const stats = same(cache, "# A\n\n[a]\n\n[a]: /a\n\n# B\n\n[b]\n\n[b]: /b\n");
      expect(stats.whole).toBeUndefined();
      expect(stats.chunks).toBe(2);
    });
  });

  describe("budget", () => {
    it("counts the nodes and the source of the chunks it keeps", () => {
      const cache = newCache();
      const doc = "# A\n\none *two*\n\n# B\n\nthree\n";
      same(cache, doc);
      expect(cache.size).toBe(2);
      // root, heading, text, paragraph, text, emphasis, text; root, heading, text, paragraph, text.
      expect(cache.nodes).toBe(12);
      expect(cache.sourceBytes).toBe(doc.length);
    });

    it("keeps an open chunk that does not end the source without its tree", () => {
      const cache = newCache();
      const doc = "# A\n\n<div>\n# B\n\ntext\n";
      same(cache, doc);
      // "# A…" alone is open (one node, no tree); "# A…# B…" spans the source and is not kept.
      expect(cache.size).toBe(1);
      expect(cache.nodes).toBe(1);
    });

    it("stays within its node, source and entry bounds", () => {
      const cache = createChunkCache({ maxEntries: 5, maxNodes: 200, maxSourceBytes: 1000 });
      let doc = generateBoard(8 * 1024, 3);
      for (let i = 0; i < 10; i += 1) {
        doc = editParagraph(doc, i / 10, i);
        same(cache, doc);
        expect(cache.size).toBeLessThanOrEqual(5);
        expect(cache.nodes).toBeLessThanOrEqual(200);
        expect(cache.sourceBytes).toBeLessThanOrEqual(1000);
      }
      cache.clear();
      expect([cache.size, cache.nodes, cache.sourceBytes]).toEqual([0, 0, 0]);
    });

    it("hands out a copy: changing the tree changes nothing in the cache", () => {
      const cache = newCache();
      const tree = cache.parse("# A\n\ntext\n\n# B\n\nmore text\n");
      // The returned tree is a copy: changing it does not reach the cache.
      (tree.children[0] as { type: string }).type = "changed";
      expect(cache.parse("# A\n\ntext\n\n# B\n\nmore text\n").children[0]?.type).toBe("heading");
    });
  });
});
