import {
  type AnyBlockType,
  type Block,
  createProjectionWalkCache,
  type Diagnostic,
  type DocId,
  documentNode,
  docVersion,
  intentExpected,
  type MergedTree,
  type ParsedDoc,
  type ProjectionNode,
  type ProjectionWalkBlock,
  type ProjectionWalkCache,
  type ProjectionWalkContext,
  type ProjectionWalkOptions,
  type Projector,
  type SourceValue,
} from "@onioneko/boardkit-core";
import type { Element, ElementContent, Nodes } from "hast";
import rehypeStringify from "rehype-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { type HastHoleHandlers, projectHast } from "./holes.js";
import { includeWrapper, sanitizePanelHast } from "./sanitize.js";

/**
 * html projection: full HTML suitable for panel embedding, produced through
 * the mdast → hast bridge. Each node is projected with {@link projectHast}
 * (`holes.ts`), which runs the shared projection walk and fills every hole in
 * the hast tree — a ref value becomes a text node, a block its hook's hast
 * subtree, an include its projected content. Nothing is spliced into
 * serialized HTML, so markdown text can never land inside an attribute.
 *
 * The assembled tree — prose, block hook output, ref values and expanded
 * includes alike — is then sanitized once with {@link sanitizePanelHast}
 * (`sanitize.ts`) before it is serialized: elements and attributes outside
 * the schema are dropped, `href` accepts only `http:`, `https:` and `mailto:`
 * URLs (plus relative and fragment URLs), `src` only `http:` and `https:`
 * (plus relative), schemes in any letter case, and every `id`/`name` is
 * prefixed with `user-content-` (a heading's `{#anchor}`, removed from its
 * text, becomes such an `id`). Raw HTML in the markdown is dropped by the pipeline itself, and include
 * provenance survives only on the projector's own include wrappers.
 *
 * Failure stays inert too. A block whose hook throws renders as its escaped
 * source in `<pre><code>` and is reported as `E_BLOCK_HOOK_ERROR`; when the
 * projection as a whole cannot complete, the engine falls back to
 * {@link degradedHtml} (the escaped source), never to the raw markdown.
 *
 * Include expansion is opt-in through `options.merged`: an include span becomes
 * the referenced content's recursive projection, wrapped in a `<section>`
 * element carrying provenance as `data-doc` and (for section slices)
 * `data-section` attributes. Without `merged`, include spans stay verbatim.
 *
 * Block hook subtrees that annotate elements with a `data-intent` attribute
 * are enriched with the full Intent payload: `docId`, `blockId`, `affordance`,
 * `params` (preserved from the hook), `expectedVersion` (the version of the
 * node's source), and `expected` (the current values of the attrs the
 * affordance's patch touches). Enrichment is driven by the merged node's
 * provenance, so a block from an included doc embeds that doc's identity and
 * version, not the root's.
 */

const toHtml = unified().use(rehypeStringify);

/** Per-render memo: one `docVersion` hash per distinct source, however many nodes share it. */
interface RenderRun {
  versionOf(src: string): string;
  /** The walk cache shared by every node of this render. */
  readonly walkCache: ProjectionWalkCache;
}

function createRenderRun(): RenderRun {
  const versions = new Map<string, string>();
  return {
    walkCache: createProjectionWalkCache(),
    versionOf(src) {
      let version = versions.get(src);
      if (version === undefined) {
        version = docVersion(src);
        versions.set(src, version);
      }
      return version;
    },
  };
}

/** Options for the html projection. */
export interface HtmlProjectionOptions {
  /** Registered block types whose `project.html` hooks render blocks. */
  blockTypes?: ReadonlyMap<string, AnyBlockType>;
  /** The merged include tree (set by the engine's MERGE stage); expands includes when present. */
  merged?: MergedTree;
  /** Receives non-fatal diagnostics, such as a block hook that threw (`E_BLOCK_HOOK_ERROR`). */
  report?: (diagnostic: Diagnostic) => void;
}

/**
 * Minimal, dependency-free HTML escaping, for hosts that build markup around
 * the projection. (The projection itself never splices strings: values become
 * text nodes and are escaped by the serializer.)
 * @param value The string to escape.
 * @returns The string with `&`, `<`, `>`, `"`, and `'` escaped to entities.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Enrich a block hook's hast subtree in place: every element carrying a
 * `data-intent` attribute whose value parses as a JSON object with a known
 * `affordance` name gets the full Intent payload merged in:
 *
 *   `{ docId, blockId, affordance, params, expectedVersion, expected }`
 *
 * in exactly that (documented, deterministic) key order. `affordance`/`params`
 * are preserved as the hook wrote them; `expectedVersion` is `docVersion(src)`
 * of the node's source; `expected` is `intentExpected(type, affordance, attrs, params)`.
 * Unknown affordances, unparseable payloads, and throwing patches leave the
 * attribute unchanged (fail-soft). Pure apart from mutating the freshly-created
 * subtree — no I/O, no shared state.
 */
function enrichDataIntent(
  subtree: Nodes,
  block: Block,
  docId: DocId,
  expectedVersion: string,
  blockTypes: ReadonlyMap<string, AnyBlockType> | undefined,
): Nodes {
  const blockType = blockTypes?.get(block.type);
  if (blockType === undefined) return subtree;

  visit(subtree, "element", (node: Element) => {
    const raw = node.properties["data-intent"];
    if (typeof raw !== "string") return;

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return; // unparseable → leave unchanged (fail-soft)
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;

    const { affordance: name, params } = payload as { affordance?: unknown; params?: unknown };
    if (typeof name !== "string") return;
    // Unknown affordance, or a throwing patch (which must not fail the
    // projection) → leave the attribute unchanged (fail-soft).
    const expected = intentExpected(blockType, name, block.attrs, params);
    if (expected === undefined) return;

    node.properties["data-intent"] = JSON.stringify({
      docId,
      blockId: block.blockId,
      affordance: name,
      params,
      expectedVersion,
      expected,
    });
  });

  return subtree;
}

/** One block as hast: its hook's subtree, enriched, or an opaque `<pre><code>` fallback. */
function renderBlock(
  piece: ProjectionWalkBlock,
  ctx: ProjectionWalkContext,
  opts: HtmlProjectionOptions,
  run: RenderRun,
): ElementContent[] {
  // `html` id ↔ hast contract: this projector's own hooks always return a hast subtree.
  if (piece.output === undefined) {
    const code: Element = {
      type: "element",
      tagName: "code",
      properties: {},
      children: [{ type: "text", value: piece.raw }],
    };
    return [{ type: "element", tagName: "pre", properties: {}, children: [code] }];
  }
  let subtree = piece.output as Nodes;
  const docId = ctx.node.provenance?.docId;
  if (docId !== undefined) {
    const version = run.versionOf(ctx.node.src);
    subtree = enrichDataIntent(subtree, piece.block, docId, version, opts.blockTypes);
  }
  return (subtree.type === "root" ? [...subtree.children] : [subtree]) as ElementContent[];
}

/**
 * The html projector's own hole handlers: a ref value becomes a text node, a
 * block its hook's (enriched) subtree, and an include the recursive projection
 * of its child node in an {@link includeWrapper}. The node's provenance
 * supplies the docId and its own `src` the version for any `data-intent`
 * enrichment, so a block from an included doc embeds that doc's identity, not
 * the root's.
 */
function htmlHandlers(
  walkOf: (node: ProjectionNode) => ProjectionWalkOptions,
  opts: HtmlProjectionOptions,
  run: RenderRun,
): HastHoleHandlers {
  const handlers: HastHoleHandlers = {
    onHole: async (hole, ctx) => {
      if (hole.kind === "source") return [{ type: "text", value: hole.value }];
      if (hole.kind === "block") {
        if (hole.block.hookError !== undefined) opts.report?.(hole.block.hookError);
        return renderBlock(hole.block, ctx, opts, run);
      }
      const inner = await projectHast(walkOf(hole.include.node), handlers);
      return [includeWrapper(hole.include, inner.children as ElementContent[])];
    },
  };
  return handlers;
}

/**
 * Render a document to full HTML suitable for panel embedding. When
 * `opts.merged` is present, the merged tree is rendered recursively (expanding
 * includes and enriching `data-intent` attributes with the full Intent payload);
 * otherwise only this document's own spans are rewritten and `data-intent`
 * enrichment is skipped (there is no document identity to embed).
 * @param doc The parsed document.
 * @param src The document's raw source.
 * @param values Resolved live values, keyed by canonical key.
 * @param opts Block types and/or the merged tree.
 * @returns The rendered HTML, sanitized with {@link sanitizePanelHast}.
 */
export async function projectHtml(
  doc: ParsedDoc,
  src: string,
  values: ReadonlyMap<string, SourceValue>,
  opts: HtmlProjectionOptions = {},
): Promise<string> {
  // A standalone document carries no provenance in its inputs (the engine
  // always projects through the merged tree, whose nodes carry it), so
  // `data-intent` enrichment is skipped — there is no document identity to embed.
  const node = opts.merged !== undefined ? opts.merged.root : documentNode(doc, src);
  const run = createRenderRun();
  const walkOf = (n: ProjectionNode): ProjectionWalkOptions => ({
    node: n,
    values,
    projectorId: "html",
    cache: run.walkCache,
    ...(opts.blockTypes !== undefined ? { blockTypes: opts.blockTypes } : {}),
    // The parse reads the leading YAML as a frontmatter node and remark-rehype
    // renders nothing for it, so it is dropped without the walk's help.
    frontmatter: true,
  });
  const assembled = await projectHast(walkOf(node), htmlHandlers(walkOf, opts, run));
  return toHtml.stringify(sanitizePanelHast(assembled));
}

/**
 * The html projector's fail-soft output, used by the engine when a
 * projection cannot complete: the whole source, escaped, in
 * `<pre class="projection-degraded"><code>`. It is inert text — never the
 * source's own markup.
 * @param src The document's raw source.
 * @returns The degraded HTML.
 */
export function degradedHtml(src: string): string {
  return `<pre class="projection-degraded"><code>${escapeHtml(src)}</code></pre>`;
}

/**
 * The `html` projector, ready to register: `id: "html"`, output `string`.
 * The engine registers only `text` by default, so a host that wants HTML
 * registers this one itself — either at construction
 * (`createEngine({ projectors: [textProjector, htmlProjector] })`) or
 * afterwards (`engine.registerProjector(htmlProjector)`).
 *
 * Use {@link projectHtml} directly instead when you need to wrap the
 * projection — a themed shell, a different sanitize policy, an id other than
 * `"html"`.
 */
export const htmlProjector: Projector<string> = {
  id: "html",
  project(input) {
    return projectHtml(input.doc, input.src, input.values, {
      blockTypes: input.blockTypes,
      ...(input.merged !== undefined ? { merged: input.merged } : {}),
      ...(input.report !== undefined ? { report: input.report } : {}),
    });
  },
  degrade(src) {
    return degradedHtml(src);
  },
};
