import {
  type DeepReadonly,
  diagnostic,
  type MergedInclude,
  mdastOf,
  type ParsedDoc,
  type ProjectionWalkBlock,
  type ProjectionWalkCache,
  type ProjectionWalkContext,
  type ProjectionWalkHandlers,
  type ProjectionWalkOptions,
  type SourceRef,
  type SourceSpan,
  walkProjectionParts,
} from "@onioneko/boardkit-core";
import type { Element, ElementContent, Root, RootContent } from "hast";
import type { Root as MdRoot } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { stripHeadingAnchors } from "./anchors.js";
import { spliceTokens, type TokenEdit } from "./splice.js";

/**
 * Hast with holes: one projection node's prose turned into hast in a single
 * pass, with every reference, block and include left as a hole the caller
 * fills.
 *
 * The prose is the document's own parse: the node's top-level nodes are
 * copied out of the mdast tree the document was parsed into (`mdastOf`), so
 * no markdown is parsed again. Each hole's placeholder token is spliced into
 * that copy at the hole's source offset, so a paragraph stays one paragraph
 * however many holes it holds, and markdown text can never land inside an
 * attribute. The tokens are then swapped for the caller's content inside the
 * hast tree. A token carries a random value chosen per call and absent from
 * the node's source, so text an author writes is never mistaken for one.
 */

/** A `{{source:…}}` whose value resolved and is not stale. */
export interface SourceHole {
  readonly kind: "source";
  /** The reference as parsed (source id and params). */
  readonly ref: SourceRef;
  /** The resolved value text. */
  readonly value: string;
}

/**
 * A `{{source:…}}` whose value is stale or did not resolve. It exists only
 * when {@link HastHoleHandlers.onUnresolved} is supplied; otherwise the
 * reference stays verbatim prose.
 */
export interface UnresolvedHole {
  readonly kind: "unresolved";
  /** The reference as parsed. */
  readonly ref: SourceRef;
  /** The reference's verbatim source, `{{` to `}}`. */
  readonly raw: string;
  /** True when the resolution degraded; false when there is no value at all. */
  readonly stale: boolean;
  /** For a stale resolution, the source's degradation marker (not real data). */
  readonly value?: string;
}

/**
 * A typed block, with this walk's projection hook already dispatched. Its
 * `output` is a structured clone of what the hook returned, so the hook's own
 * objects never reach the tree; output that cannot be cloned arrives as
 * `undefined` with an `E_BLOCK_HOOK_ERROR` in `hookError`, like a throwing hook.
 */
export interface BlockHole {
  readonly kind: "block";
  /** The block, whether it had a hook, the hook's output, and its verbatim source. */
  readonly block: ProjectionWalkBlock;
}

/** An expanded `{{include:…}}`: `include.node` is the merged child to project in turn. */
export interface IncludeHole {
  readonly kind: "include";
  /** The include's span and its child node. */
  readonly include: MergedInclude;
}

/** Something {@link projectHast} leaves for the caller to fill. */
export type Hole = SourceHole | UnresolvedHole | BlockHole | IncludeHole;

/** What each hole becomes. Every handler may be async. */
export interface HastHoleHandlers {
  /**
   * What a reference, block or include becomes in element content. Called once
   * per hole, in document order, after the walk and before the tree is
   * turned into hast. A block's trailing whitespace text is trimmed from what this
   * returns.
   *
   * A paragraph that holds nothing but one include's token is replaced by what
   * this returns for it, so an include's content does not nest inside a `<p>`.
   * To project the include, call {@link projectHast} on `hole.include.node`
   * and wrap the result with {@link includeWrapper}, the one wrapper whose
   * provenance attributes `sanitizePanelHast` keeps.
   * @param hole The hole.
   * @param ctx The walk context of the node the hole is in.
   * @returns The hole's content.
   */
  onHole(
    hole: SourceHole | BlockHole | IncludeHole,
    ctx: ProjectionWalkContext,
  ): ElementContent[] | Promise<ElementContent[]>;
  /**
   * What a stale or unresolved reference becomes. Optional: without it such a
   * reference stays verbatim prose and no hole is made for it, exactly as the
   * walk does without `onUnresolvedSource`. Block hooks never see the value
   * either way.
   * @param hole The unresolved reference.
   * @param ctx The walk context of the node the hole is in.
   * @returns The hole's content.
   */
  onUnresolved?(
    hole: UnresolvedHole,
    ctx: ProjectionWalkContext,
  ): ElementContent[] | Promise<ElementContent[]>;
  /**
   * What a hole becomes inside an attribute value: a reference in an autolink
   * (`www.example.com/{{source:p}}`, `<https://x.io/{{source:p}}>`) is in its
   * `href` too. Defaults to the value's text for a `source` hole, the reference's
   * verbatim source for an `unresolved` one, and `""` for a block or include,
   * which have no text form. The tree is unsanitized: a URL built from a value
   * is scheme-checked only when the caller sanitizes it.
   * @param hole The hole.
   * @returns The text to put in the attribute.
   */
  onHoleInAttribute?(hole: Hole): string;
}

/** Markdown → mdast, for a document whose parse kept no tree: the parser's own pipeline. */
const toMdast = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);

/**
 * mdast → hast. `clobberPrefix: ""` because the sanitizer prefixes every
 * `id` itself; letting remark-rehype prefix footnote ids too would double it.
 */
const toHast = unified().use(remarkRehype, { clobberPrefix: "" });

/**
 * A fresh per-call value for placeholder tokens: 128 random bits as hex,
 * re-drawn in the (astronomically unlikely) case that the source contains it.
 * Hex keeps the token alphanumeric, so it passes through mdast → hast
 * byte-for-byte.
 */
function placeholderNonce(src: string, ranges: readonly SourceSpan[]): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    // Only the node's own ranges are projected, so only they are searched (a
    // small slice of a large document costs the slice).
    if (!ranges.some((r) => src.slice(r.start, r.end).includes(nonce))) return nonce;
  }
}

/**
 * Trees parsed here for documents whose parse kept none, per projection walk
 * cache: a document projected in many nodes of one projection (a section
 * included many times) is parsed once per projection, not once per node.
 */
const parsedByCache = new WeakMap<
  ProjectionWalkCache,
  WeakMap<ParsedDoc, { readonly src: string; readonly tree: DeepReadonly<MdRoot> }>
>();

/**
 * The mdast tree of the node's document: the one its parse kept
 * (`mdastOf`), or else a parse of its source with the parser's own pipeline.
 * Either way the tree is the document's parse, so the output does not depend
 * on whether a tree was kept.
 */
function documentTree(walk: ProjectionWalkOptions): DeepReadonly<MdRoot> {
  const { doc, src } = walk.node;
  const kept = mdastOf(doc, src);
  if (kept !== undefined) return kept;
  let byDoc = walk.cache === undefined ? undefined : parsedByCache.get(walk.cache);
  if (walk.cache !== undefined && byDoc === undefined) {
    byDoc = new WeakMap();
    parsedByCache.set(walk.cache, byDoc);
  }
  const memo = byDoc?.get(doc);
  if (memo !== undefined && memo.src === src) return memo.tree;
  const tree = toMdast.parse(src) as DeepReadonly<MdRoot>;
  byDoc?.set(doc, { src, tree });
  return tree;
}

/** One hole, with the content its handler gave it. */
interface Filled {
  readonly hole: Hole;
  readonly nodes: readonly ElementContent[];
}

/**
 * The block with its hook's output replaced by a structured clone: plain data
 * the hook can no longer reach, holding none of the objects the hook returned.
 * So nothing a hook returns can be an {@link includeWrapper} (trust is object
 * identity, which a clone does not carry), can change between reads (a getter
 * or a `Proxy`), or is frozen against the projector's own enrichment. Output
 * that cannot be cloned (a `Proxy`, a function) fails soft like a throwing
 * hook: no output, and an `E_BLOCK_HOOK_ERROR` in `hookError` that names the
 * error's type but never quotes the output.
 */
function detach(piece: ProjectionWalkBlock, projectorId: string): ProjectionWalkBlock {
  if (piece.output === undefined) return piece;
  try {
    return { ...piece, output: structuredClone(piece.output) };
  } catch (err) {
    const { block } = piece;
    // Only the error's name, and only when it is a plain identifier: a clone
    // error's message quotes the offending value (a function's whole source),
    // and a Proxy trap can throw an error of the hook's own making.
    const raw = err instanceof Error ? err.name : undefined;
    const name = typeof raw === "string" && /^[A-Za-z]{1,64}$/.test(raw) ? raw : "Error";
    const hookError = diagnostic(
      "E_BLOCK_HOOK_ERROR",
      `${block.type} block "${block.blockId}": "${projectorId}" hook returned output that cannot be copied (${name})`,
      { nodeId: block.blockId },
    );
    return { block, hooked: piece.hooked, output: undefined, raw: piece.raw, hookError };
  }
}

/** The default text of a hole inside an attribute value. */
function attributeText(hole: Hole): string {
  if (hole.kind === "source") return hole.value;
  if (hole.kind === "unresolved") return hole.raw;
  return "";
}

/** `nodes` without trailing whitespace in its last text node: a block's output ends where its markup ends. */
function trimTrailingText(nodes: readonly ElementContent[]): ElementContent[] {
  const out = [...nodes];
  const last = out.at(-1);
  if (last?.type === "text") out[out.length - 1] = { ...last, value: last.value.trimEnd() };
  return out;
}

/**
 * Replace every placeholder token in `parent`'s text nodes with its hole's
 * content, recursing into elements but never into substituted content. A
 * paragraph holding nothing but an include token is replaced as a whole.
 * Tokens in string attribute values are replaced with `inAttribute`'s text.
 */
function substitute(
  parent: Root | Element,
  pattern: RegExp,
  filled: readonly Filled[],
  inAttribute: (hole: Hole) => string,
): void {
  const out: RootContent[] = [];
  for (const child of parent.children) {
    if (child.type === "element") {
      substituteProperties(child, pattern, filled, inAttribute);
      const [only] = child.children;
      if (child.tagName === "p" && child.children.length === 1 && only?.type === "text") {
        const [match, ...more] = only.value.matchAll(pattern);
        const whole = match !== undefined && more.length === 0 && match[0] === only.value;
        const sub = whole ? filled[Number(match[1])] : undefined;
        if (sub?.hole.kind === "include") {
          for (const n of sub.nodes) out.push(n);
          continue;
        }
      }
      substitute(child, pattern, filled, inAttribute);
      out.push(child);
      continue;
    }
    if (child.type !== "text") {
      out.push(child);
      continue;
    }
    let last = 0;
    for (const match of child.value.matchAll(pattern)) {
      const sub = filled[Number(match[1])];
      if (sub === undefined) continue;
      if (match.index > last) {
        out.push({ type: "text", value: child.value.slice(last, match.index) });
      }
      for (const n of sub.nodes) out.push(n);
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
  filled: readonly Filled[],
  inAttribute: (hole: Hole) => string,
): void {
  const replace = (value: string): string =>
    value.replace(pattern, (token, n: string) => {
      const sub = filled[Number(n)];
      return sub === undefined ? token : inAttribute(sub.hole);
    });
  for (const [key, value] of Object.entries(el.properties)) {
    if (typeof value === "string") el.properties[key] = replace(value);
    else if (Array.isArray(value)) {
      el.properties[key] = value.map((item) => (typeof item === "string" ? replace(item) : item));
    }
  }
}

/**
 * Project one node to an unsanitized hast tree with every hole filled by the
 * caller: the html projector's per-node pipeline, for a projector whose output
 * is structured (a component tree, a JSON view) rather than an HTML string.
 *
 * The node's prose is its document's parsed mdast, turned into hast in one
 * pass, so a paragraph that holds a reference, a block or an include stays one
 * paragraph, and the markdown reads exactly as the parser read the document: a
 * reference is spliced into the parsed text, never parsed as part of it. The
 * tree comes from the parse (`mdastOf`) at no parsing cost; when the parse
 * kept none, the document's source is parsed once per projection walk cache
 * (`walk.cache`), or once per call without one. A heading's
 * trailing `{#anchor}` is removed the way the parser removes it from the
 * section heading, and becomes the heading's `id`. Includes are not projected
 * for you: the include hole hands over the child node, so the caller decides
 * how deep to go (normally a recursive `projectHast` wrapped in
 * {@link includeWrapper}).
 *
 * The tree is not sanitized. Run `sanitizePanelHast` on it for the html
 * projector's exact policy before anything renders it.
 * @param walk What to walk: the node, its values, the projector id whose block
 *   hooks to call, and the block types. `unescapeRefs` has no effect: the
 *   prose comes from the parsed tree, where the parser already consumed the
 *   escaping backslash of a `\{{`.
 * @param handlers What each hole becomes.
 * @returns The node's hast tree, unsanitized.
 * @example
 * ```ts
 * const handlers: HastHoleHandlers = {
 *   onHole: async (hole) => {
 *     if (hole.kind === "source") return [{ type: "text", value: hole.value }];
 *     if (hole.kind === "block") return [{ type: "text", value: hole.block.raw }];
 *     const inner = await projectHast({ ...walk, node: hole.include.node }, handlers);
 *     return [includeWrapper(hole.include, inner.children as ElementContent[])];
 *   },
 * };
 * const tree = sanitizePanelHast(await projectHast(walk, handlers));
 * ```
 */
export async function projectHast(
  walk: ProjectionWalkOptions,
  handlers: HastHoleHandlers,
): Promise<Root> {
  const { node } = walk;
  const nonce = placeholderNonce(node.src, node.ranges);
  const holes: { readonly hole: Hole; readonly ctx: ProjectionWalkContext }[] = [];
  const tokens: TokenEdit[] = [];
  const token = (hole: Hole, ctx: ProjectionWalkContext, span: SourceSpan | undefined): string => {
    holes.push({ hole, ctx });
    const value = `bk${nonce}x${holes.length - 1}z`;
    // The walk always passes the span.
    if (span !== undefined) {
      const kind = hole.kind === "block" ? "block" : "text";
      tokens.push({ kind, start: span.start, end: span.end, token: value });
    }
    return value;
  };

  // The walk plans the holes and calls the block hooks; the prose itself comes
  // from the document's parsed tree, so it is not collected.
  const walkHandlers: ProjectionWalkHandlers<string> = {
    onProse: () => "",
    onSource: (value, ref, ctx, span) => token({ kind: "source", ref, value }, ctx, span),
    onBlock: (block, ctx, span) =>
      token({ kind: "block", block: detach(block, walk.projectorId) }, ctx, span),
    onInclude: (include, ctx, span) => token({ kind: "include", include }, ctx, span),
    ...(handlers.onUnresolved !== undefined
      ? {
          onUnresolvedSource: (ref, state, raw, ctx, span) =>
            token(
              {
                kind: "unresolved",
                ref,
                raw,
                stale: state.stale,
                ...(state.value !== undefined ? { value: state.value } : {}),
              },
              ctx,
              span,
            ),
        }
      : {}),
  } satisfies ProjectionWalkHandlers<string>;
  walkProjectionParts(walk, walkHandlers);

  // In document order, one at a time: a handler that projects an include (or
  // reports a diagnostic) sees the same order on every call.
  const filled: Filled[] = [];
  for (const { hole, ctx } of holes) {
    let nodes: readonly ElementContent[];
    if (hole.kind === "unresolved") {
      // Defined: an unresolved hole is made only when the handler is.
      const onUnresolved = handlers.onUnresolved as NonNullable<HastHoleHandlers["onUnresolved"]>;
      nodes = await onUnresolved.call(handlers, hole, ctx);
    } else {
      nodes = await handlers.onHole(hole, ctx);
      if (hole.kind === "block") nodes = trimTrailingText(nodes);
    }
    filled.push({ hole, nodes });
  }

  const mdast = spliceTokens(documentTree(walk), node.src, node.ranges, tokens);
  stripHeadingAnchors(mdast, node.src);
  const tree = (await toHast.run(mdast)) as Root;
  const inAttribute = (hole: Hole): string =>
    handlers.onHoleInAttribute?.(hole) ?? attributeText(hole);
  substitute(tree, new RegExp(`bk${nonce}x(\\d+)z`, "g"), filled, inAttribute);
  return tree;
}
