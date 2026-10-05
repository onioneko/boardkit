import { splitHeadingAnchor } from "@onioneko/boardkit-core";
import type { Heading, Root } from "mdast";

/**
 * Heading anchors: the parser reads a trailing `{#anchor}` as the section id
 * and strips it from the section's heading text, so the html projection must
 * not render it as text. This mdast transform applies the parser's rule to
 * each top-level heading of the projected markdown (`parse/sections.ts` in
 * core; keep the two in step):
 *
 * - the heading's text is its `text` and `inlineCode` runs, at most one
 *   phrasing container deep;
 * - the anchor is `splitHeadingAnchor` of the last run, which must be `text`
 *   (code is literal);
 * - the run's source must spell the anchor literally, its `{` not escaped.
 *
 * A recognized anchor is removed from the last run (with the whitespace before
 * it), runs and containers it leaves empty are removed, and the anchor becomes
 * the heading's `id`, which the sanitizer prefixes as `user-content-…`.
 */

type Leaf = Heading["children"][number] & { type: "text" | "inlineCode"; value: string };
type Container = { children: Heading["children"] | Leaf[] };

/** The runs of a heading's plain text, each with the node holding it. */
function leaves(heading: Heading): { leaf: Leaf; parent: Container }[] {
  const out: { leaf: Leaf; parent: Container }[] = [];
  for (const child of heading.children) {
    if (child.type === "text" || child.type === "inlineCode") {
      out.push({ leaf: child, parent: heading });
    } else if ("children" in child) {
      for (const grand of child.children) {
        if (grand.type === "text" || grand.type === "inlineCode") {
          out.push({ leaf: grand, parent: child as Container });
        }
      }
    }
  }
  return out;
}

/** The anchor the parser would read from `heading`, given the markdown it was parsed from. */
function literalAnchor(last: Leaf, src: string): string | undefined {
  if (last.type !== "text") return undefined;
  const { anchor } = splitHeadingAnchor(last.value);
  const start = last.position?.start.offset;
  const end = last.position?.end.offset;
  if (anchor === undefined || start === undefined || end === undefined) return undefined;
  const raw = src.slice(start, end).trimEnd();
  const literal = `{#${anchor}}`;
  if (!raw.endsWith(literal)) return undefined;
  let backslashes = 0;
  for (let i = raw.length - literal.length - 1; i >= 0 && raw[i] === "\\"; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 0 ? anchor : undefined;
}

function remove(parent: Container, node: unknown): void {
  const children = parent.children as unknown[];
  const at = children.indexOf(node);
  if (at !== -1) children.splice(at, 1);
}

/** Strip one heading's anchor, if it has one, and make it the heading's id. */
function stripAnchor(heading: Heading, src: string): void {
  const runs = leaves(heading);
  const last = runs.at(-1);
  if (last === undefined) return;
  const anchor = literalAnchor(last.leaf, src);
  if (anchor === undefined) return;
  // `splitHeadingAnchor` of the last run alone: the anchor never crosses runs.
  last.leaf.value = splitHeadingAnchor(last.leaf.value).heading;
  if (last.leaf.value === "") {
    remove(last.parent, last.leaf);
    if (last.parent !== heading && last.parent.children.length === 0) {
      remove(heading, last.parent);
    }
  }
  // The text before the anchor loses its trailing whitespace, as the
  // section's heading text does.
  const tail = heading.children.at(-1);
  if (tail?.type === "text") {
    tail.value = tail.value.trimEnd();
    if (tail.value === "") heading.children.pop();
  }
  heading.data = {
    ...heading.data,
    hProperties: { ...heading.data?.hProperties, id: anchor },
  };
}

/**
 * Strip `{#anchor}` from every top-level heading of `tree` and set it as the
 * heading's id. Mutates `tree`.
 * @param tree The mdast tree, as parsed from `src` (positions are offsets into it).
 * @param src The markdown `tree` was parsed from.
 */
export function stripHeadingAnchors(tree: Root, src: string): void {
  for (const child of tree.children) {
    if (child.type === "heading") stripAnchor(child, src);
  }
}
