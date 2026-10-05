import type { BlockType, ProjectionWalkOptions, SourceValue } from "@onioneko/boardkit-core";
import { asDocId, canonicalKey, createMemStorage, documentNode } from "@onioneko/boardkit-core";
import {
  buildMergedTree,
  parseDoc,
  resolveIncludes,
  resolveMergedValues,
} from "@onioneko/boardkit-core/internal";
import type { Element, ElementContent, Root } from "hast";
import { visit } from "unist-util-visit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HastHoleHandlers,
  type Hole,
  includeWrapper,
  projectHast,
  sanitizePanelHast,
} from "./index.js";

const text = (value: string): ElementContent => ({ type: "text", value });
const mark = (label: string): Element => ({
  type: "element",
  tagName: "mark",
  properties: {},
  children: [text(label)],
});

/** A block type with an html hook returning `<b>hook</b>` followed by whitespace text. */
const boldBlock: BlockType = {
  type: "bold",
  schema: { type: "object" },
  project: {
    html: () => ({
      type: "root",
      children: [
        { type: "element", tagName: "b", properties: {}, children: [text("hook")] },
        text("\n  "),
      ],
    }),
  },
};

/** A standalone walk of `src`, each ref resolved through `values` (by source id). */
function walkOf(src: string, values: Record<string, string> = {}): ProjectionWalkOptions {
  const doc = parseDoc(src, { blockTypes: new Set(["bold"]) });
  const map = new Map<string, SourceValue>();
  for (const ref of doc.refs) {
    if (ref.kind !== "source") continue;
    const value = values[ref.source];
    if (value !== undefined) map.set(canonicalKey(ref), { value, stale: false });
  }
  return {
    node: documentNode(doc, src),
    values: map,
    projectorId: "html",
    blockTypes: new Map([["bold", boldBlock]]),
  };
}

/** Handlers that render every hole as `<mark>kind:detail</mark>`, recording what they saw. */
function marking(seen: Hole[] = []): HastHoleHandlers {
  return {
    onHole: (hole) => {
      seen.push(hole);
      if (hole.kind === "source") return [mark(`source:${hole.value}`)];
      if (hole.kind === "block") return [mark(`block:${hole.block.block.blockId}`)];
      return [mark(`include:${hole.include.node.provenance.docId}`)];
    },
  };
}

/** Top-level element tag names of a tree. */
function tags(tree: Root): string[] {
  return tree.children.flatMap((c) => (c.type === "element" ? [c.tagName] : []));
}

function elementsOf(tree: Root, tagName: string): Element[] {
  const out: Element[] = [];
  visit(tree, "element", (el: Element) => {
    if (el.tagName === tagName) out.push(el);
  });
  return out;
}

/** Plain text content of a node. */
function textOf(node: Root | Element): string {
  let out = "";
  visit(node, "text", (t: { value: string }) => {
    out += t.value;
  });
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("projectHast — holes in element content", () => {
  it("keeps one paragraph around a ref and a block with text on both sides", async () => {
    const src = "before {{source:cash}} middle\n```bold\nid: b1\n```\nafter\n";
    const tree = await projectHast(walkOf(src, { cash: "100" }), marking());
    expect(tags(tree)).toEqual(["p"]);
    const [p] = elementsOf(tree, "p");
    expect(p?.children.map((c) => (c.type === "element" ? `<${textOf(c)}>` : c.value))).toEqual([
      "before ",
      "<source:100>",
      " middle\n",
      "<block:b1>",
      "\nafter",
    ]);
  });

  it("hands the handler each hole in document order, with its walk context", async () => {
    const seen: Hole[] = [];
    const contexts: string[] = [];
    const src = "{{source:a}} {{source:b}}\n\n```bold\nid: b1\n```\n";
    await projectHast(walkOf(src, { a: "1", b: "2" }), {
      onHole: (hole, ctx) => {
        seen.push(hole);
        contexts.push(ctx.node.src === src ? "node" : "other");
        return [];
      },
    });
    expect(seen.map((h) => h.kind)).toEqual(["source", "source", "block"]);
    expect(seen[0]).toMatchObject({ kind: "source", value: "1", ref: { source: "a" } });
    expect(seen[2]).toMatchObject({
      kind: "block",
      block: { hooked: true, block: { blockId: "b1" } },
    });
    expect(contexts).toEqual(["node", "node", "node"]);
  });

  it("awaits an async handler", async () => {
    const tree = await projectHast(walkOf("x {{source:a}}\n", { a: "1" }), {
      onHole: async () => [text("async")],
    });
    expect(textOf(tree)).toBe("x async");
  });

  it("trims a block hole's trailing whitespace text", async () => {
    const tree = await projectHast(walkOf("```bold\nid: b1\n```\n"), {
      onHole: (hole) =>
        hole.kind === "block" ? ((hole.block.output as Root).children as ElementContent[]) : [],
    });
    const [p] = elementsOf(tree, "p");
    expect(p?.children.at(-1)).toEqual({ type: "text", value: "" });
    expect(textOf(p as Element)).toBe("hook");
  });

  it("hands a block hole a copy of the hook's output, never the hook's own objects", async () => {
    const returned = { type: "element", tagName: "b", properties: {}, children: [] };
    const doc = parseDoc("```same\nid: s\n```\n", { blockTypes: new Set(["same"]) });
    const same: BlockType = {
      type: "same",
      schema: { type: "object" },
      project: { html: () => returned },
    };
    const outputs: unknown[] = [];
    await projectHast(
      {
        node: documentNode(doc, "```same\nid: s\n```\n"),
        values: new Map(),
        projectorId: "html",
        blockTypes: new Map([["same", same]]),
      },
      {
        onHole: (hole) => {
          if (hole.kind === "block") outputs.push(hole.block.output);
          return [];
        },
      },
    );
    expect(outputs).toEqual([returned]);
    expect(outputs[0]).not.toBe(returned);
  });

  it("returns the tree unsanitized", async () => {
    const tree = await projectHast(walkOf("x {{source:a}}\n", { a: "1" }), {
      onHole: () => [
        { type: "element", tagName: "script", properties: { onClick: "y" }, children: [] },
      ],
    });
    expect(elementsOf(tree, "script")).toHaveLength(1);
  });
});

describe("projectHast — includes", () => {
  async function merged(): Promise<ProjectionWalkOptions> {
    const storage = createMemStorage();
    await storage.writeAtomic(
      asDocId("board"),
      "intro\n\n{{include:r}}\n\ntail {{include:r2}} end\n",
    );
    await storage.writeAtomic(asDocId("r"), "inner\n");
    await storage.writeAtomic(asDocId("r2"), "second\n");
    const link = await resolveIncludes(asDocId("board"), storage);
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });
    const values = await resolveMergedValues(link, {
      resolve: async () => ({ value: "v", stale: false }),
    });
    return { node: tree.root, values, projectorId: "html" };
  }

  it("lifts a paragraph holding only an include token, and keeps an inline one in its paragraph", async () => {
    const tree = await projectHast(await merged(), marking());
    expect(tags(tree)).toEqual(["p", "mark", "p"]);
    const blocks = tree.children.filter((c): c is Element => c.type === "element");
    expect(textOf(blocks[2] as Element)).toBe("tail include:r2 end");
  });

  it("recurses through includeWrapper and keeps provenance through sanitizePanelHast", async () => {
    const walk = await merged();
    const handlers: HastHoleHandlers = {
      onHole: async (hole) => {
        if (hole.kind !== "include") return [];
        const inner = await projectHast({ ...walk, node: hole.include.node }, handlers);
        return [includeWrapper(hole.include, inner.children as ElementContent[])];
      },
    };
    const safe = sanitizePanelHast(await projectHast(walk, handlers));
    const sections = elementsOf(safe, "section");
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.properties)).toEqual([{ "data-doc": "r" }, { "data-doc": "r2" }]);
    expect(textOf(sections[0] as Element)).toBe("inner");
  });
});

describe("projectHast — holes inside attribute values", () => {
  it("folds a ref into an autolinked href as its value's text by default", async () => {
    const tree = await projectHast(
      walkOf("www.example.com/{{source:p}}\n", { p: "abc" }),
      marking(),
    );
    const [a] = elementsOf(tree, "a");
    expect(a?.properties.href).toBe("http://www.example.com/abc");
  });

  it("asks onHoleInAttribute when supplied", async () => {
    const seen: string[] = [];
    const tree = await projectHast(walkOf("www.example.com/{{source:p}}\n", { p: "abc" }), {
      ...marking(),
      onHoleInAttribute: (hole) => {
        seen.push(hole.kind);
        return "X";
      },
    });
    expect(elementsOf(tree, "a")[0]?.properties.href).toBe("http://www.example.com/X");
    expect(seen).toEqual(["source"]);
  });

  it("folds a block token in an attribute to the empty string by default", async () => {
    // The fence interrupts the paragraph in the source, so it is a block; once
    // it is a token, the image's title spans the three lines around it.
    const src = '![alt](x "t\n```bold\nid: b1\n```\nu")\n';
    const seen: Hole[] = [];
    const tree = await projectHast(walkOf(src), marking(seen));
    expect(elementsOf(tree, "img")[0]?.properties.title).toBe("t\n\nu");
    expect(elementsOf(tree, "mark")).toEqual([]);
  });

  it("folds an include token in an attribute to the empty string by default", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "www.example.com/{{include:r}}\n");
    await storage.writeAtomic(asDocId("r"), "inner\n");
    const link = await resolveIncludes(asDocId("board"), storage);
    const merged = await buildMergedTree({ boardDocId: asDocId("board"), link });
    const tree = await projectHast(
      { node: merged.root, values: new Map(), projectorId: "html" },
      marking(),
    );
    expect(merged.root.includes).toHaveLength(1);
    const [a] = elementsOf(tree, "a");
    expect(a?.properties.href).toBe("http://www.example.com/");
    // In the link's text the token is ordinary element content.
    expect(textOf(a as Element)).toBe("www.example.com/include:r");
  });
});

describe("projectHast — unresolved refs", () => {
  it("leaves a stale or missing ref verbatim when onUnresolved is absent", async () => {
    const seen: Hole[] = [];
    const tree = await projectHast(walkOf("v {{source:gone}}\n"), marking(seen));
    expect(textOf(tree)).toBe("v {{source:gone}}");
    expect(seen).toEqual([]);
  });

  it("makes it an unresolved hole when onUnresolved is supplied", async () => {
    const holes: Hole[] = [];
    const tree = await projectHast(walkOf("v {{source:gone}}\n"), {
      ...marking(),
      onUnresolved: (hole) => {
        holes.push(hole);
        return [mark(`unresolved:${hole.ref.source}`)];
      },
    });
    expect(holes).toEqual([
      {
        kind: "unresolved",
        ref: expect.objectContaining({ source: "gone" }),
        raw: "{{source:gone}}",
        stale: false,
      },
    ]);
    expect(textOf(tree)).toBe("v unresolved:gone");
  });

  it("passes a stale ref's degradation marker", async () => {
    const src = "v {{source:old}}\n";
    const doc = parseDoc(src, {});
    const [ref] = doc.refs;
    const values = new Map<string, SourceValue>();
    if (ref?.kind === "source") values.set(canonicalKey(ref), { value: "—", stale: true });
    const holes: Hole[] = [];
    await projectHast(
      { node: documentNode(doc, src), values, projectorId: "html" },
      {
        ...marking(),
        onUnresolved: (hole) => {
          holes.push(hole);
          return [];
        },
      },
    );
    expect(holes[0]).toMatchObject({ kind: "unresolved", stale: true, value: "—" });
  });
});

describe("projectHast — placeholder nonce", () => {
  it("draws again when the source already contains the drawn nonce", async () => {
    const first = new Uint8Array(16).fill(0xab);
    const firstHex = "ab".repeat(16);
    const spy = vi.spyOn(crypto, "getRandomValues");
    spy.mockImplementationOnce(<T extends ArrayBufferView | null>(array: T): T => {
      (array as unknown as Uint8Array).set(first);
      return array;
    });
    const literal = `bk${firstHex}x0z`;
    const tree = await projectHast(walkOf(`${literal} {{source:a}}\n`, { a: "1" }), marking());
    expect(spy).toHaveBeenCalledTimes(2);
    // The author's token-shaped text stays text; only the real ref became a hole.
    expect(textOf(tree)).toBe(`${literal} source:1`);
    expect(elementsOf(tree, "mark")).toHaveLength(1);
  });
});

describe("projectHast — heading anchors", () => {
  it("removes a heading's {#anchor} and sets it as the heading's id", async () => {
    const tree = await projectHast(walkOf("## Risk limits {#risk-limits}\n\nBody.\n"), marking());
    const [h2] = elementsOf(tree, "h2");
    expect(h2?.properties.id).toBe("risk-limits");
    expect(textOf(h2 as Element)).toBe("Risk limits");
  });
});
