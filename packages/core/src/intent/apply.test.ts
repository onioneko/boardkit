import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { docVersion } from "../engine/version.js";
import type { Diagnostic } from "../model/diagnostic.js";
import type { Block } from "../model/doc.js";
import { asBlockId, asDocId } from "../model/ids.js";
import { parseDoc } from "../parse/pipeline.js";
import { createMemStorage } from "../ports/mem.js";
import type { Storage } from "../ports/ports.js";
import { createDoc, type PipelineDeps, type WriteResult } from "../write/pipeline.js";
import { applyIntent } from "./apply.js";

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
  validate: (attrs: unknown) => {
    if (typeof attrs !== "object" || attrs === null) return [];
    const { value, states } = attrs as { value?: unknown; states?: unknown };
    if (Array.isArray(states) && typeof value === "string" && !states.includes(value)) {
      return [{ code: "E_STATUS_VALUE", message: `value "${value}" is not in states` }];
    }
    return [];
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

const src = "```status\nid: d\nstates: [pending, approved]\nvalue: pending\n```\n";

/** The same status block with a third state, for amend-to-`rejected` cases. */
const threeStateSrc =
  "```status\nid: d\nstates: [pending, approved, rejected]\nvalue: pending\n```\n";

/** A block type whose affordance declares no params schema (intents may omit params). */
const counterType: BlockType = {
  type: "counter",
  schema: { type: "object" },
  affordances: [{ name: "bump", patch: (attrs) => ({ n: ((attrs.n as number) ?? 0) + 1 }) }],
};

const noParamsSrc = "```counter\nid: n\nn: 0\n```\n";

interface CheckItem {
  id: string;
  label: string;
  done: boolean;
}

const checklistType: BlockType = {
  type: "checklist",
  schema: { type: "object" },
  affordances: [
    {
      name: "toggle",
      params: {
        type: "object",
        required: ["itemId"],
        properties: { itemId: { type: "string" } },
        additionalProperties: false,
      },
      patch: (attrs, params) => {
        const itemId = (params as { itemId: string }).itemId;
        const items = ((attrs.items as CheckItem[]) ?? []).map((item) =>
          item.id === itemId ? { ...item, done: !item.done } : item,
        );
        return { items };
      },
    },
  ],
};

const checklistSrc =
  "```checklist\nid: c\nitems:\n  - {id: a, label: A, done: false}\n  - {id: b, label: B, done: false}\n```\n";

/** The checklist's `items` at V1 (before either toggle) — the whole-array `expected` an html projection embeds. */
const staleItems: CheckItem[] = [
  { id: "a", label: "A", done: false },
  { id: "b", label: "B", done: false },
];

/** Read the committed checklist's per-item `done` flags. */
async function checklistDone(storage: Storage, docId: string): Promise<Map<string, boolean>> {
  const raw = await storage.read(asDocId(docId));
  if (raw === undefined) throw new Error(`missing doc ${docId}`);
  const parsed = parseDoc(raw, { blockTypes: new Set(["checklist"]) });
  const block = parsed.nodes.find((n): n is Block => "blockId" in n);
  const items = (block?.attrs.items ?? []) as CheckItem[];
  return new Map(items.map((item) => [item.id, item.done]));
}

function deps(): PipelineDeps {
  const storage = createMemStorage();
  return {
    storage,
    clock: () => "2026-08-21T00:00:00Z",
    blockTypes: new Map([
      ["status", statusType],
      ["checklist", checklistType],
      ["counter", counterType],
    ]),
    parseOptions: { blockTypes: new Set(["status", "checklist", "counter"]) },
  };
}

const writer = { kind: "human", id: "u1" } as const;

describe("applyIntent", () => {
  it("decodes an affordance into a patch and applies it", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("d"),
        affordance: "transition",
        params: { to: "approved" },
      },
      writer,
    );
    expect(r.ok).toBe(true);
    expect(successOf(r).events?.map((e) => e.type)).toContain("status.changed");
    expect(await d.storage.read(asDocId("fin"))).toContain("value: approved");
  });

  it("threads CAS guards (value-CAS rebase on stale version)", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("d"),
        affordance: "transition",
        params: { to: "approved" },
        expectedVersion: "bogus",
        expected: { value: "pending" },
      },
      writer,
    );
    expect(r.ok).toBe(true);
    expect(successOf(r).rebased).toBe(true);
  });

  it("rejects unknown affordances", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await applyIntent(
      d,
      { docId: asDocId("fin"), blockId: asBlockId("d"), affordance: "nope", params: {} },
      writer,
    );
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).diagnostics.map((diag) => diag.code)).toEqual(["E_UNKNOWN_AFFORDANCE"]);
  });

  it("rejects params that violate the affordance's static schema", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("d"),
        affordance: "transition",
        params: { to: 42 },
      },
      writer,
    );
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("validation");
    expect(rejectionOf(r).diagnostics.map((diag) => diag.code)).toEqual(["E_PARAM_SCHEMA"]);
  });

  it("rejects transitions to states outside the block's own list (cross-field hook)", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("d"),
        affordance: "transition",
        params: { to: "bogus" },
      },
      writer,
    );
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).diagnostics.map((diag) => diag.code)).toEqual(["E_STATUS_VALUE"]);
  });

  it("rejects intents targeting missing documents", async () => {
    const d = deps();
    const r = await applyIntent(
      d,
      {
        docId: asDocId("ghost"),
        blockId: asBlockId("d"),
        affordance: "transition",
        params: { to: "approved" },
      },
      writer,
    );
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("missing-doc");
  });

  it("rejects intents targeting missing blocks", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("nope"),
        affordance: "transition",
        params: { to: "approved" },
      },
      writer,
    );
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("missing-block");
  });

  it("commutes concurrent toggles on different items (no lost update)", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, checklistSrc);
    const [toggleA, toggleB] = await Promise.all([
      applyIntent(
        d,
        {
          docId: asDocId("fin"),
          blockId: asBlockId("c"),
          affordance: "toggle",
          params: { itemId: "a" },
        },
        writer,
      ),
      applyIntent(
        d,
        {
          docId: asDocId("fin"),
          blockId: asBlockId("c"),
          affordance: "toggle",
          params: { itemId: "b" },
        },
        writer,
      ),
    ]);
    expect(toggleA.ok).toBe(true);
    expect(toggleB.ok).toBe(true);
    const done = await checklistDone(d.storage, "fin");
    expect(done.get("a")).toBe(true);
    expect(done.get("b")).toBe(true);
  });

  it("function-delta rebase: disjoint concurrent change commutes (rebased)", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, checklistSrc);
    const v1 = docVersion(checklistSrc);
    const concurrent = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("c"),
        affordance: "toggle",
        params: { itemId: "a" },
      },
      writer,
    );
    expect(concurrent.ok).toBe(true);
    const rebased = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("c"),
        affordance: "toggle",
        params: { itemId: "b" },
        expectedVersion: v1,
        expected: { items: staleItems },
      },
      writer,
    );
    expect(rebased.ok).toBe(true);
    expect(successOf(rebased).rebased).toBe(true);
    const done = await checklistDone(d.storage, "fin");
    expect(done.get("a")).toBe(true);
    expect(done.get("b")).toBe(true);
  });

  it("function-delta conflict: concurrent change on the same item rejects (expected-mismatch)", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, checklistSrc);
    const v1 = docVersion(checklistSrc);
    const concurrent = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("c"),
        affordance: "toggle",
        params: { itemId: "b" },
      },
      writer,
    );
    expect(concurrent.ok).toBe(true);
    const conflict = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("c"),
        affordance: "toggle",
        params: { itemId: "b" },
        expectedVersion: v1,
        expected: { items: staleItems },
      },
      writer,
    );
    expect(conflict.ok).toBe(false);
    expect(rejectionOf(conflict).reason).toBe("expected-mismatch");
    expect(rejectionOf(conflict).current).toMatchObject({
      items: [
        { id: "a", label: "A", done: false },
        { id: "b", label: "B", done: true },
      ],
    });
  });

  it("E2: two whole-array expected payloads on different items both commute", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, checklistSrc);
    const guard = { expectedVersion: docVersion(checklistSrc), expected: { items: staleItems } };
    const [toggleA, toggleB] = await Promise.all([
      applyIntent(
        d,
        {
          docId: asDocId("fin"),
          blockId: asBlockId("c"),
          affordance: "toggle",
          params: { itemId: "a" },
          ...guard,
        },
        writer,
      ),
      applyIntent(
        d,
        {
          docId: asDocId("fin"),
          blockId: asBlockId("c"),
          affordance: "toggle",
          params: { itemId: "b" },
          ...guard,
        },
        writer,
      ),
    ]);
    expect(toggleA.ok).toBe(true);
    expect(toggleB.ok).toBe(true);
    const done = await checklistDone(d.storage, "fin");
    expect(done.get("a")).toBe(true);
    expect(done.get("b")).toBe(true);
  });

  it("function-delta: stale expectedVersion without expected rejects (stale-version)", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, checklistSrc);
    const concurrent = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("c"),
        affordance: "toggle",
        params: { itemId: "a" },
      },
      writer,
    );
    expect(concurrent.ok).toBe(true);
    const stale = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("c"),
        affordance: "toggle",
        params: { itemId: "b" },
        expectedVersion: docVersion(checklistSrc),
      },
      writer,
    );
    expect(stale.ok).toBe(false);
    expect(rejectionOf(stale).reason).toBe("stale-version");
  });
});

describe("applyIntent × write middleware (proposal origin)", () => {
  it("hands the intent's affordance and params to middleware as the proposal origin", async () => {
    const seen: { mode: string; affordance: string | undefined; params: unknown }[] = [];
    const d: PipelineDeps = {
      ...deps(),
      middleware: [
        async (ctx, next) => {
          if (ctx.mode === "patch") {
            const proposed = ctx.proposed as { affordance?: string; params?: unknown };
            seen.push({ mode: ctx.mode, affordance: proposed.affordance, params: proposed.params });
          }
          await next();
        },
      ],
    };
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("d"),
        affordance: "transition",
        params: { to: "approved" },
      },
      writer,
    );
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ mode: "patch", affordance: "transition", params: { to: "approved" } }]);
  });

  it("omits params from the proposal when the intent carries none", async () => {
    const seen: { hasParams: boolean; params: unknown }[] = [];
    const d: PipelineDeps = {
      ...deps(),
      middleware: [
        async (ctx, next) => {
          if (ctx.mode === "patch") {
            const proposed = ctx.proposed as Record<string, unknown>;
            seen.push({ hasParams: Object.hasOwn(proposed, "params"), params: proposed.params });
          }
          await next();
        },
      ],
    };
    await createDoc(d, asDocId("fin"), writer, noParamsSrc);
    const r = await applyIntent(
      d,
      { docId: asDocId("fin"), blockId: asBlockId("n"), affordance: "bump" },
      writer,
    );
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ hasParams: false, params: undefined }]);
  });

  it("commits the params a middleware amended (re-decoded and re-validated)", async () => {
    const d: PipelineDeps = {
      ...deps(),
      middleware: [
        async (ctx, next) => {
          const proposed = ctx.proposed as { affordance?: string; params?: unknown };
          if (proposed.affordance === "transition") proposed.params = { to: "rejected" };
          await next();
        },
      ],
    };
    await createDoc(d, asDocId("fin"), writer, threeStateSrc);
    const r = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("d"),
        affordance: "transition",
        params: { to: "approved" },
      },
      writer,
    );
    expect(r.ok).toBe(true);
    expect(await d.storage.read(asDocId("fin"))).toContain("value: rejected");
  });

  it("rejects params a middleware amended into a schema violation", async () => {
    const d: PipelineDeps = {
      ...deps(),
      middleware: [
        async (ctx, next) => {
          const proposed = ctx.proposed as { affordance?: string; params?: unknown };
          if (proposed.affordance === "transition") proposed.params = { to: 42 };
          await next();
        },
      ],
    };
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await applyIntent(
      d,
      {
        docId: asDocId("fin"),
        blockId: asBlockId("d"),
        affordance: "transition",
        params: { to: "approved" },
      },
      writer,
    );
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("validation");
    expect(rejectionOf(r).diagnostics.map((diag) => diag.code)).toEqual(["E_PARAM_SCHEMA"]);
    expect(await d.storage.read(asDocId("fin"))).toBe(src);
  });
});
