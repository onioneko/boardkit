// 01-hello.ts — the whole BoardKit lifecycle: create a document, project it,
// watch its events, write through an intent, and read the result back.

import { readFile } from "node:fs/promises";
import { starterBlocks } from "@onioneko/boardkit-blocks";
import { createEngine, createMemStorage, type Source, type Writer } from "@onioneko/boardkit-core";

// 1. An engine over in-memory storage, with the starter block types.
const writer: Writer = { kind: "human", id: "me" };
const engine = createEngine({ storage: createMemStorage(), blocks: starterBlocks });

// 2. Text in: the document is a markdown file.
const fin = await readFile(new URL("./fin.md", import.meta.url), "utf8");
await engine.createDoc("fin", { writer, content: fin });

// 3. Text out: a projection resolves {{source:…}} and renders every block.
const source: Source = {
  async resolve(ref) {
    return ref.source === "bank_balance" ? "¥23,450" : "—";
  },
};
const projected = await engine.projection<string>("fin", "text", { source });
console.log(projected.output);

// 4. Watch: every commit is an event.
engine.subscribe((evt) => {
  console.log(`${evt.seq} ${evt.type}`);
});

// 5. One write: an intent — the block decides what "transition" means.
const approve = {
  docId: "fin",
  blockId: "dec-macbook",
  affordance: "transition",
  params: { to: "approved" },
};
const result = await engine.applyIntent(approve, { writer });
console.log(`ok: ${result.ok}`);

// 6. The file changed — only the markdown moved.
const doc = await engine.getDoc("fin");
console.log(doc?.src.split("\n").find((line) => line.startsWith("value:")));

// Output:
// # Family Finance
//
// Cash: ¥23,450
//
// **STATUS**: pending
//
// - [ ] Buy MacBook
//
// 2 doc.updated
// 3 block.updated
// 4 status.changed
// ok: true
// value: approved
