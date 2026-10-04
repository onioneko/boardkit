# Getting started

BoardKit's whole job is to keep your documents as plain Markdown while letting you build live, interactive views and writes on top of them. This page takes you from an empty project to a working projection in about 30 seconds.

## 1. Install

```bash
pnpm add @onioneko/boardkit-core @onioneko/boardkit-blocks
```

`@onioneko/boardkit-core` is the engine. `@onioneko/boardkit-blocks` is a pack of six ready-made block types (checklist, status, metric, chart, form, rule); install it unless you want to define every block yourself.

## 2. Create a workspace

A workspace is just a place documents live. In-memory storage is enough to get started; swap in the filesystem adapter for a durable workspace.

```ts
import {
  createEngine,
  createMemStorage,
  type Source,
  type Writer,
} from "@onioneko/boardkit-core";
import { starterBlocks } from "@onioneko/boardkit-blocks";

const writer: Writer = { kind: "human", id: "me" };

const source: Source = {
  async resolve(ref) {
    if (ref.source === "bank_balance") return "¥23,450";
    return "—";
  },
};

const engine = createEngine({
  storage: createMemStorage(),
  blocks: starterBlocks,
});

await engine.createDoc("fin", {
  writer,
  content: `---
title: Family Finance
---

# Family Finance

## Now {#now}
- Cash: {{source:bank_balance}}

## Large Purchases
\`\`\`status
id: dec-macbook
title: Buy MacBook
states: [pending, approved, rejected, executed]
value: pending
\`\`\`
`,
});
```

That one document carries a `{{source:…}}` live reference and a typed `status` block. The text is the state.

## 3. Project

A projection renders the source through a named projector. `text` ships with the engine and
returns a string — the type parameter on `projection<string>` says so at the call site. The
`html` projector lives in `@onioneko/boardkit-html`; install it and register it when you want HTML:

```ts
import { htmlProjector } from "@onioneko/boardkit-html";

engine.registerProjector(htmlProjector);
```

```ts
const projection = await engine.projection<string>("fin", "text", { source });

console.log(projection.output);
console.log(projection.diagnostics);
```

## 4. Act on an intent

Projections expose affordances — the operations a block offers. The `status` block's `transition` affordance moves it to another state:

```ts
const result = await engine.applyIntent(
  {
    docId: "fin",
    blockId: "dec-macbook",
    affordance: "transition",
    params: { to: "approved" },
  },
  { writer },
);

console.log(result.ok); // true
```

An intent goes through the same commit pipeline as a full-text write or a patch, so every route emits the same `status.changed` event. See [Intents](guides/intents.md) for the full story.

## Next

- [Blocks](guides/blocks.md) — define your own typed blocks.
- [Projections](guides/projections.md) — write a custom projector.
- [Events](guides/events.md) — subscribe to and replay changes.
- [Sources](guides/sources.md) — `{{source:…}}`, block-declared refs, and staleness.
- [Storage and watch](guides/storage-and-watch.md) — durable workspaces and external edits.
- [Middleware](guides/middleware.md) — amend, reject, and transform writes and projections.

Or start from [`docs/README.md`](README.md) for the full guide index.
