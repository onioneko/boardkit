import {
  asDocId,
  type BlockType,
  canonicalKey,
  createEngine,
  createMemStorage,
  mdastOf,
  type SourceValue,
} from "@onioneko/boardkit-core";
import {
  buildMergedTree,
  parseDoc,
  releaseMdast,
  resolveIncludes,
  resolveMergedValues,
} from "@onioneko/boardkit-core/internal";
import { unified } from "unified";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectHtml as reparseProjectHtml } from "../test/reparse/html.js";
import { htmlProjector, projectHtml } from "./html.js";

/**
 * Counts markdown parses: every unified processor (the core parser's and the
 * projector's own) parses through the shared `Processor.prototype.parse`.
 */
function countParses(): { readonly count: () => number } {
  const proto = Object.getPrototypeOf(unified()) as { parse: (...args: unknown[]) => unknown };
  const spy = vi.spyOn(proto, "parse");
  return { count: () => spy.mock.calls.length };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const statusType: BlockType = {
  type: "status",
  schema: { type: "object" },
  project: {
    html: (attrs) => ({
      type: "element",
      tagName: "span",
      properties: { className: ["status"] },
      children: [{ type: "text", value: String(attrs.value ?? "") }],
    }),
  },
};

const writer = { kind: "human", id: "u1" } as const;
const board =
  "# Board\n\n## Now {#now}\n\ncash: {{source:cash}}\n\n```status\nid: d\nvalue: pending\n```\n\n{{include:notes#a}}\n";
const notes = "# A\n\nNote with *emphasis* and a [^1] footnote.\n\n# B\n\n[^1]: defined in B.\n";
const source = { resolve: async () => ({ value: "¥100", stale: false }) };

/** Every source ref of `src`'s parse resolved to `¥100`. */
function cash(doc: ReturnType<typeof parseDoc>): Map<string, SourceValue> {
  const values = new Map<string, SourceValue>();
  for (const ref of doc.refs) {
    if (ref.kind === "source") values.set(canonicalKey(ref), { value: "¥100", stale: false });
  }
  return values;
}

describe("projection from the parsed tree: parsing", () => {
  it("counts parses: the spy sees a parse the engine makes", async () => {
    const parses = countParses();
    parseDoc("# x\n");
    expect(parses.count()).toBe(1);
  });

  it("does no markdown parse to project a version the engine has already parsed", async () => {
    const engine = createEngine({
      storage: createMemStorage(),
      blocks: [statusType],
      projectors: [htmlProjector],
    });
    await engine.createDoc("notes", { writer, content: notes });
    await engine.createDoc("board", { writer, content: board });
    // The first projection reads (and parses) each document once.
    const first = await engine.projection<string>("board", "html", { source });

    const parses = countParses();
    const again = await engine.projection<string>("board", "html", { source });
    expect(parses.count()).toBe(0);
    expect(again.output).toBe(first.output);
    expect(again.output).toContain('<span class="status">pending</span>');
    expect(again.output).toContain("¥100");
  });

  it("does no markdown parse to project a write's own parse", async () => {
    const engine = createEngine({
      storage: createMemStorage(),
      blocks: [statusType],
      projectors: [htmlProjector],
    });
    await engine.createDoc("doc", { writer, content: "# Doc\n\nv1\n" });
    await engine.projection<string>("doc", "html", {});
    const written = await engine.write("doc", {
      writer,
      fullText: "# Doc\n\nv2 {{source:cash}}\n",
    });
    expect(written.ok).toBe(true);

    const parses = countParses();
    const out = await engine.projection<string>("doc", "html", { source });
    expect(parses.count()).toBe(0);
    expect(out.output).toBe("<h1>Doc</h1>\n<p>v2 ¥100</p>");
  });

  it("parses a document whose tree was released once per projection, with the same output", async () => {
    const src = `${["# A", "{{source:cash}} one", "# B", "two"].join("\n\n")}\n`;
    const doc = parseDoc(src);
    const values = cash(doc);
    const kept = await projectHtml(doc, src, values);
    expect(kept).toContain("¥100 one");

    releaseMdast(doc);
    expect(mdastOf(doc, src)).toBeUndefined();
    const parses = countParses();
    const released = await projectHtml(doc, src, values);
    expect(parses.count()).toBe(1);
    expect(released).toBe(kept);
  });

  it("projects a document that starts with a BOM like the same document without it, tree kept or released", async () => {
    const body = `${["# A {#a}", "{{source:cash}} one", "## B", "two {{source:cash}}"].join("\n\n")}\n`;
    const plainDoc = parseDoc(body);
    const plain = await projectHtml(plainDoc, body, cash(plainDoc));
    expect(plain).toContain("¥100 one");
    expect(plain).not.toContain("{#a}");

    const src = `\uFEFF${body}`;
    const doc = parseDoc(src);
    expect(await projectHtml(doc, src, cash(doc))).toBe(plain);
    releaseMdast(doc);
    expect(await projectHtml(doc, src, cash(doc))).toBe(plain);
  });

  it("parses an included document whose tree was released once, however many slices it gives", async () => {
    const docs = new Map([
      ["board", "{{include:n#a}}\n\n{{include:n#b}}\n\n{{include:n}}\n"],
      ["n", "# A\n\none\n\n# B\n\ntwo\n"],
    ]);
    const storage = createMemStorage();
    for (const [id, content] of docs) await storage.writeAtomic(asDocId(id), content);
    const link = await resolveIncludes(asDocId("board"), storage, {});
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });
    const values = await resolveMergedValues(link, {
      resolve: async () => ({ value: "", stale: false }),
    });
    const kept = await projectHtml(tree.root.doc, tree.root.src, values, { merged: tree });

    const [include] = tree.root.includes;
    if (include === undefined) throw new Error("no include");
    releaseMdast(include.node.doc);
    const parses = countParses();
    const released = await projectHtml(tree.root.doc, tree.root.src, values, { merged: tree });
    expect(parses.count()).toBe(1);
    expect(released).toBe(kept);
  });
});

describe("projection from the parsed tree: the shared tree", () => {
  it("leaves the parse's tree unchanged, holes or not", async () => {
    // The second heading holds no hole: only the heading copy keeps its
    // anchor removal off the shared tree, which is frozen, so a write to it
    // fails the projection.
    const src =
      "## Head {{source:cash}} {#h}\n\n## Plain *x* {#p}\n\n- a {{source:cash}}\n\n```status\nid: d\nvalue: x\n```\n\nwww.x.io/{{source:cash}}\n";
    const doc = parseDoc(src, { blockTypes: new Set(["status"]) });
    const tree = mdastOf(doc, src);
    const before = structuredClone(tree);
    const values = cash(doc);
    const html = await projectHtml(doc, src, values, {
      blockTypes: new Map([["status", statusType]]),
    });
    expect(html).toContain('<h2 id="user-content-h">Head ¥100</h2>');
    expect(html).toContain('<h2 id="user-content-p">Plain <em>x</em></h2>');
    expect(html).toContain('<a href="http://www.x.io/¥100">');
    expect(Object.isFrozen(tree)).toBe(true);
    expect(mdastOf(doc, src)).toBe(tree);
    expect(tree).toEqual(before);
  });

  it("reads a footnote defined outside an included section as text, as before", async () => {
    const docs = new Map([
      ["board", "{{include:notes#a}}\n\n{{include:notes}}\n"],
      ["notes", notes],
    ]);
    const storage = createMemStorage();
    for (const [id, content] of docs) await storage.writeAtomic(asDocId(id), content);
    const link = await resolveIncludes(asDocId("board"), storage, {});
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });
    const values = await resolveMergedValues(link, {
      resolve: async () => ({ value: "", stale: false }),
    });
    const html = await projectHtml(tree.root.doc, tree.root.src, values, { merged: tree });
    const before = await reparseProjectHtml(tree.root.doc, tree.root.src, values, { merged: tree });
    // The section alone has no definition: `[^1]` is text there, and a
    // footnote link in the whole document.
    expect(html).toContain('<section data-doc="notes" data-section="a">');
    expect(html).toContain("and a [^1] footnote.");
    expect(html).toContain("data-footnote-ref");
    expect(html).toBe(before);
  });
});
