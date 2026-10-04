import type { BlockType } from "@onioneko/boardkit-core";

/**
 * starter block: status — an ordered state machine with a current value. The
 * cross-field rule "value must be a member of states" is exactly what
 * BlockType.validate exists for (JSON Schema cannot express it).
 *
 * Usage: `states` is an ordered list of allowed values; the `transition`
 * affordance moves `value` to a new state, emitting `status.changed` with
 * `from`/`to`. The html hook renders `<div class="status" data-state="…">`
 * (style a state with `.status[data-state="…"]`) holding a badge and a button
 * for every state other than the current one.
 */

/** Attrs for the `status` block, mirroring its JSON Schema. */
export type StatusAttrs = {
  readonly id: string;
  readonly title?: string;
  readonly states: readonly string[];
  readonly value: string;
  readonly note?: string;
};

export const statusBlock: BlockType<StatusAttrs> = {
  type: "status",
  schema: {
    type: "object",
    required: ["id", "states", "value"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      states: { type: "array", items: { type: "string" }, minItems: 1 },
      value: { type: "string" },
      note: { type: "string" },
    },
    additionalProperties: false,
  },
  // Declared `attrs: unknown` on purpose, wider than `Readonly<StatusAttrs>`
  // (a function accepting `unknown` is assignable wherever a narrower-param
  // function is expected, so this still satisfies `BlockType<StatusAttrs>`).
  // `validate` is called directly by hosts and tests with arbitrary/possibly
  // malformed data (its own doc contract says "never throws" — see
  // BlockType.validate in core), so the null/non-object case is guarded
  // before any property access, not just trusted from the generic.
  validate: (attrs: unknown) => {
    if (typeof attrs !== "object" || attrs === null) return [];
    const { value, states } = attrs as { value?: unknown; states?: unknown };
    if (Array.isArray(states) && typeof value === "string" && !states.includes(value)) {
      return [{ code: "E_STATUS_VALUE", message: `value "${value}" is not in states` }];
    }
    return [];
  },
  transitions: [{ attr: "value", event: "status.changed" }],
  affordances: [
    {
      name: "transition",
      params: {
        type: "object",
        required: ["to"],
        properties: { to: { type: "string" } },
        additionalProperties: false,
      },
      patch: (_attrs, params) => ({ value: (params as { to: string }).to }),
    },
  ],
  project: {
    text: (attrs) => {
      const value = String(attrs.value);
      const title = String(attrs.title ?? "").trim();
      return title === "" ? `**STATUS**: ${value}` : `**STATUS**: ${value} — ${title}`;
    },
    html: (attrs): import("hast").Nodes => {
      const states = attrs.states;
      const value = String(attrs.value);
      const buttons: import("hast").ElementContent[] = states
        .filter((state) => state !== value)
        .map((state): import("hast").ElementContent => ({
          type: "element",
          tagName: "button",
          properties: {
            "data-intent": JSON.stringify({ affordance: "transition", params: { to: state } }),
          },
          children: [{ type: "text", value: state }],
        }));
      return {
        type: "element",
        tagName: "div",
        // The state is data, not styling: one attribute holds it whatever it
        // contains, and the class list stays fixed.
        properties: { className: ["status"], "data-state": value },
        children: [
          {
            type: "element",
            tagName: "span",
            properties: { className: ["badge"] },
            children: [{ type: "text", value }],
          },
          ...buttons,
        ],
      };
    },
  },
};
