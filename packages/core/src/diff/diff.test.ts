import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { asDocId } from "../model/ids.js";
import { parseDoc } from "../parse/pipeline.js";
import { diffDocs } from "./diff.js";
import { synthesizeEvents } from "./synthesize.js";

const types = new Map<string, BlockType>([
  [
    "status",
    {
      type: "status",
      schema: { type: "object" },
      transitions: [{ attr: "value", event: "status.changed" }],
    },
  ],
]);

const clock = () => "2026-08-21T00:00:00Z";

describe("diffDocs", () => {
  it("detects added, removed, and attr-changed nodes", () => {
    const before = parseDoc("# A\n\n```status\nid: d\nvalue: pending\n```\n", {
      blockTypes: new Set(["status"]),
    });
    const after = parseDoc(
      "# A\n\n```status\nid: d\nvalue: approved\n```\n\n```status\nid: d2\nvalue: x\n```\n",
      {
        blockTypes: new Set(["status"]),
      },
    );
    const diff = diffDocs(before, after);
    expect(
      diff.added.filter((n) => "blockId" in n).map((n) => ("blockId" in n ? n.blockId : "")),
    ).toEqual(["d2"]);
    expect(diff.removed).toHaveLength(0);
    expect(diff.attrChanges).toHaveLength(1);
    expect(diff.attrChanges[0]?.changes).toEqual([
      { path: "value", from: "pending", to: "approved" },
    ]);
  });

  it("reports a section whose prose changed (sectionChanges)", () => {
    const before = parseDoc("## Summary\n\nold prose\n", {});
    const after = parseDoc("## Summary\n\nnew prose\n", {});
    const diff = diffDocs(before, after);
    expect(diff.sectionChanges.map((c) => c.section.sectionId)).toEqual(["summary"]);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("does not report block-only changes as sectionChanges", () => {
    const before = parseDoc("## Large\n\n```status\nid: d\nvalue: pending\n```\n", {
      blockTypes: new Set(["status"]),
    });
    const after = parseDoc("## Large\n\n```status\nid: d\nvalue: approved\n```\n", {
      blockTypes: new Set(["status"]),
    });
    const diff = diffDocs(before, after);
    expect(diff.attrChanges).toHaveLength(1);
    expect(diff.sectionChanges).toHaveLength(0);
  });
});

describe("synthesizeEvents", () => {
  it("emits core events and block-declared transition events", () => {
    const before = parseDoc("```status\nid: d\nvalue: pending\n```", {
      blockTypes: new Set(["status"]),
    });
    const after = parseDoc("```status\nid: d\nvalue: approved\n```", {
      blockTypes: new Set(["status"]),
    });
    const events = synthesizeEvents(diffDocs(before, after), asDocId("fin"), {
      clock,
      blockTypes: types,
    });
    const types2 = events.map((e) => e.type);
    expect(types2).toContain("doc.updated");
    expect(types2).toContain("block.updated");
    expect(types2).toContain("status.changed");
    const transition = events.find((e) => e.type === "status.changed");
    expect(transition).toMatchObject({
      docId: "fin",
      blockId: "d",
      from: "pending",
      to: "approved",
    });
  });

  it("emits added/removed core events", () => {
    const before = parseDoc("", {});
    const after = parseDoc("## New\n\ncontent", {});
    const events = synthesizeEvents(diffDocs(before, after), asDocId("fin"), {
      clock,
      blockTypes: types,
    });
    expect(events.some((e) => e.type === "section.added")).toBe(true);
  });

  it("emits section.changed (and doc.updated) when a section's prose changes", () => {
    const before = parseDoc("## Summary\n\nold prose\n", {});
    const after = parseDoc("## Summary\n\nnew prose\n", {});
    const events = synthesizeEvents(diffDocs(before, after), asDocId("fin"), {
      clock,
      blockTypes: types,
    });
    const changed = events.find((e) => e.type === "section.changed");
    expect(changed).toMatchObject({ docId: "fin", sectionId: "summary" });
    // The prose edit is also surfaced as a document-level update.
    expect(events.some((e) => e.type === "doc.updated")).toBe(true);
  });

  it("emits only section.added for a newly added section (no spurious section.changed)", () => {
    const before = parseDoc("## Summary\n\nprose\n", {});
    const after = parseDoc("## Summary\n\nprose\n\n## New\n\nmore\n", {});
    const events = synthesizeEvents(diffDocs(before, after), asDocId("fin"), {
      clock,
      blockTypes: types,
    });
    const newSectionEvents = events.filter((e) => e.sectionId === "new").map((e) => e.type);
    expect(newSectionEvents).toEqual(["section.added"]);
  });

  it("emits only section.removed for a removed section (no spurious section.changed)", () => {
    const before = parseDoc("## Summary\n\nprose\n\n## Old\n\nstuff\n", {});
    const after = parseDoc("## Summary\n\nprose\n", {});
    const events = synthesizeEvents(diffDocs(before, after), asDocId("fin"), {
      clock,
      blockTypes: types,
    });
    const oldSectionEvents = events.filter((e) => e.sectionId === "old").map((e) => e.type);
    expect(oldSectionEvents).toEqual(["section.removed"]);
  });

  it("emits section.changed when an include span is added inside a section", () => {
    const before = parseDoc("## Ref\n\nplain prose\n", {});
    const after = parseDoc("## Ref\n\nplain prose\n\n{{include:research/q3-review#summary}}\n", {});
    const events = synthesizeEvents(diffDocs(before, after), asDocId("fin"), {
      clock,
      blockTypes: types,
    });
    expect(events.some((e) => e.type === "section.changed" && e.sectionId === "ref")).toBe(true);
  });

  it("stamps `by` on section.changed like the other synthesized events", () => {
    const before = parseDoc("## Summary\n\nold\n", {});
    const after = parseDoc("## Summary\n\nnew\n", {});
    const agent = { kind: "agent", id: "a1" } as const;
    const events = synthesizeEvents(diffDocs(before, after), asDocId("fin"), {
      clock,
      blockTypes: types,
      writer: agent,
    });
    const changed = events.find((e) => e.type === "section.changed");
    expect(changed?.by).toEqual({ kind: "agent", id: "a1" });
  });

  it("stamps `by` on every synthesized event", () => {
    const before = parseDoc("```status\nid: d\nvalue: pending\n```", {
      blockTypes: new Set(["status"]),
    });
    const after = parseDoc("```status\nid: d\nvalue: approved\n```", {
      blockTypes: new Set(["status"]),
    });
    const agent = { kind: "agent", id: "a1" } as const;
    const events = synthesizeEvents(diffDocs(before, after), asDocId("fin"), {
      clock,
      blockTypes: types,
      writer: agent,
    });
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.by).toEqual({ kind: "agent", id: "a1" });
  });

  it("block.updated keeps changes paths and adds the changed values", () => {
    const before = parseDoc("```status\nid: d\nvalue: pending\n```", {
      blockTypes: new Set(["status"]),
    });
    const after = parseDoc("```status\nid: d\nvalue: approved\n```", {
      blockTypes: new Set(["status"]),
    });
    const events = synthesizeEvents(diffDocs(before, after), asDocId("fin"), {
      clock,
      blockTypes: types,
      writer: { kind: "human", id: "u1" } as const,
    });
    const updated = events.find((e) => e.type === "block.updated");
    expect(updated).toMatchObject({ changes: ["value"], values: { value: "approved" } });
  });
});
