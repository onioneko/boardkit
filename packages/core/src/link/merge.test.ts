import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { asDocId } from "../model/ids.js";
import type { SourceRef } from "../model/refs.js";
import { createMemStorage } from "../ports/mem.js";
import type { Source } from "../ports/ports.js";
import { projectText } from "../project/text.js";
import { resolveIncludes, sectionsOf } from "./graph.js";
import { buildMergedTree, type MergedNode, resolveMergedValues } from "./merge.js";

const source: Source = {
  resolve: async (r) => {
    if (r.source === "cash") return { value: "¥100", stale: false };
    return { value: "—", stale: false };
  },
};

describe("buildMergedTree", () => {
  it("expands a single-level section include with provenance + heading + content range", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(
      asDocId("board"),
      "# Board\n\n## Ref\n{{include:research/q3#summary}}\n",
    );
    await storage.writeAtomic(
      asDocId("research/q3"),
      "# Research\n\n## Summary {#summary}\nfindings\n",
    );
    const link = await resolveIncludes(asDocId("board"), storage);
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });

    const child = tree.root.includes[0]?.node;
    expect(child).toBeDefined();
    expect(child?.provenance).toEqual({ docId: "research/q3", sectionId: "summary" });
    expect(child?.heading).toBe("Summary");
    expect(child?.ranges[0]?.start).toBeGreaterThan(0);
    expect(child?.src.slice(child?.ranges[0]?.start ?? 0, child?.ranges[0]?.end ?? 0).trim()).toBe(
      "findings",
    );
    expect(
      sectionsOf(
        child?.doc ?? { frontmatter: {}, nodes: [], refs: [], refSpans: [], diagnostics: [] },
      ).map((s) => s.sectionId),
    ).toContain("summary");
  });

  it("expands a whole-document include (no sectionId, whole range)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "# Board\n\n{{include:other}}\n");
    const otherSrc = "# Other\n\ntext\n";
    await storage.writeAtomic(asDocId("other"), otherSrc);
    const link = await resolveIncludes(asDocId("board"), storage);
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });

    const child = tree.root.includes[0]?.node;
    expect(child?.provenance).toEqual({ docId: "other" });
    expect(child?.heading).toBeUndefined();
    expect(child?.ranges).toEqual([{ start: 0, end: otherSrc.length }]);
  });

  it("recurses through a two-level include chain (a → b → c)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("a"), "# A\n{{include:b}}\n");
    await storage.writeAtomic(asDocId("b"), "# B\n{{include:c}}\n");
    await storage.writeAtomic(asDocId("c"), "# C\nleaf\n");
    const link = await resolveIncludes(asDocId("a"), storage);
    const tree = await buildMergedTree({ boardDocId: asDocId("a"), link });

    const b = tree.root.includes[0]?.node;
    const c = b?.includes[0]?.node;
    expect(b?.provenance.docId).toBe("b");
    expect(c?.provenance.docId).toBe("c");
    expect(c?.includes).toHaveLength(0);
  });

  it("breaks include cycles and still builds a finite tree (per-edge diagnostic at LINK)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("a"), "# A\n{{include:b}}\n");
    await storage.writeAtomic(asDocId("b"), "# B\n{{include:a}}\n");
    const link = await resolveIncludes(asDocId("a"), storage);
    expect(link.diagnostics.filter((d) => d.code === "E_INCLUDE_CYCLE")).toHaveLength(1);

    const tree = await buildMergedTree({ boardDocId: asDocId("a"), link });
    const b = tree.root.includes[0]?.node;
    expect(b).toBeDefined();
    expect(b?.includes).toHaveLength(0); // the cycle edge (b → a) is skipped
  });

  it("dedupes repeated doc#section references at first position only", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "# B\n\n{{include:r#s}}\n\n{{include:r#s}}\n");
    await storage.writeAtomic(asDocId("r"), "# R\n\n## S {#s}\nbody\n");
    const link = await resolveIncludes(asDocId("board"), storage);
    expect(link.diagnostics.some((d) => d.code === "E_INCLUDE_DUPLICATE")).toBe(true);
    expect(link.includes.filter((i) => i.status === "duplicate")).toHaveLength(1);

    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });
    expect(tree.root.includes).toHaveLength(1); // first position only
    expect(tree.root.includes[0]?.node.provenance).toEqual({ docId: "r", sectionId: "s" });
  });

  it("skips missing targets and still produces projection output (fail-soft)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "# B\n\n{{include:ghost}}\n");
    const link = await resolveIncludes(asDocId("board"), storage);
    expect(link.diagnostics.some((d) => d.code === "E_INCLUDE_MISSING_DOC")).toBe(true);

    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });
    expect(tree.root.includes).toHaveLength(0);
    const out = projectText(tree.root.doc, tree.root.src, await resolveMergedValues(link, source), {
      merged: tree,
    });
    expect(out).toContain("# B");
    // Fail-soft: the skipped include span stays verbatim (no fabricated content).
    expect(out).toContain("{{include:ghost}}");
  });

  it("resolves source refs inside included documents (value injection 穿透)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "# B\n\n{{include:r#s}}\n");
    await storage.writeAtomic(asDocId("r"), "# R\n\n## S {#s}\ncash: {{source:cash}}\n");
    const link = await resolveIncludes(asDocId("board"), storage);
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });
    const out = projectText(tree.root.doc, tree.root.src, await resolveMergedValues(link, source), {
      merged: tree,
    });
    expect(out).toContain("cash: ¥100");
  });

  it("excludes nested sections from an included parent (child body renders exactly once)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(
      asDocId("board"),
      "# B\n\n{{include:d#parent}}\n\n{{include:d#child}}\n",
    );
    await storage.writeAtomic(
      asDocId("d"),
      "## Parent {#parent}\nparent body\n\n### Child {#child}\nchild body\n",
    );
    const link = await resolveIncludes(asDocId("board"), storage);
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });

    const parent = tree.root.includes[0]?.node;
    const child = tree.root.includes[1]?.node;
    expect(parent?.provenance.sectionId).toBe("parent");
    expect(child?.provenance.sectionId).toBe("child");

    const out = projectText(tree.root.doc, tree.root.src, await resolveMergedValues(link, source), {
      merged: tree,
    });
    // Deepest-section ownership: the nested child must appear exactly once
    // (in its own include), never duplicated inside the parent's expansion.
    expect(out.match(/parent body/g)).toHaveLength(1);
    expect(out.match(/child body/g)).toHaveLength(1);
    expect(out.match(/### Child/g)).toBeNull();
  });

  it("produces a tree with no `values` property on any node (MERGE is pure structure)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "# B\ncash: {{source:cash}}\n{{include:r#s}}\n");
    await storage.writeAtomic(asDocId("r"), "# R\n\n## S {#s}\nspend: {{source:spend}}\n");
    const link = await resolveIncludes(asDocId("board"), storage);
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });

    const checked: MergedNode[] = [];
    (function assertNoValues(node: MergedNode): void {
      checked.push(node);
      expect("values" in node).toBe(false);
      for (const include of node.includes) assertNoValues(include.node);
    })(tree.root);
    expect(checked).toHaveLength(2); // the board and its included section
  });
});

describe("per-call RESOLVE (resolveMergedValues)", () => {
  it("resolveMergedValues resolves every reachable document's source refs through the Source port", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "# B\ncash: {{source:cash}}\n{{include:r}}\n");
    await storage.writeAtomic(asDocId("r"), "# R\nspend: {{source:spend}}\n");
    const link = await resolveIncludes(asDocId("board"), storage);
    const values = await resolveMergedValues(link, source);

    expect(values.get("cash?")).toEqual({ value: "¥100", stale: false });
    expect(values.get("spend?")).toEqual({ value: "—", stale: false });
  });

  it("returns a fresh values map per call (the second call is not the first call's map)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "# B\ncash: {{source:cash}}\n");
    const link = await resolveIncludes(asDocId("board"), storage);

    const first = await resolveMergedValues(link, source);
    const second = await resolveMergedValues(link, source);
    expect(first.get("cash?")?.value).toBe("¥100");
    expect(second).not.toBe(first);
  });
});

describe("block-declared sources (BlockType.sources)", () => {
  const metricType: BlockType = {
    type: "metric",
    schema: { type: "object" },
    sources: (attrs) =>
      typeof attrs.source === "string"
        ? [{ kind: "source", source: attrs.source, params: {} }]
        : [],
  };

  const boomType: BlockType = {
    type: "boom",
    schema: { type: "object" },
    sources: () => {
      throw new Error("sources exploded");
    },
  };

  // A type whose declaration is well-typed at the call site but wrong at
  // runtime (an untyped host, a hand-built object): `params` is missing.
  const malformedType: BlockType = {
    type: "malformed",
    schema: { type: "object" },
    sources: () => [{ kind: "source", source: "x" } as unknown as SourceRef],
  };

  const blockTypes = new Map<string, BlockType>([
    ["metric", metricType],
    ["boom", boomType],
    ["malformed", malformedType],
  ]);
  const parseOptions = { blockTypes: new Set(["metric", "boom", "malformed"]) };
  const metricSrc = "```metric\nid: m\nlabel: Cash\nsource: cash\n```\n";

  it("resolves a block-declared ref when no prose ref names the source", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), `# B\n\n${metricSrc}`);
    const link = await resolveIncludes(asDocId("board"), storage, parseOptions);

    const values = await resolveMergedValues(link, source, blockTypes);
    expect(values.get("cash?")).toEqual({ value: "¥100", stale: false });
  });

  it("ignores block-declared refs when no block types are passed (prose refs only)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), `# B\n\n${metricSrc}`);
    const link = await resolveIncludes(asDocId("board"), storage, parseOptions);

    expect((await resolveMergedValues(link, source)).size).toBe(0);
  });

  it("resolves a source named by both prose and a block exactly once (canonical dedup)", async () => {
    const calls: string[] = [];
    const counting: Source = {
      resolve: async (r) => {
        calls.push(r.source);
        return { value: "¥100", stale: false };
      },
    };
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), `# B\n\ncash: {{source:cash}}\n\n${metricSrc}`);
    const link = await resolveIncludes(asDocId("board"), storage, parseOptions);

    const values = await resolveMergedValues(link, counting, blockTypes);
    expect(calls).toEqual(["cash"]);
    expect(values.get("cash?")?.value).toBe("¥100");
  });

  it("contributes no refs and never throws when a block type's `sources` throws (fail-soft)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), `# B\n\n\`\`\`boom\nid: b\n\`\`\`\n\n${metricSrc}`);
    const link = await resolveIncludes(asDocId("board"), storage, parseOptions);

    // The throwing type degrades locally: its sibling block still resolves.
    const values = await resolveMergedValues(link, source, blockTypes);
    expect([...values.keys()]).toEqual(["cash?"]);
  });

  it("skips a malformed ref element and never rejects (fail-soft)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(
      asDocId("board"),
      `# B\n\n\`\`\`malformed\nid: bad\n\`\`\`\n\n${metricSrc}`,
    );
    const link = await resolveIncludes(asDocId("board"), storage, parseOptions);

    // The malformed element degrades locally: its sibling block still resolves.
    const values = await resolveMergedValues(link, source, blockTypes);
    expect([...values.keys()]).toEqual(["cash?"]);
  });

  it("collects block-declared refs from included documents too", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "# B\n\n{{include:r}}\n");
    await storage.writeAtomic(asDocId("r"), `# R\n\n${metricSrc}`);
    const link = await resolveIncludes(asDocId("board"), storage, parseOptions);

    const values = await resolveMergedValues(link, source, blockTypes);
    expect(values.get("cash?")?.value).toBe("¥100");
  });
});
