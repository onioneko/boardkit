import { describe, expect, it } from "vitest";
import { generateBoard } from "../../test/markdown-gen.js";
import type { Section } from "../model/doc.js";
import { createChunkCache } from "../parse/chunks.js";
import type { ParseOptions } from "../parse/options.js";
import { bindChunkCache, parseDoc } from "../parse/pipeline.js";
import { type DocInfo, summarizeDoc } from "./doc-info.js";
import { findText, locateOffset, MAX_FIND_HITS, MAX_QUERY_BYTES } from "./doc-query.js";

const BOM = "﻿";
const options: ParseOptions = { blockTypes: new Set(["status"]) };

function infoOf(src: string, opts: ParseOptions = options): DocInfo {
  return summarizeDoc("d" as never, "v", parseDoc(src, opts));
}

function chunked(): ParseOptions {
  const bound: ParseOptions = { blockTypes: new Set(["status"]) };
  bindChunkCache(
    bound,
    createChunkCache({ maxEntries: 64, maxNodes: 1_000_000, maxSourceBytes: 4 << 20 }),
  );
  return bound;
}

interface Ref {
  readonly start: number;
  readonly end: number;
  readonly level: number;
  readonly parent: number | null;
}

/** Sections from ATX heading lines outside fences: the reference for span and parent. */
function reference(src: string): Ref[] {
  const heads: { start: number; level: number }[] = [];
  let fence: string | undefined;
  let offset = BOM_LEN(src);
  for (const line of src.slice(offset).split(/(?<=\n)/)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === undefined && f !== null) fence = (f[1] as string)[0];
    else if (fence !== undefined && f !== null && (f[1] as string)[0] === fence) fence = undefined;
    else if (fence === undefined) {
      const h = /^ {0,3}(#{1,6})(?: |\r?\n|$)/.exec(line);
      if (h !== null) heads.push({ start: offset, level: (h[1] as string).length });
    }
    offset += line.length;
  }
  return heads.map((h, i) => {
    let end = src.length;
    for (let j = i + 1; j < heads.length; j += 1) {
      if ((heads[j] as { level: number }).level <= h.level) {
        end = (heads[j] as { start: number }).start;
        break;
      }
    }
    let parent: number | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if ((heads[j] as { level: number }).level < h.level) {
        parent = j;
        break;
      }
    }
    return { start: h.start, end, level: h.level, parent };
  });
}

function BOM_LEN(src: string): number {
  return src.startsWith(BOM) ? 1 : 0;
}

/** Deepest section holding `offset` by brute force. */
function deepest(refs: readonly Ref[], offset: number): number | null {
  let best: number | null = null;
  for (const [i, r] of refs.entries()) {
    if (offset >= r.start && offset < r.end) best = i;
  }
  return best;
}

describe("docInfo spans and parents", () => {
  it("agrees with a reference computed from heading lines, whole and chunked", () => {
    for (const seed of [1, 2, 3]) {
      for (const eol of ["\n", "\r\n"] as const) {
        const src = generateBoard(40_000, seed, { eol });
        const refs = reference(src);
        expect(refs.length).toBeGreaterThan(10);
        for (const opts of [options, chunked()]) {
          const info = infoOf(src, opts);
          expect(
            info.sections.map((s) => ({ ...s.span, level: s.level, parent: s.parent })),
          ).toEqual(
            refs.map((r) => ({ start: r.start, end: r.end, level: r.level, parent: r.parent })),
          );
          for (let k = 0; k < 400; k += 1) {
            const at = Math.floor((k * src.length) / 400);
            expect(locateOffset(info, at).section).toBe(deepest(refs, at));
          }
        }
      }
    }
  });

  it("gives the same ParsedDoc fields through the chunked parse", () => {
    const src = generateBoard(30_000, 7);
    const sections = (o: ParseOptions): unknown =>
      parseDoc(src, o).nodes.map((n) =>
        "sectionId" in n ? { id: n.sectionId, span: n.span, anchored: n.anchored } : n,
      );
    expect(sections(chunked())).toEqual(sections(options));
  });

  it("covers setext, ATX, indented headings and skipped levels", () => {
    const src = "Intro\n\nTitle\n=====\n\ntext\n\n   ### Deep\n\nx\n\nSub\n---\n\n# Next\n";
    const info = infoOf(src);
    const want = [
      { h: "Title", level: 1, parent: null, from: "Title", to: "# Next" },
      { h: "Deep", level: 3, parent: 0, from: "### Deep", to: "Sub\n---" },
      { h: "Sub", level: 2, parent: 0, from: "Sub\n---", to: "# Next" },
      { h: "Next", level: 1, parent: null, from: "# Next", to: undefined },
    ];
    expect(info.sections.map((s) => [s.heading, s.level, s.parent])).toEqual(
      want.map((w) => [w.h, w.level, w.parent]),
    );
    for (const [i, w] of want.entries()) {
      const s = info.sections[i] as DocInfo["sections"][number];
      expect(s.span.start).toBe(src.indexOf(w.from));
      expect(s.span.end).toBe(w.to === undefined ? src.length : src.indexOf(w.to));
    }
  });

  it("keeps the preamble span as its content range on the parsed section", () => {
    const src = "---\ntitle: T\n---\nIntro\n\n# A\n";
    const pre = parseDoc(src).nodes.find(
      (n): n is Section => "sectionId" in n && n.sectionId === "__preamble__",
    );
    expect(pre?.span).toEqual({ start: src.indexOf("Intro") - 1, end: src.indexOf("# A") });
    expect(infoOf(src).sections.length).toBe(1);
    expect(infoOf(src).frontmatterSpan).toEqual({ start: 0, end: 16 });
  });

  it("marks anchored exactly for literal anchors and keeps repeats distinct", () => {
    const src =
      "# Same\n\n# Same\n\n# Same {#x}\n\n# Other {#x}\n\n# `code {#y}`\n\n# Esc \\{#z}\n";
    const info = infoOf(src);
    expect(info.sections.map((s) => [s.sectionId, s.anchored === true])).toEqual([
      ["same", false],
      ["same-1", false],
      ["x", true],
      ["x", true],
      ["code-y", false],
      ["esc-z", false],
    ]);
    expect(new Set(info.sections.map((s) => s.span.start)).size).toBe(6);
  });

  it("copies block spans and positions", () => {
    const src = "# A\n\n```status\nid: s1\nvalue: open\n```\n\nafter\n";
    const info = infoOf(src);
    expect(info.blocks).toHaveLength(1);
    const b = info.blocks[0] as DocInfo["blocks"][number];
    expect(src.slice(b.span?.start, b.span?.end)).toBe("```status\nid: s1\nvalue: open\n```");
    expect(b.position).toEqual({ line: 3, col: 1 });
    expect(locateOffset(info, (b.span?.start ?? 0) + 3)).toEqual({ section: 0, block: 0 });
    expect(locateOffset(info, src.length - 2).block).toBeNull();
  });
});

describe("BOM", () => {
  const body = "---\nt: 1\n---\n\nIntro word\n\n# One\n\nword here\n\n## Two\n\nword end\n";
  it("keeps spans, hits and positions in src coordinates", () => {
    const src = `${BOM}${body}`;
    const info = infoOf(src);
    for (const s of info.sections) {
      expect(src.slice(s.span.start).startsWith("#")).toBe(true);
    }
    const { hits } = findText(src, info, "word", { limit: 10 });
    expect(hits).toHaveLength(3);
    for (const h of hits) expect(src.slice(h.start, h.end)).toBe("word");
    const plain = findText(body, infoOf(body), "word", { limit: 10 });
    expect(hits.map((h) => h.position)).toEqual(plain.hits.map((h) => h.position));
    expect(hits.map((h) => h.section)).toEqual([null, 0, 1]);
  });
});

describe("findText", () => {
  const find = (src: string, q: string, o: Partial<{ limit: number; ignoreCase: boolean }> = {}) =>
    findText(src, infoOf(src), q, { limit: 10, ...o });

  it("matches CJK and NFD queries against NFC text, with exact offsets", () => {
    const src = "# 日程\n\n进度 café 风险\n";
    expect(find(src, "进度").hits[0]?.start).toBe(src.indexOf("进度"));
    const nfd = "cafe\u0301";
    const hit = find(src, nfd).hits[0];
    expect(hit && src.slice(hit.start, hit.end)).toBe("café");
  });

  it("folds case without shifting offsets", () => {
    const src = "# T\n\nÜBERBLICK und Überblick und straße\n";
    const hits = find(src, "überblick").hits;
    expect(hits.map((h) => src.slice(h.start, h.end))).toEqual(["ÜBERBLICK", "Überblick"]);
    expect(find(src, "Überblick", { ignoreCase: false }).hits).toHaveLength(1);
  });

  it("matches whitespace runs across line breaks, never overlaps, in order", () => {
    const src = "# T\n\nfoo \n\n  bar foo bar\naaaa\n";
    expect(find(src, "foo   bar").hits.map((h) => src.slice(h.start, h.end))).toEqual([
      "foo \n\n  bar",
      "foo bar",
    ]);
    expect(find(src, "aa").hits.map((h) => h.start)).toEqual([
      src.indexOf("aaaa"),
      src.indexOf("aaaa") + 2,
    ]);
  });

  it("gives no hits for empty or blank queries, and skips frontmatter", () => {
    const src = "---\ntitle: needle\n---\n\n# needle\n";
    expect(find(src, "").hits).toEqual([]);
    expect(find(src, " \n\t ").hits).toEqual([]);
    const hits = find(src, "needle").hits;
    expect(hits.map((h) => h.start)).toEqual([src.lastIndexOf("needle")]);
    expect(hits[0]?.section).toBe(0);
    expect(hits[0]?.position).toEqual({ line: 5, col: 3 });
  });

  it("treats the query literally", () => {
    const src = "# T\n\na.c abc a+c (x)\n";
    expect(find(src, "a.c").hits).toHaveLength(1);
    expect(find(src, "a+c").hits).toHaveLength(1);
    expect(find(src, "(x)").hits).toHaveLength(1);
  });

  it("caps hits at 25 and sets more after limit + 1 matches", () => {
    const src = `# T\n\n${"w ".repeat(100)}\n`;
    const info = infoOf(src);
    expect(findText(src, info, "w", { limit: 3 })).toMatchObject({ more: true });
    expect(findText(src, info, "w", { limit: 3 }).hits).toHaveLength(3);
    expect(findText(src, info, "w", { limit: 100 }).hits).toHaveLength(MAX_FIND_HITS);
    expect(findText(src, info, "w", { limit: 100 }).more).toBe(true);
    expect(findText("# T\n\nw w\n", infoOf("# T\n\nw w\n"), "w", { limit: 2 }).more).toBe(false);
  });

  it("bounds the query: a window, then graphemes, then bytes", () => {
    const long = "a".repeat(5000);
    const src = `# T\n\n${long}\n`;
    const hit = find(src, long).hits[0];
    expect(hit && hit.end - hit.start).toBeLessThanOrEqual(1024);
    const wide = "界".repeat(600);
    const src2 = `# T\n\n${wide}\n`;
    const h2 = find(src2, wide).hits[0];
    expect(h2).toBeDefined();
    expect(((h2?.end ?? 0) - (h2?.start ?? 0)) * 3).toBeLessThanOrEqual(MAX_QUERY_BYTES);
    const emoji = "👍🏽".repeat(300);
    const h3 = find(`# T\n\n${emoji}\n`, emoji).hits[0];
    expect(h3).toBeDefined();
    expect((h3?.end ?? 0) - (h3?.start ?? 0)).toBeLessThanOrEqual(256 * 4);
  });

  it("positions agree with line breaks of every kind", () => {
    const src = "# T\r\n\r\nx\ry\nz\r\nneedle\n";
    expect(find(src, "needle").hits[0]?.position).toEqual({ line: 6, col: 1 });
  });
});

describe("findText cost on a 256 KiB document", () => {
  /** CPU time of the best of three runs. */
  function cpu(fn: () => void): number {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i += 1) {
      const t = process.cpuUsage();
      for (let rep = 0; rep < 5; rep += 1) fn();
      const d = process.cpuUsage(t);
      best = Math.min(best, d.user + d.system);
    }
    return best;
  }

  /** Fake the section index so only the search is timed, not the parse. */
  function ratio(make: (n: number) => { src: string; query: string }): number {
    const run = (n: number): number => {
      const { src, query } = make(n);
      const info = infoOf(src);
      return cpu(() => {
        findText(src, info, query, { limit: 25 });
      });
    };
    run(16 * 1024);
    // Timing noise only ever inflates a ratio: the best of three is the signal.
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3 && best > 2.5; attempt += 1) {
      best = Math.min(best, run(128 * 1024) / Math.max(run(64 * 1024), 1));
    }
    return best;
  }

  it("scales at most linearly (doubling ratio) on an all-a document", () => {
    expect(
      ratio((n) => ({ src: `# T\n\n${"a".repeat(n)}\n`, query: `${"a".repeat(99)}b` })),
    ).toBeLessThanOrEqual(2.5);
  });

  it("scales at most linearly on long whitespace runs with many short tokens", () => {
    const query = Array.from({ length: 100 }, () => "ab").join(" ");
    expect(
      ratio((n) => ({
        src: `# T\n\n${"ab".concat(" ".repeat(60)).repeat(Math.floor(n / 62))}\n`,
        query,
      })),
    ).toBeLessThanOrEqual(2.5);
    expect(
      ratio((n) => ({ src: `# T\n\nab${" ".repeat(n)}ab\n`, query: "ab  ab ab" })),
    ).toBeLessThanOrEqual(2.5);
  });

  it("scales at most linearly on many headings and a frequent word", () => {
    expect(
      ratio((n) => ({ src: "# h word\n\nword\n\n".repeat(Math.floor(n / 16)), query: "zzz" })),
    ).toBeLessThanOrEqual(2.5);
  });

  it("finds 25 hits on a 256 KiB document quickly, positions and owners included", () => {
    const src = "# h word\n\nword\n\n".repeat(16 * 1024);
    expect(src.length).toBe(256 * 1024);
    const info = infoOf(src);
    const started = performance.now();
    const r = findText(src, info, "word", { limit: 25 });
    expect(r.hits).toHaveLength(25);
    expect(r.more).toBe(true);
    expect(performance.now() - started).toBeLessThan(1500);
    const miss = performance.now();
    expect(findText(src, info, "word zzz", { limit: 25 }).hits).toEqual([]);
    expect(performance.now() - miss).toBeLessThan(5000);
  });
});
