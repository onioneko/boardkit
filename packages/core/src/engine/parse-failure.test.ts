import { describe, expect, it, vi } from "vitest";
import { asDocId } from "../model/ids.js";
import type { ParseOptions } from "../parse/options.js";
import { createMemStorage } from "../ports/mem.js";
import { createEngine } from "./engine.js";

/**
 * Some markdown overflows the parser's stack even within the default complexity
 * limits, and can take seconds to do it. The parser is replaced here by one
 * that throws for any source containing `BOOM`, the way that input does, and
 * counts how often it is asked to.
 */
const attempts = vi.hoisted(() => ({ boom: 0 }));

vi.mock("../parse/pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../parse/pipeline.js")>();
  return {
    ...actual,
    parseDoc: (src: string, options?: ParseOptions) => {
      if (src.includes("BOOM")) {
        attempts.boom += 1;
        throw new RangeError("Maximum call stack size exceeded");
      }
      return actual.parseDoc(src, options);
    },
  };
});

const writer = { kind: "human", id: "me" } as const;
const bad = "# Bad\n\nBOOM\n";

describe("a document whose parse throws within the default limits", () => {
  it("is refused on write with E_PARSE_FAILED", async () => {
    const engine = createEngine({ storage: createMemStorage() });
    const r = await engine.createDoc("bad", { writer, content: bad });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.rejection.reason).toBe("validation");
      expect(r.rejection.diagnostics.map((d) => d.code)).toEqual(["E_PARSE_FAILED"]);
    }
  });

  it("is parsed once, however often it is read or its subscription is rebuilt", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage });
    await storage.writeAtomic(asDocId("bad"), bad);
    attempts.boom = 0;
    engine.subscribe("bad", () => {});
    for (let i = 0; i < 3; i += 1) {
      const r = await engine.createDoc(`other${i}`, { writer, content: `# Other ${i}\n` });
      expect(r.ok).toBe(true);
    }
    for (let i = 0; i < 2; i += 1) {
      const p = await engine.projection("bad", "text", {});
      expect(p.ok).toBe(false);
      expect(p.diagnostics.map((d) => d.code)).toEqual(["E_PARSE_FAILED"]);
    }
    expect(await engine.getBlock("bad", "x")).toBeUndefined();
    expect((await engine.refGraph("bad")).diagnostics.map((d) => d.code)).toEqual([
      "E_PARSE_FAILED",
    ]);
    expect(attempts.boom).toBe(1);
  });

  it("is parsed again once its content changes", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage });
    await storage.writeAtomic(asDocId("bad"), bad);
    attempts.boom = 0;
    expect((await engine.projection("bad", "text", {})).ok).toBe(false);
    await storage.writeAtomic(asDocId("bad"), `${bad}more\n`);
    expect((await engine.projection("bad", "text", {})).ok).toBe(false);
    expect(attempts.boom).toBe(2);
    const fixed = await engine.write("bad", { writer, fullText: "# Fixed\n" });
    expect(fixed.ok).toBe(true);
    expect((await engine.projection("bad", "text", {})).ok).toBe(true);
  });
});
