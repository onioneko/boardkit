import { describe, expect, it } from "vitest";
import { decideFullText, decideFunctionPatch, decidePatch } from "./concurrency.js";
import type { PatchDeltaFn } from "./pipeline.js";

describe("decidePatch (rules 1–4)", () => {
  const attrs = { value: "pending", note: "x" };
  const v1 = "v1";
  const v2 = "v2";

  it("rule 1: no guards → apply without rebase", () => {
    expect(decidePatch(v2, attrs, {})).toEqual({ kind: "apply", rebased: false });
  });

  it("rule 2: matching expectedVersion → apply", () => {
    expect(decidePatch(v1, attrs, { expectedVersion: v1 })).toEqual({
      kind: "apply",
      rebased: false,
    });
  });

  it("rule 3: stale version + matching expected values → value-CAS rebase", () => {
    const d = decidePatch(v2, attrs, { expectedVersion: v1, expected: { value: "pending" } });
    expect(d).toEqual({ kind: "apply", rebased: true });
  });

  it("rule 4a: stale version + no expected → reject with current attrs", () => {
    const d = decidePatch(v2, attrs, { expectedVersion: v1 });
    expect(d).toEqual({ kind: "reject", reason: "stale-version", current: attrs });
  });

  it("rule 4b: stale version + mismatching expected → reject with current attrs", () => {
    const d = decidePatch(v2, attrs, { expectedVersion: v1, expected: { value: "approved" } });
    expect(d).toEqual({ kind: "reject", reason: "expected-mismatch", current: attrs });
  });
});

describe("decideFunctionPatch (function-delta value-CAS, rule 3')", () => {
  interface Item {
    id: string;
    done: boolean;
  }

  const v1 = "v1";
  const v2 = "v2";

  /** A `PatchDeltaFn`: toggle one checklist item's `done` flag (the affordance shape `applyIntent` passes). */
  const toggle =
    (itemId: string): PatchDeltaFn =>
    (attrs) => {
      const list = (attrs.items as Item[]) ?? [];
      return {
        items: list.map((item) => (item.id === itemId ? { ...item, done: !item.done } : item)),
      };
    };

  it("rule 1: no guards → apply without rebase", () => {
    const current = {
      items: [
        { id: "a", done: false },
        { id: "b", done: false },
      ],
    };
    expect(decideFunctionPatch(v2, current, toggle("a")(current), {})).toEqual({
      kind: "apply",
      rebased: false,
    });
  });

  it("rule 2: matching expectedVersion → apply", () => {
    const current = {
      items: [
        { id: "a", done: false },
        { id: "b", done: false },
      ],
    };
    expect(decideFunctionPatch(v1, current, toggle("a")(current), { expectedVersion: v1 })).toEqual(
      { kind: "apply", rebased: false },
    );
  });

  it("rule 3': stale version + disjoint concurrent change → rebased", () => {
    // The concurrent change toggled "a"; the recompute toggles "b" against current attrs.
    const current = {
      items: [
        { id: "a", done: true },
        { id: "b", done: false },
      ],
    };
    const delta = toggle("b")(current);
    const expected = {
      items: [
        { id: "a", done: false },
        { id: "b", done: false },
      ],
    };
    expect(decideFunctionPatch(v2, current, delta, { expectedVersion: v1, expected })).toEqual({
      kind: "apply",
      rebased: true,
    });
  });

  it("rule 4a: stale version + no expected → reject stale-version", () => {
    const current = {
      items: [
        { id: "a", done: false },
        { id: "b", done: false },
      ],
    };
    expect(decideFunctionPatch(v2, current, toggle("a")(current), { expectedVersion: v1 })).toEqual(
      {
        kind: "reject",
        reason: "stale-version",
        current,
      },
    );
  });

  it("rule 4b': stale version + overlapping change → reject expected-mismatch", () => {
    // The concurrent change toggled "b"; the recompute toggles "b" back (overlap).
    const current = {
      items: [
        { id: "a", done: false },
        { id: "b", done: true },
      ],
    };
    const delta = toggle("b")(current);
    const expected = {
      items: [
        { id: "a", done: false },
        { id: "b", done: false },
      ],
    };
    expect(decideFunctionPatch(v2, current, delta, { expectedVersion: v1, expected })).toEqual({
      kind: "reject",
      reason: "expected-mismatch",
      current,
    });
  });

  it("rule 4b': missing expected for a changed key → reject expected-mismatch", () => {
    const current = {
      items: [
        { id: "a", done: false },
        { id: "b", done: false },
      ],
    };
    const delta = toggle("a")(current);
    expect(decideFunctionPatch(v2, current, delta, { expectedVersion: v1, expected: {} })).toEqual({
      kind: "reject",
      reason: "expected-mismatch",
      current,
    });
  });
});

describe("decideFullText (rules 5–6)", () => {
  it("rule 5: stale expectedVersion → reject", () => {
    expect(decideFullText("v2", { expectedVersion: "v1" })).toBe("reject");
  });

  it("rule 6: no guard → apply (last-writer-wins)", () => {
    expect(decideFullText("v2", {})).toBe("apply");
  });
});
