import type { BlockType } from "@onioneko/boardkit-core";

/**
 * starter block: chart — an opaque chart source. The text hook emits the spec
 * verbatim (machine-readable); the html hook falls back to a `<pre>` because
 * the library does not know chart libraries — hosts register their own block
 * type (or renderer) to replace this fallback.
 *
 * Usage: a chart body carries `{ id, type, source, spec }`; `spec` is the
 * chart's own DSL and is rendered untouched.
 */

/** Attrs for the `chart` block, mirroring its JSON Schema. */
export type ChartAttrs = {
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly spec: string;
};

export const chartBlock: BlockType<ChartAttrs> = {
  type: "chart",
  schema: {
    type: "object",
    required: ["id", "type", "source", "spec"],
    properties: {
      id: { type: "string" },
      type: { type: "string" },
      source: { type: "string" },
      spec: { type: "string" },
    },
    additionalProperties: false,
  },
  project: {
    text: (attrs) => String(attrs.spec),
    html: (attrs): import("hast").Nodes => ({
      type: "element",
      tagName: "pre",
      properties: { className: ["chart"], "data-source": String(attrs.source) },
      children: [{ type: "text", value: String(attrs.spec) }],
    }),
  },
};
