import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { createEngine, type Engine } from "../engine/engine.js";
import type { Diagnostic } from "../model/diagnostic.js";
import { asDocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import type { Storage } from "../ports/ports.js";
import type { WriteMode, WriteResult } from "../write/pipeline.js";
import { type WriteMiddleware, WriteRejection } from "./compose.js";

/**
 * Integration: an intent-originated patch stays visible to write middleware.
 * The engine decodes affordances inside the write lock, so the proposal carries
 * the origin (`affordance`/`params`) a host policy needs to see — and amending
 * `params` before `next()` is re-validated and honored.
 */

/** Narrow a WriteResult to its rejection (throws when it unexpectedly succeeded). */
function rejectionOf(r: WriteResult): {
  readonly reason: string;
  readonly current?: unknown;
  readonly diagnostics: readonly Diagnostic[];
} {
  if (r.ok) throw new Error(`expected rejection, got success (version ${r.version})`);
  return r.rejection;
}

/** Narrow a WriteResult to its success (throws when it unexpectedly rejected). */
function successOf(r: WriteResult): Extract<WriteResult, { readonly ok: true }> {
  if (!r.ok) throw new Error(`expected success, got rejection (${r.rejection.reason})`);
  return r;
}

const statusType: BlockType = {
  type: "status",
  schema: {
    type: "object",
    required: ["id", "states", "value"],
    properties: {
      id: { type: "string" },
      states: { type: "array", items: { type: "string" } },
      value: { type: "string" },
    },
    additionalProperties: true,
  },
  transitions: [{ attr: "value", event: "status.changed" }],
  affordances: [
    {
      name: "transition",
      params: {
        type: "object",
        required: ["to"],
        properties: { to: { type: "string" } },
        additionalProperties: false,
      },
      patch: (_attrs, params) => ({ value: (params as { to: string }).to }),
    },
  ],
};

const src =
  "```status\nid: d\nstates: [pending, approved, rejected, executed]\nvalue: pending\n```\n";

const human = { kind: "human", id: "u1" } as const;
const agent = { kind: "agent", id: "a1" } as const;

/** An engine over a seeded in-memory workspace with the given write middleware. */
async function makeEngine(
  middleware: readonly WriteMiddleware[] = [],
): Promise<{ engine: Engine; storage: Storage }> {
  const storage = createMemStorage();
  const engine = createEngine({
    storage,
    clock: () => "2026-08-21T00:00:00Z",
    blocks: [statusType],
    middleware: { write: middleware },
  });
  await engine.createDoc("fin", { writer: human, content: src });
  return { engine, storage };
}

/** Read the committed `value` attr of the seeded status block. */
async function committedValue(storage: Storage): Promise<string> {
  const raw = await storage.read(asDocId("fin"));
  if (raw === undefined) throw new Error("missing doc fin");
  const match = /value: (\S+)/.exec(raw);
  if (match?.[1] === undefined) throw new Error(`no value attr in: ${raw}`);
  return match[1];
}

describe("intent-originated patch proposals", () => {
  it("observe: middleware sees mode, affordance, and params of an intent (and their absence on a direct patch)", async () => {
    const seen: { mode: WriteMode; affordance: string | undefined; params: unknown }[] = [];
    const { engine } = await makeEngine([
      async (ctx, next) => {
        if (ctx.mode === "patch") {
          const proposed = ctx.proposed as { affordance?: string; params?: unknown };
          seen.push({ mode: ctx.mode, affordance: proposed.affordance, params: proposed.params });
        }
        await next();
      },
    ]);

    const intent = await engine.applyIntent(
      { docId: "fin", blockId: "d", affordance: "transition", params: { to: "approved" } },
      { writer: human },
    );
    expect(intent.ok).toBe(true);
    const direct = await engine.patch("fin", "d", { writer: human, attrs: { value: "pending" } });
    expect(direct.ok).toBe(true);

    expect(seen).toEqual([
      { mode: "patch", affordance: "transition", params: { to: "approved" } },
      { mode: "patch", affordance: undefined, params: undefined },
    ]);
  });

  it("reject: a humans-only policy on the transition params blocks an agent's intent and passes a human's", async () => {
    const humansOnly: WriteMiddleware = async (ctx, next) => {
      const proposed = ctx.proposed as { affordance?: string; params?: { to?: unknown } };
      if (
        proposed.affordance === "transition" &&
        proposed.params?.to === "executed" &&
        ctx.writer.kind !== "human"
      ) {
        throw new WriteRejection("humans only", [
          { code: "E_POLICY", message: "only humans may transition to executed" },
        ]);
      }
      await next();
    };
    const { engine, storage } = await makeEngine([humansOnly]);

    const byAgent = await engine.applyIntent(
      { docId: "fin", blockId: "d", affordance: "transition", params: { to: "executed" } },
      { writer: agent },
    );
    expect(byAgent.ok).toBe(false);
    expect(rejectionOf(byAgent).reason).toBe("humans only");
    expect(rejectionOf(byAgent).diagnostics.map((d) => d.code)).toEqual(["E_POLICY"]);
    expect(await committedValue(storage)).toBe("pending");

    const byHuman = await engine.applyIntent(
      { docId: "fin", blockId: "d", affordance: "transition", params: { to: "executed" } },
      { writer: human },
    );
    expect(byHuman.ok).toBe(true);
    expect(await committedValue(storage)).toBe("executed");
  });

  it("amend: middleware rewriting params changes what commits and what the transition event reports", async () => {
    const { engine, storage } = await makeEngine([
      async (ctx, next) => {
        const proposed = ctx.proposed as { affordance?: string; params?: unknown };
        if (proposed.affordance === "transition") proposed.params = { to: "rejected" };
        await next();
      },
    ]);
    const r = await engine.applyIntent(
      { docId: "fin", blockId: "d", affordance: "transition", params: { to: "approved" } },
      { writer: human },
    );
    expect(r.ok).toBe(true);
    expect(await committedValue(storage)).toBe("rejected");
    const changed = successOf(r).events?.find((e) => e.type === "status.changed");
    expect(changed).toMatchObject({ from: "pending", to: "rejected" });
  });

  it("amended params are re-validated against the affordance schema", async () => {
    const { engine, storage } = await makeEngine([
      async (ctx, next) => {
        const proposed = ctx.proposed as { affordance?: string; params?: unknown };
        if (proposed.affordance === "transition") proposed.params = { to: 42 };
        await next();
      },
    ]);
    const r = await engine.applyIntent(
      { docId: "fin", blockId: "d", affordance: "transition", params: { to: "approved" } },
      { writer: human },
    );
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("validation");
    expect(rejectionOf(r).diagnostics.some((d) => d.code === "E_PARAM_SCHEMA")).toBe(true);
    expect(await committedValue(storage)).toBe("pending");
  });

  it("original params are still validated when no middleware runs", async () => {
    const { engine, storage } = await makeEngine();
    const r = await engine.applyIntent(
      { docId: "fin", blockId: "d", affordance: "transition", params: { to: 42 } },
      { writer: human },
    );
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("validation");
    expect(rejectionOf(r).diagnostics.some((d) => d.code === "E_PARAM_SCHEMA")).toBe(true);
    expect(await committedValue(storage)).toBe("pending");
  });

  it("concrete-delta path unchanged: a direct patch commits and emits its transition event", async () => {
    const { engine, storage } = await makeEngine();
    const r = await engine.patch("fin", "d", { writer: human, attrs: { value: "approved" } });
    expect(r.ok).toBe(true);
    expect(await committedValue(storage)).toBe("approved");
    expect(successOf(r).events?.map((e) => e.type)).toContain("status.changed");
  });
});
