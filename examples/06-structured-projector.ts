// 06-structured-projector.ts — a projector whose output is a JSON view, not
// an HTML string, built on the html package's two halves: `projectHast`
// projects each node to hast with every ref, block and include left as a hole
// this file fills, and `sanitizePanelHast` applies the html projector's exact
// sanitize policy before the tree is turned into JSON.

import { starterBlocks } from "@onioneko/boardkit-blocks";
import {
  createEngine,
  createMemStorage,
  documentNode,
  type ProjectionInput,
  type ProjectionNode,
  type ProjectionWalkOptions,
  type Source,
  type Writer,
} from "@onioneko/boardkit-core";
import {
  type HastHoleHandlers,
  includeWrapper,
  projectHast,
  sanitizePanelHast,
} from "@onioneko/boardkit-html";
import type { ElementContent, Root, RootContent } from "hast";

// 1. A compact JSON view of sanitized hast: elements keep their tag and the
// attributes a view needs, text stays text.
type View = string | { tag: string; attrs?: Record<string, unknown>; children: View[] };

function toView(node: RootContent): View | undefined {
  if (node.type === "text") return node.value.trim() === "" ? undefined : node.value;
  if (node.type !== "element") return undefined;
  const children = node.children.flatMap((c) => toView(c) ?? []);
  const attrs = Object.keys(node.properties).length > 0 ? node.properties : undefined;
  return { tag: node.tagName, ...(attrs !== undefined ? { attrs } : {}), children };
}

// 2. What each hole becomes. A live value is a keyed slot a view can update in
// place; a ref with no value gets a keyed, empty slot (through `onUnresolved`);
// a block is a placeholder naming its type; an include is projected in turn
// and wrapped by `includeWrapper`, the one wrapper whose provenance survives
// the sanitizer.
async function toJson(input: ProjectionInput): Promise<View[]> {
  const walkOf = (node: ProjectionNode): ProjectionWalkOptions => ({
    node,
    values: input.values,
    projectorId: "view",
    blockTypes: input.blockTypes,
  });
  const handlers: HastHoleHandlers = {
    onHole: async (hole) => {
      if (hole.kind === "source") {
        return [slot(hole.ref.source, "live", [{ type: "text", value: hole.value }])];
      }
      if (hole.kind === "block") {
        return [slot(hole.block.block.blockId, `block:${hole.block.block.type}`, [])];
      }
      const inner = await projectHast(walkOf(hole.include.node), handlers);
      return [includeWrapper(hole.include, inner.children as ElementContent[])];
    },
    onUnresolved: (hole) => [slot(hole.ref.source, hole.stale ? "stale" : "missing", [])],
  };
  const root = input.merged?.root ?? documentNode(input.doc, input.src);
  const tree: Root = sanitizePanelHast(await projectHast(walkOf(root), handlers));
  return tree.children.flatMap((c) => toView(c) ?? []);
}

/** A `<span data-source=… data-state=…>`: both attributes pass the panel schema. */
function slot(key: string, state: string, children: ElementContent[]): ElementContent {
  return {
    type: "element",
    tagName: "span",
    properties: { "data-source": key, "data-state": state },
    children,
  };
}

// 3. Register it, and project a board that includes a section of another doc.
const writer: Writer = { kind: "human", id: "me" };
const engine = createEngine({ storage: createMemStorage(), blocks: starterBlocks });
engine.registerProjector({ id: "view", project: toJson });

await engine.createDoc("notes", {
  writer,
  content: "# Notes\n\n## Plan {#plan}\n\nSave {{source:savings}} a month.\n",
});
await engine.createDoc("board", {
  writer,
  content: [
    "# Budget {#budget}",
    "",
    "Cash on hand: {{source:cash}}.",
    "",
    "```status",
    "id: buy",
    "states: [pending, done]",
    "value: pending",
    "```",
    "",
    "{{include:notes#plan}}",
    "",
  ].join("\n"),
});

// `savings` fails to resolve, so it degrades to stale: its slot comes out
// keyed and empty, never with the source's degradation marker in it.
const source: Source = {
  resolve: async (ref) => {
    if (ref.source === "cash") return { value: "¥23,450", stale: false };
    throw new Error("no such source");
  },
};
const projected = await engine.projection<View[]>("board", "view", { source });
for (const view of projected.output) console.log(JSON.stringify(view));

// Output:
// {"tag":"h1","attrs":{"id":"user-content-budget"},"children":["Budget"]}
// {"tag":"p","children":["Cash on hand: ",{"tag":"span","attrs":{"data-source":"cash","data-state":"live"},"children":["¥23,450"]},"."]}
// {"tag":"p","children":[{"tag":"span","attrs":{"data-source":"buy","data-state":"block:status"},"children":[]}]}
// {"tag":"section","attrs":{"data-doc":"notes","data-section":"plan"},"children":[{"tag":"p","children":["Save ",{"tag":"span","attrs":{"data-source":"savings","data-state":"stale"},"children":[]}," a month."]}]}
