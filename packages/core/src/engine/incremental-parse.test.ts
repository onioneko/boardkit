import type { Root } from "mdast";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editParagraph, generateBoard } from "../../test/markdown-gen.js";
import type { BlockType } from "../blocks/types.js";
import { asDocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import { createEngine } from "./engine.js";

/**
 * #43: an edit re-parses only the sections it touches. Every markdown parse
 * the engine runs is recorded, so these tests pin what a write and the reads
 * after it hand to the parser. Counts, not timings.
 */
const parsed = vi.hoisted(() => [] as string[]);

vi.mock("../parse/markdown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../parse/markdown.js")>();
  return {
    parseMarkdown: (src: string): Root => {
      parsed.push(src);
      return actual.parseMarkdown(src);
    },
  };
});

const writer = { kind: "human", id: "u1" } as const;
const clock = () => "2026-10-09T00:00:00Z";

const checklistType: BlockType = {
  type: "checklist",
  schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  affordances: [
    {
      name: "rename",
      params: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
      patch: (_attrs, params) => ({ title: (params as { title: string }).title }),
    },
  ],
};

/** An engine holding a 64 KiB board, projected once. */
async function setUp() {
  const storage = createMemStorage();
  const engine = createEngine({ storage, clock, blocks: [checklistType] });
  const doc = generateBoard(64 * 1024, 1);
  await storage.writeAtomic(asDocId("log"), doc);
  expect((await engine.projection("log", "text", {})).ok).toBe(true);
  parsed.length = 0;
  return { engine, doc };
}

/** Sections of `src` (from one heading line to the next). */
function sectionsOf(src: string): string[] {
  return src.split(/(?=^#{1,6} )/m);
}

beforeEach(() => {
  parsed.length = 0;
});

describe("an edit re-parses only the sections it touches (#43)", () => {
  it("a full-text write of a one-paragraph edit parses only the edited section", async () => {
    const { engine, doc } = await setUp();
    const edited = editParagraph(doc, 0.5, 1);
    const w = await engine.write("log", { writer, fullText: edited });
    expect(w.ok).toBe(true);
    expect(parsed).toHaveLength(1);
    // It is exactly one section of the new text, the one holding the edit.
    expect(sectionsOf(edited)).toContain(parsed[0]);
    expect(parsed[0]).toContain("Edited 1.");
    expect(sectionsOf(doc)).not.toContain(parsed[0]);

    // The write's parse is cached: the next read parses nothing.
    parsed.length = 0;
    expect((await engine.projection("log", "text", {})).ok).toBe(true);
    expect(parsed).toEqual([]);
  });

  it("a block patch parses only the section of the block", async () => {
    const { engine, doc } = await setUp();
    const ids = [...doc.matchAll(/^id: (c-\d+-\d+)$/gm)].map((m) => m[1] as string);
    const blockId = ids[Math.floor(ids.length / 2)] as string;
    const w = await engine.applyIntent(
      { docId: "log", blockId, affordance: "rename", params: { title: "renamed" } },
      { writer },
    );
    expect(w.ok).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toContain("title: renamed");
    expect(parsed[0]).toMatch(/^## /);
    expect((parsed[0] as string).length).toBeLessThan(doc.length / 20);
  });

  it("an edit reaching across sections parses those sections, each once", async () => {
    const { engine, doc } = await setUp();
    // Join two sections by removing the heading line between them.
    const sections = sectionsOf(doc);
    const victim = sections[10] as string;
    const joined = doc.replace(victim, victim.replace(/^## [^\n]*\n/, ""));
    expect((await engine.write("log", { writer, fullText: joined })).ok).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toBe(`${sections[9]}${victim.replace(/^## [^\n]*\n/, "")}`);
  });
});
