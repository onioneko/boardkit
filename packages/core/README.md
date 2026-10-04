# @onioneko/boardkit-core

The BoardKit engine: a document engine where plain Markdown is the source of
truth. Documents can be written as full text, as a patch to a typed block, or
through an affordance intent; all three flow through one commit pipeline and
emit the same events. Projections (text built in, html via
[`@onioneko/boardkit-html`](https://github.com/onioneko/boardkit/tree/main/packages/html#readme)
or your own) render from that single source, and `{{include:…}}` references
aggregate several documents without copying them.

Requires Node.js 22 or later. ESM only.

## Installation

```bash
npm install @onioneko/boardkit-core
```

## Example

Save as an ES module (for example `example.mjs`) and run it with Node:

```js
import { createEngine, createMemStorage } from "@onioneko/boardkit-core";

const writer = { kind: "human", id: "me" };
const engine = createEngine({ storage: createMemStorage() });

// A document is plain Markdown. Prose is free text; `{{source:…}}` is a live value.
await engine.createDoc("notes", {
  writer,
  content: "# Notes\n\nCash: {{source:cash}}\n",
});

// Project it to text, resolving live values at read time.
const source = { async resolve() { return "¥23,450"; } };
const { output } = await engine.projection("notes", "text", { source });
console.log(output);

// Every commit is an event.
engine.subscribe((evt) => console.log(`${evt.seq} ${evt.type}`));
const result = await engine.write("notes", { writer, fullText: "# Notes\n\nUpdated.\n" });
console.log(`ok: ${result.ok}`);
```

Output:

```text
# Notes

Cash: ¥23,450

2 doc.updated
3 section.changed
ok: true
```

The root export is the stable consumer API. Pipeline internals live under
`@onioneko/boardkit-core/internal` and carry no stability guarantee. Ready-made
block types are in
[`@onioneko/boardkit-blocks`](https://github.com/onioneko/boardkit/tree/main/packages/blocks#readme).

## Guides

- [Blocks](https://github.com/onioneko/boardkit/blob/main/docs/guides/blocks.md)
- [Intents](https://github.com/onioneko/boardkit/blob/main/docs/guides/intents.md)
- [Projections](https://github.com/onioneko/boardkit/blob/main/docs/guides/projections.md)
- [Sources](https://github.com/onioneko/boardkit/blob/main/docs/guides/sources.md)
- [Events](https://github.com/onioneko/boardkit/blob/main/docs/guides/events.md)
- [Middleware](https://github.com/onioneko/boardkit/blob/main/docs/guides/middleware.md)
- [Storage and watch](https://github.com/onioneko/boardkit/blob/main/docs/guides/storage-and-watch.md)

## License

[MIT](https://github.com/onioneko/boardkit/blob/main/packages/core/LICENSE)
