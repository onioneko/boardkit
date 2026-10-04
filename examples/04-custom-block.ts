// 04-custom-block.ts — a newcomer defines a block end to end: typed attrs, a
// schema, one affordance, one transition, and a text projection.

import {
  type BlockType,
  createEngine,
  createMemStorage,
  type Writer,
} from "@onioneko/boardkit-core";

// 1. Attrs: the block's own shape, threaded through the schema, the
// affordance, and the projection hook below — no `as` anywhere.
type CounterAttrs = {
  readonly id: string;
  readonly value: number;
};

// 2. The block type: schema with `required`, one pure affordance, one
// transition emitting a named event, and a `text` projection.
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

// 3. A doc with the typed fence, and an engine that knows the type.
const doc = "# Tally\n\n```counter\nid: tally\nvalue: 0\n```\n";
const writer: Writer = { kind: "human", id: "me" };
const engine = createEngine({ storage: createMemStorage(), blocks: [counterBlock] });
await engine.createDoc("tally", { writer, content: doc });

// 4. Watch: every commit is an event.
engine.subscribe((evt) => console.log(`${evt.seq} ${evt.type}`));

// 5. One write: an intent — the affordance decides what "increment" means.
const bump = { docId: "tally", blockId: "tally", affordance: "increment", params: { by: 3 } };
const result = await engine.applyIntent(bump, { writer });
console.log(`ok: ${result.ok}`);

// 6. Text out: the block's own projection, reading the committed value back.
const projected = await engine.projection<string>("tally", "text", {});
console.log(projected.output);

// Output:
// 2 doc.updated
// 3 block.updated
// 4 counter.changed
// ok: true
// # Tally
//
// **Count**: 3
//
