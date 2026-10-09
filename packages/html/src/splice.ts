import type { SourceSpan } from "@onioneko/boardkit-core";
import type {
  FootnoteReference,
  Link,
  Nodes,
  Paragraph,
  Parent,
  Root,
  RootContent,
  Text,
} from "mdast";

/**
 * Hole tokens spliced into a parsed mdast tree by source offset: the html
 * projection's way to mark where each hole goes without parsing the markdown
 * again.
 *
 * The node's top-level mdast nodes are copied out of its document's tree, and
 * every hole becomes its placeholder token where its source span is:
 *
 * - a reference or include span inside a text node becomes the token inside
 *   that text node's value (and inside the URL of the autolink it forms, if
 *   any, where markdown would have put the token too);
 * - a typed block's code node becomes a paragraph holding the token.
 *
 * Copying is copy-on-write: only the nodes on the path to an edit are new, so
 * the document's tree, which other readers share, is never changed. Top-level
 * headings are copied whole, because removing a heading anchor edits them.
 */

/** A hole's token at a source span. */
export interface TokenEdit {
  /** `text` for a reference or include span, `block` for a typed block's code node. */
  readonly kind: "text" | "block";
  readonly start: number;
  readonly end: number;
  readonly token: string;
}

/** What the splice does at a source span. */
type Edit = TokenEdit | { readonly kind: "footnote"; readonly start: number; readonly end: number };

function startOf(node: Nodes): number | undefined {
  return node.position?.start.offset;
}

function endOf(node: Nodes): number | undefined {
  return node.position?.end.offset;
}

/** A deep copy of a node's structure (positions and `data` shared, never changed here). */
function cloneTree<T extends Nodes>(node: T): T {
  if (!("children" in node)) return { ...node };
  return { ...node, children: node.children.map((c) => cloneTree(c as Nodes)) } as T;
}

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const CHARACTER_REFERENCE = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/;

/**
 * For each offset in `cuts` (into `raw`, ascending), the offset in `value`
 * where the same source position lands: `value` is what the parser made of
 * `raw`, which lost escaping backslashes, decoded character references and
 * dropped line indentation.
 */
function alignCuts(raw: string, value: string, cuts: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  for (const cut of cuts) {
    while (i < cut && i < raw.length) {
      const r = raw[i] as string;
      if (j < value.length && r === value[j]) {
        i += 1;
        j += 1;
      } else if (
        r === "\\" &&
        i + 1 < raw.length &&
        ASCII_PUNCTUATION.test(raw[i + 1] as string) &&
        raw[i + 1] === value[j]
      ) {
        i += 2;
        j += 1;
      } else if (r === "&" && j < value.length) {
        const reference = CHARACTER_REFERENCE.exec(raw.slice(i, i + 40));
        if (reference === null) {
          i += 1;
        } else {
          i += reference[0].length;
          j += (value.codePointAt(j) ?? 0) > 0xffff ? 2 : 1;
        }
      } else {
        i += 1; // source the value does not hold (indentation, a stripped space)
      }
    }
    out.push(j);
  }
  return out;
}

/**
 * The value offsets `[from, to)` of a reference whose source spans
 * `[start, end)` of the text node's source: aligned, then checked to read
 * `{{…}}`; when the check fails, the next `{{…}}` in the value from `cursor`.
 */
function locate(
  raw: string,
  value: string,
  start: number,
  end: number,
  cursor: number,
): readonly [number, number] | undefined {
  if (raw === value) return [start, end];
  const [from, to] = alignCuts(raw, value, [start, end]) as [number, number];
  if (from >= cursor && value.startsWith("{{", from) && value.slice(0, to).endsWith("}}")) {
    return [from, to];
  }
  const open = value.indexOf("{{", cursor);
  const close = open === -1 ? -1 : value.indexOf("}}", open + 2);
  return close === -1 ? undefined : [open, close + 2];
}

/** A text node with each edit's token in place of the reference it covers. */
function spliceText(node: Text, src: string, edits: readonly Edit[]): Text {
  const start = startOf(node);
  const end = endOf(node);
  if (start === undefined || end === undefined) return node;
  const raw = src.slice(start, end);
  const { value } = node;
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    if (edit.kind !== "text") continue;
    const at = locate(raw, value, edit.start - start, edit.end - start, cursor);
    if (at === undefined) continue;
    out += value.slice(cursor, at[0]) + edit.token;
    cursor = at[1];
  }
  return { ...node, value: out + value.slice(cursor) };
}

/**
 * The URL of an autolink (`www.x.com/…`, `https://…`, `<https://…>`) is the
 * text the link shows, so a reference in that text is in the URL too, where
 * a parse of the tokens would have put the token. A link written with a
 * destination (`[text](url)`) keeps its URL as written.
 */
function spliceAutolinkUrl(node: Link, src: string, edits: readonly Edit[]): string {
  const [only] = node.children;
  const end = endOf(node);
  const childEnd = only === undefined ? undefined : endOf(only);
  if (node.children.length !== 1 || only?.type !== "text") return node.url;
  if (end === undefined || childEnd === undefined || childEnd < end - 1) return node.url;
  let url = node.url;
  for (const edit of edits) {
    if (edit.kind === "text") url = url.replace(src.slice(edit.start, edit.end), edit.token);
  }
  return url;
}

/** `node` with `edits` (all inside its span, sorted) applied, copied on write. */
function rewrite(node: Nodes, src: string, edits: readonly Edit[]): Nodes {
  if (edits.length === 0) return node;
  const start = startOf(node);
  if (node.type === "code" && edits[0]?.kind === "block" && edits[0].start === start) {
    const token: Text = { type: "text", value: edits[0].token };
    if (node.position !== undefined) token.position = node.position;
    const paragraph: Paragraph = { type: "paragraph", children: [token] };
    if (node.position !== undefined) paragraph.position = node.position;
    return paragraph;
  }
  if (node.type === "footnoteReference" && edits[0]?.kind === "footnote") {
    return danglingFootnote(node);
  }
  if (node.type === "text") return spliceText(node, src, edits);
  if (!("children" in node)) return node;
  const children: Nodes[] = [];
  let e = 0;
  for (const child of node.children as Nodes[]) {
    const childStart = startOf(child);
    const childEnd = endOf(child);
    if (childStart === undefined || childEnd === undefined) {
      children.push(child);
      continue;
    }
    while (e < edits.length && (edits[e] as Edit).start < childStart) e += 1;
    const mine: Edit[] = [];
    for (; e < edits.length && (edits[e] as Edit).end <= childEnd; e += 1) {
      mine.push(edits[e] as Edit);
    }
    children.push(rewrite(child, src, mine));
  }
  const copy = { ...node, children } as Parent & Nodes;
  if (node.type === "link") (copy as Link).url = spliceAutolinkUrl(node, src, edits);
  return copy;
}

/**
 * A footnote reference whose definition is outside the projected node reads
 * as its literal source, `[^label]`, as markdown reads it without that
 * definition.
 */
function danglingFootnote(node: FootnoteReference): Text {
  const text: Text = { type: "text", value: `[^${node.label ?? node.identifier}]` };
  if (node.position !== undefined) text.position = node.position;
  return text;
}

/** Footnote references and definitions of a tree, by start offset. */
interface Footnotes {
  readonly references: readonly {
    readonly start: number;
    readonly end: number;
    readonly id: string;
  }[];
  readonly definitions: readonly { readonly start: number; readonly id: string }[];
}

const footnotesOfTree = new WeakMap<Root, Footnotes>();

function footnotesOf(tree: Root): Footnotes {
  let found = footnotesOfTree.get(tree);
  if (found !== undefined) return found;
  const references: { start: number; end: number; id: string }[] = [];
  const definitions: { start: number; id: string }[] = [];
  const visit = (node: Nodes): void => {
    const start = startOf(node);
    const end = endOf(node);
    if (node.type === "footnoteReference" && start !== undefined && end !== undefined) {
      references.push({ start, end, id: node.identifier });
    } else if (node.type === "footnoteDefinition" && start !== undefined) {
      definitions.push({ start, id: node.identifier });
    }
    if ("children" in node) for (const child of node.children) visit(child as Nodes);
  };
  visit(tree);
  found = { references, definitions };
  footnotesOfTree.set(tree, found);
  return found;
}

/**
 * The footnote references inside `inside` whose definition is not: markdown
 * parsed from the node's own source alone would not have read them as
 * references.
 */
function danglingFootnotes(tree: Root, src: string, inside: (offset: number) => boolean): Edit[] {
  if (!src.includes("[^")) return [];
  const { references, definitions } = footnotesOf(tree);
  const defined = new Set(definitions.filter((d) => inside(d.start)).map((d) => d.id));
  return references
    .filter((r) => inside(r.start) && !defined.has(r.id))
    .map((r) => ({ kind: "footnote" as const, start: r.start, end: r.end }));
}

/**
 * The node's top-level mdast nodes, copied out of its document's `tree`, with
 * each edit applied at its source span.
 * @param tree The document's parsed tree (shared; never changed).
 * @param src The source `tree` was parsed from.
 * @param ranges The node's ranges in `src`, disjoint: a top-level node is
 *   projected when it starts inside one.
 * @param tokens The holes' tokens, at their spans.
 * @returns A new root holding the node's content.
 */
export function spliceTokens(
  tree: Root,
  src: string,
  ranges: readonly SourceSpan[],
  tokens: readonly TokenEdit[],
): Root {
  const inside = (offset: number): boolean =>
    ranges.some((r) => offset >= r.start && offset < r.end);
  const edits: Edit[] = [...tokens, ...danglingFootnotes(tree, src, inside)];
  edits.sort((a, b) => a.start - b.start);
  const children: RootContent[] = [];
  let e = 0;
  // Only the top-level nodes starting in a range are visited (binary search
  // per range), so a small section of a large document costs the section.
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (const range of sorted) {
    for (let c = firstAtOrAfter(tree.children, range.start); c < tree.children.length; c += 1) {
      const child = tree.children[c] as RootContent;
      const start = startOf(child);
      const end = endOf(child);
      if (start === undefined || end === undefined) continue;
      if (start >= range.end) break;
      while (e < edits.length && (edits[e] as Edit).start < start) e += 1;
      const mine: Edit[] = [];
      for (; e < edits.length && (edits[e] as Edit).end <= end; e += 1) {
        mine.push(edits[e] as Edit);
      }
      // A heading is copied whole: removing its `{#anchor}` edits it in place.
      const own = child.type === "heading" ? cloneTree(child) : child;
      children.push(rewrite(own, src, mine) as RootContent);
    }
  }
  return { type: "root", children };
}

/** Index of the first of `nodes` (in source order) that starts at or after `offset`. */
function firstAtOrAfter(nodes: readonly RootContent[], offset: number): number {
  let lo = 0;
  let hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((startOf(nodes[mid] as RootContent) ?? 0) < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
