import type { BlockType } from "@onioneko/boardkit-core";

/**
 * starter block: form — a question with typed fields. Answering is the `answer`
 * affordance; the view adapter assembles entered values into the intent params
 * at interaction time (outside the block's concern).
 *
 * Usage: a form has `fields` (each with `id`, `label`, `type`, and optional
 * `options`) and a `status` of `open` or `answered`. The `answer` affordance
 * stores the assembled values in `answer`, flips `status` to `answered`, and
 * emits `form.answered`.
 */

/** Attrs for the `form` block, mirroring its JSON Schema. */
export type FormAttrs = {
  readonly id: string;
  readonly title?: string;
  readonly fields: readonly {
    readonly id: string;
    readonly label: string;
    readonly type: "text" | "select" | "number";
    readonly options?: readonly string[];
  }[];
  readonly status: "open" | "answered";
  readonly answer?: Record<string, unknown>;
};

export const formBlock: BlockType<FormAttrs> = {
  type: "form",
  schema: {
    type: "object",
    required: ["id", "fields", "status"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      fields: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "label", "type"],
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            type: { enum: ["text", "select", "number"] },
            options: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
      },
      status: { enum: ["open", "answered"] },
      answer: { type: "object" },
    },
    additionalProperties: false,
  },
  transitions: [{ attr: "status", event: "form.answered" }],
  affordances: [
    {
      name: "answer",
      params: { type: "object" },
      patch: (_attrs, params) => ({
        answer: params as Record<string, unknown>,
        status: "answered",
      }),
    },
  ],
  project: {
    text: (attrs) => {
      const fields = attrs.fields;
      const lines = fields.map((field) => {
        const suffix =
          field.options !== undefined && field.options.length > 0
            ? ` (${field.options.join("/")})`
            : "";
        return `- ${field.label}${suffix}`;
      });
      return lines.join("\n");
    },
    html: (attrs): import("hast").Nodes => {
      const fields = attrs.fields;
      return {
        type: "element",
        tagName: "div",
        properties: { className: ["form"] },
        children: fields.map((field) => ({
          type: "element",
          tagName: "label",
          properties: {},
          children: [
            { type: "text", value: field.label },
            {
              type: "element",
              tagName: "input",
              properties: { type: field.type === "number" ? "number" : "text", name: field.id },
              children: [],
            },
          ],
        })),
      };
    },
  },
};
