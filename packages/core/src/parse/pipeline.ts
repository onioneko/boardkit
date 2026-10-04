import GithubSlugger from "github-slugger";
import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { parse as parseYaml } from "yaml";
import { type Diagnostic, diagnostic } from "../model/diagnostic.js";
import type { ParsedDoc, Section, SourceSpan } from "../model/doc.js";
import { validateFrontmatter } from "../model/frontmatter.js";
import { extractBlocks } from "./blocks.js";
import type { ParseOptions } from "./options.js";
import { extractRefs } from "./refs.js";
import { extractSections, refsBySection } from "./sections.js";

const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm);

const NO_REF_KINDS: ReadonlySet<"source" | "include"> = new Set();
const DEFAULT_REF_KINDS: ReadonlySet<"source" | "include"> = new Set(["source", "include"]);

/** Derive the recognized ref kinds: frontmatter `refs` wins per document; otherwise the host parse option; otherwise both. */
function resolveRefKinds(
  frontmatterRefs: false | ("source" | "include")[] | undefined,
  optionRefs: ReadonlySet<"source" | "include"> | undefined,
): ReadonlySet<"source" | "include"> {
  if (frontmatterRefs === false) return NO_REF_KINDS;
  if (frontmatterRefs !== undefined) return new Set(frontmatterRefs);
  if (optionRefs !== undefined) return optionRefs;
  return DEFAULT_REF_KINDS;
}

/**
 * Parse one document into a ParsedDoc. Content errors are reported as
 * diagnostics and never thrown (fail-soft); only programming errors throw.
 * @param src The raw markdown source text to parse.
 * @param options Parse options; `blockTypes` selects which fences become typed blocks.
 * @returns The parsed document: frontmatter, sections/blocks, refs, spans, and diagnostics.
 */
export function parseDoc(src: string, options: ParseOptions = {}): ParsedDoc {
  const blockTypes = options.blockTypes ?? new Set<string>();
  const diagnostics: Diagnostic[] = [];
  const tree = processor.parse(src) as Root;

  // Frontmatter (shape-validated by the model layer).
  let frontmatter: Record<string, unknown> = {};
  let frontmatterSpan: SourceSpan | undefined;
  for (const child of tree.children) {
    if (child.type !== "yaml") continue;
    const yamlNode = child as unknown as {
      value: string;
      position?: {
        start: { line: number; column: number; offset?: number };
        end?: { offset?: number };
      };
    };
    const startOffset = yamlNode.position?.start.offset ?? 0;
    const endOffset = yamlNode.position?.end?.offset;
    if (endOffset !== undefined && endOffset > startOffset) {
      frontmatterSpan = { start: startOffset, end: endOffset };
    }
    try {
      const parsed: unknown = parseYaml(yamlNode.value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      } else if (parsed !== null && parsed !== undefined) {
        diagnostics.push(diagnostic("E_FRONTMATTER_YAML", "frontmatter must be a YAML mapping"));
      }
    } catch {
      const pos = yamlNode.position?.start;
      diagnostics.push(
        diagnostic(
          "E_FRONTMATTER_YAML",
          "invalid frontmatter YAML",
          pos === undefined ? undefined : { line: pos.line, col: pos.column },
        ),
      );
    }
    break;
  }
  const validated = validateFrontmatter(frontmatter);
  for (const d of validated.diagnostics) diagnostics.push(d);

  // Sections (exclusive source spans), refs, blocks.
  const spans = extractSections(tree, src, new GithubSlugger());
  const refKinds = resolveRefKinds(validated.refs, options.refs);
  const { refs, hits, diagnostics: refDiagnostics } = extractRefs(tree, src, refKinds);
  for (const d of refDiagnostics) diagnostics.push(d);
  const { blocks, diagnostics: blockDiagnostics } = extractBlocks(tree, blockTypes);
  for (const d of blockDiagnostics) diagnostics.push(d);

  // Bucket refs into their owning sections: the deepest section containing each.
  const refsBySpan = refsBySection(spans, hits);

  const sections: Section[] = spans.map((span) => ({
    sectionId: span.sectionId,
    heading: span.heading,
    level: span.level,
    content: span.content,
    refs: refsBySpan.get(span.startOffset) ?? [],
    contentSpans: span.contentSpans,
    ...(span.position !== undefined ? { position: span.position } : {}),
  }));

  return {
    frontmatter,
    ...(frontmatterSpan !== undefined ? { frontmatterSpan } : {}),
    nodes: [...sections, ...blocks],
    refs,
    refSpans: hits.map((h) => ({ start: h.offset, end: h.endOffset, ref: h.ref })),
    diagnostics,
  };
}
