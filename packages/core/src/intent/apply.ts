import type { AnyBlockType } from "../blocks/types.js";
import type { Diagnostic } from "../model/diagnostic.js";
import { diagnostic } from "../model/diagnostic.js";
import type { Block, ParsedDoc } from "../model/doc.js";
import { tryBlockId, tryDocId } from "../model/ids.js";
import {
  type PatchDeltaFn,
  type PipelineDeps,
  parseLimitRejection,
  patchDoc,
  tryParseDoc,
  type WriteResult,
  type Writer,
} from "../write/pipeline.js";

/**
 * The default Intent route: decode an affordance through the block type and
 * hand the resulting attrs delta to the patch pipeline with the Intent's
 * compare-and-set guards. Authentication, write policy, and writer identity
 * are the host's job before calling this.
 */

/** A consumer-produced request naming a document, block, affordance, params, and compare-and-set guards. */
export interface Intent {
  /** The document containing the block (a workspace-relative path). */
  readonly docId: string;
  /** The block to operate on (its `id` attr). */
  readonly blockId: string;
  /** The affordance (operation) to invoke. */
  readonly affordance: string;
  /** Operation params, validated against the affordance's declared schema when one exists. */
  readonly params?: unknown;
  /** The document version the projection was rendered against (compare-and-set). */
  readonly expectedVersion?: string;
  /** The attr values rendered against (value-CAS); when the version moved but these still match, the intent rebases. */
  readonly expected?: Record<string, unknown>;
}

function blocksOf(parsed: ParsedDoc): Block[] {
  return parsed.nodes.filter((n): n is Block => "blockId" in n);
}

function reject(reason: string, diagnostics: readonly Diagnostic[]): WriteResult {
  return { ok: false, rejection: { reason, diagnostics } };
}

/**
 * The default intent route: locate the affordance through the block type and
 * hand the patch pipeline a function that decodes the attrs delta against the
 * freshly-read current attrs (inside the write lock), with the intent's
 * compare-and-set guards and its origin (`affordance` + `params`).
 *
 * The early checks here are a fail-fast courtesy against the pre-lock read
 * (invalid ids, a missing document/block, an unknown type or affordance); the
 * authoritative param validation runs inside the lock in {@link patchDoc},
 * against the params as the write middleware chain left them — so an amended
 * `params` is validated and honored, not silently trusted or ignored.
 * @param deps The injected pipeline dependencies.
 * @param intent The request (doc, block, affordance, params, guards).
 * @param writer The write's author (audit provenance).
 * @returns The write result from the patch pipeline.
 */
export async function applyIntent(
  deps: PipelineDeps,
  intent: Intent,
  writer: Writer,
): Promise<WriteResult> {
  const docIdV = tryDocId(intent.docId);
  if (!docIdV.ok) return reject("invalid-id", [docIdV.diagnostic]);
  const blockIdV = tryBlockId(intent.blockId);
  if (!blockIdV.ok) return reject("invalid-id", [blockIdV.diagnostic]);
  const docId = docIdV.id;
  const blockId = blockIdV.id;

  const current = await deps.storage.read(docId);
  if (current === undefined) {
    return reject("missing-doc", [diagnostic("E_DOC_MISSING", `document not found: ${docId}`)]);
  }
  const overLimit = parseLimitRejection(deps, docId, current, "read");
  if (overLimit !== undefined) return overLimit;
  const attempt = tryParseDoc(current, deps.parseOptions, docId);
  if (!attempt.ok) return reject("validation", [attempt.diagnostic]);
  const parsed = attempt.parsed;
  const block = blocksOf(parsed).find((b) => b.blockId === blockId);
  if (block === undefined) {
    return reject("missing-block", [
      diagnostic("E_BLOCK_MISSING", `block not found: ${blockId}`, { nodeId: blockId }),
    ]);
  }
  const type: AnyBlockType | undefined = deps.blockTypes.get(block.type);
  if (type === undefined) {
    return reject("unknown-type", [
      diagnostic("E_UNKNOWN_BLOCK_TYPE", `unregistered block type: ${block.type}`),
    ]);
  }
  const affordance = type.affordances?.find((a) => a.name === intent.affordance);
  if (affordance === undefined) {
    return reject("unknown-affordance", [
      diagnostic(
        "E_UNKNOWN_AFFORDANCE",
        `block ${block.type} has no affordance "${intent.affordance}"`,
        { nodeId: blockId },
      ),
    ]);
  }
  // Decode inside the lock: hand patchDoc a function that recomputes the delta
  // against the freshly-read current attrs, so concurrent intents never apply a
  // delta precomputed from a stale read — and hand it the intent's origin, so
  // write middleware sees (and may amend) the affordance and params, and the
  // pipeline validates the params it actually decodes with.
  const delta: PatchDeltaFn = (currentAttrs, params) => affordance.patch(currentAttrs, params);
  return patchDoc(
    deps,
    docId,
    blockId,
    delta,
    writer,
    {
      ...(intent.expectedVersion !== undefined ? { expectedVersion: intent.expectedVersion } : {}),
      ...(intent.expected !== undefined ? { expected: intent.expected } : {}),
    },
    {
      affordance: intent.affordance,
      ...(intent.params !== undefined ? { params: intent.params } : {}),
    },
  );
}
