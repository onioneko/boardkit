import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { docVersion } from "../engine/version.js";
import { type WriteMiddleware, WriteRejection } from "../middleware/compose.js";
import type { Diagnostic } from "../model/diagnostic.js";
import type { Block } from "../model/doc.js";
import { asBlockId, asDocId } from "../model/ids.js";
import type { ComplexityLimits } from "../parse/complexity.js";
import { parseDoc } from "../parse/pipeline.js";
import { createMemStorage } from "../ports/mem.js";
import type { Storage } from "../ports/ports.js";
import {
  createDoc,
  type PatchDeltaFn,
  type PipelineDeps,
  patchDoc,
  removeDoc,
  type WriteResult,
  writeDoc,
} from "./pipeline.js";

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

const types = new Map<string, BlockType>([
  [
    "status",
    {
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
    },
  ],
  [
    "checklist",
    {
      type: "checklist",
      schema: { type: "object" },
      history: { attr: "recent", max: 2 },
    },
  ],
]);

function deps(): PipelineDeps & { storage: ReturnType<typeof createMemStorage> } {
  const storage = createMemStorage();
  return {
    storage,
    clock: () => "2026-08-21T00:00:00Z",
    blockTypes: types,
    parseOptions: { blockTypes: new Set(types.keys()) },
  };
}

const writer = { kind: "human", id: "u1" } as const;

/** A function delta (the affordance-style shape `patchDoc` now accepts) toggling one checklist item. */
function toggleItem(
  itemId: string,
): (currentAttrs: Readonly<Record<string, unknown>>) => Record<string, unknown> {
  return (currentAttrs) => {
    const items = (
      (currentAttrs.items as { id: string; label: string; done: boolean }[]) ?? []
    ).map((item) => (item.id === itemId ? { ...item, done: !item.done } : item));
    return { items };
  };
}

const checklistSrc =
  "```checklist\nid: c\nitems:\n  - {id: a, label: A, done: false}\n  - {id: b, label: B, done: false}\nrecent: []\n```\n";

/** Read the committed checklist's per-item `done` flags. */
async function checklistDone(storage: Storage, docId: string): Promise<Map<string, boolean>> {
  const raw = await storage.read(asDocId(docId));
  if (raw === undefined) throw new Error(`missing doc ${docId}`);
  const parsed = parseDoc(raw, { blockTypes: new Set(["checklist"]) });
  const block = parsed.nodes.find((n): n is Block => "blockId" in n);
  const items = (block?.attrs.items ?? []) as { id: string; done: boolean }[];
  return new Map(items.map((item) => [item.id, item.done]));
}

describe("writeDoc", () => {
  it("creates then updates a document, emitting events", async () => {
    const d = deps();
    const created = await createDoc(d, asDocId("fin"), writer, "# T\n");
    expect(created.ok).toBe(true);
    expect(successOf(created).events?.map((e) => e.type)).toEqual(["doc.created"]);

    const updated = await writeDoc(d, asDocId("fin"), writer, "# T\n\n## New\n\nx\n");
    expect(updated.ok).toBe(true);
    expect(successOf(updated).events?.map((e) => e.type)).toContain("doc.updated");
    expect(successOf(updated).events?.map((e) => e.type)).toContain("section.added");
    expect(successOf(updated).version).toBeDefined();
  });

  it("rejects writes to missing documents and duplicate creates", async () => {
    const d = deps();
    const missing = await writeDoc(d, asDocId("ghost"), writer, "# T");
    expect(missing.ok).toBe(false);
    expect(rejectionOf(missing).reason).toBe("missing-doc");
    await createDoc(d, asDocId("fin"), writer, "# T");
    const dup = await createDoc(d, asDocId("fin"), writer, "# T");
    expect(dup.ok).toBe(false);
    expect(rejectionOf(dup).reason).toBe("exists");
  });

  it("rejects stale full-text writes (rule 5)", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, "# T");
    const r = await writeDoc(d, asDocId("fin"), writer, "# T2", { expectedVersion: "bogus" });
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("stale-version");
  });

  it("rejects content that fails block schema validation", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, "# T");
    const bad = "```status\nid: d\nvalue: 42\nstates: []\n```\n";
    const r = await writeDoc(d, asDocId("fin"), writer, bad);
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).diagnostics.some((diag) => diag.code === "E_BLOCK_SCHEMA")).toBe(true);
  });

  it("accepts literal non-ref braces in prose", async () => {
    const d = deps();
    const src =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: deliberate literal `${{ ... }}` text, not a template
      '{{ user.name }} ${{ secrets.TOKEN }} {{#if admin}}…{{/if}} {{context}} {{}} {{"a":1}}';
    const r = await createDoc(d, asDocId("tmpl"), writer, src);
    expect(r.ok).toBe(true);
    expect(successOf(r).version).toBeDefined();
  });

  it("rejects malformed reserved refs", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, "# T");
    const a = await writeDoc(d, asDocId("fin"), writer, "{{source:}}");
    expect(a.ok).toBe(false);
    expect(rejectionOf(a).diagnostics.some((diag) => diag.code === "E_REF_SYNTAX")).toBe(true);
    const b = await writeDoc(d, asDocId("fin"), writer, "{{include:a#b#c}}");
    expect(b.ok).toBe(false);
    expect(rejectionOf(b).diagnostics.some((diag) => diag.code === "E_REF_SYNTAX")).toBe(true);
  });
});

describe("patchDoc", () => {
  const src = "```status\nid: d\nstates: [pending, approved]\nvalue: pending\n```\n";

  it("applies a valid patch and emits transition events", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await patchDoc(d, asDocId("fin"), asBlockId("d"), { value: "approved" }, writer);
    expect(r.ok).toBe(true);
    expect(successOf(r).events?.map((e) => e.type)).toContain("status.changed");
    const after = await d.storage.read(asDocId("fin"));
    expect(after).toContain("value: approved");
  });

  it("stamps `by` on every event emitted by a patch (audit: who changed what)", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const agent = { kind: "agent", id: "a1" } as const;
    const r = await patchDoc(d, asDocId("fin"), asBlockId("d"), { value: "approved" }, agent);
    expect(r.ok).toBe(true);
    const events = successOf(r).events ?? [];
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.by).toEqual({ kind: "agent", id: "a1" });
    }
    // The block.updated event carries the changed value alongside the paths.
    const updated = events.find((e) => e.type === "block.updated");
    expect(updated).toMatchObject({ changes: ["value"], values: { value: "approved" } });
  });

  it("rejects schema-violating patches without touching the document", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await patchDoc(d, asDocId("fin"), asBlockId("d"), { value: "bogus" }, writer);
    expect(r.ok).toBe(false);
    expect(
      rejectionOf(r).diagnostics.some(
        (diag) => diag.code === "E_STATUS_VALUE" || diag.code === "E_BLOCK_SCHEMA",
      ),
    ).toBe(true);
    expect(await d.storage.read(asDocId("fin"))).toBe(src);
  });

  it("value-CAS: stale version with matching expected → rebased apply", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const v1 = await patchDoc(d, asDocId("fin"), asBlockId("d"), { value: "approved" }, writer, {
      expectedVersion: "bogus",
      expected: { value: "pending" },
    });
    expect(v1.ok).toBe(true);
    expect(successOf(v1).rebased).toBe(true);
  });

  it("value-CAS: stale version with mismatching expected → reject with current", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await patchDoc(d, asDocId("fin"), asBlockId("d"), { value: "approved" }, writer, {
      expectedVersion: "bogus",
      expected: { value: "already-approved" },
    });
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("expected-mismatch");
    expect(rejectionOf(r).current).toMatchObject({ value: "pending" });
  });

  it("rejects patches to missing blocks and unregistered types", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const missing = await patchDoc(d, asDocId("fin"), asBlockId("nope"), { value: "x" }, writer);
    expect(missing.ok).toBe(false);
    expect(rejectionOf(missing).reason).toBe("missing-block");
  });

  it("enforces bounded history on patch", async () => {
    const d = deps();
    const doc = "```checklist\nid: c\nrecent: [a, b, c]\n```\n";
    await createDoc(d, asDocId("fin"), writer, doc);
    const r = await patchDoc(
      d,
      asDocId("fin"),
      asBlockId("c"),
      { recent: ["a", "b", "c", "d"] },
      writer,
    );
    expect(r.ok).toBe(true);
    expect(await d.storage.read(asDocId("fin"))).toContain("recent: [ c, d ]");
  });

  it("truncates multiple over-bound history blocks in one full-text write (descending spans, no drift)", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, "# T\n");
    const doc =
      "```checklist\nid: c1\nrecent: [a, b, c]\n```\n\ntext between\n\n```checklist\nid: c2\nrecent: [x, y, z, w]\n```\n";
    const r = await writeDoc(d, asDocId("fin"), writer, doc);
    expect(r.ok).toBe(true);
    const stored = await d.storage.read(asDocId("fin"));
    expect(stored).toContain("recent: [ b, c ]");
    expect(stored).toContain("recent: [ z, w ]");
    expect(stored).toContain("text between");
  });

  it("function delta: recomputes inside the lock so disjoint toggles both land", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, checklistSrc);
    const [toggleA, toggleB] = await Promise.all([
      patchDoc(d, asDocId("fin"), asBlockId("c"), toggleItem("a"), writer),
      patchDoc(d, asDocId("fin"), asBlockId("c"), toggleItem("b"), writer),
    ]);
    expect(toggleA.ok).toBe(true);
    expect(toggleB.ok).toBe(true);
    const done = await checklistDone(d.storage, "fin");
    expect(done.get("a")).toBe(true);
    expect(done.get("b")).toBe(true);
  });

  it("function delta: disjoint concurrent change rebases (rebased)", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, checklistSrc);
    const v1 = docVersion(checklistSrc);
    await patchDoc(d, asDocId("fin"), asBlockId("c"), toggleItem("a"), writer); // concurrent change
    const rebased = await patchDoc(d, asDocId("fin"), asBlockId("c"), toggleItem("b"), writer, {
      expectedVersion: v1,
      expected: {
        items: [
          { id: "a", label: "A", done: false },
          { id: "b", label: "B", done: false },
        ],
      },
    });
    expect(rebased.ok).toBe(true);
    expect(successOf(rebased).rebased).toBe(true);
  });

  it("function delta: overlapping concurrent change rejects with expected-mismatch", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, checklistSrc);
    const v1 = docVersion(checklistSrc);
    await patchDoc(d, asDocId("fin"), asBlockId("c"), toggleItem("b"), writer); // concurrent change on b
    const conflict = await patchDoc(d, asDocId("fin"), asBlockId("c"), toggleItem("b"), writer, {
      expectedVersion: v1,
      expected: {
        items: [
          { id: "a", label: "A", done: false },
          { id: "b", label: "B", done: false },
        ],
      },
    });
    expect(conflict.ok).toBe(false);
    expect(rejectionOf(conflict).reason).toBe("expected-mismatch");
    expect(rejectionOf(conflict).current).toMatchObject({
      items: [
        { id: "a", label: "A", done: false },
        { id: "b", label: "B", done: true },
      ],
    });
  });
});

describe("write middleware", () => {
  const withMiddleware = (middleware: readonly WriteMiddleware[]): PipelineDeps => ({
    ...deps(),
    middleware,
  });

  it("amend: middleware rewrites the proposed full text before commit", async () => {
    const d = withMiddleware([
      async (ctx, next) => {
        if (ctx.mode === "full") {
          ctx.proposed = {
            fullText: (ctx.proposed as { fullText: string }).fullText.replace("# T", "# T2"),
          };
        }
        await next();
      },
    ]);
    await createDoc(d, asDocId("fin"), writer, "# T");
    const r = await writeDoc(d, asDocId("fin"), writer, "# T");
    expect(r.ok).toBe(true);
    expect(await d.storage.read(asDocId("fin"))).toBe("# T2");
  });

  it("reject: a WriteRejection turns into a rejection result and leaves the document untouched", async () => {
    const d = withMiddleware([
      async () => {
        throw new WriteRejection("rate-limited", [{ code: "E_RATE_LIMIT", message: "slow down" }]);
      },
    ]);
    await d.storage.writeAtomic(asDocId("fin"), "# T");
    const r = await writeDoc(d, asDocId("fin"), writer, "# T2");
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("rate-limited");
    expect(rejectionOf(r).diagnostics.map((x) => x.code)).toEqual(["E_RATE_LIMIT"]);
    expect(await d.storage.read(asDocId("fin"))).toBe("# T");
  });

  it("observe: middleware reads ctx.result after next", async () => {
    const observed: boolean[] = [];
    const d = withMiddleware([
      async (ctx, next) => {
        await next();
        observed.push(ctx.result?.ok === true);
      },
    ]);
    await d.storage.writeAtomic(asDocId("fin"), "# T");
    await writeDoc(d, asDocId("fin"), writer, "# T2");
    expect(observed).toEqual([true]);
  });

  it("reject applies to patches too", async () => {
    const d = withMiddleware([
      async (ctx) => {
        if (ctx.mode === "patch") throw new WriteRejection("no-patches");
      },
    ]);
    await createDoc(
      d,
      asDocId("fin"),
      writer,
      "```status\nid: d\nstates: [pending]\nvalue: pending\n```\n",
    );
    const r = await patchDoc(d, asDocId("fin"), asBlockId("d"), { value: "pending" }, writer);
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("no-patches");
  });
});

describe("removeDoc", () => {
  it("removes documents and emits doc.removed; missing is rejected", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, "# T");
    const r = await removeDoc(d, asDocId("fin"), writer);
    expect(r.ok).toBe(true);
    expect(successOf(r).events?.map((e) => e.type)).toEqual(["doc.removed"]);
    expect(await d.storage.read(asDocId("fin"))).toBeUndefined();
    const missing = await removeDoc(d, asDocId("fin"), writer);
    expect(missing.ok).toBe(false);
  });

  it("rejects removal when the storage has no delete capability", async () => {
    const base = createMemStorage();
    await base.writeAtomic(asDocId("fin"), "# T");
    const { delete: _delete, ...noDeleteStorage } = base;
    const d = deps();
    const noDeleteDeps: PipelineDeps = { ...d, storage: noDeleteStorage };
    const r = await removeDoc(noDeleteDeps, asDocId("fin"), writer);
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("unsupported");
    expect(rejectionOf(r).diagnostics.map((diag) => diag.code)).toEqual(["E_UNSUPPORTED"]);
    // The document is untouched.
    expect(await base.read(asDocId("fin"))).toBe("# T");
  });
});

describe("createDoc/removeDoc write policy + middleware", () => {
  const withMiddleware = (middleware: readonly WriteMiddleware[]): PipelineDeps => ({
    ...deps(),
    middleware,
  });

  it("writePolicy.canWrite rejecting a writer blocks createDoc and removeDoc with reason write-domain", async () => {
    const d = deps();
    const modes: string[] = [];
    const policyDeps: PipelineDeps = {
      ...d,
      policy: {
        canWrite: (w, _docId, mode) => {
          modes.push(mode);
          return w.id !== "blocked";
        },
      },
    };
    const blocked = { kind: "human", id: "blocked" } as const;

    const created = await createDoc(policyDeps, asDocId("fin"), blocked, "# T");
    expect(created.ok).toBe(false);
    expect(rejectionOf(created).reason).toBe("write-domain");
    expect(await d.storage.read(asDocId("fin"))).toBeUndefined();

    await createDoc(policyDeps, asDocId("fin"), writer, "# T");
    const removed = await removeDoc(policyDeps, asDocId("fin"), blocked);
    expect(removed.ok).toBe(false);
    expect(rejectionOf(removed).reason).toBe("write-domain");
    expect(await d.storage.read(asDocId("fin"))).toBe("# T");

    expect(modes).toEqual(["create", "create", "remove"]);
  });

  it("a write middleware throwing WriteRejection blocks createDoc/removeDoc; the doc is untouched", async () => {
    const d = withMiddleware([
      async () => {
        throw new WriteRejection("rate-limited", [{ code: "E_RATE_LIMIT", message: "slow down" }]);
      },
    ]);

    const created = await createDoc(d, asDocId("fin"), writer, "# T");
    expect(created.ok).toBe(false);
    expect(rejectionOf(created).reason).toBe("rate-limited");
    expect(await d.storage.read(asDocId("fin"))).toBeUndefined();

    await d.storage.writeAtomic(asDocId("fin"), "# T");
    const removed = await removeDoc(d, asDocId("fin"), writer);
    expect(removed.ok).toBe(false);
    expect(rejectionOf(removed).reason).toBe("rate-limited");
    expect(await d.storage.read(asDocId("fin"))).toBe("# T");
  });

  it("middleware observes ctx.result (and mode) for createDoc and removeDoc", async () => {
    const seen: Array<{ mode: string; ok: boolean }> = [];
    const d = withMiddleware([
      async (ctx, next) => {
        await next();
        seen.push({ mode: ctx.mode, ok: ctx.result?.ok === true });
      },
    ]);
    await createDoc(d, asDocId("fin"), writer, "# T");
    await removeDoc(d, asDocId("fin"), writer);
    expect(seen).toEqual([
      { mode: "create", ok: true },
      { mode: "remove", ok: true },
    ]);
  });

  it("middleware can amend a create proposal (content)", async () => {
    const d = withMiddleware([
      async (ctx, next) => {
        if (ctx.mode === "create") ctx.proposed = { content: "# amended" };
        await next();
      },
    ]);
    await createDoc(d, asDocId("fin"), writer, "# T");
    expect(await d.storage.read(asDocId("fin"))).toBe("# amended");
  });

  it("doc.created and doc.removed carry by", async () => {
    const d = deps();
    const created = await createDoc(d, asDocId("fin"), writer, "# T");
    expect(successOf(created).events?.[0]?.by).toEqual({ kind: "human", id: "u1" });
    const removed = await removeDoc(d, asDocId("fin"), writer);
    expect(successOf(removed).events?.[0]?.by).toEqual({ kind: "human", id: "u1" });
  });
});

describe("patch proposal origin (intent-originated patches)", () => {
  const src = "```status\nid: d\nstates: [pending, approved, rejected]\nvalue: pending\n```\n";

  /** A function delta of the shape an affordance produces: set `value` from the params. */
  const transitionDelta: PatchDeltaFn = (_attrs, params) => ({
    value: (params as { to: string }).to,
  });

  const withMiddleware = (middleware: readonly WriteMiddleware[]): PipelineDeps => ({
    ...deps(),
    middleware,
  });

  it("exposes the origin affordance and params on the patch proposal", async () => {
    const seen: { affordance: string | undefined; params: unknown }[] = [];
    const d = withMiddleware([
      async (ctx, next) => {
        if (ctx.mode === "patch") {
          const proposed = ctx.proposed as { affordance?: string; params?: unknown };
          seen.push({ affordance: proposed.affordance, params: proposed.params });
        }
        await next();
      },
    ]);
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await patchDoc(
      d,
      asDocId("fin"),
      asBlockId("d"),
      transitionDelta,
      writer,
      {},
      {
        affordance: "transition",
        params: { to: "approved" },
      },
    );
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ affordance: "transition", params: { to: "approved" } }]);
    expect(await d.storage.read(asDocId("fin"))).toContain("value: approved");
  });

  it("leaves affordance and params absent for a patch with no origin", async () => {
    const seen: { affordance: string | undefined; params: unknown }[] = [];
    const d = withMiddleware([
      async (ctx, next) => {
        if (ctx.mode === "patch") {
          const proposed = ctx.proposed as { affordance?: string; params?: unknown };
          seen.push({ affordance: proposed.affordance, params: proposed.params });
        }
        await next();
      },
    ]);
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await patchDoc(d, asDocId("fin"), asBlockId("d"), { value: "approved" }, writer);
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ affordance: undefined, params: undefined }]);
  });

  it("calls a function delta with no origin as (currentAttrs, undefined)", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const calls: unknown[][] = [];
    const delta: PatchDeltaFn = (...args) => {
      calls.push(args);
      return { value: "approved" };
    };
    const r = await patchDoc(d, asDocId("fin"), asBlockId("d"), delta, writer);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({ id: "d", value: "pending" });
    expect(calls[0]).toHaveLength(2);
    expect(calls[0]?.[1]).toBeUndefined();
  });

  it("calls a function delta with an origin as (currentAttrs, params)", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const calls: unknown[][] = [];
    const delta: PatchDeltaFn = (...args) => {
      calls.push(args);
      return { value: "approved" };
    };
    const r = await patchDoc(
      d,
      asDocId("fin"),
      asBlockId("d"),
      delta,
      writer,
      {},
      {
        affordance: "transition",
        params: { to: "approved" },
      },
    );
    expect(r.ok).toBe(true);
    expect(calls[0]?.[1]).toEqual({ to: "approved" });
  });

  it("rejects an origin naming an affordance the block type does not declare", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await patchDoc(
      d,
      asDocId("fin"),
      asBlockId("d"),
      transitionDelta,
      writer,
      {},
      {
        affordance: "nope",
        params: { to: "approved" },
      },
    );
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("unknown-affordance");
    expect(rejectionOf(r).diagnostics.map((diag) => diag.code)).toEqual(["E_UNKNOWN_AFFORDANCE"]);
    expect(await d.storage.read(asDocId("fin"))).toBe(src);
  });

  it("validates the origin params against the affordance schema inside the lock", async () => {
    const d = deps();
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await patchDoc(
      d,
      asDocId("fin"),
      asBlockId("d"),
      transitionDelta,
      writer,
      {},
      {
        affordance: "transition",
        params: { to: 42 },
      },
    );
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("validation");
    expect(rejectionOf(r).diagnostics.map((diag) => diag.code)).toEqual(["E_PARAM_SCHEMA"]);
    expect(await d.storage.read(asDocId("fin"))).toBe(src);
  });

  it("honors params a middleware amended before next()", async () => {
    const d = withMiddleware([
      async (ctx, next) => {
        const proposed = ctx.proposed as { affordance?: string; params?: unknown };
        if (proposed.affordance === "transition") proposed.params = { to: "rejected" };
        await next();
      },
    ]);
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await patchDoc(
      d,
      asDocId("fin"),
      asBlockId("d"),
      transitionDelta,
      writer,
      {},
      {
        affordance: "transition",
        params: { to: "approved" },
      },
    );
    expect(r.ok).toBe(true);
    expect(await d.storage.read(asDocId("fin"))).toContain("value: rejected");
  });

  it("re-validates params a middleware amended (bad amendment rejects)", async () => {
    const d = withMiddleware([
      async (ctx, next) => {
        const proposed = ctx.proposed as { affordance?: string; params?: unknown };
        if (proposed.affordance === "transition") proposed.params = { to: 42 };
        await next();
      },
    ]);
    await createDoc(d, asDocId("fin"), writer, src);
    const r = await patchDoc(
      d,
      asDocId("fin"),
      asBlockId("d"),
      transitionDelta,
      writer,
      {},
      {
        affordance: "transition",
        params: { to: "approved" },
      },
    );
    expect(r.ok).toBe(false);
    expect(rejectionOf(r).reason).toBe("validation");
    expect(rejectionOf(r).diagnostics.map((diag) => diag.code)).toEqual(["E_PARAM_SCHEMA"]);
    expect(await d.storage.read(asDocId("fin"))).toBe(src);
  });
});

describe("complexity limits and parse failures (fail-soft)", () => {
  /** The issue repro: about 8 KB, far below the size limit, but 8,000 containers deep. */
  const deep = `# t\n\n${">".repeat(8000)} x\n`;
  const statusSrc = "```status\nid: s\nstates: [a, b]\nvalue: a\n```\n";

  it("rejects a create, write and patch of over-complex content with too-complex, never throwing", async () => {
    const d = deps();
    const created = createDoc(d, asDocId("deep"), writer, deep);
    await expect(created).resolves.toBeDefined();
    const c = rejectionOf(await created);
    expect(c.reason).toBe("too-complex");
    expect(c.diagnostics.map((x) => x.code)).toEqual(["E_DOCUMENT_TOO_COMPLEX"]);
    expect(await d.storage.read(asDocId("deep"))).toBeUndefined();

    successOf(await createDoc(d, asDocId("fin"), writer, statusSrc));
    const w = rejectionOf(await writeDoc(d, asDocId("fin"), writer, deep));
    expect(w.reason).toBe("too-complex");
    expect(await d.storage.read(asDocId("fin"))).toBe(statusSrc);

    // A stored over-complex document (written outside the pipeline) is never parsed.
    await d.storage.writeAtomic(asDocId("stored"), `${statusSrc}\n${deep}`);
    const p = rejectionOf(
      await patchDoc(d, asDocId("stored"), asBlockId("s"), { value: "b" }, writer),
    );
    expect(p.reason).toBe("too-complex");
    expect(p.diagnostics[0]?.message).toContain("not parsed");
  });

  it("with complexityLimits: false, a parse that throws is a validation rejection", async () => {
    const d: PipelineDeps & { storage: ReturnType<typeof createMemStorage> } = {
      ...deps(),
      complexityLimits: false,
    };
    const created = rejectionOf(await createDoc(d, asDocId("deep"), writer, deep));
    expect(created.reason).toBe("validation");
    expect(created.diagnostics.map((x) => x.code)).toEqual(["E_PARSE_FAILED"]);
    expect(await d.storage.read(asDocId("deep"))).toBeUndefined();

    successOf(await createDoc(d, asDocId("fin"), writer, statusSrc));
    const w = rejectionOf(await writeDoc(d, asDocId("fin"), writer, deep));
    expect(w.reason).toBe("validation");
    expect(w.diagnostics.map((x) => x.code)).toEqual(["E_PARSE_FAILED"]);

    await d.storage.writeAtomic(asDocId("stored"), `${statusSrc}\n${deep}`);
    const p = rejectionOf(
      await patchDoc(d, asDocId("stored"), asBlockId("s"), { value: "b" }, writer),
    );
    expect(p.reason).toBe("validation");
    expect(p.diagnostics.map((x) => x.code)).toEqual(["E_PARSE_FAILED"]);
  });

  it("honours custom limits", async () => {
    const d = { ...deps(), complexityLimits: { maxContainerDepth: 2 } };
    expect(rejectionOf(await createDoc(d, asDocId("a"), writer, "> > > x\n")).reason).toBe(
      "too-complex",
    );
    successOf(await createDoc(d, asDocId("b"), writer, "> > x\n"));
  });

  it("lets a full-text write that fits replace a stored over-complex document, logging a reset", async () => {
    const d = deps();
    await d.storage.writeAtomic(asDocId("fin"), deep);
    const r = successOf(await writeDoc(d, asDocId("fin"), writer, statusSrc));
    expect(r.events?.map((e) => e.type).slice(0, 2)).toEqual(["doc.removed", "doc.created"]);
    expect(await d.storage.read(asDocId("fin"))).toBe(statusSrc);
  });

  it("a write whose stored predecessor cannot be parsed still commits, logging a reset", async () => {
    const d = { ...deps(), complexityLimits: false as const };
    await d.storage.writeAtomic(asDocId("fin"), deep);
    const r = successOf(await writeDoc(d, asDocId("fin"), writer, statusSrc));
    expect(r.events?.map((e) => e.type).slice(0, 2)).toEqual(["doc.removed", "doc.created"]);
  });
});

describe("complexityLimits validation", () => {
  it("throws a TypeError for an invalid limits value, as createEngine does", async () => {
    for (const bad of [{ maxBracketDepth: "8" }, { maxBraketDepth: 8 }, true]) {
      const d = { ...deps(), complexityLimits: bad as unknown as ComplexityLimits };
      await expect(createDoc(d, asDocId("a"), writer, "# A\n")).rejects.toThrow(TypeError);
    }
  });
});
