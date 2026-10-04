# Blocks

A **block** is a typed, stateful region of a document: a fenced code block whose info string
names a registered block type, with a YAML body holding the block's attributes.

````markdown
```status
id: dec-macbook
title: Buy MacBook
states: [pending, approved, rejected]
value: pending
```
````

A fence becomes a block when its info string names a **registered** block type — one passed to
`createEngine({ blocks })` or added later with `engine.registerBlock`. Any other fence stays
ordinary code. Registering a type takes effect immediately: `registerBlock` invalidates the
engine's parse and merge caches, so a fence that was code a moment ago is a block on the very
next projection.

## The eight parts of a block type

A `BlockType` has eight parts. `type` and `schema` are required; the rest are optional.

| Part | Purpose |
|---|---|
| `type` | the name in the fence's info string |
| `schema` | JSON Schema for the attributes (static shape rules) |
| `validate` | cross-field rules JSON Schema cannot express (returns `Diagnostic[]`) |
| `transitions` | attribute paths that emit named events when their value changes |
| `affordances` | consumer-requestable operations (`{ name, params?, patch }`) that produce a delta |
| `history` | a list attribute (`{ attr, max }`) truncated on write |
| `sources` | the live-value references this block instance depends on |
| `project` | per-projector rendering hooks (`text` and `html`) |

Each `schema` is compiled on its own: a `$ref` may point inside the schema (`#`, `#/$defs/…`),
but not to another block type's schema by its `$id`.

Hooks receive a block's attrs read-only: the engine shares one parse of a document between
readers and freezes its attrs, so a hook that modifies them throws and the block falls back to
its verbatim source.

## Transitions

A `transitions` entry observes one attribute path and emits a named event when that value
changes. The path grammar is deliberately tiny: a top-level key (`value`) or one array hop
with a terminal field (`items[].done`).

Use `event` to name one event for both directions, or `events` to name a different event per
direction. The `events` map is keyed by the canonical direction `"from→to"` (U+2192 arrow):

```ts
transitions: [
  {
    attr: "items[].done",
    events: {
      "false→true": "checklist.item.done",
      "true→false": "checklist.item.undone",
    },
  },
],
```

When `events` is present it takes precedence over `event`; a direction with no map entry emits
no transition event (fail-soft).

## Patch semantics

A patch is a **shallow merge** into the block's attributes: top-level keys are merged, and
array values are replaced wholesale. Every byte outside the block's YAML body is preserved,
including comments, blank lines, and key order inside it.

## Live values: `sources` and the `values` record

Prose declares its live values inline with `{{source:…}}`. A block declares them with
`sources` — the live-value references *this block instance* depends on, derived from its own
attributes. This is a simplified version of `metric`, one of the starter blocks (the shipped
type also has a `view` and `thresholds` and an `html` hook; see `packages/blocks/src/metric.ts`
or the generated API docs for the full definition):

```ts
import type { BlockType } from "@onioneko/boardkit-core";

type MetricAttrs = {
  readonly id: string;
  readonly label: string;
  readonly source: string;
};

const metricBlock: BlockType<MetricAttrs> = {
  type: "metric",
  schema: {
    type: "object",
    required: ["id", "label", "source"],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      source: { type: "string" },
    },
    additionalProperties: false,
  },
  sources: (attrs) =>
    typeof attrs.source === "string" ? [{ kind: "source", source: attrs.source, params: {} }] : [],
  project: {
    text: (attrs, values) => `${attrs.label}: ${values[attrs.source] ?? attrs.source}`,
  },
};
```

> **Attrs types must be `type`, not `interface`.** `BlockType<A>` constrains `A` to
> `Record<string, unknown>`, and TypeScript only grants object type literals (`type X = {…}`) an
> implicit index signature satisfying that constraint — an `interface` never gets one. Declare
> `interface MetricAttrs { … }` instead and `BlockType<MetricAttrs>` fails to compile with a
> non-obvious `TS2344: Type 'MetricAttrs' does not satisfy the constraint 'Record<string,
> unknown>'`. Always declare a block's attrs as `type X = { … }`.

A `SourceRef` is `{ kind: "source", source, params }` — the same reference shape a
`{{source:…}}` span parses to. `metric`'s `source` attribute names the reference it wants, so a
metric renders its live value standing on its own, with no `{{source:…}}` anywhere in the prose.
The engine collects block-declared refs together with the document's prose refs and resolves the
whole set once, at RESOLVE, in the same dedup-batched pass. [Sources](sources.md) covers this
metric-vs-prose distinction end to end.

`sources` must be **pure and never throw**: it is called during the read path with the block's
committed attrs and nothing else. A `sources` that throws contributes no references (fail-soft)
— the block still renders, just without live values.

The `values` record a `project` hook receives (`text` above) is keyed by **source id** and holds
**param-less** refs only, from prose and block-declared refs alike. A ref that carries params has
no unambiguous id key, so it is resolved but not placed in the hook record. Custom projectors see
every resolved ref — param-bearing ones included — on `input.values`, keyed by the ref's
canonical key. See [Projections](projections.md) and [Sources](sources.md).

## The starter blocks

`@onioneko/boardkit-blocks` ships six types, exported together as `starterBlocks`:

| Type | What it models |
|---|---|
| `checklist` | labeled checkbox items; `toggle` affordance; directional `checklist.item.done` / `checklist.item.undone` events |
| `status` | an ordered state machine; `transition` affordance; `status.changed` event |
| `metric` | a labeled live value backed by a source reference, declared through `sources` so it renders standalone |
| `chart` | an opaque chart spec — `spec` is rendered untouched by both hooks (text emits it verbatim; html emits `<pre class="chart" data-source="…">spec</pre>`); `type` labels the spec's dialect (e.g. `mermaid`) for a host's own renderer to interpret — the shipped hooks never read it |
| `form` | a question with typed fields; `answer` affordance |
| `rule` | a `when`/`do` automation with an `enabled` switch; `toggle` affordance |

**Rendering a chart.** BoardKit never draws a chart — `chart`'s html hook is a fallback, not a renderer. A host draws one of three ways: register its own `chart` block type whose html hook returns the host's element (a `<pre class="mermaid">` for a page that loads mermaid, an `<img>` for a server-side renderer); transform the html in a projection middleware; or post-process `pre.chart` elements on the page. The library's job stops at the opaque spec, validated and recorded like any other attribute.

## Registering block types

Pass `blocks` to `createEngine`, or register later with `engine.registerBlock`:

```ts
import { createEngine, createMemStorage } from "@onioneko/boardkit-core";
import { starterBlocks } from "@onioneko/boardkit-blocks";

const engine = createEngine({
  storage: createMemStorage(),
  blocks: starterBlocks,
});

// Registering later works the same way, and takes effect on the next projection:
engine.registerBlock(myBlockType);
```

## A custom block, end to end

Typed attrs, a schema, one affordance, one transition, and a text projection — no `as` on
`attrs` anywhere; the only cast is on an affordance's `params`, which is `unknown` by design
(intent params arrive as untyped JSON):

````ts
import { createEngine, createMemStorage, type BlockType, type Writer } from "@onioneko/boardkit-core";

type CounterAttrs = {
  readonly id: string;
  readonly value: number;
};

const counterBlock: BlockType<CounterAttrs> = {
  type: "counter",
  schema: {
    type: "object",
    required: ["id", "value"],
    properties: { id: { type: "string" }, value: { type: "number" } },
    additionalProperties: false,
  },
  transitions: [{ attr: "value", event: "counter.changed" }],
  affordances: [
    {
      name: "increment",
      params: {
        type: "object",
        required: ["by"],
        properties: { by: { type: "number" } },
        additionalProperties: false,
      },
      patch: (attrs, params) => ({ value: attrs.value + (params as { by: number }).by }),
    },
  ],
  project: {
    text: (attrs) => `**Count**: ${attrs.value}`,
  },
};

const writer: Writer = { kind: "human", id: "me" };
const engine = createEngine({ storage: createMemStorage(), blocks: [counterBlock] });

await engine.createDoc("tally", {
  writer,
  content: "# Tally\n\n```counter\nid: tally\nvalue: 0\n```\n",
});

const result = await engine.applyIntent(
  { docId: "tally", blockId: "tally", affordance: "increment", params: { by: 3 } },
  { writer },
);
console.log(result.ok); // true
````

The runnable version — with `subscribe`, a projection read-back, and its committed
`// Output:` — is [`examples/04-custom-block.ts`](../../examples/04-custom-block.ts).

## Next

- [Projections](projections.md) — how `project` hooks and references render a document.
- [Intents](intents.md) — how `affordances` become consumer requests.
- [Events](events.md) — how `transitions` become an event stream.
- [Sources](sources.md) — `sources`, prose refs, and how a live value reaches a hook.
