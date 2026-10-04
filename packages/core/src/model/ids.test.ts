import { describe, expect, expectTypeOf, it } from "vitest";
import { asBlockId, asDocId, asSectionId, type DocId, tryBlockId, tryDocId } from "./ids.js";

describe("ids", () => {
  it("constructs branded ids from strings", () => {
    expect(asDocId("fin")).toBe("fin");
    expect(asSectionId("portfolio")).toBe("portfolio");
    expect(asBlockId("dec-1")).toBe("dec-1");
  });

  it("brands remain structurally strings at runtime", () => {
    const docId = asDocId("fin");
    const plain: string = docId; // assignable to string
    expect(plain).toBe("fin");
  });

  it("brands are distinct at compile time", () => {
    expectTypeOf(asDocId("a")).not.toEqualTypeOf<string>();
    expectTypeOf(asDocId("a")).toMatchTypeOf<DocId>();
  });
});

describe("tryDocId (engine boundary)", () => {
  // A docId is the workspace-relative path of a markdown document, without its
  // `.md` extension: `a/b/c`. Everything that is not that shape is rejected
  // fail-soft, with an `E_INVALID_ID` diagnostic the caller reports.
  const accepted = ["fin", "research/q3-review", "with space", "Upper", "notes.txt"];
  for (const value of accepted) {
    it(`accepts ${JSON.stringify(value)}`, () => {
      const r = tryDocId(value);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(`expected ${value} to be accepted`);
      expect(r.id).toBe(value);
    });
  }

  const rejected: readonly { value: string; why: string }[] = [
    { value: "", why: "empty string" },
    { value: "/abs", why: "leading slash (absolute path)" },
    { value: "/", why: "the root path" },
    { value: "a//b", why: "empty path segment" },
    { value: "trailing/", why: "trailing slash (empty last segment)" },
    { value: "./x", why: "`.` path segment" },
    { value: ".", why: "the current-directory path" },
    { value: "../x", why: "`..` path segment" },
    { value: "..", why: "the parent-directory path" },
    { value: "a/../b", why: "interior `..` path segment" },
    { value: "a\\b", why: "backslash" },
    { value: "C:\\docs\\fin", why: "windows-style path (backslashes)" },
    { value: "notes.md", why: "trailing .md extension" },
    { value: "research/q3-review.md", why: "trailing .md extension on a nested path" },
  ];
  for (const { value, why } of rejected) {
    it(`rejects ${JSON.stringify(value)} (${why})`, () => {
      const r = tryDocId(value);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error(`expected ${value} to be rejected`);
      expect(r.diagnostic.code).toBe("E_INVALID_ID");
      expect(r.diagnostic.message).toContain(JSON.stringify(value));
    });
  }

  it("says a docId carries no .md extension when one is supplied", () => {
    const r = tryDocId("notes.md");
    if (r.ok) throw new Error("expected rejection");
    expect(r.diagnostic.message).toContain(".md");
    expect(r.diagnostic.message).toMatch(/extension/i);
  });
});

describe("tryBlockId (engine boundary)", () => {
  it("accepts any non-empty id (block ids are YAML `id` fields, not paths)", () => {
    for (const value of ["d", "dec-1", "a/b", "with space", "..", "x.md"]) {
      const r = tryBlockId(value);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(`expected ${value} to be accepted`);
      expect(r.id).toBe(value);
    }
  });

  it("rejects the empty string with an E_INVALID_ID diagnostic", () => {
    const r = tryBlockId("");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected rejection");
    expect(r.diagnostic.code).toBe("E_INVALID_ID");
  });
});
