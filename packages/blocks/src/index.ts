/**
 * The starter block pack: six ready-made block types, exported together for
 * convenience. Hosts that do not want every block may build their own array
 * from the individual exports.
 */

export type { ChartAttrs } from "./chart.js";
export { chartBlock } from "./chart.js";
export type { ChecklistAttrs } from "./checklist.js";
export { checklistBlock } from "./checklist.js";
export type { FormAttrs } from "./form.js";
export { formBlock } from "./form.js";
export type { MetricAttrs } from "./metric.js";
export { metricBlock } from "./metric.js";
export type { RuleAttrs } from "./rule.js";
export { ruleBlock } from "./rule.js";
export type { StatusAttrs } from "./status.js";
export { statusBlock } from "./status.js";

import type { AnyBlockType } from "@onioneko/boardkit-core";
import { chartBlock } from "./chart.js";
import { checklistBlock } from "./checklist.js";
import { formBlock } from "./form.js";
import { metricBlock } from "./metric.js";
import { ruleBlock } from "./rule.js";
import { statusBlock } from "./status.js";

/**
 * All six starter blocks, ready to pass to `createEngine({ blocks })`.
 * @example
 * ```ts
 * const engine = createEngine({
 *   storage: createMemStorage(),
 *   blocks: starterBlocks,
 * });
 * ```
 */
export const starterBlocks: readonly AnyBlockType[] = [
  checklistBlock,
  statusBlock,
  metricBlock,
  chartBlock,
  formBlock,
  ruleBlock,
];
