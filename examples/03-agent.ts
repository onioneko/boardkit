// 03-agent.ts — an automated writer: subscribe to perceive, applyIntent to
// act, reacting to a human's decision on the same event stream.

import { readFile } from "node:fs/promises";
import { starterBlocks } from "@onioneko/boardkit-blocks";
import {
  createEngine,
  createMemStorage,
  type EventRecord,
  type Writer,
} from "@onioneko/boardkit-core";

const human: Writer = { kind: "human", id: "me" };
const agent: Writer = { kind: "agent", id: "buyer" };
const engine = createEngine({ storage: createMemStorage(), blocks: starterBlocks });

// 1. Text in: the same shared document every example opens.
const fin = await readFile(new URL("./fin.md", import.meta.url), "utf8");
await engine.createDoc("fin", { writer: human, content: fin });

// An event's extra fields are untyped; `by` is the writer that made the commit.
function authorTag(evt: EventRecord): string {
  const by = evt.by as Writer;
  return `${by.kind}:${by.id}`;
}

// The agent's pending write, kept so the script can await it below.
let reaction: Promise<unknown> | undefined;

// buyer is the agent: it watches the stream and reacts to one signal.
function buyer(evt: EventRecord): void {
  // perceive
  const approved = evt.type === "status.changed" && evt.to === "approved";
  if (!approved) return;
  // act
  const toggle = {
    docId: "fin",
    blockId: "subs",
    affordance: "toggle",
    params: { itemId: "c" },
  };
  reaction = engine.applyIntent(toggle, { writer: agent });
}

// 2. Watch: every commit is an event — the agent reacts on the same stream.
engine.subscribe("fin", (evt) => {
  console.log(`${evt.seq} ${evt.type} by ${authorTag(evt)}`);
  buyer(evt);
});

// 3. A human approves the decision.
await engine.patch("fin", "dec-macbook", { writer: human, attrs: { value: "approved" } });

// 4. Wait for the agent's reaction before reading the result back.
await reaction;

// 5. The file changed — the checklist item the agent ticked.
const subs = await engine.getBlock("fin", "subs");
const items = subs?.attrs.items as { id: string; done: boolean }[];
const bought = items.find((item) => item.id === "c");
console.log(`done: ${bought?.done}`);

// Output:
// 2 doc.updated by human:me
// 3 block.updated by human:me
// 4 status.changed by human:me
// 5 doc.updated by agent:buyer
// 6 block.updated by agent:buyer
// 7 checklist.item.done by agent:buyer
// done: true
