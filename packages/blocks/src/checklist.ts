import type { BlockType } from "@onioneko/boardkit-core";

/**
 * starter block: checklist — a list of labeled checkbox items. Each item is
 * `{ id, label, done }`; the `toggle` affordance flips one item's `done` flag.
 *
 * The item-toggle transition names events by direction: checking a box emits
 * `checklist.item.done` (false→true), unchecking it emits
 * `checklist.item.undone` (true→false); both carry the `from`/`to` booleans.
 *
 * Usage: include in `createEngine({ blocks })` and add `"checklist"` to the
 * parse options' `blockTypes` set so checklist fences are parsed as blocks.
 */

/** Attrs for the `checklist` block, mirroring its JSON Schema. */
export type ChecklistAttrs = {
  readonly id: string;
  readonly title?: string;
  readonly items: readonly {
    readonly id: string;
    readonly label: string;
    readonly done: boolean;
  }[];
};

export const checklistBlock: BlockType<ChecklistAttrs> = {
  type: "checklist",
  schema: {
    type: "object",
    required: ["id", "items"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "label", "done"],
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            done: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  transitions: [
    {
      attr: "items[].done",
      events: {
        "false→true": "checklist.item.done",
        "true→false": "checklist.item.undone",
      },
    },
  ],
  affordances: [
    {
      name: "toggle",
      params: {
        type: "object",
        required: ["itemId"],
        properties: { itemId: { type: "string" } },
        additionalProperties: false,
      },
      patch: (attrs, params) => {
        const itemId = (params as { itemId: string }).itemId;
        const items = attrs.items.map((item) =>
          item.id === itemId ? { ...item, done: !item.done } : item,
        );
        return { items };
      },
    },
  ],
  project: {
    text: (attrs) => {
      const items = attrs.items;
      return items.map((item) => `- [${item.done ? "x" : " "}] ${item.label}`).join("\n");
    },
    html: (attrs): import("hast").Nodes => {
      const items = attrs.items;
      return {
        type: "element",
        tagName: "ul",
        properties: { className: ["checklist"] },
        // Each item's input and label text are wrapped in a `<label>` so a
        // click anywhere on the item — not just the tiny box — toggles it
        // natively; `data-intent` stays on the `<input>` itself (the existing
        // contract the page's `closest('[data-intent]')` handler reads).
        children: items.map((item) => ({
          type: "element",
          tagName: "li",
          properties: {},
          children: [
            {
              type: "element",
              tagName: "label",
              properties: {},
              children: [
                {
                  type: "element",
                  tagName: "input",
                  properties: {
                    type: "checkbox",
                    ...(item.done ? { checked: true } : {}),
                    "data-intent": JSON.stringify({
                      affordance: "toggle",
                      params: { itemId: item.id },
                    }),
                  },
                  children: [],
                },
                { type: "text", value: item.label },
              ],
            },
          ],
        })),
      };
    },
  },
};
