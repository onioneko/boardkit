import type { AnyBlockType } from "../blocks/types.js";
import type { Projector } from "../engine/engine.js";
import type { MergedNode, MergedTree } from "../link/merge.js";
import type { Diagnostic } from "../model/diagnostic.js";
import type { ParsedDoc } from "../model/doc.js";
import type { SourceValue } from "../ports/ports.js";
import {
  createProjectionWalkCache,
  documentNode,
  type ProjectionNode,
  type ProjectionWalkCache,
  walkProjection,
} from "./walk.js";

/**
 * text projection: span rewriting over the original source. Reference spans
 * are replaced by resolved values, block spans by their text hooks' output,
 * include spans by the recursive projection of the referenced content; every
 * untouched byte is preserved verbatim. Stale values keep the original
 * reference text (fail-soft: no fabricated data). The traversal itself is the
 * shared {@link walkProjection}; this module supplies only what each piece
 * becomes.
 *
 * Include expansion is opt-in through `options.merged`: when the engine's
 * merge stage supplies a {@link MergedTree}, include spans expand recursively.
 * A section include renders as a blockquote whose heading is the discoverable
 * provenance for a human reader, in one of two forms: a single-line body sits
 * on the heading line (`> <heading>: <body>`), while a body spanning several
 * lines puts the heading on its own line (`> <heading>:`, then every body line
 * `> `-prefixed) so a list's first item is not glued to the heading. The full
 * `{docId, sectionId}` provenance lives on the merged nodes themselves (and on
 * the html projector's `data-*` attributes). Without `merged`, include spans
 * stay verbatim and this projector behaves exactly as before.
 */

/** Options for the text projection. */
export interface TextProjectionOptions {
  /** Registered block types whose `project.text` hooks render blocks. */
  blockTypes?: ReadonlyMap<string, AnyBlockType>;
  /** The merged include tree (set by the engine's MERGE stage); expands includes when present. */
  merged?: MergedTree;
  /**
   * Include the document's leading YAML frontmatter in the output. Defaults to
   * `false`: the text projection omits the frontmatter block (and its trailing
   * blank line), since it is metadata, not body content.
   */
  frontmatter?: boolean;
  /** Receives non-fatal diagnostics, such as a block hook that threw (`E_BLOCK_HOOK_ERROR`). */
  report?: (diagnostic: Diagnostic) => void;
}

/**
 * Prefix every line with `> ` (a blockquote). The caller leads the text with its
 * heading — `heading: body` on one line, or `heading:` with the body below it.
 */
function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Expansion of one include child: whole docs render verbatim; sections render as a blockquote. */
function renderIncludeText(
  child: MergedNode,
  values: ReadonlyMap<string, SourceValue>,
  opts: TextProjectionOptions,
  cache: ProjectionWalkCache,
): string {
  const body = renderNode(child, values, opts, cache);
  if (child.provenance.sectionId === undefined) return body;
  const heading = child.heading ?? "";
  // Section content is exclusive but carries the leading newline after the
  // heading line; trim both ends so the blockquote starts at the body's first
  // character. A one-line body stays on the heading line (`> heading: body`); a
  // body spanning several lines (a list, several paragraphs) takes the line
  // below the heading, so its first line is not glued to `heading:`.
  const content = body.trim();
  return blockquote(content.includes("\n") ? `${heading}:\n${content}` : `${heading}: ${content}`);
}

/**
 * Render one node: refs become their values, blocks their `text` hook's
 * markdown (or their verbatim source when the type declares none), includes
 * their recursive projection.
 */
function renderNode(
  node: ProjectionNode,
  values: ReadonlyMap<string, SourceValue>,
  opts: TextProjectionOptions,
  cache: ProjectionWalkCache,
): string {
  return walkProjection(
    {
      node,
      values,
      cache,
      projectorId: "text",
      ...(opts.blockTypes !== undefined ? { blockTypes: opts.blockTypes } : {}),
      frontmatter: opts.frontmatter === true,
      // This projector emits raw source bytes, so it owes its readers the
      // literal `{{` an escaped reference asks for.
      unescapeRefs: true,
    },
    {
      onProse: (prose) => prose,
      onSource: (value) => value,
      // `text` id ↔ string contract: this projector's own hooks render markdown.
      onBlock: ({ output, raw, hookError }) => {
        if (hookError !== undefined) opts.report?.(hookError);
        return output === undefined ? raw : String(output);
      },
      onInclude: (include) => renderIncludeText(include.node, values, opts, cache),
    },
  );
}

/**
 * Render a document to value-injected markdown via span rewriting (untouched
 * bytes preserved). When `opts.merged` is present, the merged tree is rendered
 * recursively (expanding includes); otherwise only this document's own spans
 * are rewritten.
 * @param doc The parsed document.
 * @param src The document's raw source.
 * @param values Resolved live values, keyed by canonical key.
 * @param opts Block types and/or the merged tree.
 * @returns The rendered markdown.
 */
export function projectText(
  doc: ParsedDoc,
  src: string,
  values: ReadonlyMap<string, SourceValue>,
  opts: TextProjectionOptions = {},
): string {
  const node = opts.merged !== undefined ? opts.merged.root : documentNode(doc, src);
  return renderNode(node, values, opts, createProjectionWalkCache());
}

/**
 * The built-in `text` projector: markdown in, value-injected markdown out. It
 * is the one projector `createEngine` registers by default; list it in
 * `EngineOptions.projectors` to keep it alongside your own.
 */
export const textProjector: Projector<string> = {
  id: "text",
  project(input) {
    return projectText(input.doc, input.src, input.values, {
      blockTypes: input.blockTypes,
      ...(input.merged !== undefined ? { merged: input.merged } : {}),
      ...(input.report !== undefined ? { report: input.report } : {}),
    });
  },
};
