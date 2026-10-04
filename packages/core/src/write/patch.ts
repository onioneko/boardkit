import { type Document, isCollection, parseDocument } from "yaml";
import { type Diagnostic, diagnostic } from "../model/diagnostic.js";
import type { Block } from "../model/doc.js";

/**
 * Patch = deterministic source transformation: the block's YAML body is edited
 * at the concrete-syntax level via the yaml Document API (comments, blank
 * lines, key order, quoting preserved); every byte outside the block's body is
 * unchanged by construction.
 */

/** Inputs for a deterministic source transformation of one block's attrs. */
export interface PatchInput {
  /** The document's full raw source. */
  readonly src: string;
  /** The block whose YAML body is edited (must carry a source `span`). */
  readonly block: Block;
  /** Top-level attrs delta (shallow merge; arrays are replaced wholesale). */
  readonly delta: Record<string, unknown>;
}

/**
 * Apply an attrs delta to a block by editing its YAML body in place, preserving
 * every byte outside the body and comments/quoting/key order inside it.
 * @param input The source, target block, and attrs delta.
 * @returns The rewritten source plus any patch diagnostics (the source is unchanged on failure).
 */
export function applyPatch(input: PatchInput): { src: string; diagnostics: readonly Diagnostic[] } {
  const { src, block, delta } = input;
  const span = block.span;
  if (span === undefined) {
    return {
      src,
      diagnostics: [
        diagnostic("E_PATCH_SPAN", `block ${block.blockId} has no source span`, {
          nodeId: block.blockId,
        }),
      ],
    };
  }

  const openEnd = src.indexOf("\n", span.start);
  if (openEnd === -1 || openEnd >= span.end) {
    return {
      src,
      diagnostics: [
        diagnostic("E_PATCH_SPAN", `block ${block.blockId} span is malformed`, {
          nodeId: block.blockId,
        }),
      ],
    };
  }
  const bodyStart = openEnd + 1;
  const closeStart = src.lastIndexOf("```", span.end - 1);
  if (closeStart <= bodyStart) {
    return {
      src,
      diagnostics: [
        diagnostic("E_PATCH_SPAN", `block ${block.blockId} closing fence not found`, {
          nodeId: block.blockId,
        }),
      ],
    };
  }

  const body = src.slice(bodyStart, closeStart);
  let doc: Document.Parsed;
  try {
    doc = parseDocument(body);
  } catch {
    return {
      src,
      diagnostics: [
        diagnostic("E_PATCH_YAML", `block ${block.blockId} body is not valid YAML`, {
          nodeId: block.blockId,
        }),
      ],
    };
  }

  for (const [key, value] of Object.entries(delta)) {
    const before = doc.getIn([key], true);
    const wasFlow = before !== undefined && isCollection(before) && before.flow === true;
    if (wasFlow) {
      // Recreate the value as a node so the flow style survives serialization.
      const node = doc.createNode(value);
      if (isCollection(node)) (node as unknown as { flow?: boolean }).flow = true;
      doc.setIn([key], node);
    } else {
      doc.setIn([key], value);
    }
  }

  return {
    src: src.slice(0, bodyStart) + doc.toString() + src.slice(closeStart),
    diagnostics: [],
  };
}
