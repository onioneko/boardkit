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
 * The `E_PARSE_FAILED` diagnostic for an exception thrown by {@link parseDoc}.
 * @param docId The document whose parse threw.
 * @param err What the parser threw.
 * @returns The diagnostic.
 */
export function parseFailedDiagnostic(docId: string, err: unknown): Diagnostic {
  return diagnostic(
    "E_PARSE_FAILED",
    `document ${JSON.stringify(docId)} could not be parsed: ${
      err instanceof Error ? err.message : String(err)
    }`,
    { nodeId: docId },
  );
}

/**
 * A value and everything reachable from it, read-only: the type of a tree
 * {@link mdastOf} hands out, which is frozen as well.
 * @typeParam T The value's type.
 */
export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/** The mdast each parse was built from, the source it was parsed from, and its node count. */
interface KeptTree {
  readonly src: string;
  readonly tree: Root;
  nodes?: number;
  frozen?: boolean;
}

const treeOfDoc = new WeakMap<ParsedDoc, KeptTree>();

/** Freeze `root` and every object reachable from it (nodes, positions, `data`, arrays). */
function deepFreeze(root: object): void {
  const stack: object[] = [root];
  for (let value = stack.pop(); value !== undefined; value = stack.pop()) {
    if (Object.isFrozen(value)) continue;
    Object.freeze(value);
    for (const child of Object.values(value)) {
      if (typeof child === "object" && child !== null) stack.push(child);
    }
  }
}

/**
 * The mdast tree `doc` was built from, for a projector that renders markdown
 * structure: reading it costs no parse. {@link parseDoc} keeps each parse's
 * tree for as long as its `ParsedDoc` lives, except in an engine, whose parse
 * cache keeps the trees of only its most recently used parses (see
 * `docs/guides/projections.md`); a released tree reads as `undefined`.
 *
 * The tree is shared by every reader, so it is deeply frozen (the first time
 * it is handed out) and typed read-only: changing it throws. Copy the nodes
 * you want to change. Positions are offsets into `src`.
 * @param doc A parse made by the engine or by `parseDoc`.
 * @param src The source `doc` was parsed from. A different source gives
 *   `undefined`, so a tree is never paired with text it was not parsed from.
 * @returns The frozen tree, or `undefined` when it is not kept (released, or
 *   a `ParsedDoc` not made by the parser) or `src` is not its source.
 * @example
 * ```ts
 * const tree = mdastOf(node.doc, node.src) ?? myParse(node.src);
 * ```
 */
export function mdastOf(doc: ParsedDoc, src: string): DeepReadonly<Root> | undefined {
  const kept = treeOfDoc.get(doc);
  if (kept === undefined || kept.src !== src) return undefined;
  if (kept.frozen !== true) {
    // Lazily: a parse that is never projected (a write's) pays nothing.
    deepFreeze(kept.tree);
    kept.frozen = true;
  }
  return kept.tree as DeepReadonly<Root>;
}

/**
 * The number of mdast nodes in the tree `doc` keeps, counted once: the
 * measure of the tree's memory (about 330 to 370 bytes per node, measured on
 * V8, whatever the markdown's shape), which per source character ranges from
 * about 3 to over 100 times the source.
 * @param doc A parse.
 * @returns The node count, or `0` when `doc` keeps no tree.
 */
export function mdastNodeCount(doc: ParsedDoc): number {
  const kept = treeOfDoc.get(doc);
  if (kept === undefined) return 0;
  if (kept.nodes === undefined) {
    let nodes = 0;
    const stack: unknown[] = [kept.tree];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      nodes += 1;
      const children = (node as { children?: unknown[] }).children;
      if (children !== undefined) for (const child of children) stack.push(child);
    }
    kept.nodes = nodes;
  }
  return kept.nodes;
}

/**
 * Stop keeping the mdast tree of `doc`, so it can be garbage-collected while
 * the parse itself is still held. {@link mdastOf} then returns `undefined`
 * for it. The engine's parse cache calls this for parses past its tree budget.
 * @param doc A parse.
 */
export function releaseMdast(doc: ParsedDoc): void {
  treeOfDoc.delete(doc);
}

/**
 * Parse one document into a ParsedDoc. Content errors are reported as
 * diagnostics and never thrown (fail-soft); only programming errors throw.
 * The one exception is input deep enough to exhaust the call stack (thousands
 * of nested containers): the markdown parser then throws a `RangeError`. The
 * engine screens such input out first (`EngineOptions.complexityLimits`) and
 * turns a throw that still happens into an `E_PARSE_FAILED` diagnostic
 * ({@link parseFailedDiagnostic}).
 * @param src The raw markdown source text to parse.
 * @param options Parse options; `blockTypes` selects which fences become typed blocks.
 * @returns The parsed document: frontmatter, sections/blocks, refs, spans, and diagnostics.
 *   Its mdast tree is kept with it ({@link mdastOf}) for as long as the
 *   `ParsedDoc` is reachable, unless {@link releaseMdast} drops it first:
 *   about 330 to 370 bytes per mdast node, which is about 3 to 6 times the
 *   source for plain prose and over 100 times it for lists and tables.
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

  const doc: ParsedDoc = {
    frontmatter,
    ...(frontmatterSpan !== undefined ? { frontmatterSpan } : {}),
    nodes: [...sections, ...blocks],
    refs,
    refSpans: hits.map((h) => ({ start: h.offset, end: h.endOffset, ref: h.ref })),
    diagnostics,
  };
  treeOfDoc.set(doc, { src, tree });
  return doc;
}
