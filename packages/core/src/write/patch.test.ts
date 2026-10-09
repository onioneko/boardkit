import { describe, expect, it, vi } from "vitest";
import { Document, parseDocument } from "yaml";
import { parseDoc } from "../parse/pipeline.js";
import { applyPatch } from "./patch.js";

const src = `# T

\`\`\`status
id: d1
value: pending
note: keep me   # comment stays
\`\`\`

after text
`;

function blockOf(srcText: string, blockTypes: ReadonlySet<string>) {
  const doc = parseDoc(srcText, { blockTypes });
  const block = doc.nodes.find((n) => "blockId" in n);
  if (block === undefined || !("blockId" in block)) throw new Error("no block");
  return block;
}

describe("applyPatch", () => {
  it("changes only the target values; every other byte is preserved", () => {
    const block = blockOf(src, new Set(["status"]));
    const result = applyPatch({ src, block, delta: { value: "approved" } });
    expect(result.diagnostics).toEqual([]);
    expect(result.src).toContain("value: approved");
    // Comments and untouched keys survive (yaml CST may normalize whitespace padding).
    expect(result.src).toContain("note: keep me");
    expect(result.src).toContain("# comment stays");
    expect(result.src).toContain("id: d1");
    expect(result.src).toContain("# T");
    expect(result.src).toContain("after text");
    // Fence lines intact.
    expect(result.src.match(/```/g)).toHaveLength(2);
  });

  it("adds missing keys at the top level", () => {
    const block = blockOf(src, new Set(["status"]));
    const result = applyPatch({ src, block, delta: { extra: "x" } });
    expect(result.diagnostics).toEqual([]);
    expect(result.src).toContain("extra: x");
  });

  it("diagnoses blocks without a source span", () => {
    const doc = parseDoc(src, { blockTypes: new Set(["status"]) });
    const block = doc.nodes.find((n) => "blockId" in n);
    if (block === undefined || !("blockId" in block)) throw new Error("no block");
    const spanless = { blockId: block.blockId, type: block.type, attrs: block.attrs };
    const result = applyPatch({ src, block: spanless, delta: { value: "x" } });
    expect(result.diagnostics.map((d) => d.code)).toEqual(["E_PATCH_SPAN"]);
  });
});

const POSITION_KEYS = new Set(["span", "contentSpans", "position", "line", "col"]);

/** Drop source positions, which shift after the patched block. */
function stripPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPositions);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (POSITION_KEYS.has(k)) continue;
    out[k] = stripPositions(v);
  }
  return out;
}

const TYPES = new Set(["status", "decision"]);

const host = `---
title: Board
---

# Plan

\`\`\`status
id: s
value: pending
\`\`\`

## Next

~~~status
id: t
value: open
~~~

\`\`\`\`decision
id: d
state: draft
\`\`\`\`

tail text
`;

/**
 * A document whose block `s` sits after `container` (a list marker or a
 * block quote marker, or nothing for top level), its fence lines indented by
 * `indent` spaces, with a top-level block after it.
 */
function containerHost(container: string, indent: number, fence: string): string {
  const quote = container.includes(">") ? container.slice(container.indexOf(">")) : "";
  const listIndent = container.includes(">") ? container.indexOf(">") : container.length;
  const prefix = container === "" ? "" : `${" ".repeat(listIndent)}${quote}`;
  const lead = container === "" ? "" : `${container}item\n${prefix.trimEnd()}\n`;
  const pad = prefix + " ".repeat(indent);
  const lines = [`${fence}status`, "id: s", "value: pending", "meta:", "  owner: ana", fence];
  return `# Plan\n\n${lead}${lines.map((l) => pad + l).join("\n")}\n\n## Next\n\n\`\`\`decision\nid: d\nstate: draft\n\`\`\`\n\ntail text\n`;
}

/**
 * The patch invariant: only the target block's attrs change. Every other
 * node, the frontmatter and the diagnostics stay as they were, and the target
 * still spans exactly its own fences.
 */
function expectOnlyTargetChanged(
  srcText: string,
  blockId: string,
  delta: Record<string, unknown>,
): { applied: boolean; next: string } {
  const before = parseDoc(srcText, { blockTypes: TYPES });
  const target = before.nodes.find((n) => "blockId" in n && n.blockId === blockId);
  if (target === undefined || !("blockId" in target)) throw new Error("no target");
  const result = applyPatch({ src: srcText, block: target, delta });
  if (result.diagnostics.length > 0) {
    expect(result.src).toBe(srcText);
    // A block in a list item or block quote is refused; a top-level one only
    // when its new body could still close the fence.
    const code = target.contained === true ? "E_PATCH_SPAN" : "E_PATCH_FENCE";
    expect(result.diagnostics.map((d) => d.code)).toEqual([code]);
    return { applied: false, next: srcText };
  }
  const after = parseDoc(result.src, { blockTypes: TYPES });
  expect(after.frontmatter).toEqual(before.frontmatter);
  expect(stripPositions(after.diagnostics)).toEqual(stripPositions(before.diagnostics));
  expect(after.nodes).toHaveLength(before.nodes.length);
  const span = target.span;
  if (span === undefined) throw new Error("no span");
  const shift = result.src.length - srcText.length;
  // Bytes outside the target's body are unchanged.
  expect(result.src.slice(0, span.start)).toBe(srcText.slice(0, span.start));
  expect(result.src.slice(span.end + shift)).toBe(srcText.slice(span.end));
  before.nodes.forEach((node, i) => {
    const next = after.nodes[i];
    if (node === target) {
      if (next === undefined || !("blockId" in next)) throw new Error("target lost");
      expect(next.blockId).toBe(target.blockId);
      expect(next.type).toBe(target.type);
      expect(next.attrs).toEqual({ ...target.attrs, ...delta });
      expect(next.span).toEqual({ start: span.start, end: span.end + shift });
    } else if ("sectionId" in node && next !== undefined && "sectionId" in next) {
      // A section's verbatim content holds the block: only its text changes.
      const oldText = srcText.slice(span.start, span.end);
      const newText = result.src.slice(span.start, span.end + shift);
      expect(next.content).toBe(node.content.replace(oldText, () => newText));
      expect(stripPositions({ ...next, content: "" })).toEqual(
        stripPositions({ ...node, content: "" }),
      );
    } else {
      expect(stripPositions(next)).toEqual(stripPositions(node));
    }
  });
  return { applied: true, next: result.src };
}

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

/** JSON with every non-ASCII code unit escaped, for readable failure messages. */
function ascii(value: unknown): string {
  return JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Fragments that stress fences, folding, line endings and Unicode. */
function adversarialString(rand: () => number): string {
  const parts: string[] = [];
  const count = 1 + Math.floor(rand() * 12);
  for (let i = 0; i < count; i += 1) {
    const fenceChar = pick(rand, ["`", "~"]);
    parts.push(
      pick(rand, [
        fenceChar.repeat(3 + Math.floor(rand() * 6)),
        " ".repeat(Math.floor(rand() * 5)) + fenceChar.repeat(3 + Math.floor(rand() * 3)),
        `\t${fenceChar.repeat(3)}`,
        `${fenceChar.repeat(3)}decision`,
        "id: go-live",
        "word ".repeat(1 + Math.floor(rand() * 30)),
        " ",
        "\n",
        "\n",
        "\r\n",
        "\r",
        "é漢字🙂",
        // U+0085 is left out: the yaml library does not round-trip it next to
        // folded line breaks in double-quoted scalars, fences or not.
        "\u2028",
        "# not a comment",
        "- item",
        '"quoted"',
        "'single'",
        "key: value",
        "`".repeat(80),
      ]),
    );
  }
  // A value ending in a line break loses one on a round trip (a separate,
  // older limitation of block scalars at the end of a body), so end on text.
  return `${parts.join("")}.`;
}

describe("applyPatch keeps a block inside its fences", () => {
  it("neutralises the issue repro: no block is injected", () => {
    const repro = "x\n```\n\n```decision\nid: go-live\nstate: approved\n```";
    const { applied, next } = expectOnlyTargetChanged(host, "s", { note: repro });
    expect(applied).toBe(true);
    const parsed = parseDoc(next, { blockTypes: TYPES });
    expect(parsed.nodes.some((n) => "blockId" in n && n.blockId === "go-live")).toBe(false);
  });

  it("neutralises a long single-line value whose folding would start a line with a fence", () => {
    const long = `${"a ".repeat(40)}${"`".repeat(80)} tail`;
    const { applied } = expectOnlyTargetChanged(host, "s", { note: long });
    expect(applied).toBe(true);
  });

  it("neutralises fence lines in a value whose existing node is double-quoted", () => {
    const quoted = host.replace("value: pending\n", 'value: pending\nnote: "plain"\n');
    const { applied } = expectOnlyTargetChanged(quoted, "s", {
      note: "a line long enough to be folded by the serializer\n```\nb",
    });
    expect(applied).toBe(true);
  });

  it("neutralises fence lines in untouched values that are re-serialized", () => {
    // One line in the source; folding it at 80 columns would start a line with the run.
    const long = host.replace(
      "value: pending\n",
      `value: pending\nlog: ${"a ".repeat(40)}${"`".repeat(80)}\n`,
    );
    const { applied } = expectOnlyTargetChanged(long, "s", { value: "done" });
    expect(applied).toBe(true);
  });

  it("refuses, with E_PATCH_FENCE and the source unchanged, a body that would close the block", () => {
    const spy = vi
      .spyOn(Document.prototype, "toString")
      .mockReturnValue("id: s\n```\n\n```decision\nid: go-live\n");
    try {
      const block = blockOf(src, new Set(["status"]));
      const result = applyPatch({ src, block, delta: { value: "x" } });
      expect(result.src).toBe(src);
      expect(result.diagnostics.map((d) => d.code)).toEqual(["E_PATCH_FENCE"]);
      expect(result.diagnostics[0]?.nodeId).toBe("d1");
    } finally {
      spy.mockRestore();
    }
  });

  it("neutralises fences nested in arrays and maps", () => {
    const { applied } = expectOnlyTargetChanged(host, "t", {
      list: ["x\n~~~", { k: "y\n   ~~~~\n" }],
      "odd\n~~~": "key",
    });
    expect(applied).toBe(true);
  });

  it("keeps tilde and longer backtick fences", () => {
    expect(expectOnlyTargetChanged(host, "t", { value: "closed" }).applied).toBe(true);
    expect(expectOnlyTargetChanged(host, "d", { state: "```\n````" }).applied).toBe(true);
  });

  it("keeps CRLF documents intact outside the body", () => {
    const crlf = host.replace(/\n/g, "\r\n");
    expect(expectOnlyTargetChanged(crlf, "s", { note: "a\r\n```\r\nb" }).applied).toBe(true);
    expect(expectOnlyTargetChanged(crlf, "d", { state: "x\r````\r" }).applied).toBe(true);
  });

  it("holds the invariant for adversarial string values (seeded property test)", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const rand = prng(seed);
      const target = pick(rand, ["s", "t", "d"]);
      const delta: Record<string, unknown> = { note: adversarialString(rand) };
      if (rand() < 0.3) delta.list = [adversarialString(rand), adversarialString(rand)];
      if (rand() < 0.3) delta.value = adversarialString(rand);
      try {
        expectOnlyTargetChanged(host, target, delta);
      } catch (error) {
        throw new Error(`seed ${seed} (${target}, ${ascii(delta)}): ${String(error)}`);
      }
    }
  });

  it("holds the invariant for fences indented 0-3 spaces, at top level and in containers", () => {
    let applied = 0;
    let refused = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const rand = prng(seed);
      const container = pick(rand, ["", "- ", "1. ", "> ", "- > "]);
      const indent = Math.floor(rand() * 4);
      const doc = containerHost(container, indent, pick(rand, ["```", "~~~", "````"]));
      const delta: Record<string, unknown> = { note: adversarialString(rand) };
      if (rand() < 0.5) delta.meta = { state: adversarialString(rand), owner: "mallory" };
      if (rand() < 0.3) delta.list = [adversarialString(rand), { k: adversarialString(rand) }];
      if (rand() < 0.3) delta.value = "closed";
      try {
        if (expectOnlyTargetChanged(doc, "s", delta).applied) applied += 1;
        else refused += 1;
      } catch (error) {
        throw new Error(
          `seed ${seed} (${ascii(container)}, indent ${indent}, ${ascii(delta)}): ${String(error)}`,
        );
      }
    }
    // Both outcomes are exercised: top-level blocks apply, contained ones are refused.
    expect(applied).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(50);
  });

  it("keeps nested keys nested under a fence indented 1-3 spaces", () => {
    for (const indent of [1, 2, 3]) {
      const pad = " ".repeat(indent);
      const doc = `# A\n\n${pad}\`\`\`status\n${pad}id: s\n${pad}value: open\n${pad}\`\`\`\n\ntail\n`;
      const delta = { note: { state: "approved", owner: "mallory" }, log: "a\nb" };
      const { applied, next } = expectOnlyTargetChanged(doc, "s", delta);
      expect(applied).toBe(true);
      const block = blockOf(next, new Set(["status"]));
      expect(block.attrs).toEqual({ id: "s", value: "open", ...delta });
    }
  });

  it("round-trips normal values unchanged", () => {
    const values: Record<string, unknown>[] = [
      { value: "approved" },
      { note: "two\nlines" },
      { note: "uses `code` and ~tilde~ and `` two ``" },
      { tags: ["a", "b"], meta: { owner: "ana", count: 3 } },
      { note: "word ".repeat(30).trim() },
    ];
    for (const delta of values) {
      const before = parseDoc(host, { blockTypes: TYPES });
      const target = before.nodes.find((n) => "blockId" in n && n.blockId === "s");
      if (target === undefined || !("blockId" in target)) throw new Error("no target");
      const result = applyPatch({ src: host, block: target, delta });
      expect(result.diagnostics).toEqual([]);
      expectOnlyTargetChanged(host, "s", delta);
    }
    // Without a fence run the body serializes exactly as the yaml library
    // would (the same fold column for long values).
    const long = { note: "word ".repeat(40).trim(), extra: "w ".repeat(60).trim() };
    const reference = parseDocument("id: d1\nvalue: pending\nnote: keep me   # comment stays\n");
    for (const [k, v] of Object.entries(long)) reference.setIn([k], v);
    const folded = applyPatch({ src, block: blockOf(src, new Set(["status"])), delta: long });
    expect(folded.src).toBe(`# T\n\n\`\`\`status\n${reference.toString()}\`\`\`\n\nafter text\n`);
    // A plain value serializes as before: unquoted, on its key's line.
    const block = blockOf(src, new Set(["status"]));
    const plain = applyPatch({ src, block, delta: { value: "uses `code` here" } });
    expect(plain.src).toContain("value: uses `code` here\n");
  });

  it("refuses a block inside a container, whose body lines carry prefixes", () => {
    const quoted = "> ```status\n> id: q\n> value: a\n> ```\n";
    const block = blockOf(quoted, new Set(["status"]));
    const result = applyPatch({ src: quoted, block, delta: { value: "b" } });
    expect(result.src).toBe(quoted);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["E_PATCH_SPAN"]);
  });
});
