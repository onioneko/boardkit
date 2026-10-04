import type { BlockType } from "@onioneko/boardkit-core";

/**
 * starter block: rule — an opaque when/do automation with an enabled switch.
 * The library validates only presence and type; the semantics of `when`/`do`
 * belong to the host.
 *
 * Usage: the `toggle` affordance flips `enabled`, emitting `rule.enabled`; the
 * host observes that event (or reads the block) to execute the rule.
 */

/** Attrs for the `rule` block, mirroring its JSON Schema. */
export type RuleAttrs = {
  readonly id: string;
  readonly title?: string;
  readonly when: string;
  readonly do: string;
  readonly enabled: boolean;
};

export const ruleBlock: BlockType<RuleAttrs> = {
  type: "rule",
  schema: {
    type: "object",
    required: ["id", "when", "do", "enabled"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      when: { type: "string" },
      do: { type: "string" },
      enabled: { type: "boolean" },
    },
    additionalProperties: false,
  },
  transitions: [{ attr: "enabled", event: "rule.enabled" }],
  affordances: [
    {
      name: "toggle",
      patch: (attrs) => ({ enabled: !attrs.enabled }),
    },
  ],
  project: {
    text: (attrs) =>
      `- rule ${attrs.enabled === true ? "(enabled)" : "(disabled)"}: when ${String(attrs.when)} do ${String(attrs.do)}`,
    html: (attrs): import("hast").Nodes => ({
      type: "element",
      tagName: "div",
      properties: { className: ["rule"] },
      children: [
        {
          type: "element",
          tagName: "input",
          properties: {
            type: "checkbox",
            ...(attrs.enabled === true ? { checked: "" } : {}),
            "data-intent": JSON.stringify({ affordance: "toggle" }),
          },
          children: [],
        },
        { type: "text", value: ` when ${String(attrs.when)} do ${String(attrs.do)}` },
      ],
    }),
  },
};
