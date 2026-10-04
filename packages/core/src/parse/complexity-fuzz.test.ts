import type { Nodes, Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import {
  type ComplexityLimits,
  DEFAULT_COMPLEXITY_LIMITS,
  documentComplexityDiagnostic,
  fencedCodeLines,
} from "./complexity.js";

/**
 * Seeded property tests of the scan against the parser it models (the same
 * remark pipeline `parseDoc` runs):
 * - whatever input the scan accepts must parse, and must not nest emphasis
 *   deeper than `maxEmphasisDepth`;
 * - every line the scan skips as fenced code must be code to the parser too,
 *   so a fence-like line can never hide prose from the scan.
 * A small emphasis limit (6) stresses the bound with short, fast inputs.
 */

const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);

/** mulberry32: a small deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

const ALPHABET = ["*", "*", "_", "_", "~", "~", "a", " ", "(", ")", ".", "「"];

function unit(rand: () => number): string {
  const length = 1 + Math.floor(rand() * 6);
  let out = "";
  for (let i = 0; i < length; i += 1) out += pick(rand, ALPHABET);
  return out;
}

/** Lines that open, close, continue or imitate fences and the blocks around them. */
const FENCE_LINES = [
  "```",
  "````",
  "~~~",
  "~~~~",
  "``` js",
  "```a`b",
  "~~~ a`b",
  " ```",
  "  ```",
  "   ```",
  "    ```",
  "\t```",
  "> ```",
  "> ````",
  ">```",
  "> > ```",
  ">  ```",
  " > ```",
  "> ~~~",
  ">\t```",
  "> \t```",
  "- ```",
  "  - ```",
  "1. ```",
  "[^a]: ```",
  "<!--",
  "-->",
  "<div>",
  "</div>",
  "",
  " ",
  ">",
  "> ",
  "> >",
  "---",
  '[a]: /u "',
  '"',
  "| a | b |",
  "|---|---|",
  "text",
  "> text",
  "- item",
  "  code",
  "    code",
  "\tcode",
  ">\tcode",
  "   > code",
  "    > code",
  "    >",
  " \t> code",
  "> > code",
];

/** Deepest chain of emphasis, strong and delete nodes, walked without recursion. */
function emphasisDepth(root: Root): number {
  let deepest = 0;
  const stack: { node: Nodes; depth: number }[] = [{ node: root, depth: 0 }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node } = item;
    const nested = node.type === "emphasis" || node.type === "strong" || node.type === "delete";
    const depth = item.depth + (nested ? 1 : 0);
    if (depth > deepest) deepest = depth;
    if ("children" in node) for (const child of node.children) stack.push({ node: child, depth });
  }
  return deepest;
}

/** The 1-based lines covered by a code node (fenced or indented). */
function codeLines(root: Root): Set<number> {
  const lines = new Set<number>();
  const stack: Nodes[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === "code" && node.position !== undefined) {
      for (let l = node.position.start.line; l <= node.position.end.line; l += 1) lines.add(l);
    }
    if ("children" in node) for (const child of node.children) stack.push(child);
  }
  return lines;
}

function parsedDepth(src: string): number | string {
  try {
    return emphasisDepth(processor.parse(src));
  } catch (err) {
    return String(err);
  }
}

const stress: Required<ComplexityLimits> = { ...DEFAULT_COMPLEXITY_LIMITS, maxEmphasisDepth: 6 };
const accepts = (src: string, limits: Required<ComplexityLimits>): boolean =>
  documentComplexityDiagnostic("d", src, limits, "write") === undefined;

/** Check that every input the scan accepts parses no deeper than the limit. */
function boundViolations(
  inputs: readonly string[],
  limits: Required<ComplexityLimits>,
): { accepted: number; refused: number; violations: { src: string; depth: number | string }[] } {
  let accepted = 0;
  let refused = 0;
  const violations: { src: string; depth: number | string }[] = [];
  for (const src of inputs) {
    if (!accepts(src, limits)) {
      refused += 1;
      continue;
    }
    accepted += 1;
    const depth = parsedDepth(src);
    if (typeof depth !== "number" || depth > limits.maxEmphasisDepth) {
      violations.push({ src, depth });
    }
  }
  return { accepted, refused, violations };
}

describe("maxEmphasisDepth is an upper bound on parsed emphasis nesting", () => {
  it("holds at the default limit for shapes found by the review", () => {
    const pairs: [string, string][] = [
      [" ~~a*_", "**(*_~~"],
      ["** _a", "a_*a"],
      ["~~a***_", "_)_~~)"],
      ["**a****", "*._*"],
      ["*a _b ", " b_ a*"],
      ["(~~ ~", " a~"],
    ];
    const inputs = pairs.map(([open, close]) => `${open.repeat(300)}x${close.repeat(300)}\n`);
    expect(boundViolations(inputs, DEFAULT_COMPLEXITY_LIMITS).violations).toEqual([]);
  });

  it("holds for seeded random unit pairs, unfenced and between fences", () => {
    const rand = prng(0x5eed);
    const inputs: string[] = [];
    for (let sample = 0; sample < 1500; sample += 1) {
      const repeat = 4 + Math.floor(rand() * 20);
      const body = `${unit(rand).repeat(repeat)}x${unit(rand).repeat(repeat)}\n`;
      if (rand() < 0.5) inputs.push(body);
      else {
        // Fence-like lines around and inside the body: whatever the scan
        // skips, the nesting it still counts must bound the parse.
        const before = `${pick(rand, FENCE_LINES)}\n${pick(rand, FENCE_LINES)}\n`;
        const after = `${pick(rand, FENCE_LINES)}\n`;
        const split = Math.floor(body.length / 2);
        const middle = pick(rand, FENCE_LINES);
        inputs.push(
          `${before}${body.slice(0, split)}\n${middle}\n${body.slice(split)}${after}${body}`,
        );
      }
    }
    const { accepted, refused, violations } = boundViolations(inputs, stress);
    expect(violations).toEqual([]);
    // The sample exercises both sides of the limit.
    expect(accepted).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(100);
  }, 30_000);
});

describe("fenced-code skipping agrees with the parser", () => {
  it("only skips lines the parser reads as code", () => {
    const rand = prng(0xf3ce);
    const mismatches: { src: string; line: number }[] = [];
    let skipped = 0;
    for (let sample = 0; sample < 3000; sample += 1) {
      const lines: string[] = [];
      if (rand() < 0.15) lines.push("---");
      const count = 3 + Math.floor(rand() * 18);
      for (let i = 0; i < count; i += 1) {
        lines.push(rand() < 0.75 ? pick(rand, FENCE_LINES) : `*a ${unit(rand)}`);
      }
      const src = `${lines.join(rand() < 0.1 ? "\r\n" : "\n")}\n`;
      const flags = fencedCodeLines(src);
      const code = codeLines(processor.parse(src));
      flags.forEach((flag, index) => {
        if (flag === 0) return;
        skipped += 1;
        if (!code.has(index + 1)) mismatches.push({ src, line: index + 1 });
      });
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    // The sample does exercise skipping.
    expect(skipped).toBeGreaterThan(1000);
  }, 30_000);
});
