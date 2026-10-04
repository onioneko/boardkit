import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BlockType, MergedTree, Source, SourceValue } from "@onioneko/boardkit-core";
import { asDocId, canonicalKey, createMemStorage, docVersion } from "@onioneko/boardkit-core";
// The projector itself imports only `@onioneko/boardkit-core`'s public root — that is the
// point of this package. These tests are a different job: they assemble the
// PARSE → LINK → MERGE → RESOLVE inputs a projector is *handed*, which is what
// `/internal` exists for ("advanced hosts who compose the pipeline stages
// themselves"). Nothing that ships reaches past the root.
import {
  buildMergedTree,
  parseDoc,
  resolveIncludes,
  resolveMergedValues,
  resolveRefs,
} from "@onioneko/boardkit-core/internal";
import type { Element, ElementContent } from "hast";
import { fromHtml } from "hast-util-from-html";
import { visit } from "unist-util-visit";
import { describe, expect, it } from "vitest";
import { escapeHtml, projectHtml } from "./html.js";

const fin = readFileSync(
  fileURLToPath(new URL("../test/fixtures/fin.md", import.meta.url)),
  "utf8",
);

const statusBlock: BlockType = {
  type: "status",
  schema: { type: "object" },
  affordances: [
    {
      name: "transition",
      params: {
        type: "object",
        required: ["to"],
        properties: { to: { type: "string" } },
        additionalProperties: false,
      },
      patch: (_attrs, params) => ({ value: (params as { to: string }).to }),
    },
  ],
  project: {
    html: (attrs): import("hast").Nodes => {
      const states = (attrs.states as string[]) ?? [];
      const value = String(attrs.value ?? "");
      const buttons: import("hast").ElementContent[] = states
        .filter((state) => state !== value)
        .map((state): import("hast").ElementContent => ({
          type: "element",
          tagName: "button",
          properties: {
            "data-intent": JSON.stringify({ affordance: "transition", params: { to: state } }),
          },
          children: [{ type: "text", value: state }],
        }));
      return {
        type: "element",
        tagName: "div",
        properties: { className: ["status", value] },
        children: [
          {
            type: "element",
            tagName: "span",
            properties: { className: ["badge"] },
            children: [{ type: "text", value }],
          },
          ...buttons,
        ],
      };
    },
  },
};

const checklistBlock: BlockType = {
  type: "checklist",
  schema: { type: "object" },
  affordances: [
    {
      name: "toggle",
      params: {
        type: "object",
        required: ["itemId"],
        properties: { itemId: { type: "string" } },
        additionalProperties: false,
      },
      patch: (attrs, params) => {
        const itemId = (params as { itemId: string }).itemId;
        const items = ((attrs.items as { id: string; label: string; done: boolean }[]) ?? []).map(
          (item) => (item.id === itemId ? { ...item, done: !item.done } : item),
        );
        return { items };
      },
    },
  ],
  project: {
    html: (attrs): import("hast").Nodes => {
      const items = (attrs.items as { id: string; label: string; done: boolean }[]) ?? [];
      return {
        type: "element",
        tagName: "ul",
        properties: { className: ["checklist"] },
        children: items.map((item): import("hast").ElementContent => ({
          type: "element",
          tagName: "li",
          properties: {},
          children: [
            {
              type: "element",
              tagName: "label",
              properties: {},
              children: [
                {
                  type: "element",
                  tagName: "input",
                  properties: {
                    type: "checkbox",
                    ...(item.done ? { checked: true } : {}),
                    "data-intent": JSON.stringify({
                      affordance: "toggle",
                      params: { itemId: item.id },
                    }),
                  },
                  children: [],
                },
                { type: "text", value: item.label },
              ],
            },
          ],
        })),
      };
    },
  },
};

const metricBlock: BlockType = {
  type: "metric",
  schema: { type: "object" },
  project: {
    html: (): import("hast").Nodes => ({
      type: "element",
      tagName: "div",
      properties: { className: ["metric"] },
      children: [{ type: "text", value: "42" }],
    }),
  },
};

const rawIntentBlock: BlockType = {
  type: "rawintent",
  schema: { type: "object" },
  affordances: [
    {
      name: "known",
      params: { type: "object" },
      patch: (_attrs, _params) => ({ value: "changed" }),
    },
  ],
  project: {
    html: (attrs): import("hast").Nodes => ({
      type: "element",
      tagName: "button",
      properties: { "data-intent": String(attrs.intent ?? "") },
      children: [{ type: "text", value: "go" }],
    }),
  },
};

/** A block whose html hook emits a non-checkbox `<input>` (tests the sanitizer's `required.input.type` rewrite). */
const oddInputBlock: BlockType = {
  type: "oddinput",
  schema: { type: "object" },
  affordances: [{ name: "toggle", params: { type: "object" }, patch: (_attrs, _params) => ({}) }],
  project: {
    html: (): import("hast").Nodes => ({
      type: "element",
      tagName: "input",
      properties: {
        type: "text",
        "data-intent": JSON.stringify({ affordance: "toggle", params: {} }),
      },
      children: [],
    }),
  },
};

/**
 * A block whose html hook emits a `<label for="…" id="…" data-intent="…">`
 * wrapping its own `<input data-intent="…">` — the shape a broken or hostile
 * block hook could use to steer a click to a different control (`for`) or
 * spoof the click's own intent payload (`data-intent` on the wrapper, which
 * `closest('[data-intent]')` would match before ever reaching the input).
 */
const labelAttackBlock: BlockType = {
  type: "labelattack",
  schema: { type: "object" },
  affordances: [{ name: "toggle", params: { type: "object" }, patch: (_attrs, _params) => ({}) }],
  project: {
    html: (): import("hast").Nodes => ({
      type: "element",
      tagName: "label",
      properties: {
        htmlFor: ["user-content-elsewhere"],
        id: "user-content-mine",
        "data-intent": JSON.stringify({ affordance: "forged", params: {} }),
      },
      children: [
        {
          type: "element",
          tagName: "input",
          properties: {
            type: "checkbox",
            "data-intent": JSON.stringify({ affordance: "toggle", params: {} }),
          },
          children: [],
        },
        { type: "text", value: "click me" },
      ],
    }),
  },
};

/** A block whose html hook falls back to `<pre class="chart" data-source="…">` (the starter `chart` block's shape). */
const chartBlock: BlockType = {
  type: "chart",
  schema: { type: "object" },
  project: {
    html: (attrs): import("hast").Nodes => ({
      type: "element",
      tagName: "pre",
      properties: { className: ["chart"], "data-source": String(attrs.source ?? "") },
      children: [{ type: "text", value: String(attrs.spec ?? "") }],
    }),
  },
};

const valuesOf: Source = {
  resolve: async (r) => {
    if (r.source === "bank_balance") return { value: "¥23,450", stale: false };
    if (r.source === "monthly_spend") return { value: "¥8,120", stale: false };
    return { value: "—", stale: false };
  },
};

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&#39;");
  });
});

describe("projectHtml", () => {
  it("injects resolved values, HTML-escaped, into the output", async () => {
    const doc = parseDoc(fin, { blockTypes: new Set(["status", "checklist"]) });
    const values = await resolveRefs(doc.refs, valuesOf);
    const html = await projectHtml(doc, fin, values, {
      blockTypes: new Map([["status", statusBlock]]),
    });
    expect(html).toContain("¥23,450");
    expect(html).toContain("¥8,120");
    expect(html).toContain("{{include:research/q3-review#summary}}"); // verbatim (merge is a later slice)
  });

  it("escapes values containing HTML-significant characters", async () => {
    const src = "v: {{source:x}}";
    const doc = parseDoc(src, {});
    const values = await resolveRefs(doc.refs, {
      resolve: async () => ({ value: "<b>&", stale: false }),
    });
    const html = await projectHtml(doc, src, values);
    // The value is a text node: it reads back as the literal string, never as markup.
    expect(elementsOf(html, "b")).toEqual([]);
    expect(elementsOf(html, "p")[0]?.children).toEqual([
      expect.objectContaining({ type: "text", value: "v: <b>&" }),
    ]);
    expect(html).not.toContain("<b>");
  });

  it("keeps stale refs verbatim (fail-soft)", async () => {
    const src = "v: {{source:broken}}";
    const doc = parseDoc(src, {});
    const values = await resolveRefs(doc.refs, {
      resolve: async () => {
        throw new Error("down");
      },
    });
    const html = await projectHtml(doc, src, values);
    expect(html).toContain("{{source:broken}}");
  });

  it("renders blocks through their html hooks", async () => {
    const doc = parseDoc(fin, { blockTypes: new Set(["status", "checklist"]) });
    const values = await resolveRefs(doc.refs, valuesOf);
    const html = await projectHtml(doc, fin, values, {
      blockTypes: new Map([["status", statusBlock]]),
    });
    expect(html).toContain('<div class="status pending"><span class="badge">pending</span>');
    expect(html).toContain("<button");
  });

  it("renders blocks without hooks as escaped pre/code", async () => {
    const doc = parseDoc(fin, { blockTypes: new Set(["status", "checklist"]) });
    const values = await resolveRefs(doc.refs, valuesOf);
    const html = await projectHtml(doc, fin, values, {
      blockTypes: new Map([["status", statusBlock]]),
    });
    expect(html).toContain("<pre><code>```checklist");
  });

  it("renders ordinary markdown (bold, lists)", async () => {
    const src = "**bold** text\n\n- one\n- two\n";
    const doc = parseDoc(src, {});
    const values = await resolveRefs(doc.refs, valuesOf);
    const html = await projectHtml(doc, src, values);
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<li>one</li>");
  });
});

describe("projectHtml — block-hook <input> is interactive, not sanitizer-disabled (user report: checklist boxes don't respond to clicks and render unchecked)", () => {
  it("does not force `disabled` on a block hook's checkbox input", async () => {
    const doc = parseDoc(fin, { blockTypes: new Set(["status", "checklist"]) });
    const values = await resolveRefs(doc.refs, valuesOf);
    const html = await projectHtml(doc, fin, values, {
      blockTypes: new Map([["checklist", checklistBlock]]),
    });
    expect(html).toContain("data-intent");
    expect(html).not.toContain("disabled");
  });

  it("renders `checked` for a hook input with checked: true", async () => {
    const doc = parseDoc(fin, { blockTypes: new Set(["status", "checklist"]) });
    const values = await resolveRefs(doc.refs, valuesOf);
    const html = await projectHtml(doc, fin, values, {
      blockTypes: new Map([["checklist", checklistBlock]]),
    });
    // Item "b" in the fin fixture is done: true.
    expect(html).toMatch(/<input[^>]*\bchecked\b[^>]*>/);
  });

  it("rewrites a non-checkbox input type to checkbox (the sanitizer's `required.input.type` rule)", async () => {
    const src = "```oddinput\nid: o\n```\n";
    const doc = parseDoc(src, { blockTypes: new Set(["oddinput"]) });
    const values = await resolveRefs(doc.refs, valuesOf);
    const html = await projectHtml(doc, src, values, {
      blockTypes: new Map([["oddinput", oddInputBlock]]),
    });
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('type="text"');
  });
});

describe("projectHtml — <label> is pruned to className only (hardening: for/id/data-intent must not leak through the sanitizer's wildcard)", () => {
  it("strips for/id/data-intent from a hook's <label>, leaving a bare tag", async () => {
    const src = "```labelattack\nid: la\n```\n";
    const doc = parseDoc(src, { blockTypes: new Set(["labelattack"]) });
    const values = await resolveRefs(doc.refs, valuesOf);
    const html = await projectHtml(doc, src, values, {
      blockTypes: new Map([["labelattack", labelAttackBlock]]),
    });
    const labelTag = html.match(/<label[^>]*>/)?.[0];
    expect(labelTag).toBe("<label>");
    expect(html).not.toContain("for=");
    expect(html).not.toContain("user-content-mine");
    expect(html).not.toContain("forged");
    // The input's own data-intent — the legitimate one — must survive untouched.
    expect(html).toContain(
      '<input type="checkbox" data-intent="{&#x22;affordance&#x22;:&#x22;toggle&#x22;',
    );
  });

  it("still renders the checklist's li > label > input[data-intent] shape, checked/enabled", async () => {
    const doc = parseDoc(fin, { blockTypes: new Set(["status", "checklist"]) });
    const values = await resolveRefs(doc.refs, valuesOf);
    const html = await projectHtml(doc, fin, values, {
      blockTypes: new Map([["checklist", checklistBlock]]),
    });
    expect(html).toContain("<li><label><input");
    expect(html).not.toContain("disabled");
    expect(html).toMatch(/<input[^>]*\bchecked\b[^>]*>/);
  });
});

describe("projectHtml — block-hook elements keep their `data-source` attribute (the starter `chart` block's fallback declares it, the sanitizer used to drop it)", () => {
  it('renders a hook\'s `<pre class="chart" data-source="…">` with data-source intact', async () => {
    const src = "```chart\nid: q3-spend\nsource: ledger\nspec: pie title Q3 spend\n```\n";
    const doc = parseDoc(src, { blockTypes: new Set(["chart"]) });
    const values = await resolveRefs(doc.refs, valuesOf);
    const html = await projectHtml(doc, src, values, {
      blockTypes: new Map([["chart", chartBlock]]),
    });
    expect(html).toContain('<pre class="chart" data-source="ledger">');
  });

  it("still prunes a hook's <label> to className only (data-source is not a wildcard leak back in)", async () => {
    const src = "```labelattack\nid: la\n```\n";
    const doc = parseDoc(src, { blockTypes: new Set(["labelattack"]) });
    const values = await resolveRefs(doc.refs, valuesOf);
    const html = await projectHtml(doc, src, values, {
      blockTypes: new Map([["labelattack", labelAttackBlock]]),
    });
    const labelTag = html.match(/<label[^>]*>/)?.[0];
    expect(labelTag).toBe("<label>");
  });
});

describe("projectHtml with merged tree", () => {
  it("carries provenance as data-doc/data-section attributes on merged content", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "## Ref\n{{include:r#s}}\n");
    await storage.writeAtomic(asDocId("r"), "## S {#s}\nbody\n");
    const link = await resolveIncludes(asDocId("board"), storage);
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });
    const values = await resolveMergedValues(link, valuesOf);
    const html = await projectHtml(tree.root.doc, tree.root.src, values, { merged: tree });
    expect(html).toContain('<section data-doc="r" data-section="s">');
    expect(html).toContain("<p>body</p>");
  });

  it("omits data-section for whole-document includes (data-doc only)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "{{include:r}}\n");
    await storage.writeAtomic(asDocId("r"), "# R\nbody\n");
    const link = await resolveIncludes(asDocId("board"), storage);
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });
    const values = await resolveMergedValues(link, valuesOf);
    const html = await projectHtml(tree.root.doc, tree.root.src, values, { merged: tree });
    expect(html).toContain('data-doc="r"');
    expect(html).not.toContain("data-section");
  });
});

/**
 * Build the merged include tree and the resolved values for a set of docs keyed
 * by docId (the engine's LOAD→LINK→MERGE→RESOLVE for tests). MERGE is pure
 * structure, so the values come back alongside the tree rather than inside it.
 */
async function mergedTree(
  docs: ReadonlyMap<string, string>,
  boardDocId: string,
  blockTypes: ReadonlySet<string> = new Set(["status", "checklist"]),
): Promise<{ tree: MergedTree; values: ReadonlyMap<string, SourceValue> }> {
  const storage = createMemStorage();
  for (const [id, content] of docs) await storage.writeAtomic(asDocId(id), content);
  const link = await resolveIncludes(asDocId(boardDocId), storage, { blockTypes });
  const tree = await buildMergedTree({ boardDocId: asDocId(boardDocId), link });
  const values = await resolveMergedValues(link, valuesOf);
  return { tree, values };
}

/** Decode the numeric character references the stringify stage writes into attribute values. */
function decodeEntities(value: string): string {
  return value
    .replaceAll("&#x22;", '"')
    .replaceAll("&#x26;", "&")
    .replaceAll("&#x3C;", "<")
    .replaceAll("&#x3E;", ">")
    .replaceAll("&#x27;", "'");
}

/** All `data-intent` payloads in the output, decoded and parsed (throws on non-JSON payloads). */
function intentsOf(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const match of html.matchAll(/data-intent="([^"]*)"/g)) {
    const raw = match[1];
    if (raw === undefined) continue;
    out.push(JSON.parse(decodeEntities(raw)) as Record<string, unknown>);
  }
  return out;
}

describe("projectHtml enriches data-intent with the full Intent shape", () => {
  const blocks = new Map<string, BlockType>([
    ["status", statusBlock],
    ["checklist", checklistBlock],
  ]);

  it("status transition button embeds docId/blockId/affordance/params/expectedVersion/expected", async () => {
    const { tree, values } = await mergedTree(new Map([["fin", fin]]), "fin");
    const html = await projectHtml(tree.root.doc, tree.root.src, values, {
      merged: tree,
      blockTypes: blocks,
    });
    const approved = intentsOf(html).find(
      (i) => i.affordance === "transition" && (i.params as { to: string }).to === "approved",
    );
    expect(approved).toEqual({
      docId: "fin",
      blockId: "dec-macbook",
      affordance: "transition",
      params: { to: "approved" },
      expectedVersion: docVersion(fin),
      expected: { value: "pending" },
    });
  });

  it("checklist toggle embeds the current values of exactly the touched attrs", async () => {
    const { tree, values } = await mergedTree(new Map([["fin", fin]]), "fin");
    const html = await projectHtml(tree.root.doc, tree.root.src, values, {
      merged: tree,
      blockTypes: blocks,
    });
    const toggleA = intentsOf(html).find(
      (i) => i.affordance === "toggle" && (i.params as { itemId: string }).itemId === "a",
    );
    expect(toggleA).toEqual({
      docId: "fin",
      blockId: "subs",
      affordance: "toggle",
      params: { itemId: "a" },
      expectedVersion: docVersion(fin),
      expected: {
        items: [
          { id: "a", label: "Video platform", done: false },
          { id: "b", label: "Cloud storage", done: true },
        ],
      },
    });
  });

  it("leaves data-intent unchanged for an unknown affordance (fail-soft)", async () => {
    const src = '```rawintent\nid: f\nintent: \'{"affordance":"nope","params":{}}\'\n```\n';
    const { tree, values } = await mergedTree(new Map([["r", src]]), "r", new Set(["rawintent"]));
    const html = await projectHtml(tree.root.doc, tree.root.src, values, {
      merged: tree,
      blockTypes: new Map([["rawintent", rawIntentBlock]]),
    });
    expect(intentsOf(html)).toEqual([{ affordance: "nope", params: {} }]);
  });

  it("leaves data-intent unchanged when the payload is not JSON (fail-soft)", async () => {
    const src = "```rawintent\nid: f\nintent: not-json\n```\n";
    const { tree, values } = await mergedTree(new Map([["r", src]]), "r", new Set(["rawintent"]));
    const html = await projectHtml(tree.root.doc, tree.root.src, values, {
      merged: tree,
      blockTypes: new Map([["rawintent", rawIntentBlock]]),
    });
    expect(html).toContain('data-intent="not-json"');
    expect(html).not.toContain("docId");
  });

  it("does not inject attributes into blocks whose hooks emit no data-intent", async () => {
    const src = "```metric\nid: m\nvalue: 42\n```\n";
    const doc = parseDoc(src, { blockTypes: new Set(["metric"]) });
    const values = await resolveRefs(doc.refs, valuesOf);
    const html = await projectHtml(doc, src, values, {
      blockTypes: new Map([["metric", metricBlock]]),
    });
    expect(html).toContain('<div class="metric">42</div>');
    expect(html).not.toContain("data-intent");
  });

  it("embeds the included document's docId/version/blockId, not the root's", async () => {
    const board = "# Board\n\n{{include:child}}\n";
    const child = "```status\nid: kid\nstates: [pending, approved]\nvalue: pending\n```\n";
    const { tree, values } = await mergedTree(
      new Map([
        ["board", board],
        ["child", child],
      ]),
      "board",
    );
    const html = await projectHtml(tree.root.doc, tree.root.src, values, {
      merged: tree,
      blockTypes: blocks,
    });
    expect(html).toContain('<section data-doc="child">');
    expect(intentsOf(html)).toEqual([
      {
        docId: "child",
        blockId: "kid",
        affordance: "transition",
        params: { to: "approved" },
        expectedVersion: docVersion(child),
        expected: { value: "pending" },
      },
    ]);
  });

  it("is deterministic: identical inputs produce byte-identical output", async () => {
    const { tree, values } = await mergedTree(new Map([["fin", fin]]), "fin");
    const opts = { merged: tree, blockTypes: blocks };
    const a = await projectHtml(tree.root.doc, tree.root.src, values, opts);
    const b = await projectHtml(tree.root.doc, tree.root.src, values, opts);
    expect(b).toBe(a);
  });
});

describe("projectHtml with block-declared sources (BlockType.sources)", () => {
  const liveMetricType: BlockType = {
    type: "metric",
    schema: { type: "object" },
    sources: (attrs) =>
      typeof attrs.source === "string"
        ? [{ kind: "source", source: attrs.source, params: {} }]
        : [],
    project: {
      html: (attrs, values): import("hast").Nodes => ({
        type: "element",
        tagName: "span",
        properties: { className: ["metric"] },
        children: [
          {
            type: "text",
            value: `${String(attrs.label ?? "")}: ${values[String(attrs.source ?? "")] ?? String(attrs.source ?? "")}`,
          },
        ],
      }),
    },
  };
  const parseOptions = { blockTypes: new Set(["metric"]) };
  const blockTypes = new Map<string, BlockType>([["metric", liveMetricType]]);
  const metricSrc = "```metric\nid: m\nlabel: Cash\nsource: bank_balance\n```\n";

  /** Project `metricSrc` through the real LINK + RESOLVE stages against `source`. */
  async function project(source: Source): Promise<string> {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("m"), metricSrc);
    const link = await resolveIncludes(asDocId("m"), storage, parseOptions);
    const values = await resolveMergedValues(link, source, blockTypes);
    return projectHtml(parseDoc(metricSrc, parseOptions), metricSrc, values, { blockTypes });
  }

  it("renders a block's live value with no prose ref in the document", async () => {
    expect(await project(valuesOf)).toContain("Cash: ¥23,450");
  });

  it("leaves the hook value absent for a stale resolution (the block's fallback renders)", async () => {
    const stale: Source = { resolve: async () => ({ value: "¥23,450", stale: true }) };
    expect(await project(stale)).toContain("Cash: bank_balance");
  });

  it("leaves the hook value absent for a failed resolution (the block's fallback renders)", async () => {
    const failing: Source = {
      resolve: async () => {
        throw new Error("upstream down");
      },
    };
    expect(await project(failing)).toContain("Cash: bank_balance");
  });
});

/**
 * Parse `html` the way a browser would (spec-compliant HTML parser) and list
 * every attribute that could run script: any `on*` event handler, and any
 * attribute whose value uses a `javascript:`, `vbscript:` or `data:` URL.
 */
function unsafeAttributes(html: string): string[] {
  const found: string[] = [];
  visit(fromHtml(html, { fragment: true }), "element", (el: Element) => {
    for (const [key, value] of Object.entries(el.properties)) {
      const text = Array.isArray(value) ? value.join(" ") : String(value);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: browsers skip leading C0 controls before a URL scheme, so the check must too.
      if (/^on/i.test(key) || /^[\u0000- ]*(?:javascript|vbscript|data):/i.test(text)) {
        found.push(`<${el.tagName} ${key}="${text}">`);
      }
    }
  });
  return found;
}

/** Every element with tag `tagName` in the parsed output. */
function elementsOf(html: string, tagName: string): Element[] {
  const out: Element[] = [];
  visit(fromHtml(html, { fragment: true }), "element", (el: Element) => {
    if (el.tagName === tagName) out.push(el);
  });
  return out;
}

async function projectProse(
  src: string,
  blockTypes: ReadonlyMap<string, BlockType> = new Map(),
): Promise<string> {
  const doc = parseDoc(src, { blockTypes: new Set(blockTypes.keys()) });
  const values = await resolveRefs(doc.refs, valuesOf);
  return projectHtml(doc, src, values, { blockTypes });
}

describe("projectHtml — prose URLs are restricted to http, https, mailto and relative targets", () => {
  it("drops a `javascript:` link target", async () => {
    const html = await projectProse("[click](javascript:alert(document.domain))\n");
    expect(unsafeAttributes(html)).toEqual([]);
    expect(elementsOf(html, "a")).toHaveLength(1); // the link text survives, its href does not
    expect(elementsOf(html, "a")[0]?.properties.href).toBeUndefined();
  });

  it("drops a `javascript:` autolink target", async () => {
    const html = await projectProse("<javascript:alert(1)>\n");
    expect(unsafeAttributes(html)).toEqual([]);
    expect(elementsOf(html, "a")[0]?.properties.href).toBeUndefined();
  });

  it("drops a `vbscript:` link target", async () => {
    const html = await projectProse("[a](vbscript:msgbox(1))\n");
    expect(unsafeAttributes(html)).toEqual([]);
    expect(elementsOf(html, "a")[0]?.properties.href).toBeUndefined();
  });

  it("drops a `data:text/html` link target", async () => {
    const html = await projectProse("[b](data:text/html,<script>alert(1)</script>)\n");
    expect(unsafeAttributes(html)).toEqual([]);
    expect(elementsOf(html, "a")[0]?.properties.href).toBeUndefined();
  });

  it("drops a `data:image/svg+xml` image source", async () => {
    const html = await projectProse("![x](data:image/svg+xml,<svg/onload=alert(1)>)\n");
    expect(unsafeAttributes(html)).toEqual([]);
    const [img] = elementsOf(html, "img");
    expect(img?.properties.src).toBeUndefined();
    expect(img?.properties.alt).toBe("x");
  });

  it("drops forbidden schemes regardless of case", async () => {
    const html = await projectProse("[a](JavaScript:alert(1)) ![b](DATA:image/png;base64,AAAA)\n");
    expect(unsafeAttributes(html)).toEqual([]);
  });

  it("keeps http, https, mailto, relative and fragment targets unchanged", async () => {
    const html = await projectProse(
      "[a](http://example.com) [b](https://example.com/x?y=1#z) [c](mailto:me@example.com) [d](./other.md) [e](/abs) [f](#top) [g](?q=1) ![i](./img.png) ![j](https://example.com/i.png)\n",
    );
    expect(elementsOf(html, "a").map((a) => a.properties.href)).toEqual([
      "http://example.com",
      "https://example.com/x?y=1#z",
      "mailto:me@example.com",
      "./other.md",
      "/abs",
      "#top",
      "?q=1",
    ]);
    expect(elementsOf(html, "img").map((i) => i.properties.src)).toEqual([
      "./img.png",
      "https://example.com/i.png",
    ]);
  });

  it("keeps GFM tables, task lists, code language classes and footnotes intact", async () => {
    const html = await projectProse(
      "| a | b |\n|:--|--:|\n| 1 | 2 |\n\n- [ ] todo\n- [x] done\n\n```js\nx\n```\n\nNote[^1].\n\n[^1]: Foot.\n",
    );
    expect(html).toContain('<th align="left">a</th>');
    expect(html).toContain('<ul class="contains-task-list">');
    expect(html).toContain(
      '<li class="task-list-item"><input type="checkbox" checked disabled> done</li>',
    );
    expect(html).toContain('<code class="language-js">');
    // Footnote anchors still point at the (prefixed) ids they reference.
    const [ref] = elementsOf(html, "a").filter((a) => a.properties.dataFootnoteRef !== undefined);
    const [back] = elementsOf(html, "a").filter(
      (a) => a.properties.dataFootnoteBackref !== undefined,
    );
    expect(ref?.properties.href).toBe("#user-content-fn-1");
    expect(ref?.properties.id).toBe("user-content-fnref-1");
    expect(back?.properties.href).toBe("#user-content-fnref-1");
    expect(elementsOf(html, "li").some((li) => li.properties.id === "user-content-fn-1")).toBe(
      true,
    );
  });
});

describe("projectHtml — text that looks like an internal placeholder stays ordinary text", () => {
  // Placeholder spellings an author could guess (the projector's historic token
  // format) — none of them may pull block, ref or include output into the page.
  const hostile = "a onerror=alert(document.domain) b";
  const statusSrc = `\`\`\`status\nid: s\nstates: ["${hostile}", "ok"]\nvalue: "${hostile}"\n\`\`\`\n`;
  const blockTypes = new Map<string, BlockType>([["status", statusBlock]]);

  it("keeps the token literal in an image alt next to a block", async () => {
    const html = await projectProse(`![BKPLACEHOLDER0BK](x)\n\n${statusSrc}`, blockTypes);
    expect(unsafeAttributes(html)).toEqual([]);
    const [img] = elementsOf(html, "img");
    expect(img?.properties.alt).toBe("BKPLACEHOLDER0BK");
    expect(img?.properties.src).toBe("x");
    expect(elementsOf(html, "button")).toHaveLength(1); // the block rendered exactly once
  });

  it("keeps the token literal in a link title next to a block", async () => {
    const html = await projectProse(
      `[t](https://example.com "BKPLACEHOLDER0BK")\n\n${statusSrc}`,
      blockTypes,
    );
    expect(unsafeAttributes(html)).toEqual([]);
    expect(elementsOf(html, "a")[0]?.properties.title).toBe("BKPLACEHOLDER0BK");
    expect(elementsOf(html, "button")).toHaveLength(1);
  });

  it("keeps the token literal in plain text next to a block and a ref", async () => {
    const html = await projectProse(
      `BKPLACEHOLDER0BK and BKPLACEHOLDER1BK cash {{source:bank_balance}}\n\n${statusSrc}`,
      blockTypes,
    );
    expect(unsafeAttributes(html)).toEqual([]);
    expect(html).toContain("<p>BKPLACEHOLDER0BK and BKPLACEHOLDER1BK cash ¥23,450</p>");
    expect(elementsOf(html, "button")).toHaveLength(1);
  });

  it("keeps the token literal next to an include", async () => {
    const { tree, values } = await mergedTree(
      new Map([
        ["board", "![BKPLACEHOLDER0BK](x) BKPLACEHOLDER0BK\n\n{{include:r}}\n"],
        ["r", "inner [x](javascript:alert(1))\n"],
      ]),
      "board",
    );
    const html = await projectHtml(tree.root.doc, tree.root.src, values, { merged: tree });
    expect(unsafeAttributes(html)).toEqual([]);
    expect(elementsOf(html, "section")).toHaveLength(1);
    expect(elementsOf(html, "img")[0]?.properties.alt).toBe("BKPLACEHOLDER0BK");
    expect(html).toContain('<section data-doc="r"><p>inner <a>x</a></p></section>');
  });
});

/** Project `src` standalone with a source that resolves every ref to `value`. */
async function projectWithValue(src: string, value: string): Promise<string> {
  const doc = parseDoc(src, {});
  const values = await resolveRefs(doc.refs, { resolve: async () => ({ value, stale: false }) });
  return projectHtml(doc, src, values);
}

const TOKEN_SHAPE = /bk[0-9a-f]{32}x\d+z/;

describe("projectHtml — refs inside GFM autolink literals", () => {
  it("substitutes the value into an http(s) autolink's href and text", async () => {
    const html = await projectWithValue("https://example.com/{{source:p}}\n", "abc");
    const [a] = elementsOf(html, "a");
    expect(a?.properties.href).toBe("https://example.com/abc");
    expect(html).toContain(">https://example.com/abc</a>");
    expect(html).not.toMatch(TOKEN_SHAPE);
  });

  it("substitutes the value into a www autolink's href", async () => {
    const html = await projectWithValue("www.example.com/{{source:p}}\n", "abc");
    expect(elementsOf(html, "a")[0]?.properties.href).toBe("http://www.example.com/abc");
    expect(html).not.toMatch(TOKEN_SHAPE);
  });

  it("substitutes the value into an email autolink's href", async () => {
    const html = await projectWithValue("{{source:p}}@example.com\n", "abc");
    expect(elementsOf(html, "a")[0]?.properties.href).toBe("mailto:abc@example.com");
    expect(html).not.toMatch(TOKEN_SHAPE);
  });

  it("still scheme-checks an href built from a ref value", async () => {
    const html = await projectWithValue("www.example.com/{{source:p}}\n", 'x" onclick="alert(1)');
    expect(unsafeAttributes(html)).toEqual([]);
    expect(html).not.toMatch(TOKEN_SHAPE);
  });
});

describe("projectHtml — scheme case", () => {
  it("keeps upper- and mixed-case http, https and mailto URLs, lowercasing the scheme", async () => {
    const html = await projectProse(
      "[a](HTTPS://example.com/X) [b](MAILTO:me@example.com) [c](Http://example.com) ![i](HTTP://example.com/i.png)\n",
    );
    expect(elementsOf(html, "a").map((a) => a.properties.href)).toEqual([
      "https://example.com/X",
      "mailto:me@example.com",
      "http://example.com",
    ]);
    expect(elementsOf(html, "img")[0]?.properties.src).toBe("http://example.com/i.png");
  });
});

describe("projectHtml — author text in the current placeholder shape is inert", () => {
  it("keeps a token-shaped string literal in text, alt and next to a block and a ref", async () => {
    const fake = `bk${"0123456789abcdef".repeat(2)}x0z`;
    const src = `${fake} cash {{source:bank_balance}} ![${fake}](x)\n\n\`\`\`metric\nid: m\n\`\`\`\n`;
    const html = await projectProse(src, new Map([["metric", metricBlock]]));
    expect(unsafeAttributes(html)).toEqual([]);
    expect(elementsOf(html, "img")[0]?.properties.alt).toBe(fake);
    expect(html).toContain(`<p>${fake} cash ¥23,450 <img src="x" alt="${fake}"></p>`);
    expect(
      elementsOf(html, "div").filter((d) => d.properties.className?.toString() === "metric"),
    ).toHaveLength(1);
  });
});

describe("projectHtml — a hostile block hook's subtree is sanitized", () => {
  const el = (
    tagName: string,
    properties: Element["properties"],
    children: ElementContent[] = [],
  ): Element => ({
    type: "element",
    tagName,
    properties,
    children,
  });
  const hostileBlock: BlockType = {
    type: "hostile",
    schema: { type: "object" },
    project: {
      html: (): import("hast").Nodes =>
        el("div", { onClick: "alert(1)", style: "background:url(javascript:alert(1))" }, [
          el("script", {}, [{ type: "text", value: "alert(1)" }]),
          el("iframe", { src: "https://evil.example" }),
          el("a", { href: "javascript:alert(1)" }, [{ type: "text", value: "x" }]),
          el("a", { href: "\u0001javascript:alert(1)" }, [{ type: "text", value: "y" }]),
          el("form", { action: "javascript:alert(1)" }, [
            el("button", {}, [{ type: "text", value: "go" }]),
          ]),
          el("base", { href: "https://evil.example/" }),
          el("svg", {}, [el("script", {}, [{ type: "text", value: "alert(1)" }])]),
          el("picture", {}, [
            el("source", { srcSet: "javascript:alert(1) 1x, data:image/svg+xml,x 2x" }),
          ]),
          el("img", { src: "data:image/svg+xml,x", onError: "alert(1)" }),
        ]),
    },
  };

  it("drops event handlers, style, script-bearing elements, form actions, base, srcset and bad URLs", async () => {
    const html = await projectProse(
      "```hostile\nid: h\n```\n",
      new Map([["hostile", hostileBlock]]),
    );
    expect(unsafeAttributes(html)).toEqual([]);
    const tags = new Set<string>();
    const keys = new Set<string>();
    visit(fromHtml(html, { fragment: true }), "element", (node: Element) => {
      tags.add(node.tagName);
      for (const key of Object.keys(node.properties)) keys.add(key);
    });
    // `<picture><source>` may stay (it is in the default schema) but loses its `srcset`.
    for (const tag of ["script", "iframe", "form", "base", "svg"]) {
      expect(tags.has(tag), tag).toBe(false);
    }
    for (const key of ["style", "action", "srcSet", "onClick", "onError"]) {
      expect(keys.has(key), key).toBe(false);
    }
    expect(html).not.toContain("alert(1)</script>");
  });
});

describe("projectHtml — block values across direct calls", () => {
  it("shows the current value when one values map is reused and updated between calls", async () => {
    const cashType: BlockType = {
      type: "cash",
      schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      project: {
        html: (_attrs, values) => ({
          type: "element",
          tagName: "span",
          properties: { className: ["cash"] },
          children: [{ type: "text", value: `Cash ${values.cash ?? "?"}` }],
        }),
      },
    };
    const src = "prose {{source:cash}}\n\n```cash\nid: c\n```\n";
    const doc = parseDoc(src, { blockTypes: new Set(["cash"]) });
    const blockTypes = new Map([["cash", cashType]]);
    const key = canonicalKey({ kind: "source", source: "cash", params: {} });
    const values = new Map<string, SourceValue>([[key, { value: "100", stale: false }]]);

    const first = await projectHtml(doc, src, values, { blockTypes });
    expect(first).toContain("prose 100");
    expect(first).toContain("Cash 100");

    values.set(key, { value: "200", stale: false });
    const second = await projectHtml(doc, src, values, { blockTypes });
    expect(second).toContain("prose 200");
    expect(second).toContain("Cash 200");
  });
});
