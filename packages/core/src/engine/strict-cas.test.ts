import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { createMemStorage } from "../ports/mem.js";
import type { WriteResult } from "../write/pipeline.js";
import { createEngine, type EngineOptions } from "./engine.js";

/**
 * Strict value-CAS is the engine's default (#15): a present `expected` is
 * compared against the current attrs even when `expectedVersion` is current,
 * so a client holding a version and values from different snapshots is
 * refused. `strictExpected: false` (per call, per intent, or engine-wide)
 * restores the lax rules.
 */

const statusType: BlockType = {
  type: "status",
  schema: {
    type: "object",
    required: ["id", "value"],
    properties: { id: { type: "string" }, value: { type: "string" } },
  },
  affordances: [
    {
      name: "transition",
      params: { type: "object", required: ["to"], properties: { to: { type: "string" } } },
      patch: (_attrs, params) => ({ value: (params as { to: string }).to }),
    },
  ],
};

const writer = { kind: "human", id: "u1" } as const;
const src = "```status\nid: s\nvalue: pending\n```\n";

async function setup(extra: Partial<EngineOptions> = {}) {
  const engine = createEngine({
    storage: createMemStorage(),
    clock: () => "2026-10-04T00:00:00Z",
    blocks: [statusType],
    ...extra,
  });
  const created = await engine.createDoc("d", { writer, content: src });
  if (!created.ok) throw new Error("setup create failed");
  return { engine, version: created.version };
}

function reasonOf(r: WriteResult): string | undefined {
  return r.ok ? undefined : r.rejection.reason;
}

describe("strict value-CAS (engine default)", () => {
  it("patch: a current version with a stale expected is refused, and the doc is untouched", async () => {
    const { engine, version } = await setup();
    const r = await engine.patch("d", "s", {
      writer,
      attrs: { value: "done" },
      expectedVersion: version,
      expected: { value: "something-else" },
    });
    expect(reasonOf(r)).toBe("expected-mismatch");
    if (!r.ok) expect(r.rejection.current).toEqual({ id: "s", value: "pending" });
    expect((await engine.getDoc("d"))?.version).toBe(version);
  });

  it("patch: strictExpected: false applies it as 0.1 did", async () => {
    const { engine, version } = await setup();
    const r = await engine.patch("d", "s", {
      writer,
      attrs: { value: "done" },
      expectedVersion: version,
      expected: { value: "something-else" },
      strictExpected: false,
    });
    expect(r.ok).toBe(true);
    expect((await engine.getBlock("d", "s"))?.attrs.value).toBe("done");
  });

  it("patch: a matching expected with the current version applies", async () => {
    const { engine, version } = await setup();
    const r = await engine.patch("d", "s", {
      writer,
      attrs: { value: "done" },
      expectedVersion: version,
      expected: { value: "pending" },
    });
    expect(r.ok).toBe(true);
  });

  it("applyIntent: a current version with a stale expected is refused", async () => {
    const { engine, version } = await setup();
    const intent = {
      docId: "d",
      blockId: "s",
      affordance: "transition",
      params: { to: "done" },
      expectedVersion: version,
      expected: { value: "approved" },
    };
    expect(reasonOf(await engine.applyIntent(intent, { writer }))).toBe("expected-mismatch");
    const lax = await engine.applyIntent({ ...intent, strictExpected: false }, { writer });
    expect(lax.ok).toBe(true);
  });

  it("EngineOptions.strictExpected: false makes patch and applyIntent lax", async () => {
    const { engine, version } = await setup({ strictExpected: false });
    const r = await engine.applyIntent(
      {
        docId: "d",
        blockId: "s",
        affordance: "transition",
        params: { to: "done" },
        expectedVersion: version,
        expected: { value: "approved" },
      },
      { writer },
    );
    expect(r.ok).toBe(true);
  });

  it("a per-call strictExpected: true overrides an engine-wide false", async () => {
    const { engine, version } = await setup({ strictExpected: false });
    const r = await engine.patch("d", "s", {
      writer,
      attrs: { value: "done" },
      expectedVersion: version,
      expected: { value: "something-else" },
      strictExpected: true,
    });
    expect(reasonOf(r)).toBe("expected-mismatch");
  });
});
