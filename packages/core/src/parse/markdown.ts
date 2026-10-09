import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);

/**
 * One markdown parse of `src` into mdast (CommonMark, GFM and YAML
 * frontmatter): the only place the engine runs the markdown parser.
 * @param src The markdown source.
 * @returns The mdast tree, positions relative to `src`.
 */
export function parseMarkdown(src: string): Root {
  return processor.parse(src) as Root;
}
