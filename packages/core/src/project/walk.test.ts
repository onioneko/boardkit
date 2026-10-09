import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { resolveIncludes } from "../link/graph.js";
import { buildMergedTree, resolveMergedValues } from "../link/merge.js";
import { asDocId } from "../model/ids.js";
import { parseDoc } from "../parse/pipeline.js";
import { createMemStorage } from "../ports/mem.js";
import type { Source, SourceValue } from "../ports/ports.js";
import { canonicalKey, resolveRefs } from "../resolve/resolve.js";
import {
  documentNode,
  type ProjectionWalkContext,
  type ProjectionWalkHandlers,
  walkProjection,
  walkProjectionParts,
} from "./walk.js";

const valuesOf: Source = {
  resolve: async (r) => {
    if (r.source === "cash") return { value: "¥100", stale: false };
    if (r.source === "gone") return { value: "—", stale: true };
    return { value: "—", stale: false };
  },
};

/** Handlers that mark each kind of piece, so a walk's structure is readable in one string. */
const marking: ProjectionWalkHandlers = {
  onProse: (prose) => prose,
  onSource: (value) => `<v:${value}>`,
  onBlock: ({ block, output, raw }) =>
    output === undefined ? `<raw:${raw.trim().split("\n")[0]}>` : `<b:${block.blockId}:${output}>`,
  onInclude: (include) => `<i:${include.node.provenance.docId}>`,
};

/** Parse `src` and walk it as a standalone document. */
async function walkDoc(
  src: string,
  handlers: ProjectionWalkHandlers,
  opts: {
    blockTypes?: ReadonlyMap<string, BlockType>;
    /** Fence names the parser recognizes as blocks; defaults to the registered types. */
    fences?: readonly string[];
    frontmatter?: boolean;
    unescapeRefs?: boolean;
    projectorId?: string;
  } = {},
): Promise<string> {
  const fenceTypes = new Set(
    opts.fences ?? (opts.blockTypes === undefined ? [] : [...opts.blockTypes.keys()]),
  );
  const doc = parseDoc(src, { blockTypes: fenceTypes });
  const values = await resolveRefs(doc.refs, valuesOf);
  return walkProjection(
    {
      node: documentNode(doc, src),
      values,
      projectorId: opts.projectorId ?? "test",
      ...(opts.blockTypes !== undefined ? { blockTypes: opts.blockTypes } : {}),
      ...(opts.frontmatter !== undefined ? { frontmatter: opts.frontmatter } : {}),
      ...(opts.unescapeRefs !== undefined ? { unescapeRefs: opts.unescapeRefs } : {}),
    },
    handlers,
  );
}

const noteType: BlockType = {
  type: "note",
  schema: { type: "object" },
  project: {
    test: (attrs) => `note=${String(attrs.text ?? "")}`,
    other: () => "other-projector",
  },
};

/** A hook that runs and renders nothing — the third `output === undefined` case. */
const silentType: BlockType = {
  type: "silent",
  schema: { type: "object" },
  // Deliberately violates `ProjectionHook`'s `=> string` contract; the cast is
  // the point of the test (a real-world hook with a missing return path).
  project: { test: (() => undefined) as unknown as (attrs: unknown) => string },
};

/** A hook that throws — a block whose attrs the hook cannot handle. */
const throwingType: BlockType = {
  type: "boom",
  schema: { type: "object" },
  project: {
    test: () => {
      throw new Error("bad attrs");
    },
  },
};

const liveType: BlockType = {
  type: "live",
  schema: { type: "object" },
  sources: (attrs) =>
    typeof attrs.source === "string"
      ? [{ kind: "source" as const, source: attrs.source, params: {} }]
      : [],
  project: { test: (_attrs, values) => `live=${values.cash ?? "?"}` },
};

describe("walkProjection", () => {
  it("preserves every untouched byte and replaces only recognized spans", async () => {
    const out = await walkDoc("A {{source:cash}} B\n", marking);
    expect(out).toBe("A <v:¥100> B\n");
  });

  it("leaves a stale reference verbatim (fail-soft: onSource never sees it)", async () => {
    const seen: string[] = [];
    const out = await walkDoc("x {{source:gone}} y\n", {
      ...marking,
      onSource: (value, ref) => {
        seen.push(ref.source);
        return value;
      },
    });
    expect(out).toBe("x {{source:gone}} y\n");
    expect(seen).toEqual([]);
  });

  it("dispatches each block to its type's hook for this walk's projector id", async () => {
    const blockTypes = new Map([["note", noteType]]);
    const src = "```note\nid: n1\ntext: hi\n```\n";
    expect(await walkDoc(src, marking, { blockTypes })).toBe("<b:n1:note=hi>\n");
    expect(await walkDoc(src, marking, { blockTypes, projectorId: "other" })).toBe(
      "<b:n1:other-projector>\n",
    );
  });

  it("hands a block with no hook for this projector its verbatim source", async () => {
    const blockTypes = new Map([["note", noteType]]);
    const src = "```note\nid: n1\ntext: hi\n```\n";
    expect(await walkDoc(src, marking, { blockTypes, projectorId: "nobody" })).toBe(
      "<raw:```note>\n",
    );
    // An unregistered type is the same case: the fence *is* a block (the parser
    // recognizes it), no type is registered for it, so no hook and verbatim source.
    expect(await walkDoc(src, marking, { blockTypes: new Map(), fences: ["note"] })).toBe(
      "<raw:```note>\n",
    );
  });

  it("distinguishes an absent hook from a hook that returned nothing, via `hooked`", async () => {
    const seen: { hooked: boolean; output: unknown; raw: string }[] = [];
    const record: ProjectionWalkHandlers = {
      ...marking,
      onBlock: ({ hooked, output, raw }) => {
        seen.push({ hooked, output, raw });
        return "";
      },
    };

    const noteSrc = "```note\nid: n1\ntext: hi\n```\n";
    const silentSrc = "```silent\nid: s1\n```\n";
    await walkDoc(noteSrc, record, { blockTypes: new Map([["note", noteType]]) });
    await walkDoc(noteSrc, record, { blockTypes: new Map(), fences: ["note"] }); // unregistered
    await walkDoc(noteSrc, record, {
      blockTypes: new Map([["note", noteType]]),
      projectorId: "nobody", // registered, but no hook for this projector id
    });
    await walkDoc(silentSrc, record, { blockTypes: new Map([["silent", silentType]]) });

    expect(seen.map((b) => ({ hooked: b.hooked, output: b.output }))).toEqual([
      { hooked: true, output: "note=hi" },
      { hooked: false, output: undefined },
      { hooked: false, output: undefined },
      { hooked: true, output: undefined }, // the hook ran and rendered nothing
    ]);
    expect(seen.every((b) => b.raw.startsWith("```"))).toBe(true);
  });

  it("gives a hook that returns nothing the same fallback as no hook at all", async () => {
    // The documented delta from the pre-walk projectors, pinned: `text`-shaped
    // handlers key off `output === undefined`, so a hook that rendered nothing
    // falls back to the block's verbatim source rather than emitting "undefined".
    const src = "```silent\nid: s1\n```\n";
    const out = await walkDoc(src, marking, { blockTypes: new Map([["silent", silentType]]) });
    expect(out).toBe("<raw:```silent>\n");
    expect(out).not.toContain("undefined");
  });

  it("fails soft per block: a throwing hook renders its block verbatim and carries a diagnostic", async () => {
    const seen: {
      hooked: boolean;
      output: unknown;
      code: string | undefined;
      nodeId: string | undefined;
    }[] = [];
    const record: ProjectionWalkHandlers = {
      ...marking,
      onBlock: (b, ctx) => {
        seen.push({
          hooked: b.hooked,
          output: b.output,
          code: b.hookError?.code,
          nodeId: b.hookError?.nodeId,
        });
        return marking.onBlock(b, ctx);
      },
    };
    const blockTypes = new Map<string, BlockType>([
      ["boom", throwingType],
      ["note", noteType],
    ]);
    const src =
      "before {{source:cash}}\n\n```boom\nid: b1\n```\n\n```note\nid: n1\ntext: hi\n```\n";
    expect(await walkDoc(src, record, { blockTypes })).toBe(
      "before <v:¥100>\n\n<raw:```boom>\n\n<b:n1:note=hi>\n",
    );
    expect(seen).toEqual([
      { hooked: true, output: undefined, code: "E_BLOCK_HOOK_ERROR", nodeId: "b1" },
      { hooked: true, output: "note=hi", code: undefined, nodeId: undefined },
    ]);
  });

  it("assembles hookValues from prose refs and block-declared sources alike", async () => {
    const blockTypes = new Map([["live", liveType]]);
    const src = "```live\nid: l1\nsource: cash\n```\n";
    const doc = parseDoc(src, { blockTypes: new Set(["live"]) });
    // The document's prose names no source at all: `cash` reaches the hook only
    // because the block type declared it and the walk assembles both halves.
    expect(doc.refs).toEqual([]);
    const values = await resolveMergedValues(
      { docs: [{ docId: asDocId("l"), src, parsed: doc }], includes: [], diagnostics: [] },
      valuesOf,
      blockTypes,
    );
    const out = walkProjection(
      { node: documentNode(doc, src), values, projectorId: "test", blockTypes },
      marking,
    );
    expect(out).toBe("<b:l1:live=¥100>\n");
  });

  it("exposes the node, its hookValues, and the canonical-key values to every handler", async () => {
    const seen: ProjectionWalkContext[] = [];
    await walkDoc("cash: {{source:cash}}\n", {
      ...marking,
      onProse: (prose, ctx) => {
        seen.push(ctx);
        return prose;
      },
      onSource: (value, _ref, ctx) => {
        seen.push(ctx);
        return value;
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    const ctx = seen[0];
    expect(ctx?.hookValues).toEqual({ cash: "¥100" });
    const key = canonicalKey({ kind: "source", source: "cash", params: {} });
    expect(ctx?.values.get(key)).toEqual({ value: "¥100", stale: false });
    expect(ctx?.node.ranges).toEqual([{ start: 0, end: "cash: {{source:cash}}\n".length }]);
  });

  it("calls onProse for each verbatim run and never for an empty one", async () => {
    const runs: string[] = [];
    await walkDoc("a {{source:cash}} b {{source:cash}}", {
      ...marking,
      onProse: (prose) => {
        runs.push(prose);
        return prose;
      },
    });
    expect(runs).toEqual(["a ", " b "]);
  });

  it("clips the frontmatter out of the walked ranges by default, keeps it on request", async () => {
    const src = "---\ntitle: T\n---\n\nbody\n";
    expect(await walkDoc(src, marking)).toBe("body\n");
    expect(await walkDoc(src, marking, { frontmatter: true })).toBe(src);
  });

  it("strips a ref's escaping backslash only when asked", async () => {
    const src = "A \\{{source:cash}} B\n";
    expect(await walkDoc(src, marking)).toBe(src);
    expect(await walkDoc(src, marking, { unescapeRefs: true })).toBe("A {{source:cash}} B\n");
  });

  it("leaves an escaped backslash and a block's verbatim bytes alone when unescaping", async () => {
    const blockTypes = new Map([["note", noteType]]);
    const src = "A \\\\{{source:cash}} B\n\n```note\nid: n1\ntext: \\{{x}}\n```\n";
    const out = await walkDoc(src, marking, { blockTypes, unescapeRefs: true });
    expect(out).toContain("A \\\\{{source:cash}} B");
    // The block's own bytes are the hook's business; the walk does not edit them.
    expect(out).toContain("<b:n1:note=\\{{x}}>");
  });

  it("walks a merged node's exclusive ranges and hands include children to onInclude", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "# B\n\n{{include:kid#s}}\n\ntail\n");
    await storage.writeAtomic(asDocId("kid"), "## S {#s}\nbody\n");
    const link = await resolveIncludes(asDocId("board"), storage);
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });
    const values: ReadonlyMap<string, SourceValue> = await resolveMergedValues(link, valuesOf);

    const child: string[] = [];
    const out = walkProjection(
      { node: tree.root, values, projectorId: "test" },
      {
        ...marking,
        onInclude: (include, ctx) => {
          child.push(`${include.node.provenance.sectionId ?? ""}/${include.node.heading ?? ""}`);
          expect(ctx.node).toBe(tree.root);
          // The child is a node in its own right: walking it is one call.
          return walkProjection(
            { node: include.node, values, projectorId: "test" },
            marking,
          ).trim();
        },
      },
    );
    expect(child).toEqual(["s/S"]);
    expect(out).toBe("# B\n\nbody\n\ntail\n");
  });

  it("renders nothing outside the ranges of a section-slice node", async () => {
    const storage = createMemStorage();
    await storage.writeAtomic(asDocId("board"), "{{include:kid#s}}\n");
    await storage.writeAtomic(asDocId("kid"), "# Kid\n\nout\n\n## S {#s}\nin\n");
    const link = await resolveIncludes(asDocId("board"), storage);
    const tree = await buildMergedTree({ boardDocId: asDocId("board"), link });
    const values = await resolveMergedValues(link, valuesOf);
    const slice = tree.root.includes[0]?.node;
    if (slice === undefined) throw new Error("expected one include child");

    const out = walkProjection({ node: slice, values, projectorId: "test" }, marking);
    expect(out).toContain("in");
    expect(out).not.toContain("out");
  });
});

describe("walkProjection: hole spans", () => {
  it("hands every hole handler the hole's span in the node's source", async () => {
    const src = "a {{source:cash}} b {{source:gone}}\n\n```note\nid: n\ntext: n\n```\n";
    const spans: string[] = [];
    const slice = (span: { start: number; end: number } | undefined): string =>
      span === undefined ? "none" : src.slice(span.start, span.end);
    await walkDoc(
      src,
      {
        ...marking,
        onSource: (value, _ref, _ctx, span) => {
          spans.push(`source:${slice(span)}`);
          return value;
        },
        onUnresolvedSource: (_ref, _state, raw, _ctx, span) => {
          spans.push(`unresolved:${slice(span)}`);
          return raw;
        },
        onBlock: ({ raw }, _ctx, span) => {
          spans.push(`block:${slice(span) === raw}`);
          return raw;
        },
      },
      { blockTypes: new Map([["note", noteType]]) },
    );
    expect(spans).toEqual(["source:{{source:cash}}", "unresolved:{{source:gone}}", "block:true"]);
  });
});

describe("walkProjectionParts", () => {
  it("returns pieces of the projector's own type, in document order", async () => {
    type Piece = { readonly kind: string; readonly text: string };
    const src = "A {{source:cash}} B\n\n```note\nid: n1\ntext: hi\n```\n";
    const doc = parseDoc(src, { blockTypes: new Set(["note"]) });
    const values = await resolveRefs(doc.refs, valuesOf);

    // No accumulator, no discarded return value: the pieces are the output.
    const pieces = walkProjectionParts<Piece>(
      {
        node: documentNode(doc, src),
        values,
        projectorId: "test",
        blockTypes: new Map([["note", noteType]]),
      },
      {
        onProse: (text) => ({ kind: "prose", text }),
        onSource: (value, ref) => ({ kind: `source:${ref.source}`, text: value }),
        onBlock: ({ block, output }) => ({ kind: `block:${block.type}`, text: String(output) }),
        onInclude: (include) => ({ kind: "include", text: include.node.provenance.docId }),
      },
    );

    expect(pieces).toEqual([
      { kind: "prose", text: "A " },
      { kind: "source:cash", text: "¥100" },
      { kind: "prose", text: " B\n\n" },
      { kind: "block:note", text: "note=hi" },
      { kind: "prose", text: "\n" },
    ]);
  });

  it("is what walkProjection joins: the string walk is the `T = string` case", async () => {
    const src = "A {{source:cash}} B\n";
    const doc = parseDoc(src, {});
    const values = await resolveRefs(doc.refs, valuesOf);
    const walk = { node: documentNode(doc, src), values, projectorId: "test" };

    expect(walkProjectionParts(walk, marking).join("")).toBe(walkProjection(walk, marking));
  });
});

describe("onUnresolvedSource (#14)", () => {
  /** A values map keyed by canonical key, for param-less refs to the given sources. */
  function valuesFor(
    entries: readonly (readonly [string, SourceValue])[],
  ): ReadonlyMap<string, SourceValue> {
    return new Map(
      entries.map(([source, v]) => [canonicalKey({ kind: "source", source, params: {} }), v]),
    );
  }

  /** `cash` resolved, `gone` is stale, and nothing else resolved. */
  const partial = valuesFor([
    ["cash", { value: "¥100", stale: false }],
    ["gone", { value: "—", stale: true }],
  ]);

  type Piece =
    | { readonly kind: "prose"; readonly text: string }
    | { readonly kind: "source"; readonly source: string; readonly value: string }
    | {
        readonly kind: "unresolved";
        readonly source: string;
        readonly state: { readonly value?: string; readonly stale: boolean };
        readonly raw: string;
      }
    | { readonly kind: "other" };

  const structured: ProjectionWalkHandlers<Piece> = {
    onProse: (text) => ({ kind: "prose", text }),
    onSource: (value, ref) => ({ kind: "source", source: ref.source, value }),
    onUnresolvedSource: (ref, state, raw) => ({
      kind: "unresolved",
      source: ref.source,
      state,
      raw,
    }),
    onBlock: () => ({ kind: "other" }),
    onInclude: () => ({ kind: "other" }),
  };

  it("hands a missing ref and a stale ref each to one call, with its state and raw span", () => {
    const src = "A {{source:cash}} B {{source:missing}} C {{source:gone}}\n";
    const doc = parseDoc(src, {});
    const pieces = walkProjectionParts(
      { node: documentNode(doc, src), values: partial, projectorId: "test" },
      structured,
    );
    expect(pieces).toEqual([
      { kind: "prose", text: "A " },
      { kind: "source", source: "cash", value: "¥100" },
      { kind: "prose", text: " B " },
      {
        kind: "unresolved",
        source: "missing",
        state: { stale: false },
        raw: "{{source:missing}}",
      },
      { kind: "prose", text: " C " },
      {
        kind: "unresolved",
        source: "gone",
        state: { value: "—", stale: true },
        raw: "{{source:gone}}",
      },
      { kind: "prose", text: "\n" },
    ]);
  });

  it("is called once per unresolved span, and never for a ref that resolved", () => {
    const src = "{{source:missing}} {{source:cash}} {{source:missing}}\n";
    const doc = parseDoc(src, {});
    const calls: string[] = [];
    walkProjectionParts(
      { node: documentNode(doc, src), values: partial, projectorId: "test" },
      {
        ...structured,
        onUnresolvedSource: (ref, state, raw, ctx) => {
          calls.push(`${ref.source}:${raw}:${ctx.node.src.length}`);
          return { kind: "unresolved" as const, source: ref.source, state, raw };
        },
      },
    );
    expect(calls).toEqual([
      `missing:{{source:missing}}:${src.length}`,
      `missing:{{source:missing}}:${src.length}`,
    ]);
  });

  it("hands a param-bearing ref over too, params and raw span included", () => {
    const src = "rsi {{source:rsi symbol=AAPL period=14}} end\n";
    const doc = parseDoc(src, {});
    const params: unknown[] = [];
    const pieces = walkProjectionParts(
      { node: documentNode(doc, src), values: new Map(), projectorId: "test" },
      {
        ...structured,
        onUnresolvedSource: (ref, state, raw) => {
          params.push(ref.params);
          return { kind: "unresolved" as const, source: ref.source, state, raw };
        },
      },
    );
    expect(pieces[1]).toEqual({
      kind: "unresolved",
      source: "rsi",
      state: { stale: false },
      raw: "{{source:rsi symbol=AAPL period=14}}",
    });
    expect(params).toEqual([{ symbol: "AAPL", period: "14" }]);
  });

  it("keeps hookValues free of both refs: block hooks never see a placeholder", () => {
    const seenByHook: Readonly<Record<string, string>>[] = [];
    const probe: BlockType = {
      type: "probe",
      schema: { type: "object" },
      project: {
        test: (_attrs, values) => {
          seenByHook.push(values);
          return "probe";
        },
      },
    };
    const src = "{{source:cash}} {{source:missing}} {{source:gone}}\n\n```probe\nid: p\n```\n";
    const doc = parseDoc(src, { blockTypes: new Set(["probe"]) });
    const seenByHandler: Readonly<Record<string, string>>[] = [];
    walkProjectionParts(
      {
        node: documentNode(doc, src),
        values: partial,
        projectorId: "test",
        blockTypes: new Map([["probe", probe]]),
      },
      {
        ...structured,
        onUnresolvedSource: (ref, state, raw, ctx) => {
          seenByHandler.push(ctx.hookValues);
          return { kind: "unresolved" as const, source: ref.source, state, raw };
        },
      },
    );
    expect(seenByHook).toEqual([{ cash: "¥100" }]);
    expect(seenByHandler).toEqual([{ cash: "¥100" }, { cash: "¥100" }]);
  });

  it("without the handler, leaves fin.md byte-identical to today (golden)", () => {
    const fin = readFileSync(
      fileURLToPath(new URL("../../test/fixtures/fin.md", import.meta.url)),
      "utf8",
    );
    const doc = parseDoc(fin, {});
    const node = documentNode(doc, fin);
    // bank_balance is stale; monthly_spend did not resolve at all.
    const values = valuesFor([["bank_balance", { value: "—", stale: true }]]);
    const body = fin.slice(fin.indexOf("# Family Finance"));
    expect(walkProjection({ node, values, projectorId: "test" }, marking)).toBe(body);
    // A handler that renders each raw span reproduces the same bytes.
    const viaHandler = walkProjection(
      { node, values, projectorId: "test" },
      { ...marking, onUnresolvedSource: (_ref, _state, raw) => raw },
    );
    expect(viaHandler).toBe(body);
  });
});

describe("documentNode", () => {
  it("covers the whole source, expands nothing, and attributes nothing", () => {
    const src = "# T\n";
    const node = documentNode(parseDoc(src, {}), src);
    expect(node.ranges).toEqual([{ start: 0, end: src.length }]);
    expect(node.includes).toEqual([]);
    expect(node.provenance).toBeUndefined();
  });
});
