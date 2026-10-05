// 05-custom-projector.ts — register a `json` projector: walk the document
// with `walkProjectionParts`, consult each block's own `json` hook, and fall
// back to its attrs for block types that declare none. A `{{source:…}}` ref
// whose value is missing or stale still gets a keyed record, through the
// optional `onUnresolvedSource` handler, so a live view can fill it in later.

import { readFile } from "node:fs/promises";
import { starterBlocks } from "@onioneko/boardkit-blocks";
import {
  type BlockType,
  createEngine,
  createMemStorage,
  documentNode,
  type ProjectionInput,
  type Writer,
  walkProjectionParts,
} from "@onioneko/boardkit-core";

// 1. A local block type: its `json` hook returns a plain object — Task A's
// widened `unknown` return means handing one back needs no cast.
type NoteAttrs = {
  readonly id: string;
  readonly text: string;
};
const noteBlock: BlockType<NoteAttrs> = {
  type: "note",
  schema: {
    type: "object",
    required: ["id", "text"],
    properties: { id: { type: "string" }, text: { type: "string" } },
    additionalProperties: false,
  },
  project: {
    json: (attrs) => ({ text: attrs.text, words: attrs.text.trim().split(/\s+/).length }),
  },
};

// 2. One piece per block and one per ref; prose and includes contribute
// nothing to the assembled JSON, so those handlers return `undefined`. A
// resolved ref reaches `onSource`; one with no value or a stale one reaches
// `onUnresolvedSource` (without that handler it would stay verbatim prose).
// Block hooks never see either kind of unresolved value.
type Piece = { readonly id: string; readonly type: string; readonly value: unknown } | undefined;

function toJson(input: ProjectionInput): Piece[] {
  const node = input.merged?.root ?? documentNode(input.doc, input.src);
  return walkProjectionParts<Piece>(
    { node, values: input.values, projectorId: "json", blockTypes: input.blockTypes },
    {
      onProse: () => undefined,
      onSource: (value, ref) => ({ id: ref.source, type: "source", value }),
      onUnresolvedSource: (ref, state) => ({
        id: ref.source,
        type: "source",
        value: state.stale ? { stale: true } : null,
      }),
      onInclude: () => undefined,
      onBlock: ({ block, hooked, output }) => ({
        id: block.blockId,
        type: block.type,
        value: hooked ? output : block.attrs,
      }),
    },
  );
}

// 3. Register it like any projector, then run it over a doc mixing hookless
// blocks (fin.md's status/checklist, which fall back to attrs) with a hooked
// one (the note appended below).
const writer: Writer = { kind: "human", id: "me" };
const engine = createEngine({ storage: createMemStorage(), blocks: [...starterBlocks, noteBlock] });
engine.registerProjector({ id: "json", project: toJson });

const fin = await readFile(new URL("./fin.md", import.meta.url), "utf8");
const content = `${fin}\n\`\`\`note\nid: memo\ntext: Ask about the warranty.\n\`\`\`\n`;
await engine.createDoc("fin-json", { writer, content });

// 4. JSON out: each ref and block, in document order. No `Source` is passed,
// so `bank_balance` has no value and comes out keyed, with a `null` value.
const projected = await engine.projection<Piece[]>("fin-json", "json", {});
const blocks = projected.output.filter((p): p is NonNullable<Piece> => p !== undefined);
console.log(JSON.stringify(blocks));

// Output:
// [{"id":"bank_balance","type":"source","value":null},{"id":"dec-macbook","type":"status","value":{"id":"dec-macbook","states":["pending","approved","executed"],"value":"pending"}},{"id":"subs","type":"checklist","value":{"id":"subs","items":[{"id":"c","label":"Buy MacBook","done":false}]}},{"id":"memo","type":"note","value":{"text":"Ask about the warranty.","words":4}}]
