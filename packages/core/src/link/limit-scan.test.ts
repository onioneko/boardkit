import { describe, expect, it, vi } from "vitest";
import { createEngine } from "../engine/engine.js";
import { asDocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import { resolveIncludes } from "./graph.js";

/**
 * The complexity scan is linear but not free (a few milliseconds per MB), so
 * it runs once per document per resolution pass, however many includes name
 * the document. Both scan entry points are wrapped to count calls by docId.
 */
const scans = vi.hoisted(() => new Map<string, number>());

vi.mock("../parse/complexity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../parse/complexity.js")>();
  const count = (docId: string): void => {
    scans.set(docId, (scans.get(docId) ?? 0) + 1);
  };
  return {
    ...actual,
    complexityDiagnostic: (...args: Parameters<typeof actual.complexityDiagnostic>) => {
      count(args[0]);
      return actual.complexityDiagnostic(...args);
    },
    documentComplexityDiagnostic: (
      ...args: Parameters<typeof actual.documentComplexityDiagnostic>
    ) => {
      count(args[0]);
      return actual.documentComplexityDiagnostic(...args);
    },
  };
});

const target = `${Array.from({ length: 5 }, (_, i) => `# s${i}\n\nx\n`).join("\n")}`;
const board = `# Board\n\n${Array.from({ length: 20 }, (_, i) => `{{include:t#s${i % 5}}}`).join("\n\n")}\n\n{{include:t}}\n`;

describe("the complexity scan runs once per document per resolution pass", () => {
  it("in resolveIncludes, however many includes name a document", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("t"), target);
    await storage.writeAtomic(asDocId("board"), board);
    scans.clear();
    const link = await resolveIncludes(asDocId("board"), storage);
    expect(link.docs.map((d) => d.docId)).toEqual(["board", "t"]);
    expect(Object.fromEntries(scans)).toEqual({ board: 1, t: 1 });
  });

  it("in a projection, including the board", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("t"), target);
    await storage.writeAtomic(asDocId("board"), board);
    const engine = createEngine({ storage });
    scans.clear();
    const r = await engine.projection("board", "text", {});
    expect(r.ok).toBe(true);
    expect(Object.fromEntries(scans)).toEqual({ board: 1, t: 1 });
  });
});
