import { describe, expect, it } from "vitest";
import { asDocId } from "../model/ids.js";
import { parseDoc } from "../parse/pipeline.js";
import { createMemStorage } from "../ports/mem.js";
import { buildReverseIndex, resolveIncludes, sectionsOf } from "./graph.js";

const BOARD = `# Board\n\n## A\n{{include:research/q3#summary}}\n{{include:other}}\n`;
const RESEARCH = `# Research\n\n## Summary {#summary}\nfindings\n`;
const OTHER = `# Other\n\ntext\n`;
const CYCLE_A = `# A\n{{include:b}}\n`;
const CYCLE_B = `# B\n{{include:a}}\n`;

describe("resolveIncludes", () => {
  it("loads reachable docs and resolves ok edges", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), BOARD);
    await storage.writeAtomic(asDocId("research/q3"), RESEARCH);
    await storage.writeAtomic(asDocId("other"), OTHER);
    const result = await resolveIncludes(asDocId("board"), storage);
    expect(result.docs.map((d) => d.docId)).toEqual(["board", "research/q3", "other"]);
    expect(result.includes).toEqual([
      { fromDoc: "board", toDoc: "research/q3", sectionId: "summary", status: "ok" },
      { fromDoc: "board", toDoc: "other", sectionId: undefined, status: "ok" },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("diagnoses missing documents and missing sections", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(
      asDocId("board"),
      "# B\n{{include:ghost}}\n{{include:research/q3#nope}}\n",
    );
    await storage.writeAtomic(asDocId("research/q3"), RESEARCH);
    const result = await resolveIncludes(asDocId("board"), storage);
    expect(result.includes.map((i) => i.status)).toEqual(["missing-doc", "missing-section"]);
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "E_INCLUDE_MISSING_DOC",
      "E_INCLUDE_MISSING_SECTION",
    ]);
  });

  it("detects include cycles without infinite recursion", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("a"), CYCLE_A);
    await storage.writeAtomic(asDocId("b"), CYCLE_B);
    const result = await resolveIncludes(asDocId("a"), storage);
    expect(result.docs.map((d) => d.docId)).toEqual(["a", "b"]);
    expect(result.diagnostics.some((d) => d.code === "E_INCLUDE_CYCLE")).toBe(true);
  });

  it("dedupes repeated doc#section includes: duplicate edge + informational diagnostic", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(
      asDocId("board"),
      "# B\n{{include:research/q3#summary}}\n{{include:research/q3#summary}}\n",
    );
    await storage.writeAtomic(asDocId("research/q3"), RESEARCH);
    const result = await resolveIncludes(asDocId("board"), storage);
    expect(result.includes.map((i) => i.status)).toEqual(["ok", "duplicate"]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["E_INCLUDE_DUPLICATE"]);
  });

  it("diagnoses a missing board document", async () => {
    const storage = createMemStorage();
    const result = await resolveIncludes(asDocId("board"), storage);
    expect(result.diagnostics.some((d) => d.code === "E_BOARD_MISSING")).toBe(true);
  });
});

describe("sectionsOf", () => {
  it("returns the prose sections of a parsed document", () => {
    const parsed = parseDoc("# A\n\n## S {#s}\n\nbody", {});
    expect(sectionsOf(parsed).map((s) => s.sectionId)).toEqual(["a", "s"]);
  });
});

describe("buildReverseIndex", () => {
  it("maps included docs to their includers (ok edges only)", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), BOARD);
    await storage.writeAtomic(asDocId("research/q3"), RESEARCH);
    await storage.writeAtomic(asDocId("other"), OTHER);
    const result = await resolveIncludes(asDocId("board"), storage);
    const index = buildReverseIndex(result.includes);
    expect(index.get(asDocId("research/q3"))).toEqual(new Set([asDocId("board")]));
    expect(index.get(asDocId("other"))).toEqual(new Set([asDocId("board")]));
  });

  it("never reads storage for an escaping include target", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("evil"), "# E\n\n{{include:../outside/secret}}\n");
    const reads: string[] = [];
    const spy = {
      ...storage,
      read: async (id: Parameters<typeof storage.read>[0]) => {
        reads.push(id);
        return storage.read(id);
      },
    };
    const result = await resolveIncludes(asDocId("evil"), spy);
    expect(reads).toEqual(["evil"]);
    expect(result.includes).toEqual([]);
    // The bad target is diagnosed on the including document's parse, not as a graph edge.
    expect(result.docs[0]?.parsed.diagnostics.map((d) => d.code)).toEqual([
      "E_INCLUDE_INVALID_TARGET",
    ]);
  });
});
