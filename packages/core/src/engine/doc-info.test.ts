import { describe, expect, it, vi } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { asDocId } from "../model/ids.js";
import type { ParseOptions } from "../parse/options.js";
import { createMemStorage } from "../ports/mem.js";
import { createEngine } from "./engine.js";
import { docVersion } from "./version.js";

/**
 * #16: `docInfo` reads a document's title, frontmatter, headings and blocks
 * through the engine's parse cache. Parses are counted, never timed.
 */
const counts = vi.hoisted(() => ({ parses: 0 }));

vi.mock("../parse/pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../parse/pipeline.js")>();
  return {
    ...actual,
    parseDoc: (src: string, options?: ParseOptions) => {
      counts.parses += 1;
      return actual.parseDoc(src, options);
    },
  };
});

const writer = { kind: "human", id: "u1" } as const;

const statusType: BlockType = {
  type: "status",
  schema: {
    type: "object",
    required: ["id", "value"],
    properties: { id: { type: "string" }, value: { type: "string" } },
  },
};

/** An engine over a fresh memory storage, with documents stored around the engine. */
async function setup(
  docs: Readonly<Record<string, string>>,
  opts: { readonly maxDocumentBytes?: number } = {},
): Promise<ReturnType<typeof createEngine>> {
  const storage = createMemStorage();
  for (const [id, src] of Object.entries(docs)) await storage.writeAtomic(asDocId(id), src);
  return createEngine({ storage, blocks: [statusType], ...opts });
}

describe("docInfo (#16)", () => {
  it("summarizes a document: id, version, frontmatter, headings, blocks, diagnostics", async () => {
    const src = [
      "---",
      "stability: volatile",
      "tags: [a, b]",
      "---",
      "",
      "Intro before any heading.",
      "",
      "# Family Finance",
      "",
      "## Now {#now}",
      "",
      "```status",
      "id: s",
      "value: a",
      "```",
      "",
      "### Detail",
      "",
    ].join("\n");
    const engine = await setup({ fin: src });
    const info = await engine.docInfo("fin");
    expect(info).toEqual({
      docId: "fin",
      version: docVersion(src),
      title: "Family Finance",
      frontmatter: { stability: "volatile", tags: ["a", "b"] },
      sections: [
        { sectionId: "family-finance", heading: "Family Finance", level: 1 },
        { sectionId: "now", heading: "Now", level: 2 },
        { sectionId: "detail", heading: "Detail", level: 3 },
      ],
      blocks: [{ blockId: "s", type: "status" }],
      diagnostics: [],
    });
  });

  it("takes the title from the first h1, not a later one or a deeper heading", async () => {
    const engine = await setup({ d: "## Sub first\n\n# Real title\n\n# Second h1\n" });
    expect((await engine.docInfo("d"))?.title).toBe("Real title");
  });

  it("lets a frontmatter string `title` win over the first h1", async () => {
    const engine = await setup({
      fm: "---\ntitle: From frontmatter\n---\n\n# From heading\n",
      num: "---\ntitle: 2024\n---\n\n# From heading\n",
      blank: "---\ntitle: '  '\n---\n\n# From heading\n",
      only: "---\ntitle: Only frontmatter\n---\n\nNo heading.\n",
    });
    expect((await engine.docInfo("fm"))?.title).toBe("From frontmatter");
    // A non-string or blank frontmatter title is not a title: the h1 is.
    expect((await engine.docInfo("num"))?.title).toBe("From heading");
    expect((await engine.docInfo("blank"))?.title).toBe("From heading");
    expect((await engine.docInfo("only"))?.title).toBe("Only frontmatter");
  });

  it("trims a frontmatter title, as heading text is trimmed (M1)", async () => {
    const engine = await setup({
      padded: "---\ntitle: '  Padded  '\n---\n\n# H\n",
      block: "---\ntitle: |\n  line1\n  line2\n---\n\n# H\n",
    });
    expect((await engine.docInfo("padded"))?.title).toBe("Padded");
    expect((await engine.docInfo("block"))?.title).toBe("line1\nline2");
  });

  it("skips an empty h1 and takes the first h1 with text (M2)", async () => {
    const engine = await setup({
      bare: "#\n\n# Second\n",
      anchorOnly: "# {#top}\n\n# Second\n",
      allEmpty: "#\n\nBody.\n",
    });
    expect((await engine.docInfo("bare"))?.title).toBe("Second");
    expect((await engine.docInfo("anchorOnly"))?.title).toBe("Second");
    const info = await engine.docInfo("allEmpty");
    expect(info).toBeDefined();
    expect(info !== undefined && "title" in info).toBe(false);
  });

  it("fails soft when copying the parse throws: undefined, not a rejection (M3)", async () => {
    const engine = await setup({ d: "---\nmeta: {a: 1}\n---\n\n# T\n" });
    const spy = vi.spyOn(globalThis, "structuredClone").mockImplementation(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    try {
      await expect(engine.docInfo("d")).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect((await engine.docInfo("d"))?.title).toBe("T");
  });

  it("has no title when there is neither a frontmatter title nor an h1", async () => {
    const engine = await setup({ d: "## Only h2\n\nBody.\n" });
    const info = await engine.docInfo("d");
    expect(info).toBeDefined();
    expect(info !== undefined && "title" in info).toBe(false);
  });

  it("does not take a heading inside a fence (or a blockquote) as the title", async () => {
    const engine = await setup({
      d: "```md\n# Not a title\n```\n\n> # Quoted\n\n# Real\n",
    });
    const info = await engine.docInfo("d");
    expect(info?.title).toBe("Real");
    expect(info?.sections.map((s) => s.heading)).toEqual(["Real"]);
  });

  it("counts a setext h1 as the title", async () => {
    const engine = await setup({ d: "Setext Title\n============\n\nBody.\n\nSub\n---\n" });
    const info = await engine.docInfo("d");
    expect(info?.title).toBe("Setext Title");
    expect(info?.sections.map((s) => [s.heading, s.level])).toEqual([
      ["Setext Title", 1],
      ["Sub", 2],
    ]);
  });

  it("strips a `{#anchor}` from heading text and title, and uses it as the id", async () => {
    const engine = await setup({
      d: "# Rules {#rules-top}\n\n## Risk limits {#risk-limits}\n\n## Plain\n",
    });
    const info = await engine.docInfo("d");
    expect(info?.title).toBe("Rules");
    expect(info?.sections).toEqual([
      { sectionId: "rules-top", heading: "Rules", level: 1 },
      { sectionId: "risk-limits", heading: "Risk limits", level: 2 },
      { sectionId: "plain", heading: "Plain", level: 2 },
    ]);
  });

  it("reports the parse's diagnostics", async () => {
    const engine = await setup({ d: "---\n: [bad\n---\n\n# T\n" });
    const info = await engine.docInfo("d");
    expect(info?.diagnostics.map((d) => d.code)).toEqual(["E_FRONTMATTER_YAML"]);
    expect(info?.title).toBe("T");
  });

  it("is undefined for a missing document or an invalid id", async () => {
    const engine = await setup({});
    expect(await engine.docInfo("ghost")).toBeUndefined();
    expect(await engine.docInfo("../escape")).toBeUndefined();
    expect(await engine.docInfo("")).toBeUndefined();
  });

  it("is undefined for a document over maxDocumentBytes, without parsing it", async () => {
    const engine = await setup({ big: `# Big\n\n${"x".repeat(200)}\n` }, { maxDocumentBytes: 64 });
    counts.parses = 0;
    expect(await engine.docInfo("big")).toBeUndefined();
    expect(counts.parses).toBe(0);
    expect((await engine.getDoc("big"))?.src).toContain("# Big");
  });

  it("is undefined for a document over a complexity limit, without parsing it", async () => {
    const engine = await setup({ deep: `# t\n\n${">".repeat(8000)} x\n` });
    counts.parses = 0;
    expect(await engine.docInfo("deep")).toBeUndefined();
    expect(counts.parses).toBe(0);
  });

  it("is undefined for a document whose parse throws (limits off)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("deep"), `# t\n\n${">".repeat(8000)} x\n`);
    const engine = createEngine({ storage, complexityLimits: false });
    expect(await engine.docInfo("deep")).toBeUndefined();
  });

  it("parses a stored document once: a second call is served from the parse cache", async () => {
    const engine = await setup({ d: "# T\n\n## A\n" });
    counts.parses = 0;
    await engine.docInfo("d");
    expect(counts.parses).toBe(1);
    await engine.docInfo("d");
    expect(counts.parses).toBe(1);
  });

  it("parses nothing for a document the engine just wrote (the write seeded the cache)", async () => {
    const engine = createEngine({ storage: createMemStorage(), blocks: [statusType] });
    const created = await engine.createDoc("d", {
      writer,
      content: "# Written\n\n```status\nid: s\nvalue: a\n```\n",
    });
    expect(created.ok).toBe(true);
    counts.parses = 0;
    const info = await engine.docInfo("d");
    expect(info?.title).toBe("Written");
    expect(info?.blocks).toEqual([{ blockId: "s", type: "status" }]);
    expect(counts.parses).toBe(0);
  });

  it("parses nothing for a document a projection already parsed", async () => {
    const engine = await setup({ d: "# P\n" });
    await engine.projection("d", "text", {});
    counts.parses = 0;
    expect((await engine.docInfo("d"))?.title).toBe("P");
    expect(counts.parses).toBe(0);
  });

  it("follows the document's content: a new version gets a new summary", async () => {
    const engine = createEngine({ storage: createMemStorage() });
    await engine.createDoc("d", { writer, content: "# One\n" });
    const first = await engine.docInfo("d");
    const written = await engine.write("d", { writer, fullText: "# Two\n" });
    expect(written.ok).toBe(true);
    const second = await engine.docInfo("d");
    expect(second?.title).toBe("Two");
    expect(second?.version).not.toBe(first?.version);
  });

  it("returns a copy: mutating it changes neither the cached parse nor later reads", async () => {
    const engine = await setup({
      d: "---\nmeta: {owner: a, list: [1, 2]}\n---\n\n# T\n\n```status\nid: s\nvalue: a\n```\n",
    });
    const first = await engine.docInfo("d");
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(Object.isFrozen(first.frontmatter)).toBe(false);
    const meta = first.frontmatter.meta as { owner: string; list: number[] };
    meta.owner = "mutated";
    meta.list.push(3);
    const [section] = first.sections as unknown as { heading: string }[];
    const [block] = first.blocks as unknown as { type: string }[];
    if (section === undefined || block === undefined)
      throw new Error("expected a section and a block");
    section.heading = "mutated";
    block.type = "mutated";
    (first.diagnostics as unknown[]).push({ code: "X" });

    counts.parses = 0;
    const second = await engine.docInfo("d");
    expect(counts.parses).toBe(0);
    expect(second?.frontmatter).toEqual({ meta: { owner: "a", list: [1, 2] } });
    expect(second?.sections[0]?.heading).toBe("T");
    expect(second?.blocks[0]?.type).toBe("status");
    expect(second?.diagnostics).toEqual([]);
    expect((await engine.getBlock("d", "s"))?.type).toBe("status");
  });
});
