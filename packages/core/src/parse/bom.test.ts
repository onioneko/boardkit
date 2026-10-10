import { isDeepStrictEqual } from "node:util";
import type { Nodes, Root } from "mdast";
import { describe, expect, it } from "vitest";
import type { Block, ParsedDoc, Section, SourceSpan } from "../model/doc.js";
import { createChunkCache } from "./chunks.js";
import { parseMarkdown } from "./markdown.js";
import { bindChunkCache, mdastOf, parseDoc } from "./pipeline.js";

/**
 * A document that starts with a byte order mark (U+FEFF): every public offset
 * is an index into `src` as given, BOM included, so it agrees with the same
 * document without the BOM shifted by one.
 */

const BOM = "﻿";

const body = [
  "---",
  "title: Ledger",
  "---",
  "",
  "Intro with {{source:cash}} here.",
  "",
  "# Overview {#overview}",
  "",
  "Some text with {{source:balance}}.",
  "",
  "```status",
  "id: s1",
  "value: open",
  "```",
  "",
  "## Details",
  "",
  "- item",
  "",
  "  ```status",
  "  id: s2",
  "  value: nested",
  "  ```",
  "",
  "Setext heading",
  "--------------",
  "",
  "```status",
  "id: s3",
  "value: done",
  "```",
  "",
  "# Tail",
  "",
  "end {{source:last}}",
  "",
].join("\n");

const options = { blockTypes: new Set(["status"]) };

/** Every public span of a parse, labelled. */
function spans(doc: ParsedDoc): [string, SourceSpan][] {
  const out: [string, SourceSpan][] = [];
  if (doc.frontmatterSpan !== undefined) out.push(["frontmatter", doc.frontmatterSpan]);
  for (const node of doc.nodes) {
    if ("blockId" in node) {
      const block = node as Block;
      if (block.span !== undefined) out.push([`block ${block.blockId}`, block.span]);
    } else {
      const section = node as Section;
      for (const [i, s] of (section.contentSpans ?? []).entries()) {
        out.push([`section ${section.sectionId} content ${i}`, s]);
      }
    }
  }
  for (const [i, r] of doc.refSpans.entries())
    out.push([`ref ${i}`, { start: r.start, end: r.end }]);
  return out;
}

/** Every positioned node of a tree with its offsets. */
function treeSpans(root: Root): [string, SourceSpan][] {
  const out: [string, SourceSpan][] = [];
  const stack: Nodes[] = [...root.children];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) out.push([node.type, { start, end }]);
    if ("children" in node) for (const child of node.children) stack.push(child as Nodes);
  }
  return out;
}

describe("parse: documents that start with a BOM", () => {
  const plain = parseDoc(body, options);
  const bommed = parseDoc(`${BOM}${body}`, options);

  it("gives every public span as an index into src, one past the same span without the BOM", () => {
    const expected = spans(plain);
    const actual = spans(bommed);
    expect(expected.length).toBeGreaterThan(8);
    expect(actual.map(([label]) => label)).toEqual(expected.map(([label]) => label));
    for (const [i, [label, span]] of actual.entries()) {
      const [, base] = expected[i] as [string, SourceSpan];
      expect({ label, span }).toEqual({
        label,
        span: { start: base.start + 1, end: base.end + 1 },
      });
      expect(`${BOM}${body}`.slice(span.start, span.end)).toBe(body.slice(base.start, base.end));
    }
  });

  it("gives the mdast tree's offsets in the same coordinates", () => {
    const src = `${BOM}${body}`;
    const tree = mdastOf(bommed, src) as Root;
    const base = treeSpans(parseMarkdown(body));
    const actual = treeSpans(tree);
    expect(actual.length).toBe(base.length);
    for (const [i, [type, span]] of actual.entries()) {
      const [, b] = base[i] as [string, SourceSpan];
      expect([type, span]).toEqual([type, { start: b.start + 1, end: b.end + 1 }]);
    }
    expect(tree.position?.start.offset).toBe(0);
    expect(tree.position?.end.offset).toBe(src.length);
  });

  it("keeps everything but offsets the same: ids (anchors included), content and positions", () => {
    const strip = (doc: ParsedDoc): unknown =>
      doc.nodes.map((node) =>
        "blockId" in node
          ? { id: node.blockId, attrs: node.attrs, position: node.position }
          : { id: node.sectionId, heading: node.heading, content: node.content, at: node.position },
      );
    expect(strip(bommed)).toEqual(strip(plain));
    expect(bommed.nodes.some((n) => "sectionId" in n && n.sectionId === "overview")).toBe(true);
    expect(bommed.frontmatter).toEqual({ title: "Ledger" });
    expect(bommed.refs).toEqual(plain.refs);
  });

  it("reports diagnostics at the same lines and columns, on the first line and after it", () => {
    const bad = "{{source:}} first\n\n# H\n\nsecond {{source:}}\n";
    const expected = parseDoc(bad).diagnostics;
    expect(expected.map((d) => d.code)).toEqual(["E_REF_SYNTAX", "E_REF_SYNTAX"]);
    expect(parseDoc(`${BOM}${bad}`).diagnostics).toEqual(expected);
  });

  it("gives the same parse through the chunked (incremental) parse", () => {
    const bound = { blockTypes: new Set(["status"]) };
    bindChunkCache(
      bound,
      createChunkCache({ maxEntries: 64, maxNodes: 100_000, maxSourceBytes: 1 << 20 }),
    );
    for (const src of [
      `${BOM}${body}`,
      `${BOM}# A\n\ntext\n\n# B\n\nmore\n`,
      `${BOM}\`\`\`status\nid: x\n\`\`\`\n\n# B\n\nmore\n`,
      `${BOM}`,
    ]) {
      const chunked = parseDoc(src, bound);
      const whole = parseDoc(src, options);
      expect(isDeepStrictEqual(chunked, whole)).toBe(true);
      expect(isDeepStrictEqual(mdastOf(chunked, src), mdastOf(whole, src))).toBe(true);
    }
  });
});
