# BoardKit docs

BoardKit is a document engine where the text source is the state: plain Markdown you edit as
full text, as a patch to a typed block, or through an affordance intent, with every route
committing through one pipeline and emitting the same events. Any number of projections — the
built-in `text`, the separately-installed `html`, or your own — render live views from that one
source, and `{{include:…}}` aggregates documents together without copying them.

## Start here

[Getting started](getting-started.md) takes you from an empty project to a working projection in
about 30 seconds. After that, the guides below go deep on one topic each — read them in whatever
order your question is in, or top to bottom for the full picture.

## Guides

| Guide | What it covers |
|---|---|
| [Blocks](guides/blocks.md) | typed block types — schema, transitions, affordances, `sources`, `project` hooks — and a custom block end to end |
| [Projections](guides/projections.md) | the `Projector` interface, source-faithful span rewriting, include expansion, and writing your own projector on the public walk |
| [Sources](guides/sources.md) | the `Source` port, `{{source:…}}` prose refs vs. a block's own `sources` declaration, canonical keys, staleness |
| [Intents](guides/intents.md) | consumer-produced requests, the `data-intent` payload, in-lock decoding, value-CAS rebase |
| [Events](guides/events.md) | the append-only event stream, transitions, subscribing, replay, external writes |
| [Middleware](guides/middleware.md) | write and projection middleware, patch-proposal shapes, per-reader redaction |
| [Storage and watch](guides/storage-and-watch.md) | mem vs. filesystem storage, workspace layout on disk, durability, watching for external edits |

## Beyond the guides

- **`examples/`** — five runnable, CI-checked scripts: the whole lifecycle in about 30 lines
  (`01-hello.ts`), watching external edits (`02-watch.ts`), an automated writer (`03-agent.ts`),
  a hand-rolled block (`04-custom-block.ts`), and a hand-rolled projector
  (`05-custom-projector.ts`). See [`examples/README.md`](../examples/README.md).
- **`apps/demo`** — the workbench: a long-running server over a real filesystem workspace you
  edit from your own editor, its browser page, and a program's API calls at once, watching every
  surface follow the others. See "Try it: the workbench" in the [root README](../README.md#try-it-the-workbench).
- **[`docs/api`](api/index.html)** — the API reference, generated from the source's JSDoc, for
  the full signature of anything a guide only sketches.
