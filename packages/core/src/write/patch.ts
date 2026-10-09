import { type Document, isCollection, isNode, parseDocument, Scalar, visit } from "yaml";
import { type Diagnostic, diagnostic } from "../model/diagnostic.js";
import type { Block } from "../model/doc.js";

/**
 * Patch = deterministic source transformation: the block's YAML body is edited
 * at the concrete-syntax level via the yaml Document API (comments, blank
 * lines, key order, quoting preserved); every byte outside the block's body is
 * unchanged by construction. The new body never closes the block early: a
 * string holding a fence run is serialized on one line, and a body with a
 * line that could close the block's fence is refused (`E_PATCH_FENCE`), so a
 * patch cannot add, remove or change any other block.
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

  const fence = locateFence(src, span);
  if (typeof fence === "string") {
    return {
      src,
      diagnostics: [
        diagnostic("E_PATCH_SPAN", `block ${block.blockId} ${fence}`, { nodeId: block.blockId }),
      ],
    };
  }
  const { bodyStart, closeStart } = fence;

  const body = src.slice(bodyStart, closeStart);
  let doc: Document.Parsed;
  try {
    doc = parseDocument(body);
    // A document with errors cannot be serialized back.
    if (doc.errors.length > 0) throw doc.errors[0];
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

  // A string holding a fence run must never start a line of the body: keep
  // it on its own key's line (double-quoted when it has line breaks, and no
  // folding anywhere). Bodies without such strings serialize as before.
  const nextBody = quoteFenceRuns(doc)
    ? doc.toString({ lineWidth: 0, doubleQuotedMinMultiLineLength: Number.MAX_SAFE_INTEGER })
    : doc.toString();

  // The new body must not close the block early: everything after the
  // closing fence is byte-identical, so this keeps the rest of the document
  // as it was.
  const breakout = closingFenceLine(nextBody, fence);
  if (breakout !== undefined) {
    return {
      src,
      diagnostics: [
        diagnostic(
          "E_PATCH_FENCE",
          `patch of block ${block.blockId} would put a closing fence at body line ${breakout}; the patch was not applied`,
          { nodeId: block.blockId },
        ),
      ],
    };
  }

  return {
    src: src.slice(0, bodyStart) + nextBody + src.slice(closeStart),
    diagnostics: [],
  };
}

/** The opening fence's marker: its character and run length. */
interface Fence {
  readonly char: "`" | "~";
  readonly length: number;
}

const LINE_BREAK = /\r\n|\r|\n/;
const FENCE_RUN = /`{3}|~{3}/;
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_LIKE_LINE = /^([ \t]*)(`+|~+)[ \t]*$/;

/**
 * Locate a block's body between its own fences: the line after the opening
 * fence up to the start of its closing fence line. The fence must open a
 * line (indented at most 3 spaces, so not inside a list item or block quote,
 * whose body lines carry prefixes) and the span's last line must close it.
 * @returns The fence and body bounds, or why the span cannot be patched.
 */
function locateFence(
  src: string,
  span: { readonly start: number; readonly end: number },
): (Fence & { bodyStart: number; closeStart: number }) | string {
  const lineStart = lineStartBefore(src, span.start);
  const opener = OPENING_FENCE.exec(src.slice(lineStart, span.end));
  if (opener === null || !/^ *$/.test(src.slice(lineStart, span.start))) {
    return "is not a fenced block at the start of a line";
  }
  const run = opener[1] as string;
  const fence: Fence = { char: run[0] as "`" | "~", length: run.length };

  let bodyStart = -1;
  for (let i = lineStart; i < span.end; i += 1) {
    const c = src.charCodeAt(i);
    if (c === 10 || c === 13) {
      bodyStart = c === 13 && src.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
      break;
    }
  }
  if (bodyStart === -1 || bodyStart >= span.end) return "span is malformed";

  const closeStart = lineStartBefore(src, span.end);
  if (closeStart < bodyStart || !closesFence(src.slice(closeStart, span.end), fence)) {
    return "closing fence not found";
  }
  return { ...fence, bodyStart, closeStart };
}

/** The offset of the start of the line holding `offset` (after LF, CR or CRLF). */
function lineStartBefore(src: string, offset: number): number {
  return Math.max(src.lastIndexOf("\n", offset - 1), src.lastIndexOf("\r", offset - 1)) + 1;
}

/**
 * Whether a line may close the fence: a run of its character at least as
 * long, indented at most 3 spaces, with only spaces or tabs after it. A tab
 * in the indent counts as fence-like (conservative).
 */
function closesFence(line: string, fence: Fence): boolean {
  const m = FENCE_LIKE_LINE.exec(line);
  if (m === null) return false;
  const indent = m[1] as string;
  const run = m[2] as string;
  if (!indent.includes("\t") && indent.length > 3) return false;
  return run[0] === fence.char && run.length >= fence.length;
}

/** The 1-based number of the first body line that would close the fence, if any. */
function closingFenceLine(body: string, fence: Fence): number | undefined {
  const lines = body.split(LINE_BREAK);
  for (let i = 0; i < lines.length; i += 1) {
    if (closesFence(lines[i] as string, fence)) return i + 1;
  }
  return undefined;
}

/**
 * Mark every string scalar holding a fence run (3 backticks or tildes) that
 * spans lines, or is styled as a block scalar, as double-quoted, so it is
 * serialized on one line with escaped line breaks.
 * @returns Whether the document holds any string with a fence run.
 */
function quoteFenceRuns(doc: Document.Parsed): boolean {
  let found = false;
  visit(doc, {
    Pair(_, pair) {
      // Values set from the delta may be plain JS values; make them nodes so
      // the scalars below are visited.
      if (!isNode(pair.key) && pair.key != null) pair.key = doc.createNode(pair.key);
      if (!isNode(pair.value) && pair.value != null) pair.value = doc.createNode(pair.value);
    },
    Scalar(_, node) {
      if (typeof node.value !== "string" || !FENCE_RUN.test(node.value)) return;
      found = true;
      if (
        LINE_BREAK.test(node.value) ||
        node.type === Scalar.BLOCK_LITERAL ||
        node.type === Scalar.BLOCK_FOLDED
      ) {
        node.type = Scalar.QUOTE_DOUBLE;
      }
    },
  });
  return found;
}
