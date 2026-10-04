import type { Code, Root } from "mdast";
import { visit } from "unist-util-visit";
import { parse as parseYaml } from "yaml";
import { type Diagnostic, diagnostic } from "../model/diagnostic.js";
import type { Block } from "../model/doc.js";
import { asBlockId } from "../model/ids.js";

/**
 * Typed block extraction: fenced code blocks whose info string is a registered
 * block type become Block nodes (YAML body parsed into attrs). Unregistered
 * fences remain ordinary code; YAML or id errors yield diagnostics and drop the
 * block (fail-soft).
 */

/**
 * Extract typed blocks from fenced code blocks whose info string is a
 * registered block type. Unregistered fences stay ordinary code.
 * @param root The parsed markdown tree.
 * @param blockTypes The set of info strings that become typed blocks.
 * @returns The extracted blocks plus diagnostics for YAML/id errors (fail-soft).
 */
export function extractBlocks(
  root: Root,
  blockTypes: ReadonlySet<string>,
): { blocks: Block[]; diagnostics: Diagnostic[] } {
  const blocks: Block[] = [];
  const diagnostics: Diagnostic[] = [];

  visit(root, "code", (node: Code) => {
    const lang = node.lang;
    if (lang === null || lang === undefined || !blockTypes.has(lang)) return;

    const line = node.position?.start.line ?? 1;
    const col = node.position?.start.column ?? 1;
    const startOffset = node.position?.start.offset;
    const endOffset = node.position?.end.offset;

    let parsed: unknown;
    try {
      parsed = parseYaml(node.value);
    } catch {
      diagnostics.push(
        diagnostic("E_BLOCK_YAML", `invalid YAML body in ${lang} block`, { line, col }),
      );
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      diagnostics.push(
        diagnostic("E_BLOCK_YAML", `${lang} block body must be a YAML mapping`, { line, col }),
      );
      return;
    }
    const attrs = parsed as Record<string, unknown>;
    const id = attrs.id;
    if (typeof id !== "string" || id.length === 0) {
      diagnostics.push(
        diagnostic("E_BLOCK_ID", `${lang} block requires a non-empty string "id"`, { line, col }),
      );
      return;
    }

    blocks.push({
      blockId: asBlockId(id),
      type: lang,
      attrs,
      position: { line, col },
      ...(startOffset !== undefined && endOffset !== undefined
        ? { span: { start: startOffset, end: endOffset } }
        : {}),
    });
  });

  return { blocks, diagnostics };
}
