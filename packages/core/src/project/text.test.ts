import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { resolveIncludes } from "../link/graph.js";
import { buildMergedTree, resolveMergedValues } from "../link/merge.js";
import { asDocId } from "../model/ids.js";
import { parseDoc } from "../parse/pipeline.js";
import { createMemStorage } from "../ports/mem.js";
import type { Source } from "../ports/ports.js";
import { resolveRefs } from "../resolve/resolve.js";
import { projectText } from "./text.js";

const fin = readFileSync(
  fileURLToPath(new URL("../../test/fixtures/fin.md", import.meta.url)),
  "utf8",
);
const q3review = readFileSync(
  fileURLToPath(new URL("../../test/fixtures/research/q3-review.md", import.meta.url)),
  "utf8",
);

const statusBlock: BlockType = {
  type: "status",
  schema: { type: "object" },
  project: {
    text: (attrs) => `**STATUS**: ${String(attrs.value ?? "")} — ${String(attrs.title ?? "")}`,
  },
};

const checklistBlock: BlockType = {
  type: "checklist",
  schema: { type: "object" },
  project: {
    text: (attrs) => {
      const items = attrs.items;
      if (!Array.isArray(items)) return "";
      return items
        .map((item) => {
          const o = item as { label?: unknown; done?: unknown };
          return `- [${o.done === true ? "x" : " "}] ${String(o.label ?? "")}`;
        })
        .join("\n");
    },
  },
};

const valuesOf: Source = {
  resolve: async (r) => {
    if (r.source === "bank_balance") return { value: "¥23,450", stale: false };
    if (r.source === "monthly_spend") return { value: "¥8,120", stale: false };
    return { value: "—", stale: false };
  },
};

describe("projectText", () => {
  it("injects values at ref spans and preserves every other byte", async () => {
    const doc = parseDoc(fin, { blockTypes: new Set(["status", "checklist"]) });
    const values = await resolveRefs(doc.refs, valuesOf);
    // `frontmatter: true` keeps the whole source in scope for the byte-
    // preservation invariant (the default omits the frontmatter block).
    const out = projectText(doc, fin, values, {
      blockTypes: new Map([["status", statusBlock]]),
      frontmatter: true,
    });

    expect(out).toContain("- Cash: ¥23,450");
    expect(out).toContain("- Spend this month: ¥8,120");
    // Include span stays verbatim in this slice (merge is a later stage).
    expect(out).toContain("{{include:research/q3-review#summary}}");
    // Block with a hook is rendered through it.
    expect(out).toContain("**STATUS**: pending — Buy MacBook");
    // Byte preservation: removing the injections restores the original text.
    const untouched = out
      .replace("¥23,450", "{{source:bank_balance}}")
      .replace("¥8,120", "{{source:monthly_spend}}")
      .replace(
        "**STATUS**: pending — Buy MacBook",
        fin.slice(fin.indexOf("```status"), fin.indexOf("```", fin.indexOf("```status") + 3) + 3),
      );
    expect(untouched).toBe(fin);
  });

  it("omits frontmatter by default and includes it with frontmatter: true", async () => {
    const doc = parseDoc(fin, { blockTypes: new Set(["status", "checklist"]) });
    const values = await resolveRefs(doc.refs, valuesOf);

    const omitted = projectText(doc, fin, values);
    expect(omitted).not.toContain("title: Family Finance");
    expect(omitted.startsWith("# Family Finance")).toBe(true);

    const included = projectText(doc, fin, values, { frontmatter: true });
    expect(included).toContain("title: Family Finance");
    expect(included.startsWith("---")).toBe(true);
  });

  it("keeps stale refs verbatim (fail-soft, no fabricated data)", async () => {
    const src = "A {{source:broken}} B";
    const doc = parseDoc(src, {});
    const values = await resolveRefs(doc.refs, {
      resolve: async () => {
        throw new Error("down");
      },
    });
    expect(projectText(doc, src, values)).toBe(src);
  });

  it("renders blocks without hooks verbatim", async () => {
    const src = "## T\n\n```checklist\nid: c\nitems: []\n```\n";
    const doc = parseDoc(src, { blockTypes: new Set(["checklist"]) });
    const values = await resolveRefs(doc.refs, valuesOf);
    const out = projectText(doc, src, values);
    expect(out).toBe(src);
  });

  it("preserves untouched bytes exactly (no normalization)", async () => {
    const src = "**bold** *em* `code`\n\n- item one\n- item two\n\n{{source:bank_balance}} end";
    const doc = parseDoc(src, {});
    const values = await resolveRefs(doc.refs, valuesOf);
    const out = projectText(doc, src, values);
    expect(out).toBe(src.replace("{{source:bank_balance}}", "¥23,450"));
  });

  it("strips the escape backslash from an escaped ref (literal braces)", async () => {
    const src = "A \\{{source:x}} B";
    const doc = parseDoc(src, {});
    const values = await resolveRefs(doc.refs, valuesOf);
    expect(projectText(doc, src, values)).toBe("A {{source:x}} B");
  });
});

describe("projectText with merged tree", () => {
  it("golden: expands fin.md's include as a blockquote and injects values", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("fin"), fin);
    await storage.writeAtomic(asDocId("research/q3-review"), q3review);
    const link = await resolveIncludes(asDocId("fin"), storage, {
      blockTypes: new Set(["status", "checklist"]),
    });
    const tree = await buildMergedTree({ boardDocId: asDocId("fin"), link });
    const values = await resolveMergedValues(link, valuesOf);
    const out = projectText(tree.root.doc, tree.root.src, values, {
      blockTypes: new Map([
        ["status", statusBlock],
        ["checklist", checklistBlock],
      ]),
      merged: tree,
    });

    expect(out).toContain(
      "> Summary: Q3 travel overspend 15%; recommend cutting outing budget for the rest of the month.",
    );
    expect(out).toContain("- Cash: ¥23,450");
    expect(out).toContain("- Spend this month: ¥8,120");
    expect(out).toContain("**STATUS**: pending — Buy MacBook");
    expect(out).toContain("- [ ] Video platform");
    expect(out).toContain("- [x] Cloud storage");
    expect(out).not.toContain("{{include:");
  });

  it("renders a whole-document include as its full projected content", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "# Board\n\n{{include:other}}\n");
    await storage.writeAtomic(asDocId("other"), "# Other\n\ncash: {{source:bank_balance}}\n");
    const link = await resolveIncludes(asDocId("board"), storage);
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });
    const values = await resolveMergedValues(link, valuesOf);
    const out = projectText(tree.root.doc, tree.root.src, values, { merged: tree });
    expect(out).toContain("# Other");
    expect(out).toContain("cash: ¥23,450");
    expect(out).not.toContain("{{include:");
  });

  /** Project a board document (which includes one section) against `docs`. */
  async function projectBoard(
    board: string,
    docs: Readonly<Record<string, string>>,
  ): Promise<string> {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), board);
    for (const [id, src] of Object.entries(docs)) await storage.writeAtomic(asDocId(id), src);
    const parseOptions = { blockTypes: new Set(["status", "checklist"]) };
    const link = await resolveIncludes(asDocId("board"), storage, parseOptions);
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });
    const values = await resolveMergedValues(link, valuesOf);
    return projectText(tree.root.doc, tree.root.src, values, { merged: tree });
  }

  it("puts a section include's multi-line body below the heading line", async () => {
    const out = await projectBoard("# Board\n\n{{include:fin#now}}\n", { fin });
    expect(out).toContain("> Now:\n> - Cash: ¥23,450\n> - Spend this month: ¥8,120");
  });

  it("keeps a single-line section body on the heading line", async () => {
    const out = await projectBoard("# Board\n\n{{include:research/q3-review#summary}}\n", {
      "research/q3-review": q3review,
    });
    expect(out).toContain(
      "> Summary: Q3 travel overspend 15%; recommend cutting outing budget for the rest of the month.",
    );
  });

  it("blockquotes the blank line inside a multi-paragraph section body", async () => {
    const out = await projectBoard("# Board\n\n{{include:notes#intro}}\n", {
      notes: "## Intro {#intro}\nFirst paragraph.\n\nSecond paragraph.\n",
    });
    expect(out).toContain("> Intro:\n> First paragraph.\n> \n> Second paragraph.");
  });
});

describe("projectText with block-declared sources (BlockType.sources)", () => {
  const metricType: BlockType = {
    type: "metric",
    schema: { type: "object" },
    sources: (attrs) =>
      typeof attrs.source === "string"
        ? [{ kind: "source", source: attrs.source, params: {} }]
        : [],
    project: {
      text: (attrs, values) =>
        `${String(attrs.label ?? "")}: ${values[String(attrs.source ?? "")] ?? String(attrs.source ?? "")}`,
    },
  };
  const parseOptions = { blockTypes: new Set(["metric"]) };
  const blockTypes = new Map<string, BlockType>([["metric", metricType]]);
  const metricSrc = "```metric\nid: m\nlabel: Cash\nsource: bank_balance\n```\n";

  /** Resolve `metricSrc` through the real LINK + RESOLVE stages against `src`. */
  async function project(src: string, source: Source): Promise<string> {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("m"), src);
    const link = await resolveIncludes(asDocId("m"), storage, parseOptions);
    const values = await resolveMergedValues(link, source, blockTypes);
    return projectText(parseDoc(src, parseOptions), src, values, { blockTypes });
  }

  it("renders a block's live value with no prose ref in the document", async () => {
    expect(await project(metricSrc, valuesOf)).toContain("Cash: ¥23,450");
  });

  it("leaves the hook value absent for a stale resolution (the block's fallback renders)", async () => {
    const stale: Source = { resolve: async () => ({ value: "¥23,450", stale: true }) };
    expect(await project(metricSrc, stale)).toContain("Cash: bank_balance");
  });

  it("leaves the hook value absent for a failed resolution (the block's fallback renders)", async () => {
    const failing: Source = {
      resolve: async () => {
        throw new Error("upstream down");
      },
    };
    expect(await project(metricSrc, failing)).toContain("Cash: bank_balance");
  });

  it("keeps a param-bearing block ref out of the hook record but resolves it", async () => {
    const paramType: BlockType = {
      ...metricType,
      sources: () => [{ kind: "source", source: "bank_balance", params: { period: "month" } }],
    };
    const types = new Map<string, BlockType>([["metric", paramType]]);
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("m"), metricSrc);
    const link = await resolveIncludes(asDocId("m"), storage, parseOptions);
    const values = await resolveMergedValues(link, valuesOf, types);

    // Resolved (visible to custom projectors by canonical key)…
    expect(values.get("bank_balance?period=month")?.value).toBe("¥23,450");
    // …but hooks look values up by source id, so the block renders its fallback.
    const out = projectText(parseDoc(metricSrc, parseOptions), metricSrc, values, {
      blockTypes: types,
    });
    expect(out).toContain("Cash: bank_balance");
  });
});
