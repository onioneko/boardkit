import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { tests as specExamples, text as specText } from "commonmark-spec";
import type { Root } from "mdast";
import { beforeAll, describe, expect, it } from "vitest";
import { DANGEROUS, generateBoard, mutate, rng } from "../../test/markdown-gen.js";
import { type ChunkCache, type ChunkCacheOptions, createChunkCache } from "./chunks.js";
import { parseMarkdown } from "./markdown.js";

/**
 * Differential test of the chunked parse: on every document and every edit
 * it must give exactly the tree one whole parse gives, positions included.
 *
 * CI runs a deterministic sample. The full run (more edits per document,
 * larger documents, more generated ones, and optionally an external corpus of
 * recorded `parseDoc` inputs, one JSON string per line, at
 * `BOARDKIT_PARSE_CORPUS`) is `pnpm --filter @onioneko/boardkit-core
 * test:differential`. Run it after upgrading the markdown parser packages.
 */
const FULL = process.env.BOARDKIT_PARSE_DIFFERENTIAL === "full";
const scale = (ci: number, full: number): number => (FULL ? full : ci);

const TIMEOUT = FULL ? 3_600_000 : 120_000;

/** A whole parse, or `undefined` when the parser itself throws (stack overflow): nothing to compare. */
function wholeParse(src: string): Root | undefined {
  try {
    return parseMarkdown(src);
  } catch {
    return undefined;
  }
}

const tally = { compared: 0, definitions: 0, merges: 0 };

/** Parse `src` through `cache` and require the whole parse's tree. */
function check(label: string, cache: ChunkCache, src: string): boolean {
  const expected = wholeParse(src);
  if (expected === undefined) return false;
  const actual = cache.parse(src);
  tally.compared += 1;
  if (cache.last?.whole === "definitions") tally.definitions += 1;
  tally.merges += cache.last?.merges ?? 0;
  if (!isDeepStrictEqual(actual, expected)) {
    const at = expected.children.findIndex((c, i) => !isDeepStrictEqual(c, actual.children[i]));
    throw new Error(
      [
        `${label}: chunked parse differs from the whole parse at top-level child ${at}`,
        `source: ${JSON.stringify(src.length > 600 ? `${src.slice(0, 600)}…` : src)}`,
        `stats: ${JSON.stringify(cache.last)}`,
        `expected: ${JSON.stringify(expected.children[at] ?? expected.position)?.slice(0, 800)}`,
        `actual:   ${JSON.stringify(actual.children[at] ?? actual.position)?.slice(0, 800)}`,
      ].join("\n"),
    );
  }
  return true;
}

/** Check `src` and `edits` random edits of it, each applied to the previous version. */
function checkEdits(
  label: string,
  cache: ChunkCache,
  src: string,
  edits: number,
  r: () => number,
): void {
  let current = src;
  if (!check(label, cache, current)) return;
  for (let v = 0; v < edits; v += 1) {
    current = mutate(current, r);
    check(`${label}.v${v}`, cache, current);
  }
}

/** The cut mode under test: see {@link ChunkCacheOptions.fenceScan}. */
let fenceScan = true;

function newCache(): ChunkCache {
  return createChunkCache({
    maxEntries: 4096,
    maxNodes: 400_000,
    maxSourceBytes: 8 * 1024 * 1024,
    fenceScan,
  });
}

const corpus: string[] = readFileSync(
  new URL("../../test/fixtures/parse-corpus.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as string);
const external = process.env.BOARDKIT_PARSE_CORPUS;
if (external !== undefined) {
  for (const line of readFileSync(external, "utf8").split("\n")) {
    if (line.length > 0) corpus.push(JSON.parse(line) as string);
  }
}

const examples = specExamples.map((e) => e.markdown.replace(/→/g, "\t"));

// With the line scan for fences, and without it: cutting at every heading
// line makes merging open chunks do the work the scan otherwise saves.
describe.each([
  { mode: "skipping heading lines in fences", scan: true },
  { mode: "cutting at every heading line", scan: false },
])("chunked parse equals one whole parse, positions included ($mode)", ({ scan }) => {
  beforeAll(() => {
    fenceScan = scan;
  });

  it(
    "recorded parse inputs, each with random edits",
    () => {
      const cache = newCache();
      const r = rng(7);
      for (const [i, doc] of corpus.entries())
        checkEdits(`corpus#${i}`, cache, doc, scale(3, 8), r);
      expect(tally.compared).toBeGreaterThan(corpus.length);
    },
    TIMEOUT,
  );

  it(
    "every CommonMark example, alone and stitched together with headings",
    () => {
      const cache = newCache();
      for (const [i, example] of examples.entries()) check(`spec#${i + 1}`, cache, example);
      const r = rng(11);
      for (let g = 0; g < scale(200, 2000); g += 1) {
        let doc = "";
        const n = 2 + Math.floor(r() * 6);
        for (let k = 0; k < n; k += 1) {
          const example = examples[Math.floor(r() * examples.length)] as string;
          const heading = r() < 0.5 ? `## part ${k}\n` : `\n# part ${k}\n\n`;
          doc += (k === 0 ? "" : heading) + example;
        }
        checkEdits(`stitched#${g}`, cache, doc, 4, r);
      }
    },
    TIMEOUT,
  );

  it(
    "the CommonMark spec's own source (long, with long fences), with random edits",
    () => {
      checkEdits("spec.txt", newCache(), specText, scale(2, 40), rng(5));
    },
    TIMEOUT,
  );

  it(
    "generated boards with random dangerous edits, LF, CRLF and CR",
    () => {
      const r = rng(3);
      for (let seed = 1; seed <= scale(4, 24); seed += 1) {
        const eol = seed % 3 === 1 ? "\n" : seed % 3 === 2 ? "\r\n" : "\r";
        const doc = generateBoard(scale(12, 48) * 1024, seed, {
          eol,
          ...(seed % 4 === 0 ? { footerDefinitions: 0.1 } : {}),
        });
        checkEdits(`board${seed}`, newCache(), doc, scale(30, 200), r);
      }
    },
    TIMEOUT,
  );

  it(
    "seeded random documents built from dangerous fragments",
    () => {
      const cache = newCache();
      const fragments = [
        ...DANGEROUS,
        "# Title\n",
        "## Section\n\nSome text.\n\n",
        "- item\n  ```\n  code\n",
        "> quote\n> ```\n> # not a heading\n",
        "<div>\nhtml\n",
        "| a | b |\n| - | - |\n| 1 | 2 |\n",
        "[spec-3]: /target\n",
        "See [spec-3] and [^1].\n\n",
        "[^1]: Footnote\n    continued\n",
        "    indented code\n",
        "Setext\n---\n",
        "1. one\n2. two\n",
        "~~~ \n# inside\n~~~\n",
        "\n",
      ];
      const r = rng(13);
      for (let d = 0; d < scale(400, 20_000); d += 1) {
        let doc = "";
        const n = 3 + Math.floor(r() * 14);
        for (let k = 0; k < n; k += 1)
          doc += fragments[Math.floor(r() * fragments.length)] as string;
        checkEdits(`random#${d}`, cache, doc, 3, r);
      }
    },
    TIMEOUT,
  );

  it("a small cache evicting chunks gives the same trees", () => {
    const cache = createChunkCache({ maxEntries: 8, maxNodes: 300, maxSourceBytes: 2048 });
    checkEdits(
      "evicting",
      cache,
      generateBoard(16 * 1024, 2, { eol: "\r\n" }),
      scale(30, 300),
      rng(17),
    );
    expect(cache.nodes).toBeLessThanOrEqual(300);
    expect(cache.sourceBytes).toBeLessThanOrEqual(2048);
    expect(cache.size).toBeLessThanOrEqual(8);
  });

  it("reports what it compared", () => {
    // Visible in the full run's output: how often the fallbacks fire.
    if (FULL) console.log("chunked parse differential", tally);
    expect(tally.compared).toBeGreaterThan(0);
  });
});
