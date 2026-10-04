# BoardKit

[![CI](https://github.com/onioneko/boardkit/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/onioneko/boardkit/actions/workflows/ci.yml) [![@onioneko/boardkit-core](https://img.shields.io/npm/v/@onioneko/boardkit-core?label=boardkit-core)](https://www.npmjs.com/package/@onioneko/boardkit-core) [![@onioneko/boardkit-html](https://img.shields.io/npm/v/@onioneko/boardkit-html?label=boardkit-html)](https://www.npmjs.com/package/@onioneko/boardkit-html) [![@onioneko/boardkit-blocks](https://img.shields.io/npm/v/@onioneko/boardkit-blocks?label=boardkit-blocks)](https://www.npmjs.com/package/@onioneko/boardkit-blocks)

BoardKit: the text source is the state — a document engine with dual-mode writes, projections, events, and include aggregation.

BoardKit is a writer-agnostic and consumer-agnostic document engine. Plain Markdown is the source of truth: you can edit a document as full text, as a patch to a typed block, or through an affordance intent — all three flow through one commit pipeline and emit the same events. Any number of projections (text, HTML, or your own) render from that single source, and `{{include:…}}` references aggregate multiple documents without copying them.

## Packages

| Package | What it is |
|---|---|
| [`@onioneko/boardkit-core`](packages/core) | the engine — parse, link, merge, resolve, project, write, events, ports |
| [`@onioneko/boardkit-html`](packages/html) | the `html` projector; install and register it when you want HTML rather than markdown out |
| [`@onioneko/boardkit-blocks`](packages/blocks) | six ready-made block types — checklist, status, metric, chart, form, rule |

`@onioneko/boardkit-core` never depends on the other two; `@onioneko/boardkit-html` and `@onioneko/boardkit-blocks` each
depend only on `@onioneko/boardkit-core`, so either is optional and neither depends on the other.

## Quick start

Runnable versions of this and four more live in `examples/` — `pnpm example 01-hello.ts`.

```bash
pnpm add @onioneko/boardkit-core @onioneko/boardkit-blocks
```

```ts
import {
  createEngine,
  createMemStorage,
  type Clock,
  type Source,
  type Writer,
} from "@onioneko/boardkit-core";
import { starterBlocks } from "@onioneko/boardkit-blocks";

const clock: Clock = () => new Date().toISOString();
const writer: Writer = { kind: "human", id: "me" };

// Resolve {{source:…}} references at projection time.
const source: Source = {
  async resolve(ref) {
    if (ref.source === "bank_balance") return "¥23,450";
    return "—";
  },
};

const storage = createMemStorage();
const engine = createEngine({
  storage,
  clock,
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

const projection = await engine.projection<string>("fin", "text", { source });
console.log(projection.output);
```

## Documentation

- [Docs index](docs/README.md) — the one-screen map of getting started, every guide, the examples, and the workbench.
- [Getting started](docs/getting-started.md) — install, create a workspace, and run your first projection.
- Guides: [blocks](docs/guides/blocks.md), [projections](docs/guides/projections.md), [sources](docs/guides/sources.md), [intents](docs/guides/intents.md), [events](docs/guides/events.md), [middleware](docs/guides/middleware.md), [storage and watch](docs/guides/storage-and-watch.md).
- [API reference](docs/api) — generated from the source's JSDoc.

## Try it: the workbench

`apps/demo` is not a script that prints a story — it is a **long-running server** over a real filesystem workspace. Start it, then edit the same three documents from your editor, from the browser page it serves, and from any program that speaks its JSON API, and watch every other surface follow.

From a fresh clone, `pnpm install && pnpm build` first — the workbench imports the workspace packages from their built `dist/`.

```bash
pnpm --filter boardkit-demo demo          # alias: pnpm --filter boardkit-demo serve
```

It prints where everything is and then mirrors every commit and every rejection, one line each:

```
BoardKit workbench
  workspace  /…/apps/demo/.workspace                open this folder in your editor
  seeded     three documents were written to an empty workspace
  browser    http://127.0.0.1:4321
  api        GET  /api/state · /api/doc/{id} · /api/projection/{id}?format=html|text&reader=owner|guest
             PUT  /api/doc/{id} · PATCH /api/doc/{id}/block/{blockId} · POST /api/intent
             GET  /api/events?afterSeq=N   (server-sent events; Last-Event-ID resumes)
             writers identify themselves with  X-Writer: program:<id> | agent:<id> | human:<id>
  reactor    on   program:reactor-1 — when dec-macbook → approved it ticks "Buy MacBook" and appends a note
  guard      on   only a human may transition a status to `executed`
  events     /…/apps/demo/.workspace/events.jsonl   (last seq 3)
Ctrl-C to stop.
```

The workspace is git-ignored and durable: documents and `events.jsonl` survive a restart, so the log continues where it stopped. Open `http://127.0.0.1:4321` in a browser and leave the console visible.

### 1. Edit on disk — the engine's watcher reports it

Open `.workspace/fin.md` in your editor, change `value: pending` to `value: approved` under the `dec-macbook` status block, and save. The console shows the commit as `by human:editor`, the browser redraws the board, and the reactor — a script subscribed to the same events — ticks "Buy MacBook" and appends a note:

```
#4   doc.updated        fin                                       by human:editor
 …
#6   status.changed     fin/dec-macbook   pending → approved      by human:editor
 …
#9   checklist.item.done fin/subs         false → true            by program:reactor-1
```

(Every write emits several events — `block.updated`, `section.changed` — and the mirror prints them all; the lines between these are elided here.)

### 2. Click in the browser — the text is what changed

Click a checklist item or a status button on the **board** tab. The click POSTs the `data-intent` payload the HTML projector rendered to `/api/intent`; switch to the **source** tab and the YAML line for that item now reads the other way. Nothing but the markdown was written.

### 3. Write as a program — and be refused

```bash
curl -X POST http://127.0.0.1:4321/api/intent -H 'X-Writer: program:curl' -H 'Content-Type: application/json' \
  -d '{"docId":"fin","blockId":"dec-macbook","affordance":"transition","params":{"to":"executed"}}'
```

```
409  {"ok":false,"rejection":{"reason":"humans-only","diagnostics":[{"code":"E_NOT_HUMAN", …}]}}
```

One write middleware rejected it, and the console mirrors the refusal to every surface:

```
 ✗   rejected           fin/dec-macbook   humans-only             by program:curl
```

Send the same intent as `-H 'X-Writer: human:me'` and it commits. Provenance is a claim the caller makes and the pipeline records; the guard is policy written over it.

`X-Writer` is a demo-only identity label, **not authentication**: anyone who can reach the port can claim any writer, including `human:*`. The demo is safe to run only because it binds `127.0.0.1` and refuses requests whose `Host` is not `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` (421, which blocks DNS rebinding), and refuses writes (`POST`/`PUT`/`PATCH`/`DELETE`) whose `Origin` header is present and is not its own origin (403). Requests with no `Origin` (curl, scripts) are accepted. The page is served with a strict Content-Security-Policy (no inline script or style). Do not expose the demo on a non-loopback address.

### See value-CAS reject a stale click

Click **● live** in the page header to pause the stream. Now change `value:` in your editor and save. The paused page still holds the buttons it rendered before — each carries the `expectedVersion` and `expected` values it was rendered with — so clicking one now is refused with `expected-mismatch` and the banner names the live value.

### See two readers

Switch the **reader** select from `owner` to `guest`. The same committed bytes project with `Cash: ¥••••` — a projection middleware masks the resolved value on the way out; the Source port still returns the real amount.

### See an opaque chart

`research/q3-review.md` carries a `chart` block; the board shows its spec as text in `<pre class="chart">`, because the library does not interpret chart DSLs. Edit the spec in the **source** tab and the mirror shows `block.updated` by you — a validated, recorded change to an opaque spec; drawing it is the host's job. See [Blocks](docs/guides/blocks.md).

### See replay

Press Ctrl-C, then start the workbench again over the same workspace. Nothing is reseeded, the log continues, and the page reconnects with `Last-Event-ID` — resuming exactly after the last event it saw.

### Flags

```bash
pnpm --filter boardkit-demo demo --port 4321 --root ./ws --reset --no-reactor --no-guard
```

`--port 0` picks an ephemeral port. `--root` opens (and creates) any directory. `--reset` empties the root and reseeds the three fixtures — it refuses a directory that holds neither `events.jsonl` nor a markdown document, so a mistyped `--root` cannot delete somebody's work. `--no-reactor` leaves the automated writer unsubscribed; `--no-guard` removes the humans-only rule.

### Where an LLM agent plugs in

The reactor is a *script* — no reasoning, writer kind `program`. A real agent uses exactly the same API and says who it is with `X-Writer: agent:<id>`. Save this as `agent.mjs` and run it with `node agent.mjs` (Node ≥22, no dependencies) while the workbench is up:

```js
// agent.mjs — where an LLM agent plugs in: subscribe, decide, write back.
const base = "http://127.0.0.1:4321";
const headers = { "content-type": "application/json", "x-writer": "agent:my-agent" };
const toggle = { docId: "fin", blockId: "subs", affordance: "toggle", params: { itemId: "c" } };
const { lastSeq } = await (await fetch(`${base}/api/state`)).json(); // start from now, not from the log
const dec = new TextDecoder(); let buf = "";
for await (const chunk of (await fetch(`${base}/api/events?afterSeq=${lastSeq}`)).body) {
  const lines = (buf + dec.decode(chunk, { stream: true })).split("\n");
  buf = lines.pop() ?? "";
  for (const evt of lines.filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)))) {
    if (evt.type !== "status.changed" || evt.to !== "approved") continue;
    const res = await fetch(`${base}/api/intent`, { method: "POST", headers, body: JSON.stringify(toggle) });
    console.log(`#${evt.seq} ${evt.blockId} → ${evt.to}; my toggle → HTTP ${res.status}`);
  }
}
```

Approve `dec-macbook` from your editor or the page, and the agent answers:

```
#17 dec-macbook → approved; my toggle → HTTP 200
```

…while the workbench's console records who did it — the reactor had already ticked that item, so the agent's toggle flipped it back, and both writes are in the log under their own names:

```
#22  checklist.item.undone fin/subs       true → false            by agent:my-agent
```

Swap the `if` for a model call and you have an agent. `engine.subscribe` (perceive), `engine.projection` (read), `engine.applyIntent` (act) are the same three calls behind these three routes.

### Notes

- The workbench binds `127.0.0.1` and has no auth. It is a workbench, not a deployment.
- The write routes demand a JSON content type, so another website cannot post to the loopback workbench: sending `application/json` cross-origin requires a preflight, which browsers refuse here because the server answers no `OPTIONS`.
- The reactor stands in for any automated writer. Its "is it already ticked?" read happens outside the write lock, so a human toggling the same item in that instant can leave it un-ticked — the feed makes whatever happened visible rather than hiding it.
- The engine's file watcher has a short re-watch gap after each commit (the atomic temp-file rename swaps the inode). An editor that saves twice inside that window can lose the second save's notification.
- Rejections are broadcast live only and never persisted: a paused page misses other writers' rejections, though its own always arrive in its HTTP response.
- The API has no `DELETE`, and the page has no "new document" button — a `PUT /api/doc/{newId}` creates one.


## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development standards and the changesets process.

## License

[MIT](LICENSE)
