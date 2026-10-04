import type { BlockType } from "@onioneko/boardkit-core";

/**
 * starter block: metric — a labeled live value backed by a source. Hooks
 * receive resolved values keyed by source id, so the metric's value is injected
 * at projection time and never persisted.
 *
 * Usage: a metric's `source` field names a source id; the block declares it
 * through `sources`, so the value is resolved from the block alone — the
 * document needs no `{{source:…}}` prose ref. The resolved value (optionally
 * annotated by `view`/`thresholds`) is rendered next to its `label`; an
 * unresolved (absent or stale) value falls back to the source id.
 */

/** Attrs for the `metric` block, mirroring its JSON Schema. */
export type MetricAttrs = {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly view?: "value" | "sparkline" | "chart";
  readonly thresholds?: readonly number[];
};

export const metricBlock: BlockType<MetricAttrs> = {
  type: "metric",
  schema: {
    type: "object",
    required: ["id", "label", "source"],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      source: { type: "string" },
      view: { enum: ["value", "sparkline", "chart"] },
      thresholds: { type: "array", items: { type: "number" } },
    },
    additionalProperties: false,
  },
  sources: (attrs) =>
    typeof attrs.source === "string" ? [{ kind: "source", source: attrs.source, params: {} }] : [],
  project: {
    text: (attrs, values) =>
      `${String(attrs.label)}: ${values[String(attrs.source)] ?? String(attrs.source)}`,
    html: (attrs, values): import("hast").Nodes => ({
      type: "element",
      tagName: "span",
      properties: { className: ["metric"] },
      children: [
        {
          type: "element",
          tagName: "strong",
          properties: {},
          children: [{ type: "text", value: String(attrs.label) }],
        },
        { type: "text", value: ` ${values[String(attrs.source)] ?? String(attrs.source)}` },
      ],
    }),
  },
};
