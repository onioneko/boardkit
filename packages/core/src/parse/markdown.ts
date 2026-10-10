import type { Nodes, Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);

type Point = NonNullable<Root["position"]>["start"];

const BOM = 0xfeff;

/**
 * One markdown parse of `src` into mdast (CommonMark, GFM and YAML
 * frontmatter): the only place the engine runs the markdown parser.
 *
 * The markdown parser drops a leading byte order mark (U+FEFF) and counts its
 * offsets from the character after it. They are moved on by one here, so every
 * offset in the tree, and every span derived from it, is an index into `src`
 * as given, BOM included. Lines and columns stay as the parser gives them (the
 * BOM takes no column).
 * @param src The markdown source.
 * @returns The mdast tree, offsets relative to `src`.
 */
export function parseMarkdown(src: string): Root {
  const root = processor.parse(src) as Root;
  if (src.charCodeAt(0) === BOM) shiftOffsets(root);
  return root;
}

/**
 * Move every offset of a freshly parsed tree one character on, except the
 * root's start, which stays at the start of the source (before the BOM).
 */
function shiftOffsets(root: Root): void {
  const p = root.position;
  if (p !== undefined) root.position = { start: p.start, end: next(p.end) };
  const stack: Nodes[] = [...root.children];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const at = node.position;
    if (at !== undefined) {
      // Fresh points, so a point the parser shares between nodes moves once.
      node.position = { start: next(at.start), end: next(at.end) };
    }
    if ("children" in node) for (const child of node.children) stack.push(child as Nodes);
  }
}

/** A copy of `point` one character on (a point without an offset keeps none). */
function next(point: Point): Point {
  return point.offset === undefined ? { ...point } : { ...point, offset: point.offset + 1 };
}
