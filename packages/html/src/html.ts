import {
  type AnyBlockType,
  type Block,
  createProjectionWalkCache,
  type Diagnostic,
  type DocId,
  documentNode,
  docVersion,
  intentExpected,
  type MergedInclude,
  type MergedNode,
  type MergedTree,
  type ParsedDoc,
  type ProjectionNode,
  type ProjectionWalkCache,
  type Projector,
  type SourceSpan,
  type SourceValue,
  walkProjection,
} from "@onioneko/boardkit-core";
import type { Element, ElementContent, Nodes, Root, RootContent } from "hast";
import { defaultSchema, type Schema, sanitize } from "hast-util-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

/**
 * html projection: full HTML suitable for panel embedding, produced through
 * the mdast → hast bridge. The shared `walkProjection` classifies the
 * source exactly as it does for the text projector; this module replaces block
 * spans, non-stale ref spans and include spans with placeholder tokens before
 * the markdown pipeline runs, then swaps each token's text for the real
 * content inside the hast tree — a ref value becomes a text node, a block its
 * hook's hast subtree, an include its projected content. Nothing is spliced
 * into serialized HTML, so markdown text can never land inside an attribute.
 * The tokens carry a random value chosen per render and absent from the
 * source, so text an author writes is never mistaken for one.
 *
 * The assembled tree — prose, block hook output, ref values and expanded
 * includes alike — is then sanitized once with {@link panelSchema} before it
 * is serialized: elements and attributes outside the schema are dropped,
 * `href` accepts only `http:`, `https:` and `mailto:` URLs (plus relative and
 * fragment URLs), `src` only `http:` and `https:` (plus relative), schemes in
 * any letter case, and every `id`/`name` is prefixed with `user-content-`. Raw
 * HTML in the markdown is dropped by the pipeline itself.
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

/**
 * Markdown → hast. `clobberPrefix: ""` because the sanitizer prefixes every
 * `id` itself; letting remark-rehype prefix footnote ids too would double it.
 */
const toHast = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkRehype, { clobberPrefix: "" });

const toHtml = unified().use(rehypeStringify);

/** The prefix the sanitizer puts in front of every `id` and `name`. */
const CLOBBER_PREFIX = defaultSchema.clobberPrefix ?? "user-content-";

/**
 * A fresh per-render value for placeholder tokens: 128 random bits as hex,
 * re-drawn in the (astronomically unlikely) case that the source contains it.
 * Hex keeps the token alphanumeric, which the markdown pipeline passes through
 * byte-for-byte.
 */
function placeholderNonce(src: string, ranges: readonly SourceSpan[]): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    // Only the node's own ranges reach the markdown pipeline, so only they are
    // searched (a small slice of a large document costs the slice).
    if (!ranges.some((r) => src.slice(r.start, r.end).includes(nonce))) return nonce;
  }
}

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
 * Panel-embedding sanitize schema, applied to the whole projected document:
 * defaultSchema plus className/id/data-intent/data-source/data-state on every
 * element, `data-doc`/`data-section` on `section` (the include provenance
 * wrapper), `button` and `label` added to `tagNames` (the panel renders
 * transition buttons; a checklist item wraps its input and text in a `label`
 * so a click on the text toggles the box — neither tag is in the default
 * schema), and `required.input` narrowed to `{ type: "checkbox" }`.
 *
 * URL protocols follow defaultSchema, except that `href` is narrowed to
 * `http`, `https` and `mailto`: a URL with any other scheme (`javascript:`,
 * `vbscript:`, `data:`, …) is dropped, while relative and fragment URLs pass.
 * `src` keeps defaultSchema's `http`/`https`. `srcSet` (a list of URLs the
 * sanitizer cannot check one by one) is removed from `source`.
 *
 * BoardKit inputs that carry `data-intent` are interactive controls, not
 * GitHub's read-only tasklist markers, so `defaultSchema.required.input`'s
 * `disabled: true` (GFM tasklist rendering — every `<input>` forced
 * `disabled`) is deliberately not inherited here. `type` stays required to
 * `"checkbox"`, the only input type BoardKit projects.
 *
 * `label` is given no attribute list of its own here, because one would not
 * help: `hast-util-sanitize`'s `'*'` wildcard entry (extended above with
 * `className`/`id`/`data-intent`/`data-source`/`data-state` so arbitrary hook-authored
 * elements can carry them) is an *unconditional* per-attribute fallback — a
 * tag with its own specific attribute list still falls back to `'*'` for any
 * key that list doesn't itself allow (`properties()` in `hast-util-sanitize`'s
 * `lib/index.js` retries `defaults` whenever the tag-specific lookup misses,
 * regardless of why; confirmed empirically against the installed 5.0.2). A
 * schema can add permissions for one tag beyond the wildcard; it cannot
 * revoke a wildcard-granted one for a single tag. So `label` inherits `for`
 * (`htmlFor`) and `id` from the vanilla wildcard, and `data-intent`/`data-source`
 * from this function's own addition — enough for a broken or hostile hook to
 * redirect a click to a different control (`for`) or spoof the click's own
 * intent ahead of the input it wraps, since `closest('[data-intent]')` matches
 * the label before it ever reaches the input inside. `pruneLabelAttributes`
 * enforces the real restriction after `sanitize` runs, where denial is
 * unconditional.
 * @returns A fresh schema; callers may extend it without affecting this module.
 */
export function panelSchema(): Schema {
  const attributes: Schema["attributes"] = {};
  for (const [tag, value] of Object.entries(defaultSchema.attributes ?? {})) {
    attributes[tag] = [...value, "className", "id", "data-intent", "data-source", "data-state"];
  }
  attributes.section = [...(attributes.section ?? []), "data-doc", "data-section"];
  // `srcset` holds several URLs, and the sanitizer checks only a value's first
  // scheme, so it is not allowed at all.
  attributes.source = (attributes.source ?? []).filter((attr) => attr !== "srcSet");
  return {
    ...defaultSchema,
    attributes,
    tagNames: [...(defaultSchema.tagNames ?? []), "button", "label"],
    required: { ...defaultSchema.required, input: { type: "checkbox" } },
    protocols: { ...defaultSchema.protocols, href: ["http", "https", "mailto"] },
  };
}

/**
 * Post-sanitize hardening for `<label>`: strips every property except
 * `className`. `label` exists in the panel schema only so a checklist item's
 * text can wrap its input for a native click-to-toggle; it has no
 * legitimate use for `for`/`id`/`data-intent` or anything else, and — unlike
 * every other restriction this module applies — the sanitizer's schema
 * cannot deny them, because they are allowed through its `'*'` wildcard (see
 * `panelSchema`'s doc comment). Mutates in place; returns `node` so callers
 * can chain it directly onto `sanitize`'s result.
 * @param node The sanitized subtree to harden.
 * @returns The same node, with every `<label>` stripped to `className`.
 */
export function pruneLabelAttributes(node: Nodes): Nodes {
  visit(node, "element", (el: Element) => {
    if (el.tagName !== "label") return;
    const { className } = el.properties;
    el.properties = className === undefined ? {} : { className };
  });
  return node;
}

/**
 * Lowercase the scheme of every `href` and `src`, so the sanitizer's
 * case-sensitive scheme check keeps `HTTPS:` and `MAILTO:` URLs (schemes are
 * case-insensitive) while still dropping every scheme it does not allow.
 */
function lowercaseSchemes(tree: Root): void {
  visit(tree, "element", (el: Element) => {
    for (const key of ["href", "src"]) {
      const value = el.properties[key];
      if (typeof value !== "string") continue;
      const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(value)?.[0];
      if (scheme !== undefined)
        el.properties[key] = scheme.toLowerCase() + value.slice(scheme.length);
    }
  });
}

/**
 * Point footnote links at their sanitized targets. The sanitizer prefixes the
 * footnote ids (`fn-1` → `user-content-fn-1`) but cannot know which `href`s
 * name them, so the GFM footnote reference and back-reference anchors get the
 * same prefix here.
 */
function prefixFootnoteLinks(tree: Root): void {
  visit(tree, "element", (el: Element) => {
    if (el.tagName !== "a") return;
    const { href, dataFootnoteRef, dataFootnoteBackref } = el.properties;
    if (dataFootnoteRef === undefined && dataFootnoteBackref === undefined) return;
    if (typeof href === "string" && href.startsWith("#")) {
      el.properties.href = `#${CLOBBER_PREFIX}${href.slice(1)}`;
    }
  });
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

/** One block awaiting rendering: the walk hands over its hook's subtree, the pipeline runs after. */
interface PendingBlock {
  readonly block: Block;
  readonly output: unknown;
  readonly raw: string;
}

/** What one placeholder token stands for: inline content, or an include's wrapper (`undefined` when unexpanded). */
type Substitution =
  | { readonly kind: "inline"; readonly nodes: readonly ElementContent[] }
  | { readonly kind: "include"; readonly node: Element | undefined };

/** One block as hast: its hook's subtree, enriched, or an opaque `<pre><code>` fallback. */
function renderBlock(
  pending: PendingBlock,
  src: string,
  docId: DocId | undefined,
  opts: HtmlProjectionOptions,
  run: RenderRun,
): ElementContent[] {
  // `html` id ↔ hast contract: this projector's own hooks always return a hast subtree.
  if (pending.output === undefined) {
    const code: Element = {
      type: "element",
      tagName: "code",
      properties: {},
      children: [{ type: "text", value: pending.raw }],
    };
    return [{ type: "element", tagName: "pre", properties: {}, children: [code] }];
  }
  let subtree = pending.output as Nodes;
  if (docId !== undefined) {
    subtree = enrichDataIntent(subtree, pending.block, docId, run.versionOf(src), opts.blockTypes);
  }
  const nodes = (subtree.type === "root" ? [...subtree.children] : [subtree]) as ElementContent[];
  // A block's output ends where its markup ends: no trailing whitespace text.
  const last = nodes.at(-1);
  if (last?.type === "text") nodes[nodes.length - 1] = { ...last, value: last.value.trimEnd() };
  return nodes;
}

/** Provenance wrapper element around one merged include's projected content. */
function wrapInclude(inner: Root, child: MergedNode): Element {
  const section = child.provenance.sectionId;
  return {
    type: "element",
    tagName: "section",
    properties:
      section === undefined
        ? { "data-doc": child.provenance.docId }
        : { "data-doc": child.provenance.docId, "data-section": section },
    children: inner.children as ElementContent[],
  };
}

/**
 * Replace every placeholder token in `parent`'s text nodes with what it stands
 * for, recursing into elements but never into substituted content. A
 * paragraph holding nothing but an include token is replaced as a whole, so
 * the include wrapper does not nest inside a `<p>`.
 *
 * String attribute values are searched too: markdown can fold a ref's token
 * into an attribute (a GFM autolink literal such as `www.example.com/{{source:p}}`
 * puts it in `href`). There a ref becomes its value as plain text, and a block
 * or include token — which has no text form — is removed. The sanitizer runs
 * afterwards, so a URL built from a value is still scheme-checked.
 */
function substitute(
  parent: Root | Element,
  pattern: RegExp,
  substitutions: ReadonlyMap<number, Substitution>,
): void {
  const out: RootContent[] = [];
  for (const child of parent.children) {
    if (child.type === "element") {
      substituteProperties(child, pattern, substitutions);
      const [only] = child.children;
      if (child.tagName === "p" && child.children.length === 1 && only?.type === "text") {
        const [match, ...more] = only.value.matchAll(pattern);
        const whole = match !== undefined && more.length === 0 && match[0] === only.value;
        const sub = whole ? substitutions.get(Number(match[1])) : undefined;
        if (sub?.kind === "include") {
          if (sub.node !== undefined) out.push(sub.node);
          continue;
        }
      }
      substitute(child, pattern, substitutions);
      out.push(child);
      continue;
    }
    if (child.type !== "text") {
      out.push(child);
      continue;
    }
    let last = 0;
    for (const match of child.value.matchAll(pattern)) {
      const sub = substitutions.get(Number(match[1]));
      if (sub === undefined) continue;
      if (match.index > last) {
        out.push({ type: "text", value: child.value.slice(last, match.index) });
      }
      if (sub.kind === "inline") for (const n of sub.nodes) out.push(n);
      else if (sub.node !== undefined) out.push(sub.node);
      last = match.index + match[0].length;
    }
    if (last === 0) out.push(child);
    else if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
  }
  parent.children = out as typeof parent.children;
}

/** Replace placeholder tokens inside `el`'s string (and string-list) attribute values. */
function substituteProperties(
  el: Element,
  pattern: RegExp,
  substitutions: ReadonlyMap<number, Substitution>,
): void {
  const replace = (value: string): string =>
    value.replace(pattern, (token, n: string) => {
      const sub = substitutions.get(Number(n));
      if (sub === undefined) return token;
      if (sub.kind === "include") return "";
      return sub.nodes.every((node) => node.type === "text")
        ? sub.nodes.map((node) => (node.type === "text" ? node.value : "")).join("")
        : "";
    });
  for (const [key, value] of Object.entries(el.properties)) {
    if (typeof value === "string") el.properties[key] = replace(value);
    else if (Array.isArray(value)) {
      el.properties[key] = value.map((item) => (typeof item === "string" ? replace(item) : item));
    }
  }
}

/**
 * Recursive projection of one node into an (unsanitized) hast tree. The
 * node's provenance supplies the docId and its own `src` the version for any
 * `data-intent` enrichment, so a block from an included doc embeds that doc's
 * identity, not the root's.
 *
 * Include children are projected before the walk rather than inside it: each
 * node's rewritten markdown goes through remark/rehype on its own, and that
 * pass is async, while the walk's handlers are synchronous. The walk still
 * decides where each child's tree lands, and in what order.
 */
async function renderNode(
  node: ProjectionNode,
  values: ReadonlyMap<string, SourceValue>,
  opts: HtmlProjectionOptions,
  run: RenderRun,
): Promise<Root> {
  const docId = node.provenance?.docId;
  const expanded = new Map<MergedInclude, Element>();
  for (const include of node.includes) {
    expanded.set(
      include,
      wrapInclude(await renderNode(include.node, values, opts, run), include.node),
    );
  }

  const nonce = placeholderNonce(node.src, node.ranges);
  const substitutions = new Map<number, Substitution>();
  const pendingBlocks = new Map<number, PendingBlock>();
  const nextPlaceholder = (): { n: number; token: string } => {
    const n = substitutions.size + pendingBlocks.size;
    return { n, token: `bk${nonce}x${n}z` };
  };

  const rewritten = walkProjection(
    {
      node,
      values,
      projectorId: "html",
      cache: run.walkCache,
      ...(opts.blockTypes !== undefined ? { blockTypes: opts.blockTypes } : {}),
      // remark-frontmatter parses the leading YAML and remark-rehype renders
      // nothing for it, so the markdown pipeline drops it without the walk's help.
      frontmatter: true,
    },
    {
      onProse: (prose) => prose,
      onSource: (value) => {
        const { n, token } = nextPlaceholder();
        substitutions.set(n, { kind: "inline", nodes: [{ type: "text", value }] });
        return token;
      },
      onBlock: ({ block, output, raw, hookError }) => {
        if (hookError !== undefined) opts.report?.(hookError);
        const { n, token } = nextPlaceholder();
        pendingBlocks.set(n, { block, output, raw });
        return token;
      },
      onInclude: (include) => {
        const { n, token } = nextPlaceholder();
        substitutions.set(n, { kind: "include", node: expanded.get(include) });
        return token;
      },
    },
  );

  for (const [n, pending] of pendingBlocks) {
    substitutions.set(n, {
      kind: "inline",
      nodes: renderBlock(pending, node.src, docId, opts, run),
    });
  }

  const tree = await toHast.run(toHast.parse(rewritten));
  substitute(tree, new RegExp(`bk${nonce}x(\\d+)z`, "g"), substitutions);
  return tree;
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
 * @returns The rendered HTML, sanitized with {@link panelSchema}.
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
  const assembled = await renderNode(node, values, opts, createRenderRun());
  lowercaseSchemes(assembled);
  const tree = sanitize(assembled, panelSchema()) as Root;
  pruneLabelAttributes(tree);
  prefixFootnoteLinks(tree);
  return toHtml.stringify(tree);
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
