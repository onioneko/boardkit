import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { createMemStorage } from "../ports/mem.js";
import { createEngine } from "./engine.js";

/**
 * Two refusals of `Engine.applyIntent` and `Engine.patch` that leave the
 * document and the event log untouched: an intent whose delta changes nothing
 * (`no-change`), and a patch that would give a block another block's id
 * (`E_PATCH_ID_TAKEN`).
 */

const writer = { kind: "human", id: "u1" } as const;
const clock = (): string => "2026-10-11T00:00:00Z";

const lampType: BlockType = {
  type: "lamp",
  schema: {
    type: "object",
    required: ["id", "on"],
    properties: { id: { type: "string" }, on: { type: "boolean" } },
    additionalProperties: false,
  },
  affordances: [{ name: "light", patch: (attrs) => (attrs.on === true ? {} : { on: true }) }],
};

const statusType: BlockType = {
  type: "status",
  schema: {
    type: "object",
    required: ["id", "value"],
    properties: { id: { type: "string" }, value: { type: "string" } },
  },
};

describe("Engine.applyIntent: an intent that changes nothing", () => {
  it("is refused with no-change, and nothing is written or emitted", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock, blocks: [lampType] });
    const content = "# Room\n\n```lamp\nid: desk\non: true\n```\n";
    await engine.createDoc("room", { writer, content });
    const before = await engine.getDoc("room");
    const eventsBefore = storage.getEvents().length;
    const block = await engine.getBlock("room", "desk");
    if (block === undefined) throw new Error("no block");

    const r = await engine.applyIntent(
      {
        docId: "room",
        blockId: "desk",
        affordance: "light",
        expectedVersion: block.version,
        expected: block.attrs,
      },
      { writer },
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.reason).toBe("no-change");
    expect(r.rejection.diagnostics.map((d) => d.code)).toEqual(["E_INTENT_NO_CHANGE"]);
    expect(r.rejection.current).toEqual({ id: "desk", on: true });
    expect((await engine.getDoc("room"))?.version).toBe(before?.version);
    expect(storage.getEvents()).toHaveLength(eventsBefore);
  });

  it("still commits the same intent when it changes a value", async () => {
    const engine = createEngine({ storage: createMemStorage(), clock, blocks: [lampType] });
    await engine.createDoc("room", { writer, content: "```lamp\nid: desk\non: false\n```\n" });
    const r = await engine.applyIntent(
      { docId: "room", blockId: "desk", affordance: "light" },
      { writer },
    );
    expect(r.ok).toBe(true);
    expect((await engine.getBlock("room", "desk"))?.attrs.on).toBe(true);
  });
});

describe("Engine.patch: block ids stay unique within a document", () => {
  const content = "# D\n\n```status\nid: a\nvalue: x\n```\n\n```status\nid: b\nvalue: x\n```\n";

  it("refuses a rename onto another block's id, leaving the document untouched", async () => {
    const storage = createMemStorage();
    const engine = createEngine({ storage, clock, blocks: [statusType] });
    await engine.createDoc("d", { writer, content });
    const eventsBefore = storage.getEvents().length;

    const r = await engine.patch("d", "b", { writer, attrs: { id: "a" } });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rejection.reason).toBe("patch");
    expect(r.rejection.diagnostics.map((d) => d.code)).toEqual(["E_PATCH_ID_TAKEN"]);
    expect((await engine.getDoc("d"))?.src).toBe(content);
    expect(storage.getEvents()).toHaveLength(eventsBefore);
  });

  it("accepts a rename to an unused id", async () => {
    const engine = createEngine({ storage: createMemStorage(), clock, blocks: [statusType] });
    await engine.createDoc("d", { writer, content });
    const r = await engine.patch("d", "b", { writer, attrs: { id: "c" } });
    expect(r.ok).toBe(true);
    expect(await engine.getBlock("d", "b")).toBeUndefined();
    expect((await engine.getBlock("d", "c"))?.attrs).toEqual({ id: "c", value: "x" });
  });
});
