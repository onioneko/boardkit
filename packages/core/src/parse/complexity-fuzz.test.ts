import type { Nodes, Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPLEXITY_LIMITS, documentComplexityDiagnostic } from "./complexity.js";

/**
 * A seeded property test of the emphasis estimate: whatever input the scan
 * accepts must not nest emphasis deeper than `maxEmphasisDepth` once parsed
 * (and must parse). Inputs are short random units repeated on either side of
 * a middle, the shape that builds deep nesting.
 */

const processor = unified().use(remarkParse).use(remarkGfm);

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

const ALPHABET = ["*", "*", "_", "_", "~", "~", "a", " ", "(", ")", ".", "「"];

function unit(rand: () => number): string {
  const length = 1 + Math.floor(rand() * 6);
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return out;
}

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

function parsedDepth(src: string): number | string {
  try {
    return emphasisDepth(processor.parse(src));
  } catch (err) {
    return String(err);
  }
}

const limit = DEFAULT_COMPLEXITY_LIMITS.maxEmphasisDepth;
const accepts = (src: string): boolean =>
  documentComplexityDiagnostic("d", src, DEFAULT_COMPLEXITY_LIMITS, "write") === undefined;

describe("maxEmphasisDepth is an upper bound on parsed emphasis nesting", () => {
  it("holds for shapes found by the review", () => {
    const pairs: [string, string][] = [
      [" ~~a*_", "**(*_~~"],
      ["** _a", "a_*a"],
      ["~~a***_", "_)_~~)"],
      ["**a****", "*._*"],
      ["*a _b ", " b_ a*"],
    ];
    for (const [open, close] of pairs) {
      const src = `${open.repeat(150)}x${close.repeat(150)}\n`;
      if (accepts(src)) {
        const depth = parsedDepth(src);
        expect({ open, close, ok: typeof depth === "number" && depth <= limit }).toEqual({
          open,
          close,
          ok: true,
        });
      }
    }
  });

  it("holds for seeded random unit pairs", () => {
    const rand = prng(0x5eed);
    let accepted = 0;
    let refused = 0;
    const violations: { open: string; close: string; depth: number | string }[] = [];
    for (let sample = 0; sample < 600; sample += 1) {
      const open = unit(rand);
      const close = unit(rand);
      const src = `${open.repeat(150)}x${close.repeat(150)}\n`;
      if (!accepts(src)) {
        refused += 1;
        continue;
      }
      accepted += 1;
      const depth = parsedDepth(src);
      if (typeof depth !== "number" || depth > limit) violations.push({ open, close, depth });
    }
    expect(violations).toEqual([]);
    // The sample exercises both sides of the limit.
    expect(accepted).toBeGreaterThan(20);
    expect(refused).toBeGreaterThan(50);
  }, 30_000);
});
