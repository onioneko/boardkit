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
| `doc.created` | a document is created, or imported (`imported: true`, see [Importing a document](#importing-a-document)) |
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

## Commit boundaries

Every event carries `commit`, which says which commit appended it and where in that commit it
sits:

```ts
{ seq: 8, t: "…", type: "section.added", docId: "fin", commit: { id: "fin@3f9c…e1#a41c0d9be2f7.12", index: 1, size: 3 }, by: { … } }
```

- `id` is shared by every event of one commit: a write, a patch, an intent, a create, an
  import, a remove, or one handled external write. It is unique per event log, so group
  records by it. Its shape is `<docId>@<version>#<prefix>.<n>`: `version` is the committed
  content's hash, 64 hex digits (the removed content's, for `doc.removed`); `prefix` identifies
  the engine; and `n` counts that engine's commits from 1. Treat the id as opaque.
- `index` is the event's position in the commit, from 0, and `size` is the commit's event count.
  The event with `index === size - 1` closes the commit.

The prefix is random for each engine, so ids stay unique when the engine restarts or when
several engines append to one log. To get reproducible ids, in tests for example, pin it with
`createEngine({ commitIdPrefix: "test" })`. Engines that share a log must then use different
prefixes.

A subscriber that re-renders on change can wait for the closing event instead of debouncing:

```ts
engine.subscribe("fin", (evt) => {
  if (evt.commit === undefined || evt.commit.index === evt.commit.size - 1) rerender();
});
```

This works because every event of a commit has the same `docId`, so a subscriber scoped to a
document always sees whole commits.

The records of one commit keep their order, but they are not always adjacent. Commits on
different documents run at the same time, so their records can interleave in the log, for
example `b:0 a:0 b:1 a:1`. A reader of the whole log groups by `id`, not by position. The fs
event log stores the field, so a replay groups the same way. A record from an older log, or one a
host appended by hand, has no `commit`.

## Importing a document

`engine.importDoc(docId, { writer, content })` puts a document back exactly as it was: the
restore path for a trash or an undo. It stores `content` byte for byte, including content
`createDoc` would reject (attrs that fail their schema, a document over a complexity limit) or
rewrite (bounded-history truncation), and emits one `doc.created` with `imported: true`:

```ts
const result = await engine.importDoc("notes/q3", { writer, content: trashed.src });
// events: [{ type: "doc.created", docId: "notes/q3", imported: true, by: writer, commit: { … } }]
```

It is a commit like any other: the write policy and write middleware see mode `"import"` (and
may veto it), it takes the document lock, the watcher does not event it a second time, and
scoped subscribers and caches see the new document. Middleware may not amend an import's bytes:
an amended proposal is rejected with `import-amended`. An existing id is rejected with `exists`.

Content over `maxDocumentBytes` is rejected with `too-large`. Pass `ignoreSizeLimit: true` to
store it anyway; it is then never parsed, and its projection is `ok: false` with
`E_DOCUMENT_TOO_LARGE`, like a document written outside the engine.

A consumer that switches on the event type sees an ordinary `doc.created`. Check `imported` to
tell a restore from a create.

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

The engine keeps the include graph behind scoped delivery up to date as documents change. It
re-reads a subscribed board's include closure only when a commit may have changed an include
edge in it: a commit that adds, removes or retargets an `{{include:…}}`, renames a section, or
creates, imports or removes a document. Other edits re-read nothing. The graph follows every
commit made through the engine and every external write reported through `watch` (or
`engine.externalWrite`). A document changed in storage behind the engine's back, with no watch,
is seen once it is next committed or reported, or once a resolution for another subscriber reads
it.

Document ids are compared exactly, case included. On a case-insensitive file system,
`{{include:Notes}}` and a commit to `notes` touch the same file but name different documents, so
a commit to `notes` is not delivered to a board that includes `Notes`. Spell each id the same way
everywhere.

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
