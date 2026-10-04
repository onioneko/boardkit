import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import type { MergedTree } from "../link/merge.js";
import { type ProjectionMiddleware, WriteRejection } from "../middleware/compose.js";
import type { ParsedDoc } from "../model/doc.js";
import { asDocId } from "../model/ids.js";
import { createMemStorage } from "../ports/mem.js";
import type { EventRecord, EventSink, Lock, Source, SourceValue } from "../ports/ports.js";
import { textProjector } from "../project/text.js";
import { createEngine, type ProjectionInput, type Projector } from "./engine.js";
import { docVersion } from "./version.js";

const q3review = readFileSync(
  fileURLToPath(new URL("../../test/fixtures/research/q3-review.md", import.meta.url)),
  "utf8",
);

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
  project: {
    text: (attrs) => `**STATUS**: ${String(attrs.value ?? "")}`,
    html: (attrs) => ({
      type: "element",
      tagName: "span",
      properties: { className: ["status"] },
      children: [{ type: "text", value: String(attrs.value ?? "") }],
    }),
  },
};

const source: Source = {
  resolve: async (r) => {
    if (r.source === "cash") return { value: "¥100", stale: false };
    return { value: "—", stale: false };
  },
};

const writer = { kind: "human", id: "u1" } as const;

function makeEngine(projectionMiddleware?: readonly ProjectionMiddleware[]) {
  const storage = createMemStorage();
  const engine = createEngine({
    storage,
    clock: () => "2026-08-21T00:00:00Z",
    blocks: [statusType],
    parseOptions: { blockTypes: new Set(["status"]) },
    ...(projectionMiddleware !== undefined
      ? { middleware: { projection: projectionMiddleware } }
      : {}),
  });
  return { storage, engine };
}

/** A block type registered only at runtime, to exercise `registerBlock`'s cache invalidation. */
const lateStatusType: BlockType = {
  type: "status",
  schema: {
    type: "object",
    required: ["id", "value"],
    properties: { id: { type: "string" }, value: { type: "string" } },
    additionalProperties: true,
  },
  project: { text: (attrs) => `STATUS ${String(attrs.value ?? "")}` },
};

/** A body whose `status` fence becomes a block only once `lateStatusType` is registered. */
const lateStatusSrc = "```status\nid: s1\nvalue: pending\n```\n";

/** An engine with no block types (so `registerBlock` is the only way a fence is recognized). */
function engineWithoutBlocks() {
  const storage = createMemStorage();
  const engine = createEngine({ storage, clock: () => "2026-08-21T00:00:00Z" });
  return { storage, engine };
}

/** Narrow a `ProjectionResult<unknown>`'s output to a string (built-in projectors return strings). */
function stringOutput(result: { readonly output: unknown }): string {
  if (typeof result.output !== "string") throw new Error("expected a string projection output");
  return result.output;
}

describe("engine (integration)", () => {
  it("runs the full lifecycle: create → project → patch via intent → events replay", async () => {
    const { storage, engine } = makeEngine();
    const src =
      "## Now\n\ncash: {{source:cash}}\n\n```status\nid: d\nstates: [pending, approved]\nvalue: pending\n```\n";

    const created = await engine.createDoc("fin", { writer, content: src });
    expect(created.ok).toBe(true);

    const projection = await engine.projection("fin", "text", { source });
    expect(projection.ok).toBe(true);
    expect(projection.output).toContain("cash: ¥100");
    expect(projection.output).toContain("**STATUS**: pending");
    expect(projection.diagnostics).toEqual([]);
    expect(projection.versions.fin).toBeDefined();

    const intent = await engine.applyIntent(
      { docId: "fin", blockId: "d", affordance: "transition", params: { to: "approved" } },
      { writer },
    );
    if (!intent.ok) throw new Error("expected intent ok");
    expect(intent.events?.map((e) => e.type)).toContain("status.changed");

    const replay: EventRecord[] = [];
    for await (const evt of engine.events({ afterSeq: 0 })) replay.push(evt);
    expect(replay.map((e) => e.type)).toEqual(
      expect.arrayContaining(["doc.created", "status.changed"]),
    );

    const graph = await engine.refGraph("fin");
    expect(graph.docs).toEqual(["fin"]);

    expect(await storage.read(asDocId("fin"))).toContain("value: approved");
  });

  it("delivers global and doc-scoped subscriptions on writes", async () => {
    const { engine } = makeEngine();
    const global: string[] = [];
    const scoped: string[] = [];
    const offGlobal = engine.subscribe((evt) => global.push(evt.type));
    const offScoped = engine.subscribe("fin", (evt) => scoped.push(evt.type));

    await engine.createDoc("fin", { writer, content: "# T" });
    await engine.createDoc("other", { writer, content: "# O" });

    expect(global).toEqual(["doc.created", "doc.created"]);
    expect(scoped).toEqual(["doc.created"]);

    offGlobal();
    offScoped();
    await engine.write("fin", { writer, fullText: "# T2" });
    expect(global).toEqual(["doc.created", "doc.created"]);
  });

  it("reports unknown projectors and missing docs without throwing", async () => {
    const { engine } = makeEngine();
    const unknown = await engine.projection("ghost", "text", { source });
    expect(unknown.ok).toBe(false);
    expect(unknown.diagnostics.map((d) => d.code)).toEqual(["E_DOC_MISSING"]);

    await engine.createDoc("fin", { writer, content: "# T" });
    const badProjector = await engine.projection("fin", "nope", { source });
    expect(badProjector.ok).toBe(false);
    expect(badProjector.diagnostics.map((d) => d.code)).toEqual(["E_UNKNOWN_PROJECTOR"]);
  });

  it("registers `text` and nothing else by default: `html` is an unknown projector id", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T" });

    // `html` ships in @onioneko/boardkit-html and is registered by the consumer. Asking
    // a default engine for it fails exactly the way any unregistered id does —
    // no special case, no hint that a package is missing.
    const html = await engine.projection("fin", "html", { source });
    const nope = await engine.projection("fin", "nope", { source });
    expect(html.ok).toBe(false);
    expect(html.output).toBe("");
    expect(html.diagnostics.map((d) => d.code)).toEqual(["E_UNKNOWN_PROJECTOR"]);
    expect(html.diagnostics.map((d) => d.message)).toEqual(["unknown projector: html"]);
    expect(nope.diagnostics.map((d) => d.code)).toEqual(html.diagnostics.map((d) => d.code));
  });

  it("replaces the default set when `projectors` is passed, keeping `text` only if it is listed", async () => {
    // A tiny inline fake stands in for a second projector: engine-level tests
    // never reach for @onioneko/boardkit-html (core must not depend on it, even in dev).
    const fake: Projector<string> = { id: "fake", project: (input) => `<${input.src}>` };

    const only = createEngine({
      storage: createMemStorage(),
      clock: () => "2026-08-21T00:00:00Z",
      projectors: [fake],
    });
    await only.createDoc("fin", { writer, content: "# T" });
    expect((await only.projection("fin", "text", { source })).ok).toBe(false);
    expect((await only.projection("fin", "fake", { source })).output).toBe("<# T>");

    const both = createEngine({
      storage: createMemStorage(),
      clock: () => "2026-08-21T00:00:00Z",
      projectors: [textProjector, fake],
    });
    await both.createDoc("fin", { writer, content: "# T" });
    expect((await both.projection("fin", "text", { source })).output).toBe("# T");
    expect((await both.projection("fin", "fake", { source })).output).toBe("<# T>");
  });

  it("supports custom projectors via the registry", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T" });
    engine.registerProjector({
      id: "upper",
      project: (input) => input.src.toUpperCase(),
    });
    const out = await engine.projection("fin", "upper", { source });
    expect(out.output).toBe("# T".toUpperCase());
  });

  it("expands includes and reports versions for every doc in the merged tree", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", {
      writer,
      content: "## Now\ncash: {{source:cash}}\n\n## Ref\n{{include:research/q3-review#summary}}\n",
    });
    await engine.createDoc("research/q3-review", { writer, content: q3review });

    const projection = await engine.projection("fin", "text", { source });
    expect(projection.output).toContain("cash: ¥100");
    expect(projection.output).toContain(
      "> Summary: Q3 travel overspend 15%; recommend cutting outing budget for the rest of the month.",
    );
    expect(projection.output).not.toContain("{{include:");
    expect(projection.diagnostics).toEqual([]);
    expect(projection.versions.fin).toBeDefined();
    expect(projection.versions["research/q3-review"]).toBeDefined();
  });

  it("never copies source files during include expansion", async () => {
    const { storage, engine } = makeEngine();
    await engine.createDoc("fin", {
      writer,
      content: "## Ref\n{{include:research/q3-review#summary}}\n",
    });
    await engine.createDoc("research/q3-review", { writer, content: q3review });

    const before = await storage.read(asDocId("research/q3-review"));
    const listBefore = await storage.list();
    await engine.projection("fin", "text", { source });
    const after = await storage.read(asDocId("research/q3-review"));
    const listAfter = await storage.list();

    expect(after).toBe(before);
    expect(listAfter).toEqual(listBefore); // no new documents were written
  });

  it("keeps projectors that ignore `merged` working on documents with includes", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", {
      writer,
      content: "# T\n{{include:research/q3-review#summary}}\n",
    });
    await engine.createDoc("research/q3-review", { writer, content: q3review });
    engine.registerProjector({
      id: "upper",
      project: (input) => input.src.toUpperCase(),
    });
    const out = await engine.projection("fin", "upper", { source });
    expect(out.output).toContain("{{INCLUDE:RESEARCH/Q3-REVIEW#SUMMARY}}");
    expect(out.output).toContain("# T".toUpperCase());
  });

  it("runs projection middleware onion-style around the projector", async () => {
    const order: string[] = [];
    const { engine } = makeEngine([
      async (_ctx, next) => {
        order.push("m1-in");
        await next();
        order.push("m1-out");
      },
      async (_ctx, next) => {
        order.push("m2-in");
        await next();
        order.push("m2-out");
      },
    ]);
    await engine.createDoc("fin", { writer, content: "# T" });
    engine.registerProjector({
      id: "order",
      project: async () => {
        order.push("project");
        return "P";
      },
    });
    await engine.projection("fin", "order", { source });
    expect(order).toEqual(["m1-in", "m2-in", "project", "m2-out", "m1-out"]);
  });

  it("lets middleware amend ctx.options before the projector observes them", async () => {
    const { engine } = makeEngine([
      async (ctx, next) => {
        ctx.options.suffix = "!";
        await next();
      },
    ]);
    await engine.createDoc("fin", { writer, content: "# T" });
    engine.registerProjector({
      id: "suffix",
      project: (input) => `${input.src}${String(input.options.suffix ?? "")}`,
    });
    const out = await engine.projection("fin", "suffix", { source });
    expect(out.output).toBe("# T!");
  });

  it("lets middleware rewrite ctx.output after next(); the engine returns it", async () => {
    const { engine } = makeEngine([
      async (ctx, next) => {
        await next();
        ctx.output = `[[${String(ctx.output)}]]`;
      },
    ]);
    await engine.createDoc("fin", { writer, content: "# T" });
    const out = await engine.projection("fin", "text", { source });
    expect(out.output).toBe("[[# T]]");
  });

  it("degrades fail-soft when projection middleware rejects before next()", async () => {
    const { engine } = makeEngine([
      async () => {
        throw new WriteRejection("blocked", [{ code: "E_RATE_LIMIT", message: "slow down" }]);
      },
    ]);
    await engine.createDoc("fin", { writer, content: "# T" });
    const out = await engine.projection("fin", "text", { source });
    expect(out.diagnostics.map((d) => d.code)).toContain("E_RATE_LIMIT");
    expect(out.output).toBe("# T");
  });

  it("degrades with E_MIDDLEWARE_ERROR when projection middleware throws a generic error", async () => {
    const { engine } = makeEngine([
      async () => {
        throw new Error("plugin broke");
      },
    ]);
    await engine.createDoc("fin", { writer, content: "# T" });
    const seen: string[][] = [];
    engine.registerProjector({
      id: "safe",
      project: (input) => input.src,
      degrade: (src, diagnostics) => {
        seen.push(diagnostics.map((d) => d.code));
        return `safe(${src})`;
      },
    });
    const out = await engine.projection("fin", "safe", { source });
    expect(out.ok).toBe(true);
    expect(out.output).toBe("safe(# T)");
    expect(seen).toEqual([["E_MIDDLEWARE_ERROR"]]);
    const failure = out.diagnostics.find((d) => d.code === "E_MIDDLEWARE_ERROR");
    expect(failure?.message).toContain("plugin broke");
    // Without a degrade hook the output falls back to the raw source.
    const text = await engine.projection("fin", "text", { source });
    expect(text.output).toBe("# T");
    expect(text.diagnostics.map((d) => d.code)).toEqual(["E_MIDDLEWARE_ERROR"]);
  });

  it("degrades with E_MIDDLEWARE_ERROR when projection middleware throws after next()", async () => {
    const { engine } = makeEngine([
      async (_ctx, next) => {
        await next();
        throw "not even an Error";
      },
    ]);
    await engine.createDoc("fin", { writer, content: "# T" });
    const out = await engine.projection("fin", "text", { source });
    expect(out.output).toBe("# T");
    expect(out.diagnostics.map((d) => d.code)).toEqual(["E_MIDDLEWARE_ERROR"]);
    expect(out.diagnostics[0]?.message).toContain("not even an Error");
  });

  it("degrades a throwing projector to raw source with E_PROJECTOR_ERROR", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T" });
    engine.registerProjector({
      id: "boom",
      project: async () => {
        throw new Error("kaboom");
      },
    });
    const out = await engine.projection("fin", "boom", { source });
    expect(out.output).toBe("# T");
    expect(typeof out.output).toBe("string");
    expect(out.diagnostics.map((d) => d.code)).toContain("E_PROJECTOR_ERROR");
  });

  it("uses the projector's degrade hook instead of raw source when the projector throws", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T" });
    const seen: string[][] = [];
    engine.registerProjector({
      id: "boom",
      project: async () => {
        throw new Error("kaboom");
      },
      degrade: (src, diagnostics) => {
        seen.push(diagnostics.map((d) => d.code));
        return `safe(${src})`;
      },
    });
    const out = await engine.projection("fin", "boom", { source });
    expect(out.output).toBe("safe(# T)");
    expect(seen).toEqual([["E_PROJECTOR_ERROR"]]);
    expect(out.diagnostics.map((d) => d.code)).toContain("E_PROJECTOR_ERROR");
  });

  it("uses the projector's degrade hook when projection middleware rejects", async () => {
    const { engine } = makeEngine([
      async () => {
        throw new WriteRejection("blocked", [{ code: "E_RATE_LIMIT", message: "slow down" }]);
      },
    ]);
    await engine.createDoc("fin", { writer, content: "# T" });
    const seen: string[][] = [];
    engine.registerProjector({
      id: "safe",
      project: (input) => input.src,
      degrade: (src, diagnostics) => {
        seen.push(diagnostics.map((d) => d.code));
        return `safe(${src})`;
      },
    });
    const out = await engine.projection("fin", "safe", { source });
    expect(out.output).toBe("safe(# T)");
    expect(seen).toEqual([["E_RATE_LIMIT"]]);
    expect(out.diagnostics.map((d) => d.code)).toContain("E_RATE_LIMIT");
  });

  it("degrades to empty output, never raw source, when the degrade hook itself throws", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T" });
    engine.registerProjector({
      id: "boom",
      project: () => {
        throw new Error("kaboom");
      },
      degrade: () => {
        throw new Error("worse");
      },
    });
    const out = await engine.projection("fin", "boom", { source });
    expect(out.output).toBe("");
    expect(out.diagnostics.filter((d) => d.code === "E_PROJECTOR_ERROR")).toHaveLength(2);
  });

  it("fails soft per block: a throwing text hook renders that block verbatim and reports E_BLOCK_HOOK_ERROR", async () => {
    const boomType: BlockType = {
      type: "boom",
      schema: { type: "object" },
      project: {
        text: () => {
          throw new Error("bad attrs");
        },
      },
    };
    const engine = createEngine({
      storage: createMemStorage(),
      blocks: [boomType],
      parseOptions: { blockTypes: new Set(["boom"]) },
    });
    const content = "# T\n\ncash: {{source:cash}}\n\n```boom\nid: b1\n```\n";
    await engine.createDoc("fin", { writer, content });
    const out = await engine.projection<string>("fin", "text", { source });
    expect(out.output).toBe("# T\n\ncash: ¥100\n\n```boom\nid: b1\n```\n");
    expect(out.diagnostics).toEqual([
      expect.objectContaining({ code: "E_BLOCK_HOOK_ERROR", nodeId: "b1" }),
    ]);
  });

  it("behaves as before without projection middleware and tolerates an empty array", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "cash: {{source:cash}}\n" });
    const out = await engine.projection("fin", "text", { source });
    expect(out.output).toContain("cash: ¥100");
    expect(out.diagnostics).toEqual([]);

    const { engine: emptyEngine } = makeEngine([]);
    await emptyEngine.createDoc("other", { writer, content: "# O" });
    const empty = await emptyEngine.projection("other", "text", { source });
    expect(empty.output).toBe("# O");
  });

  it("runs write and projection middleware independently", async () => {
    const writeLog: string[] = [];
    const projLog: string[] = [];
    const storage = createMemStorage();
    const engine = createEngine({
      storage,
      clock: () => "2026-08-21T00:00:00Z",
      blocks: [statusType],
      parseOptions: { blockTypes: new Set(["status"]) },
      middleware: {
        write: [
          async (_ctx, next) => {
            writeLog.push("write");
            await next();
          },
        ],
        projection: [
          async (_ctx, next) => {
            projLog.push("proj");
            await next();
          },
        ],
      },
    });
    await engine.createDoc("fin", { writer, content: "# T" });
    await engine.write("fin", { writer, fullText: "# T2" });
    await engine.projection("fin", "text", { source });
    // createDoc and write both run the write middleware; the projection
    // middleware runs only on projection.
    expect(writeLog).toEqual(["write", "write"]);
    expect(projLog).toEqual(["proj"]);
  });
});

describe("arbitrary projector output", () => {
  it("passes a non-string projector output through untouched (no String coercion)", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T" });
    const tree = { tree: { type: "root", children: [{ type: "text", value: "# T" }] } };
    engine.registerProjector({
      id: "react",
      project: () => tree,
    });
    const out = await engine.projection("fin", "react", { source });
    expect(out.ok).toBe(true);
    expect(out.output).toBe(tree); // identity — not "[object Object]"
  });

  it("the built-in text projector still returns a string", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T" });
    const text = await engine.projection("fin", "text", { source });
    expect(typeof text.output).toBe("string");
  });

  it("lets middleware transform a non-string output (wraps an object)", async () => {
    const { engine } = makeEngine([
      async (ctx, next) => {
        await next();
        ctx.output = { wrapped: ctx.output };
      },
    ]);
    await engine.createDoc("fin", { writer, content: "# T" });
    const tree = { tree: { type: "root" } };
    engine.registerProjector({
      id: "tree",
      project: () => tree,
    });
    const out = await engine.projection("fin", "tree", { source });
    expect(out.output).toEqual({ wrapped: tree });
  });

  it("lets the caller assert the output type via projection<T>", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("d", { writer, content: "# T\n" });
    const r = await engine.projection<string>("d", "text", {});
    // The assignment is the type-level assertion (typecheck enforces it); the
    // expectation is the runtime one.
    const s: string = r.output;
    expect(typeof s).toBe("string");
  });
});

describe("engine caches", () => {
  it("reuses the parse cache: identical content parses once (same ParsedDoc identity)", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T" });
    const parsed: ParsedDoc[] = [];
    engine.registerProjector({
      id: "capture-doc",
      project: (input) => {
        parsed.push(input.doc);
        return "P";
      },
    });
    await engine.projection("fin", "capture-doc", { source });
    await engine.projection("fin", "capture-doc", { source });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toBe(parsed[1]);
  });

  it("reuses the merge cache: unchanged board + includes merge once (same MergedTree identity)", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", {
      writer,
      content: "## Ref\n{{include:research/q3-review#summary}}\n",
    });
    await engine.createDoc("research/q3-review", { writer, content: q3review });
    const merged: MergedTree[] = [];
    engine.registerProjector({
      id: "capture-merged",
      project: (input) => {
        if (input.merged !== undefined) merged.push(input.merged);
        return "M";
      },
    });
    await engine.projection("fin", "capture-merged", { source });
    await engine.projection("fin", "capture-merged", { source });
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(merged[1]);
  });

  it("re-parses and re-merges after a write changes the board", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", {
      writer,
      content: "# T\n{{include:research/q3-review#summary}}\n",
    });
    await engine.createDoc("research/q3-review", { writer, content: q3review });
    const parsed: ParsedDoc[] = [];
    const merged: MergedTree[] = [];
    engine.registerProjector({
      id: "capture",
      project: (input) => {
        parsed.push(input.doc);
        if (input.merged !== undefined) merged.push(input.merged);
        return "P";
      },
    });
    await engine.projection("fin", "capture", { source });
    await engine.projection("fin", "capture", { source });
    expect(parsed[0]).toBe(parsed[1]);
    expect(merged[0]).toBe(merged[1]);

    await engine.write("fin", {
      writer,
      fullText: "# T2\n{{include:research/q3-review#summary}}\n",
    });
    await engine.projection("fin", "capture", { source });

    expect(parsed[2]).not.toBe(parsed[0]);
    expect(merged[2]).not.toBe(merged[0]);
  });

  it("re-merges when an included document changes", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", {
      writer,
      content: "## Ref\n{{include:research/q3-review#summary}}\n",
    });
    await engine.createDoc("research/q3-review", { writer, content: q3review });
    const merged: MergedTree[] = [];
    engine.registerProjector({
      id: "capture-merged",
      project: (input) => {
        if (input.merged !== undefined) merged.push(input.merged);
        return "M";
      },
    });
    await engine.projection("fin", "capture-merged", { source });
    await engine.projection("fin", "capture-merged", { source });
    expect(merged[0]).toBe(merged[1]);

    await engine.write("research/q3-review", {
      writer,
      fullText: q3review.replace("overspend 15%", "overspend 20%"),
    });
    await engine.projection("fin", "capture-merged", { source });

    expect(merged[2]).not.toBe(merged[0]);
  });

  it("registerBlock invalidates the parse cache", async () => {
    const { engine } = engineWithoutBlocks();
    await engine.createDoc("d", { writer, content: lateStatusSrc });
    const blockNodeCounts: number[] = [];
    engine.registerProjector({
      id: "count-blocks",
      project: (input) => {
        blockNodeCounts.push(input.doc.nodes.filter((n) => "blockId" in n).length);
        return "P";
      },
    });

    const before = await engine.projection("d", "text", {});
    await engine.projection("d", "count-blocks", {});
    // The type is unknown, so the fence is plain code and renders verbatim.
    expect(stringOutput(before)).toContain("```status");
    expect(stringOutput(before)).not.toContain("STATUS pending");

    engine.registerBlock(lateStatusType);

    // Same content (same parse-cache key) — the registration must still take effect.
    const after = await engine.projection("d", "text", {});
    await engine.projection("d", "count-blocks", {});
    expect(stringOutput(after)).toContain("STATUS pending");
    expect(blockNodeCounts).toEqual([0, 1]);
  });

  it("registerBlock invalidates the merge cache", async () => {
    const { engine } = engineWithoutBlocks();
    await engine.createDoc("d", { writer, content: lateStatusSrc });
    await engine.createDoc("b", { writer, content: "# Board\n\n{{include:d}}\n" });

    const before = await engine.projection("b", "text", {});
    expect(stringOutput(before)).toContain("```status");

    engine.registerBlock(lateStatusType);

    // Same board + included content (same merge-cache key) — the cached tree
    // was built from parses that did not recognize the fence.
    const after = await engine.projection("b", "text", {});
    expect(stringOutput(after)).toContain("STATUS pending");
  });
});

describe("per-call RESOLVE: values are live, never cached", () => {
  it("re-runs RESOLVE per projection: a ticking Source yields fresh values every call", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "cash: {{source:cash}}\n" });
    let ticks = 0;
    const ticking: Source = {
      resolve: async (r) => {
        if (r.source !== "cash") return { value: "—", stale: false };
        ticks += 1;
        return { value: `¥${ticks}`, stale: false };
      },
    };

    const first = await engine.projection("fin", "text", { source: ticking });
    const second = await engine.projection("fin", "text", { source: ticking });
    const third = await engine.projection("fin", "text", { source: ticking });

    expect(stringOutput(first).trim()).toBe("cash: ¥1");
    expect(stringOutput(second).trim()).toBe("cash: ¥2");
    expect(stringOutput(third).trim()).toBe("cash: ¥3");
  });

  it("swaps the Source object without a doc edit: the next projection shows the new value", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "cash: {{source:cash}}\n" });
    const sourceA: Source = { resolve: async () => ({ value: "A", stale: false }) };
    const sourceB: Source = { resolve: async () => ({ value: "B", stale: false }) };

    const a = await engine.projection("fin", "text", { source: sourceA });
    const b = await engine.projection("fin", "text", { source: sourceB });

    expect(a.output).toContain("cash: A");
    expect(b.output).toContain("cash: B");
  });

  it("resolves an included document's source refs per projection (no doc edit)", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "## Ref\n{{include:r#s}}\n" });
    await engine.createDoc("r", { writer, content: "## S {#s}\ncash: {{source:cash}}\n" });
    let ticks = 0;
    const ticking: Source = {
      resolve: async (r) => {
        if (r.source !== "cash") return { value: "—", stale: false };
        ticks += 1;
        return { value: `¥${ticks}`, stale: false };
      },
    };

    const first = await engine.projection("fin", "text", { source: ticking });
    const second = await engine.projection("fin", "text", { source: ticking });

    expect(first.output).toContain("cash: ¥1");
    expect(second.output).toContain("cash: ¥2");
  });

  it("passes a per-call values map to projectors (the merged tree + values shape is unchanged)", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "cash: {{source:cash}}\n" });
    let ticks = 0;
    const ticking: Source = {
      resolve: async (r) => {
        if (r.source !== "cash") return { value: "—", stale: false };
        ticks += 1;
        return { value: `¥${ticks}`, stale: false };
      },
    };
    const seen: string[] = [];
    engine.registerProjector({
      id: "capture-values",
      project: (input) => {
        seen.push(input.values.get("cash?")?.value ?? "missing");
        return "V";
      },
    });

    await engine.projection("fin", "capture-values", { source: ticking });
    await engine.projection("fin", "capture-values", { source: ticking });

    expect(seen).toEqual(["¥1", "¥2"]);
  });

  it("isolates per-call values across interleaved projections on the same board", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "cash: {{source:cash}}\n" });
    const sourceA: Source = { resolve: async () => ({ value: "A", stale: false }) };
    const sourceB: Source = { resolve: async () => ({ value: "B", stale: false }) };

    let capturedByA: ReadonlyMap<string, SourceValue> | undefined;
    let signalCaptured: () => void = () => {};
    const captured = new Promise<void>((resolve) => {
      signalCaptured = resolve;
    });
    let releaseA: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let calls = 0;

    engine.registerProjector({
      id: "parking",
      project: async (input) => {
        calls += 1;
        if (calls === 1) {
          capturedByA = input.values;
          signalCaptured();
          await parked; // park projection A mid-render
        }
        return "P";
      },
    });

    const projectionA = engine.projection("fin", "parking", { source: sourceA });
    await captured; // A has resolved its values and is now parked

    // While A is parked, run B to completion — it must not disturb A's values.
    const projectionB = await engine.projection("fin", "parking", { source: sourceB });
    expect(projectionB.output).toBe("P");

    releaseA();
    const resultA = await projectionA;
    expect(resultA.output).toBe("P");
    expect(capturedByA?.get("cash?")?.value).toBe("A");
  });

  it("a custom projector receives fresh `input.values` per call and `input.merged` nodes carry no `values`", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "cash: {{source:cash}}\n" });
    const first: Source = { resolve: async () => ({ value: "FIRST", stale: false }) };
    const second: Source = { resolve: async () => ({ value: "SECOND", stale: false }) };

    const seen: string[] = [];
    const rootCarriesValues: (boolean | "missing")[] = [];
    engine.registerProjector({
      id: "capture-merged-values",
      project: (input) => {
        seen.push(String(input.values.get("cash?")?.value ?? "missing"));
        // An absent `merged` records "missing" rather than `false`, so a
        // projection that stopped passing the tree fails this test.
        rootCarriesValues.push(
          input.merged === undefined ? "missing" : Object.hasOwn(input.merged.root, "values"),
        );
        return "P";
      },
    });

    await engine.projection("fin", "capture-merged-values", { source: first });
    await engine.projection("fin", "capture-merged-values", { source: second });

    expect(seen).toEqual(["FIRST", "SECOND"]);
    // The merged tree is cached across both calls: it must be pure structure,
    // so a projector cannot read the first call's values off it.
    expect(rootCarriesValues).toEqual([false, false]);
  });
});

describe("use() runtime middleware", () => {
  it("runs write middleware registered after construction and lets it amend the proposal", async () => {
    const { storage, engine } = makeEngine();
    engine.use({
      write: async (ctx, next) => {
        (ctx.proposed as { fullText: string }).fullText = "# amended";
        await next();
      },
    });
    await engine.createDoc("fin", { writer, content: "# T" });
    const result = await engine.write("fin", { writer, fullText: "# T2" });
    expect(result.ok).toBe(true);
    expect(await storage.read(asDocId("fin"))).toBe("# amended");
  });

  it("runs projection middleware registered after construction", async () => {
    const { engine } = makeEngine();
    engine.use({
      projection: async (ctx, next) => {
        ctx.options.suffix = "!";
        await next();
      },
    });
    await engine.createDoc("fin", { writer, content: "# T" });
    engine.registerProjector({
      id: "suffix",
      project: (input) => `${input.src}${String(input.options.suffix ?? "")}`,
    });
    const out = await engine.projection("fin", "suffix", { source });
    expect(out.output).toBe("# T!");
  });

  it("appends multiple use() calls in registration order", async () => {
    const { engine } = makeEngine();
    const order: string[] = [];
    engine.use({
      projection: async (_ctx, next) => {
        order.push("a-in");
        await next();
        order.push("a-out");
      },
    });
    engine.use({
      projection: async (_ctx, next) => {
        order.push("b-in");
        await next();
        order.push("b-out");
      },
    });
    await engine.createDoc("fin", { writer, content: "# T" });
    engine.registerProjector({
      id: "order",
      project: async () => {
        order.push("project");
        return "P";
      },
    });
    await engine.projection("fin", "order", { source });
    expect(order).toEqual(["a-in", "b-in", "project", "b-out", "a-out"]);
  });

  it("works when no middleware was configured at construction (empty chains)", async () => {
    const { engine } = makeEngine();
    engine.use({});
    await engine.createDoc("fin", { writer, content: "# T" });
    const out = await engine.projection("fin", "text", { source });
    expect(out.output).toBe("# T");
  });
});

describe("events() async iterable", () => {
  it("yields records after the cursor in seq order", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T" });
    await engine.write("fin", { writer, fullText: "# T2" });

    const all: EventRecord[] = [];
    for await (const evt of engine.events({ afterSeq: 0 })) all.push(evt);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0]?.type).toBe("doc.created");
    expect(all.map((e) => e.type)).toContain("doc.updated");

    // seq order is monotonic.
    const seqs = all.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    // afterSeq filtering: nothing at/before the cursor is replayed.
    const firstSeq = all[0]?.seq ?? 0;
    const tail: EventRecord[] = [];
    for await (const evt of engine.events({ afterSeq: firstSeq })) tail.push(evt);
    expect(tail.every((e) => e.seq > firstSeq)).toBe(true);
    expect(tail.map((e) => e.type)).not.toContain("doc.created");
    expect(tail.map((e) => e.type)).toContain("doc.updated");
  });

  it("iterates zero times when nothing follows the cursor", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T" });
    const all: EventRecord[] = [];
    for await (const evt of engine.events({ afterSeq: 0 })) all.push(evt);
    const lastSeq = all[all.length - 1]?.seq ?? 0;

    let count = 0;
    for await (const _evt of engine.events({ afterSeq: lastSeq })) count += 1;
    expect(count).toBe(0);
  });
});

describe("dependency-scoped subscriptions", () => {
  /** Assert `events` are non-empty, all from `expectedDocId`, and delivered exactly once each. */
  function assertSingleDocDelivery(events: EventRecord[], expectedDocId: string): string[] {
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.docId === expectedDocId)).toBe(true);
    const types = events.map((e) => e.type);
    expect(new Set(types).size).toBe(types.length); // no duplicate deliveries
    return types;
  }

  it("delivers an event on c to subscribers of a, b, and c (transitive includes)", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("a", { writer, content: "# A\n\n{{include:b}}\n" });
    await engine.createDoc("b", { writer, content: "# B\n\n{{include:c}}\n" });
    await engine.createDoc("c", { writer, content: "# C\n" });

    const seenA: EventRecord[] = [];
    const seenB: EventRecord[] = [];
    const seenC: EventRecord[] = [];
    engine.subscribe("a", (e) => seenA.push(e));
    engine.subscribe("b", (e) => seenB.push(e));
    engine.subscribe("c", (e) => seenC.push(e));

    await engine.write("c", { writer, fullText: "# C2\n" });

    const typesC = assertSingleDocDelivery(seenC, "c");
    expect(assertSingleDocDelivery(seenA, "c")).toEqual(typesC);
    expect(assertSingleDocDelivery(seenB, "c")).toEqual(typesC);
  });

  it("degenerates to this-document delivery for a doc with no includes", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("solo", { writer, content: "# Solo\n" });
    await engine.createDoc("other", { writer, content: "# Other\n" });

    const seenSolo: EventRecord[] = [];
    engine.subscribe("solo", (e) => seenSolo.push(e));

    await engine.write("solo", { writer, fullText: "# Solo2\n" });
    await engine.write("other", { writer, fullText: "# Other2\n" });

    expect(seenSolo.length).toBeGreaterThan(0);
    expect(seenSolo.every((e) => e.docId === "solo")).toBe(true);
  });

  it("does not deliver an unrelated document's events to scoped subscribers", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("a", { writer, content: "# A\n\n{{include:b}}\n" });
    await engine.createDoc("b", { writer, content: "# B\n\n{{include:c}}\n" });
    await engine.createDoc("c", { writer, content: "# C\n" });
    await engine.createDoc("x", { writer, content: "# X\n" });

    const seenA: EventRecord[] = [];
    const seenB: EventRecord[] = [];
    const seenC: EventRecord[] = [];
    engine.subscribe("a", (e) => seenA.push(e));
    engine.subscribe("b", (e) => seenB.push(e));
    engine.subscribe("c", (e) => seenC.push(e));

    await engine.write("x", { writer, fullText: "# X2\n" });

    expect(seenA).toEqual([]);
    expect(seenB).toEqual([]);
    expect(seenC).toEqual([]);
  });

  it("unsubscribes cleanly: off() stops one handler and leaves the other working", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("a", { writer, content: "# A\n" });

    const h1: EventRecord[] = [];
    const h2: EventRecord[] = [];
    const off1 = engine.subscribe("a", (e) => h1.push(e));
    const off2 = engine.subscribe("a", (e) => h2.push(e));

    await engine.write("a", { writer, fullText: "# A2\n" });
    expect(h1.length).toBeGreaterThan(0);
    expect(h2.length).toBeGreaterThan(0);

    // Removing one handler leaves the other working.
    off1();
    const h1Before = h1.length;
    const h2Before = h2.length;
    await engine.write("a", { writer, fullText: "# A3\n" });
    expect(h1.length).toBe(h1Before);
    expect(h2.length).toBeGreaterThan(h2Before);

    // Removing the last handler stops delivery entirely.
    off2();
    const h2After = h2.length;
    await engine.write("a", { writer, fullText: "# A4\n" });
    expect(h1.length).toBe(h1Before);
    expect(h2.length).toBe(h2After);
  });

  it("refreshes the index after a new include edge is written", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("a", { writer, content: "# A\n\n{{include:b}}\n" });
    await engine.createDoc("b", { writer, content: "# B\n" });
    await engine.createDoc("c", { writer, content: "# C\n" });

    const seenA: EventRecord[] = [];
    engine.subscribe("a", (e) => seenA.push(e));

    // Before the new edge, a's inputs are {a, b}; c events do not reach a.
    await engine.write("c", { writer, fullText: "# C0\n" });
    expect(seenA).toEqual([]);

    // Rewrite a to also include c (a's own rewrite emits a-events only).
    await engine.write("a", { writer, fullText: "# A\n\n{{include:b}}\n{{include:c}}\n" });
    expect(seenA.every((e) => e.docId === "a")).toBe(true);

    // After the rewrite, an event on c reaches a.
    await engine.write("c", { writer, fullText: "# C2\n" });
    expect(seenA.some((e) => e.docId === "c")).toBe(true);
  });

  it("delivers a doc.removed event on an included doc to the includer (pre-removal graph)", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("a", { writer, content: "# A\n\n{{include:b}}\n" });
    await engine.createDoc("b", { writer, content: "# B\n" });

    const seenA: EventRecord[] = [];
    engine.subscribe("a", (e) => seenA.push(e));

    const removed = await engine.removeDoc("b", { writer });
    expect(removed.ok).toBe(true);

    expect(seenA.some((e) => e.type === "doc.removed" && e.docId === "b")).toBe(true);
  });

  it("keeps workspace-wide subscribers receiving every event", async () => {
    const { engine } = makeEngine();
    const global: string[] = [];
    engine.subscribe((e) => global.push(e.type));

    await engine.createDoc("a", { writer, content: "# A\n\n{{include:b}}\n" });
    await engine.createDoc("b", { writer, content: "# B\n" });
    await engine.write("b", { writer, fullText: "# B2\n" });

    expect(global.filter((t) => t === "doc.created")).toHaveLength(2);
    expect(global).toContain("doc.updated");
  });

  it("treats a missing include target as no input (inputs = {a}), without crashing", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("a", { writer, content: "# A\n\n{{include:ghost}}\n" });
    await engine.createDoc("other", { writer, content: "# Other\n" });

    const seenA: EventRecord[] = [];
    engine.subscribe("a", (e) => seenA.push(e));

    // a's own events still reach a; the ghost target produces no delivery.
    await engine.write("a", { writer, fullText: "# A2\n\n{{include:ghost}}\n" });
    expect(seenA.length).toBeGreaterThan(0);
    expect(seenA.every((e) => e.docId === "a")).toBe(true);

    // An event on an unrelated doc does not reach a.
    const before = seenA.length;
    await engine.write("other", { writer, fullText: "# Other2\n" });
    expect(seenA.length).toBe(before);
  });
});

describe("block registration derives fence recognition from the registry", () => {
  const statusSrc = "```status\nid: d\nstates: [pending, approved]\nvalue: pending\n```\n";

  it("recognizes blocks registered via `blocks` without parseOptions.blockTypes (createDoc + patch + projection)", async () => {
    const storage = createMemStorage();
    const engine = createEngine({
      storage,
      clock: () => "2026-08-21T00:00:00Z",
      blocks: [statusType],
    });

    const created = await engine.createDoc("fin", { writer, content: statusSrc });
    expect(created.ok).toBe(true);

    const patched = await engine.patch("fin", "d", { writer, attrs: { value: "approved" } });
    if (!patched.ok) throw new Error("expected patched ok");
    expect(patched.events?.map((e) => e.type)).toContain("status.changed");

    const projection = await engine.projection("fin", "text", { source });
    expect(projection.output).toContain("**STATUS**: approved");
    expect(projection.diagnostics).toEqual([]);
  });

  it("registerBlock at runtime (after construction, before createDoc) makes patch + projection work", async () => {
    const storage = createMemStorage();
    const engine = createEngine({
      storage,
      clock: () => "2026-08-21T00:00:00Z",
    });
    engine.registerBlock(statusType);

    const created = await engine.createDoc("fin", { writer, content: statusSrc });
    expect(created.ok).toBe(true);

    const patched = await engine.patch("fin", "d", { writer, attrs: { value: "approved" } });
    expect(patched.ok).toBe(true);
    expect(await storage.read(asDocId("fin"))).toContain("value: approved");

    const projection = await engine.projection("fin", "text", { source });
    expect(projection.output).toContain("**STATUS**: approved");
  });

  it("keeps recognizing fences named only by explicit parseOptions.blockTypes (backwards compat)", async () => {
    const storage = createMemStorage();
    const engine = createEngine({
      storage,
      clock: () => "2026-08-21T00:00:00Z",
      blocks: [statusType],
      parseOptions: { blockTypes: new Set(["status", "ghost"]) },
    });
    await engine.createDoc("fin", { writer, content: "```ghost\nid: g\n```\n" });
    // The fence is recognized as a Block via parseOptions.blockTypes, so the
    // patch reaches the block lookup and fails on the unregistered type — not
    // "missing-block" (which would mean the fence was treated as plain code).
    const patched = await engine.patch("fin", "g", { writer, attrs: { x: 1 } });
    expect(patched.ok).toBe(false);
    if (patched.ok) throw new Error("expected rejection");
    expect(patched.rejection.reason).toBe("unknown-type");
  });
});

describe("read API (getDoc/getBlock/listDocs)", () => {
  it("getDoc round-trips src + version; missing → undefined", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T" });
    expect(await engine.getDoc("fin")).toEqual({ src: "# T", version: docVersion("# T") });
    expect(await engine.getDoc("ghost")).toBeUndefined();
  });

  it("getBlock round-trips attrs + type + version; missing block/doc → undefined", async () => {
    const { engine } = makeEngine();
    const src = "```status\nid: d\nstates: [pending, approved]\nvalue: pending\n```\n";
    await engine.createDoc("fin", { writer, content: src });
    const got = await engine.getBlock("fin", "d");
    expect(got?.attrs).toMatchObject({ id: "d", value: "pending" });
    expect(got?.type).toBe("status");
    expect(got?.version).toBe(docVersion(src));
    expect(await engine.getBlock("fin", "nope")).toBeUndefined();
    expect(await engine.getBlock("ghost", "d")).toBeUndefined();
  });

  it("listDocs returns sorted plain strings", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("b", { writer, content: "# B" });
    await engine.createDoc("a", { writer, content: "# A" });
    expect(await engine.listDocs()).toEqual(["a", "b"]);
  });
});

describe("lock and eventSink overrides", () => {
  it("writes go through the provided lock", async () => {
    const storage = createMemStorage();
    const locked: string[] = [];
    const lock: Lock = {
      withLock: async (fn) => {
        locked.push("lock");
        return fn();
      },
    };
    const engine = createEngine({ storage, clock: () => "2026-08-21T00:00:00Z", lock });
    const r = await engine.createDoc("fin", { writer, content: "# T" });
    expect(r.ok).toBe(true);
    expect(locked).toContain("lock");
  });

  it("events append through the provided eventSink", async () => {
    const storage = createMemStorage();
    const appended: string[] = [];
    const eventSink: EventSink = {
      append: async (record) => {
        appended.push(record.type);
        return { ...record, seq: appended.length };
      },
    };
    const engine = createEngine({
      storage,
      clock: () => "2026-08-21T00:00:00Z",
      eventSink,
    });
    await engine.createDoc("fin", { writer, content: "# T" });
    expect(appended).toContain("doc.created");
  });
});

describe("refGraph(docId) independence", () => {
  it("two different docs give different graphs (no lastProjected state)", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("a", { writer, content: "# A\n\n{{include:b}}\n" });
    await engine.createDoc("b", { writer, content: "# B\n" });
    await engine.createDoc("c", { writer, content: "# C\n" });

    const ga = await engine.refGraph("a");
    const gc = await engine.refGraph("c");
    expect(ga.docs).toEqual(["a", "b"]);
    expect(gc.docs).toEqual(["c"]);
  });
});

describe("string-id boundary validation", () => {
  it("rejects empty, .., and absolute docIds fail-soft with a diagnostic", async () => {
    const { engine } = makeEngine();
    for (const id of ["", "..", "../x", "a/../b", "/abs"]) {
      const r = await engine.createDoc(id, { writer, content: "# T" });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected rejection");
      expect(r.rejection.reason).toBe("invalid-id");
      expect(r.rejection.diagnostics.map((d) => d.code)).toEqual(["E_INVALID_ID"]);
    }
  });

  it("rejects an empty blockId fail-soft with a diagnostic on patch", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T" });
    const r = await engine.patch("fin", "", { writer, attrs: { value: "x" } });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected rejection");
    expect(r.rejection.reason).toBe("invalid-id");
    expect(r.rejection.diagnostics.map((d) => d.code)).toEqual(["E_INVALID_ID"]);
  });

  it("treats an invalid id as absent on reads (getDoc/getBlock → undefined)", async () => {
    const { engine } = makeEngine();
    expect(await engine.getDoc("")).toBeUndefined();
    expect(await engine.getDoc("../x")).toBeUndefined();
    expect(await engine.getBlock("", "d")).toBeUndefined();
    expect(await engine.getBlock("fin", "")).toBeUndefined();
  });

  it("refGraph of an invalid docId reports E_INVALID_ID", async () => {
    const { engine } = makeEngine();
    const graph = await engine.refGraph("../x");
    expect(graph.docs).toEqual([]);
    expect(graph.diagnostics.map((d) => d.code)).toEqual(["E_INVALID_ID"]);
  });
});

describe("ProjectionInput shape", () => {
  it("hands a custom projector typed input including blockTypes and merged", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T" });
    const seen: ProjectionInput[] = [];
    engine.registerProjector({
      id: "capture-input",
      project: (input) => {
        seen.push(input);
        return "P";
      },
    });
    await engine.projection("fin", "capture-input", { source });
    expect(seen).toHaveLength(1);
    const input = seen[0];
    expect(input?.doc).toBeDefined();
    expect(input?.src).toBe("# T");
    expect(input?.values).toBeInstanceOf(Map);
    expect(input?.blockTypes).toBeInstanceOf(Map);
    expect(input?.merged).toBeDefined();
    expect(input?.options).toBeDefined();
  });

  it("projects a ref-less document without a Source (absent source behaves as no-refs)", async () => {
    const { engine } = makeEngine();
    await engine.createDoc("fin", { writer, content: "# T\n" });
    const out = await engine.projection("fin", "text", {});
    expect(out.ok).toBe(true);
    expect(out.output).toBe("# T\n");
  });
});

describe("WriteResult discriminated narrowing", () => {
  it("an ok:false result has no version at the type level", async () => {
    const { engine } = makeEngine();
    const missing = await engine.write("ghost", { writer, fullText: "# T" });
    if (missing.ok) throw new Error("expected rejection");
    expect(missing.rejection.reason).toBe("missing-doc");
    // @ts-expect-error — the rejected branch carries no `version`
    missing.version;
  });
});

describe("block-declared sources (BlockType.sources)", () => {
  const metricType: BlockType = {
    type: "metric",
    schema: {
      type: "object",
      required: ["id", "label", "source"],
      properties: { id: { type: "string" }, label: { type: "string" }, source: { type: "string" } },
      additionalProperties: false,
    },
    sources: (attrs) =>
      typeof attrs.source === "string"
        ? [{ kind: "source", source: attrs.source, params: {} }]
        : [],
    project: {
      text: (attrs, values) =>
        `${String(attrs.label ?? "")}: ${values[String(attrs.source ?? "")] ?? String(attrs.source ?? "")}`,
    },
  };

  const metricSrc = "```metric\nid: m1\nlabel: Cash\nsource: bank_balance\n```\n";
  const metricSource: Source = {
    resolve: async (r) =>
      r.source === "bank_balance"
        ? { value: "¥23,450", stale: false }
        : { value: "—", stale: false },
  };

  function metricEngine() {
    return createEngine({
      storage: createMemStorage(),
      clock: () => "2026-08-21T00:00:00Z",
      blocks: [metricType],
    });
  }

  it("renders a block's live value with no prose ref in the document", async () => {
    const engine = metricEngine();
    await engine.createDoc("m", { writer, content: metricSrc });

    const out = await engine.projection("m", "text", { source: metricSource });
    expect(out.ok).toBe(true);
    expect(stringOutput(out)).toContain("Cash: ¥23,450");
  });

  it("exposes the block-declared ref to custom projectors through input.values", async () => {
    const engine = metricEngine();
    await engine.createDoc("m", { writer, content: metricSrc });
    const seen: ProjectionInput[] = [];
    engine.registerProjector({
      id: "capture-values",
      project: (input) => {
        seen.push(input);
        return "P";
      },
    });

    await engine.projection("m", "capture-values", { source: metricSource });
    expect(seen[0]?.values.get("bank_balance?")).toEqual({ value: "¥23,450", stale: false });
  });

  it("picks up a block type registered at runtime (the registry is read per projection)", async () => {
    const { engine } = engineWithoutBlocks();
    await engine.createDoc("m", { writer, content: metricSrc });
    engine.registerBlock(metricType);

    const out = await engine.projection("m", "text", { source: metricSource });
    expect(stringOutput(out)).toContain("Cash: ¥23,450");
  });
});

describe("block schemas across engines", () => {
  it("validates writes in each engine against that engine's schema for a shared type name", async () => {
    const counter = (valueType: "number" | "string"): BlockType => ({
      type: "counter",
      schema: {
        type: "object",
        required: ["id", "value"],
        properties: { id: { type: "string" }, value: { type: valueType } },
      },
    });
    const numeric = createEngine({ storage: createMemStorage(), blocks: [counter("number")] });
    const textual = createEngine({ storage: createMemStorage(), blocks: [counter("string")] });
    const numberDoc = "```counter\nid: c\nvalue: 3\n```\n";
    const stringDoc = "```counter\nid: c\nvalue: three\n```\n";

    expect((await numeric.createDoc("a", { writer, content: numberDoc })).ok).toBe(true);
    expect((await textual.createDoc("a", { writer, content: stringDoc })).ok).toBe(true);
    const wrongForNumeric = await numeric.createDoc("b", { writer, content: stringDoc });
    const wrongForTextual = await textual.createDoc("b", { writer, content: numberDoc });
    expect(wrongForNumeric.ok).toBe(false);
    expect(wrongForTextual.ok).toBe(false);
  });
});
