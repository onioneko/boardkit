/**
 * `@onioneko/boardkit-html` — the html projector for BoardKit.
 *
 * A document's markdown goes through remark/rehype while the shared projection
 * walk (`walkProjection`, from `@onioneko/boardkit-core`) replaces reference spans with
 * their resolved values, typed blocks with their `project.html` hooks' hast
 * subtrees, and `{{include:…}}` spans with the referenced content wrapped in a
 * provenance-carrying `<section>`. The result is sanitized HTML suitable for
 * embedding in a panel, with every `data-intent` attribute enriched into a full
 * Intent payload the browser can post straight back.
 *
 * A projector whose output is structured rather than an HTML string builds on
 * the same two halves: {@link projectHast} (one node's hast, with every
 * reference, block and include left as a hole the caller fills) and
 * {@link sanitizePanelHast} (the html projector's exact sanitize pass).
 *
 * The engine registers only the `text` projector by default. Register this one:
 *
 * ```ts
 * import { createEngine, createMemStorage } from "@onioneko/boardkit-core";
 * import { htmlProjector } from "@onioneko/boardkit-html";
 *
 * const engine = createEngine({ storage: createMemStorage() });
 * engine.registerProjector(htmlProjector);
 * const { output } = await engine.projection<string>("fin", "html", { source });
 * ```
 *
 * This package imports nothing from `@onioneko/boardkit-core` but its public root — it
 * is written against the same API any custom projector has.
 *
 * @module
 */

export type {
  BlockHole,
  HastHoleHandlers,
  Hole,
  IncludeHole,
  SourceHole,
  UnresolvedHole,
} from "./holes.js";
export { projectHast } from "./holes.js";
export type { HtmlProjectionOptions } from "./html.js";
export { degradedHtml, escapeHtml, htmlProjector, projectHtml } from "./html.js";
export {
  includeWrapper,
  panelAttributeNames,
  panelSchema,
  pruneLabelAttributes,
  sanitizePanelHast,
} from "./sanitize.js";
