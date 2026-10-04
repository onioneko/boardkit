import { describe, expect, it } from "vitest";
import { parseDoc } from "./pipeline.js";

describe("inline refs", () => {
  it("parses source refs with unquoted and single-quoted params", () => {
    const doc = parseDoc("{{source:rsi symbol=AAPL period=14 label='my rsi'}}", {});
    expect(doc.refs[0]).toEqual({
      kind: "source",
      source: "rsi",
      params: { symbol: "AAPL", period: "14", label: "my rsi" },
    });
    expect(doc.diagnostics).toEqual([]);
  });

  it("parses whole-document and section includes", () => {
    const doc = parseDoc("{{include:a}} {{include:b#sec}}", {});
    expect(doc.refs[0]).toEqual({ kind: "include", docId: "a" });
    expect(doc.refs[1]).toEqual({ kind: "include", docId: "b", sectionId: "sec" });
    expect(doc.diagnostics).toEqual([]);
  });

  it("ignores escaped refs without diagnostics", () => {
    const doc = parseDoc("\\{{source:x}}", {});
    expect(doc.refs).toEqual([]);
    expect(doc.diagnostics).toEqual([]);
  });

  it("ignores refs inside code spans and fenced code blocks", () => {
    const doc = parseDoc("`{{source:x}}`\n\n```\n{{source:y}}\n```", {});
    expect(doc.refs).toEqual([]);
  });

  it("treats unknown braces as literal text (no ref, no diagnostic)", () => {
    const doc = parseDoc(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: deliberate literal `${{ ... }}` text, not a template
      '{{ user.name }} ${{ secrets.TOKEN }} {{#if admin}}…{{/if}} {{context}} {{}} {{"a":1}}',
      {},
    );
    expect(doc.refs).toEqual([]);
    expect(doc.diagnostics).toEqual([]);
  });

  it("tolerates whitespace inside braces for reserved refs", () => {
    const doc = parseDoc("{{ source:bank_balance }} {{ include:research/q3-review#summary }}", {});
    expect(doc.refs[0]).toEqual({ kind: "source", source: "bank_balance", params: {} });
    expect(doc.refs[1]).toEqual({
      kind: "include",
      docId: "research/q3-review",
      sectionId: "summary",
    });
    expect(doc.diagnostics).toEqual([]);
  });

  it("diagnoses malformed reserved refs", () => {
    const doc = parseDoc("{{source:}} {{include:}} {{include:a#b#c}}", {});
    expect(doc.refs).toEqual([]);
    expect(doc.diagnostics).toHaveLength(3);
    expect(doc.diagnostics.every((d) => d.code === "E_REF_SYNTAX")).toBe(true);
  });

  it("diagnoses malformed-param source refs", () => {
    const doc = parseDoc("{{source:x a b=}}", {});
    expect(doc.diagnostics).toHaveLength(1);
    expect(doc.diagnostics[0]?.code).toBe("E_REF_SYNTAX");
  });

  it("honors frontmatter refs: false (no recognition)", () => {
    const doc = parseDoc("---\nrefs: false\n---\n\n{{source:x}} {{include:y}}", {});
    expect(doc.refs).toEqual([]);
    expect(doc.diagnostics).toEqual([]);
  });

  it("honors frontmatter refs: [include] (source refs literal)", () => {
    const doc = parseDoc("---\nrefs: [include]\n---\n\n{{source:x}} {{include:y}}", {});
    expect(doc.refs).toEqual([{ kind: "include", docId: "y" }]);
    expect(doc.diagnostics).toEqual([]);
  });

  it.each([
    "../outside/secret",
    "a/../../outside",
    "/etc/passwd",
    "a\\..\\b",
    "./x",
    "a//b",
    "x.md",
  ])("rejects the include target %s with E_INCLUDE_INVALID_TARGET", (target) => {
    const doc = parseDoc(`# T\n\n{{include:${target}}}\n`, {});
    expect(doc.refs).toEqual([]);
    expect(doc.diagnostics.map((d) => d.code)).toEqual(["E_INCLUDE_INVALID_TARGET"]);
    expect(doc.diagnostics[0]?.message).toContain(JSON.stringify(target));
    expect(doc.diagnostics[0]?.line).toBe(3);
  });

  it("still accepts nested include targets", () => {
    const doc = parseDoc("{{include:research/q3-review#summary}}", {});
    expect(doc.refs).toEqual([
      { kind: "include", docId: "research/q3-review", sectionId: "summary" },
    ]);
    expect(doc.diagnostics).toEqual([]);
  });
});
