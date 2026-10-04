# Events

Every change that flows through the commit pipeline is recorded as an append-only event.
Whether a change arrives as a full-text write, a patch, an intent, or an external write, it
emits the same event stream.

An event is a record with a monotonic `seq`, a timestamp `t`, a `type`, the writer `by`, and
type-specific payload fields on the top level:

```ts
{ seq: 4, t: "2026-08-21T00:00:00Z", type: "status.changed", docId: "fin", blockId: "dec-macbook", from: "pending", to: "approved", by: { kind: "human", id: "me" } }
```

Every event carries `by` — the `Writer` the change was authored by, whichever route it took —
so an audit consumer can answer "who changed what" from the event alone. A writer's `kind` is
`human` (a person acting through an editor, browser, or CLI), `agent` (an autonomous or
LLM-driven agent), or `program` (a script, job, or service). All three are provenance labels
the pipeline treats identically; middleware and host policy may branch on them.

## The core events

| Event | Emitted when |
|---|---|
| `doc.created` | a document is created |
| `doc.updated` | a document's content changes through the pipeline |
| `doc.removed` | a document is removed (also emitted, followed by `doc.created`, when a write replaces a stored document too large to parse; see [Document size limit](projections.md#document-size-limit)) |
| `section.added` / `section.removed` | a section appears or disappears |
| `section.changed` | a section's prose changes (carries its `sectionId`) |
| `block.added` / `block.removed` | a block appears or disappears |
| `block.updated` | a block's attributes change |

`block.updated` carries the `blockId`, a `changes` array of the attribute paths that moved
(the same tiny path grammar `transitions` use — `value`, `items[].done`), and a `values` record
mapping each of those paths to its **new** value, so a consumer can react to what a block
became without re-reading the document:

```ts
{ seq: 7, t: "…", type: "block.updated", docId: "fin", blockId: "subs", changes: ["items[].done"], values: { "items[].done": true }, by: { kind: "agent", id: "agent-7" } }
```

A single write can emit several events: a full-text edit that rewords a section and bumps a
block value emits `doc.updated`, `section.changed`, `block.updated`, and any matched transition
events.

## Transition events

Block types declare `transitions` — attribute paths that emit named events when their value
changes. The `status` block's `value` transition emits `status.changed` (with `from` and
`to`); the `checklist` block's `items[].done` transition emits `checklist.item.done` or
`checklist.item.undone` by direction. See [Blocks](blocks.md).

## Subscribing

`engine.subscribe(handler)` delivers every event workspace-wide. `engine.subscribe(docId,
handler)` scopes delivery to a document and everything it transitively includes, so a handler
on an aggregate board fires when any of its inputs change:

```ts
const unsubscribe = engine.subscribe("fin", (evt) => {
  console.log(evt.type);
});
// ... later, to stop receiving events:
unsubscribe();
```

## Replaying from a cursor

`engine.events({ afterSeq })` returns an async iterable that replays records with `seq >
afterSeq`, in order. Capture the last sequence number you saw, then consume only what is new:

```ts
let seen = 0;
for await (const evt of engine.events({ afterSeq: seen })) {
  seen = evt.seq;
  console.log(evt.type);
}
```

## External writes

Humans editing files directly bypass the pipeline by nature. When watching is enabled,
`engine.externalWrite(path)` detects those writes, suppresses the engine's own commits (a
self-echo is recognized by content hash), and events everything else as an external write,
stamped with writer `{ kind: "human", id: "external" }` (the id is configurable). It is never
rejected — the content is already on disk — but "surfaces as diagnostics" is narrower than it
sounds: ajv schema validation runs only on the write path, so a genuine schema violation in an
external write produces no diagnostic at all on read; only YAML/id-shape problems (`E_BLOCK_YAML`,
`E_BLOCK_ID`) surface on the next projection. See [Storage and watch](storage-and-watch.md) for
enabling `watch`, workspace layout, and durability.

## Next

- [Blocks](blocks.md) — how `transitions` declare events.
- [Intents](intents.md) — how intents emit the same stream.
- [Middleware](middleware.md) — observing writes around the pipeline.
- [Storage and watch](storage-and-watch.md) — durable workspaces and external-write detection.
