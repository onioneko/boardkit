import { describe, expect, expectTypeOf, it } from "vitest";
import { asDocId, asSectionId } from "./ids.js";
import type { InlineRef } from "./refs.js";

describe("InlineRef", () => {
  it("source ref carries params", () => {
    const ref: InlineRef = { kind: "source", source: "bank_balance", params: { fmt: "cny" } };
    if (ref.kind === "source") {
      expect(ref.source).toBe("bank_balance");
      expect(ref.params.fmt).toBe("cny");
    }
  });

  it("include ref may omit sectionId (whole-document include)", () => {
    const whole: InlineRef = { kind: "include", docId: asDocId("research/q3-review") };
    expectTypeOf(whole).toMatchTypeOf<InlineRef>();
    expect(whole.kind).toBe("include");
  });

  it("include ref may target a section", () => {
    const part: InlineRef = {
      kind: "include",
      docId: asDocId("research/q3-review"),
      sectionId: asSectionId("summary"),
    };
    expect(part.sectionId).toBe("summary");
  });

  it("discriminates on kind", () => {
    // Route through a helper so declaration-site narrowing does not collapse
    // the annotated union into the single literal member.
    function pick(ref: InlineRef): string {
      return ref.kind === "source" ? ref.source : ref.docId;
    }
    const source: InlineRef = { kind: "source", source: "x", params: {} };
    const include: InlineRef = { kind: "include", docId: asDocId("d") };
    expect(pick(source)).toBe("x");
    expect(pick(include)).toBe("d");
  });
});
