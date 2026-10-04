import { randomUUID } from "node:crypto";
import equal from "fast-deep-equal";
import type { AnyBlockType } from "../blocks/types.js";
import { diffDocs } from "../diff/diff.js";
import { synthesizeEvents } from "../diff/synthesize.js";
import { docVersion } from "../engine/version.js";
import {
  compose,
  type WriteCtx,
  type WriteMiddleware,
  WriteRejection,
} from "../middleware/compose.js";
import type { Diagnostic } from "../model/diagnostic.js";
import { diagnostic } from "../model/diagnostic.js";
import type { Block, ParsedDoc } from "../model/doc.js";
import type { BlockId, DocId } from "../model/ids.js";
import { type ComplexityLimits, complexityDiagnostic } from "../parse/complexity.js";
import type { ParseOptions } from "../parse/options.js";
import { parseDoc, parseFailedDiagnostic } from "../parse/pipeline.js";
import {
  DEFAULT_MAX_DOCUMENT_BYTES,
  documentSizeDiagnostic,
  exceedsDocumentLimit,
} from "../parse/size.js";
import type { Clock, CommitInfo, EventDraft, EventRecord, Storage } from "../ports/ports.js";
import { enforceHistory } from "../validate/history.js";
import { validateBlock, validateParams } from "../validate/schema.js";
import {
  decideFullText,
  decideFunctionPatch,
  decidePatch,
  type PatchGuards,
} from "./concurrency.js";
import { applyPatch } from "./patch.js";

/**
 * The commit pipeline: VALIDATE → LOCK → COMMIT → DIFF → EMIT. Full-text and
 * patch writes share this pipeline — no code path mutates a document outside
 * it. Content failures return WriteResult rejections; only programming errors
 * throw.
 */

/**
 * A write's author: a provenance label for audit, never a behavioral switch.
 * See {@link Writer.kind} for what the three author categories mean.
 */
export interface Writer {
  /**
   * The author's category — `human` (a person acting through an editor,
   * browser, or CLI), `agent` (an autonomous or LLM-driven agent), or
   * `program` (a script, job, or service). All three are provenance labels the
   * pipeline treats identically: the kind is stamped on events for audit, and
   * middleware and host policy may branch on it (for example, to let only a
   * human execute a decision).
   */
  readonly kind: "human" | "agent" | "program";
  /** A stable author identifier, stamped on events for audit. */
  readonly id: string;
}

/**
 * Which write mode a policy decision (and a middleware context) concerns.
 *
 * The lifecycle operations `createDoc`/`removeDoc` get their own modes (rather
 * than reusing `"full"`/`"patch"`) so a host policy can distinguish "may this
 * writer create documents" and "may this writer delete documents" from "may
 * this writer replace/patch content". A create IS a whole-document write, but a
 * policy that grants full-text edits must not implicitly grant creation.
 * `"import"` is {@link importDoc}: a create that stores the bytes verbatim,
 * skipping content validation, so a policy can grant it separately (to a
 * restore or undo path only, for example).
 */
export type WriteMode = "full" | "patch" | "create" | "remove" | "import";

/**
 * A patch delta computed inside the write lock against the freshly-read current
 * attrs (rather than a precomputed concrete delta). Passing a function lets an
 * affordance decode against committed truth, so concurrent writers never apply
 * a delta built from stale attrs.
 * @param currentAttrs The block's attrs as read inside the lock.
 * @param params The proposal's params, as the middleware chain left them
 * (`undefined` for a patch with no {@link patchDoc} `origin`).
 * @returns The top-level attrs delta to apply.
 */
export type PatchDeltaFn = (
  currentAttrs: Readonly<Record<string, unknown>>,
  params?: unknown,
) => Record<string, unknown>;

/** Host write-domain policy; absence means allow-all. */
export interface WritePolicy {
  /**
   * Decide whether a writer may perform a write of the given mode.
   * @param writer The proposed write's author.
   * @param docId The target document.
   * @param mode The write mode: `full` (replace), `patch` (attrs delta),
   * `create` (new document), `remove` (delete document), or `import` (new
   * document stored verbatim, see {@link importDoc}).
   * @returns `true` to allow; `false` rejects the write with a write-domain diagnostic.
   */
  canWrite?(writer: Writer, docId: DocId, mode: WriteMode): boolean;
}

/**
 * The outcome of any write through the commit pipeline, as a discriminated
 * union: a successful commit carries a `version`; a rejection carries a
 * `rejection` with no `version` (narrow on `ok`).
 */
export type WriteResult =
  | {
      /** True when the write committed. */
      readonly ok: true;
      /** The committed document's version (content hash). */
      readonly version: string;
      /** True when a patch applied via value-CAS rebase (the version moved but the touched attrs matched). */
      readonly rebased?: boolean;
      /** The event records the write appended, when an event sink is configured. */
      readonly events?: readonly EventRecord[];
      /** True when events were actually appended (false when no sink is configured). */
      readonly eventsAppended?: boolean;
    }
  | {
      /** False when the write was rejected. */
      readonly ok: false;
      /** Why the write was rejected. */
      readonly rejection: {
        /** Machine-readable rejection reason: `write-domain`, `missing-doc`, `validation`, `stale-version`, `expected-mismatch`, `missing-block`, `unknown-type`, `unknown-affordance`, `patch`, `unsupported`, `exists`, `invalid-id`, `too-large`, `too-complex`, `import-amended`, … */
        readonly reason: string;
        /** The live value(s) the write conflicted with (e.g. the current version or attrs), when relevant. */
        readonly current?: unknown;
        /** The diagnostics explaining the rejection. */
        readonly diagnostics: readonly Diagnostic[];
      };
    };

/** Everything the commit pipeline needs, injected at construction. */
export interface PipelineDeps {
  /** Where document bytes live. */
  readonly storage: Storage;
  /** Timestamp source for emitted events. */
  readonly clock: Clock;
  /** Registered block types, keyed by type name. */
  readonly blockTypes: ReadonlyMap<string, AnyBlockType>;
  /** Parse options used to re-parse documents during the pipeline. */
  readonly parseOptions?: ParseOptions;
  /** Write-domain policy; absent means allow-all. */
  readonly policy?: WritePolicy;
  /** Write middleware wrapping the whole pipeline (amend/reject/observe). */
  readonly middleware?: readonly WriteMiddleware[];
  /**
   * Document size limit in UTF-8 bytes; defaults to
   * `DEFAULT_MAX_DOCUMENT_BYTES` (256 KiB). A write whose result would exceed it
   * is rejected with reason `too-large`, and a stored document over it is not
   * parsed: patches and intents against it are rejected the same way.
   */
  readonly maxDocumentBytes?: number;
  /**
   * Markdown complexity limits; absent takes `DEFAULT_COMPLEXITY_LIMITS`, and
   * `false` turns the check off. A write whose result is over a limit is
   * rejected with reason `too-complex`, and a stored document over one is not
   * parsed: patches and intents against it are rejected the same way. The
   * value is validated on use: an invalid one is a programming error, and the
   * write rejects with a `TypeError`, as `createEngine` throws for it.
   */
  readonly complexityLimits?: ComplexityLimits | false;
  /**
   * Mints the {@link CommitInfo.id} stamped on every event of one commit,
   * called once per commit. The engine passes its own minter
   * (`<docId>@<version>#<prefix>.<n>`, see `EngineOptions.commitIdPrefix`).
   * Absent, {@link defaultCommitId} gives each commit a random id, unique but
   * not reproducible; pass a minter for deterministic ids.
   */
  readonly commitId?: (docId: DocId, version: string) => string;
}

/**
 * The commit id used when no `commitId` minter is configured:
 * `<docId>@<version>#<uuid>`. `docId@version` alone does not identify a
 * commit (a create and the remove of the same bytes share it, and so do
 * A→B→A edits), so a random suffix makes every id unique.
 * @param docId The committed document.
 * @param version The committed (or, for a removal, removed) content's hash.
 * @returns A fresh, unique commit id.
 */
export function defaultCommitId(docId: DocId, version: string): string {
  return `${docId}@${version}#${randomUUID()}`;
}

/**
 * Stamp each draft of one commit with its {@link CommitInfo}: a shared `id`,
 * its `index` and the commit's `size`.
 * @param drafts The commit's event drafts, in append order.
 * @param id The commit id.
 * @returns New drafts carrying `commit`.
 */
export function stampCommit(drafts: readonly EventDraft[], id: string): EventDraft[] {
  return drafts.map((draft, index) => {
    const commit: CommitInfo = { id, index, size: drafts.length };
    return { ...draft, commit };
  });
}

/**
 * A `too-large` rejection when `src` is over the document size limit.
 * @param deps The pipeline dependencies (for the limit).
 * @param docId The document the source belongs to.
 * @param src The source to measure.
 * @param action `"write"` for content about to be stored, `"read"` for a stored document.
 * @returns The rejection, or `undefined` when the source fits.
 */
export function sizeRejection(
  deps: Pick<PipelineDeps, "maxDocumentBytes">,
  docId: DocId,
  src: string,
  action: "write" | "read",
): WriteResult | undefined {
  const max = deps.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const d = documentSizeDiagnostic(docId, src, max, action);
  return d === undefined ? undefined : rejection("too-large", [d]);
}

/**
 * A `too-large` or `too-complex` rejection when `src` is over the document
 * size limit or a complexity limit: the checks that run before any parse.
 * @param deps The pipeline dependencies (for the limits).
 * @param docId The document the source belongs to.
 * @param src The source to check.
 * @param action `"write"` for content about to be stored, `"read"` for a stored document.
 * @returns The rejection, or `undefined` when the source may be parsed.
 */
export function parseLimitRejection(
  deps: Pick<PipelineDeps, "maxDocumentBytes" | "complexityLimits">,
  docId: DocId,
  src: string,
  action: "write" | "read",
): WriteResult | undefined {
  const tooLarge = sizeRejection(deps, docId, src, action);
  if (tooLarge !== undefined) return tooLarge;
  const d = complexityDiagnostic(docId, src, deps.complexityLimits, action);
  return d === undefined ? undefined : rejection("too-complex", [d]);
}

/**
 * Parse a source, turning a parser exception (a stack overflow on deeply
 * nested input the complexity limits did not catch, for example) into an
 * `E_PARSE_FAILED` diagnostic.
 * @param src The source to parse.
 * @param options Parse options.
 * @param docId The document the source belongs to (for the diagnostic).
 * @returns The parse, or the diagnostic when the parser threw.
 */
export function tryParseDoc(
  src: string,
  options: ParseOptions | undefined,
  docId: DocId,
):
  | { readonly ok: true; readonly parsed: ParsedDoc }
  | { readonly ok: false; readonly diagnostic: Diagnostic } {
  try {
    return { ok: true, parsed: parseDoc(src, options) };
  } catch (err) {
    return { ok: false, diagnostic: parseFailedDiagnostic(docId, err) };
  }
}

function rejection(
  reason: string,
  diagnostics: readonly Diagnostic[],
  current?: unknown,
): WriteResult {
  return {
    ok: false,
    rejection: {
      reason,
      ...(current !== undefined ? { current } : {}),
      diagnostics,
    },
  };
}

function blocksOf(parsed: ParsedDoc): Block[] {
  return parsed.nodes.filter((n): n is Block => "blockId" in n);
}

/** EMIT: append one commit's drafts, stamped with their shared commit info. */
async function emit(
  deps: PipelineDeps,
  docId: DocId,
  version: string,
  drafts: readonly EventDraft[],
): Promise<{ records: EventRecord[]; appended: boolean }> {
  const sink = deps.storage.defaultEventSink?.();
  if (sink === undefined) return { records: [], appended: false };
  if (drafts.length === 0) return { records: [], appended: true };
  const id = (deps.commitId ?? defaultCommitId)(docId, version);
  const records: EventRecord[] = [];
  for (const draft of stampCommit(drafts, id)) records.push(await sink.append(draft));
  return { records, appended: true };
}

/** Validate parsed content and apply bounded-history truncation, returning the final source. */
function validateAndTruncate(
  deps: PipelineDeps,
  docId: DocId,
  src: string,
): { ok: true; src: string } | { ok: false; diagnostics: readonly Diagnostic[] } {
  const attempt = tryParseDoc(src, deps.parseOptions, docId);
  if (!attempt.ok) return { ok: false, diagnostics: [attempt.diagnostic] };
  const parsed = attempt.parsed;
  const diagnostics: Diagnostic[] = [...parsed.diagnostics];
  for (const node of blocksOf(parsed)) {
    const type = deps.blockTypes.get(node.type);
    if (type !== undefined) for (const d of validateBlock(type, node.attrs)) diagnostics.push(d);
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  // Bounded history: rewrite any block whose history attr exceeds its bound.
  // Blocks are processed by descending span start so each patch only shifts
  // bytes at or after its own span — earlier spans stay valid (no drift).
  let current = src;
  const candidates = blocksOf(parsed)
    .filter((node) => {
      const type = deps.blockTypes.get(node.type);
      return type?.history !== undefined;
    })
    .sort((a, b) => (b.span?.start ?? 0) - (a.span?.start ?? 0));
  for (const node of candidates) {
    const type = deps.blockTypes.get(node.type);
    if (type?.history === undefined) continue;
    const enforced = enforceHistory(type, node.attrs);
    if (enforced.diagnostics.length > 0) return { ok: false, diagnostics: enforced.diagnostics };
    if (equal(enforced.attrs, node.attrs)) continue;
    const delta: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(node.attrs), ...Object.keys(enforced.attrs)])) {
      if (!equal(node.attrs[key], enforced.attrs[key])) {
        delta[key] = enforced.attrs[key];
      }
    }
    const { src: next, diagnostics: patchDiags } = applyPatch({ src: current, block: node, delta });
    if (patchDiags.length > 0) return { ok: false, diagnostics: patchDiags };
    current = next;
  }
  return { ok: true, src: current };
}

function diffAndEmitDrafts(
  deps: PipelineDeps,
  docId: DocId,
  before: string,
  after: string,
  writer: Writer,
): EventDraft[] {
  // A stored document over the size limit or a complexity limit is never
  // parsed (and one whose parse throws cannot be), so there is no tree to diff
  // a replacement against. The log records a reset instead: `doc.removed`
  // then `doc.created`, followed by the new content diffed from an empty
  // document. A consumer replaying the log drops the old state on
  // `doc.removed` and so ends with exactly the new document.
  const max = deps.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const beforeAttempt =
    exceedsDocumentLimit(before, max) ||
    complexityDiagnostic(docId, before, deps.complexityLimits, "read") !== undefined
      ? undefined
      : tryParseDoc(before, deps.parseOptions, docId);
  const reset = beforeAttempt === undefined || !beforeAttempt.ok;
  const beforeParsed = reset ? parseDoc("", deps.parseOptions) : beforeAttempt.parsed;
  // The new content was parsed (or checked) before it was stored. Should its
  // parse throw here anyway, the commit has landed: record the reset alone.
  const afterAttempt = tryParseDoc(after, deps.parseOptions, docId);
  if (!afterAttempt.ok) {
    return [
      { t: deps.clock(), type: "doc.removed", docId, by: writer },
      { t: deps.clock(), type: "doc.created", docId, by: writer },
    ];
  }
  const diff = diffDocs(beforeParsed, afterAttempt.parsed);
  const drafts = synthesizeEvents(diff, docId, {
    clock: deps.clock,
    blockTypes: deps.blockTypes,
    writer,
  });
  if (!reset) return drafts;
  return [
    { t: deps.clock(), type: "doc.removed", docId, by: writer },
    { t: deps.clock(), type: "doc.created", docId, by: writer },
    ...drafts,
  ];
}

async function withLock<T>(deps: PipelineDeps, docId: DocId, fn: () => Promise<T>): Promise<T> {
  const lock = deps.storage.defaultLock?.(docId);
  if (lock === undefined) return fn();
  return lock.withLock(fn);
}

/** Run the pipeline body through the write middleware chain (amend/reject/observe). */
async function withWriteMiddleware(
  deps: PipelineDeps,
  ctx: WriteCtx,
  body: () => Promise<WriteResult>,
): Promise<WriteResult> {
  const middlewares = deps.middleware;
  if (middlewares === undefined || middlewares.length === 0) return body();
  try {
    await compose(middlewares)(ctx, async () => {
      ctx.result = await body();
    });
    return ctx.result as WriteResult;
  } catch (err) {
    if (err instanceof WriteRejection) {
      return { ok: false, rejection: { reason: err.message, diagnostics: err.diagnostics } };
    }
    throw err;
  }
}

/**
 * Full-text write through the commit pipeline: VALIDATE → LOCK → COMMIT →
 * DIFF → EMIT. Rejects missing documents and stale versions; an absent
 * `expectedVersion` means last-writer-wins.
 * @param deps The injected pipeline dependencies (storage, clock, block types, …).
 * @param docId The document to replace.
 * @param writer The write's author (audit provenance).
 * @param fullText The new full source text.
 * @param guards Optional compare-and-set guard (`expectedVersion`).
 * @returns The write result, including the new version and appended events on success.
 */
export async function writeDoc(
  deps: PipelineDeps,
  docId: DocId,
  writer: Writer,
  fullText: string,
  guards: { readonly expectedVersion?: string } = {},
): Promise<WriteResult> {
  if (deps.policy?.canWrite && !deps.policy.canWrite(writer, docId, "full")) {
    return rejection("write-domain", [
      diagnostic("E_WRITE_DOMAIN", `writer not allowed: ${docId}`),
    ]);
  }
  const ctx: WriteCtx = { docId, writer, mode: "full", proposed: { fullText } };
  return withLock(deps, docId, () =>
    withWriteMiddleware(deps, ctx, async () => {
      const text = (ctx.proposed as { fullText: string }).fullText;
      const current = await deps.storage.read(docId);
      if (current === undefined) {
        return rejection("missing-doc", [
          diagnostic("E_DOC_MISSING", `document not found: ${docId}`),
        ]);
      }
      if (decideFullText(docVersion(current), guards) === "reject") {
        return rejection("stale-version", [], docVersion(current));
      }
      const overLimit = parseLimitRejection(deps, docId, text, "write");
      if (overLimit !== undefined) return overLimit;
      const validated = validateAndTruncate(deps, docId, text);
      if (!validated.ok) return rejection("validation", validated.diagnostics);
      const grown = parseLimitRejection(deps, docId, validated.src, "write");
      if (grown !== undefined) return grown;
      await deps.storage.writeAtomic(docId, validated.src);
      const drafts = diffAndEmitDrafts(deps, docId, current, validated.src, writer);
      const version = docVersion(validated.src);
      const { records, appended } = await emit(deps, docId, version, drafts);
      return {
        ok: true,
        version,
        events: records,
        eventsAppended: appended,
      };
    }),
  );
}

/**
 * Patch write: apply an attrs delta to one block through the same commit
 * pipeline, with compare-and-set guards (version and/or expected attr values).
 *
 * `delta` is either a concrete top-level attrs delta (shallow merge; arrays
 * replaced wholesale) or a {@link PatchDeltaFn} invoked **inside the lock**
 * against the freshly-read current attrs — so a function delta always decodes
 * against committed truth. Concrete deltas keep the classic value-CAS rules
 * ({@link decidePatch}); function deltas use the scoped rebase comparison
 * ({@link decideFunctionPatch}), which lets disjoint concurrent changes commute.
 *
 * `origin` marks the patch as intent-originated: the affordance name and its
 * params travel on the middleware proposal, so a host policy can decide on
 * *what the write means* instead of an opaque function. Inside the lock the
 * affordance is looked up on the block type (unknown → `unknown-affordance`)
 * and the proposal's params — including an amendment a middleware made — are
 * validated against its schema before the delta is decoded with them.
 *
 * @param deps The injected pipeline dependencies.
 * @param docId The document containing the block.
 * @param blockId The block whose attrs change.
 * @param delta The top-level attrs delta, or a function computing it from the current attrs and params.
 * @param writer The write's author (audit provenance).
 * @param guards Optional compare-and-set guards.
 * @param origin The intent origin (affordance name and its params) for an intent-decoded patch; absent for a direct patch.
 * @returns The write result, including the new version and appended events on success.
 */
export async function patchDoc(
  deps: PipelineDeps,
  docId: DocId,
  blockId: BlockId,
  delta: Record<string, unknown> | PatchDeltaFn,
  writer: Writer,
  guards: PatchGuards = {},
  origin?: { readonly affordance: string; readonly params?: unknown },
): Promise<WriteResult> {
  if (deps.policy?.canWrite && !deps.policy.canWrite(writer, docId, "patch")) {
    return rejection("write-domain", [
      diagnostic("E_WRITE_DOMAIN", `writer not allowed: ${docId}`),
    ]);
  }
  const ctx: WriteCtx = {
    docId,
    writer,
    mode: "patch",
    proposed: {
      blockId,
      delta,
      ...(origin !== undefined
        ? {
            affordance: origin.affordance,
            ...(origin.params !== undefined ? { params: origin.params } : {}),
          }
        : {}),
    },
  };
  return withLock(deps, docId, () =>
    withWriteMiddleware(deps, ctx, async () => {
      const proposed = ctx.proposed as {
        blockId: BlockId;
        delta: Record<string, unknown> | PatchDeltaFn;
        affordance?: string;
        params?: unknown;
      };
      const current = await deps.storage.read(docId);
      if (current === undefined) {
        return rejection("missing-doc", [
          diagnostic("E_DOC_MISSING", `document not found: ${docId}`),
        ]);
      }
      const storedOverLimit = parseLimitRejection(deps, docId, current, "read");
      if (storedOverLimit !== undefined) return storedOverLimit;
      const currentAttempt = tryParseDoc(current, deps.parseOptions, docId);
      if (!currentAttempt.ok) return rejection("validation", [currentAttempt.diagnostic]);
      const currentParsed = currentAttempt.parsed;
      const block = blocksOf(currentParsed).find((b) => b.blockId === proposed.blockId);
      if (block === undefined) {
        return rejection("missing-block", [
          diagnostic("E_BLOCK_MISSING", `block not found: ${proposed.blockId}`, {
            nodeId: proposed.blockId,
          }),
        ]);
      }
      const type = deps.blockTypes.get(block.type);
      if (type === undefined) {
        return rejection("unknown-type", [
          diagnostic("E_UNKNOWN_BLOCK_TYPE", `unregistered block type: ${block.type}`),
        ]);
      }

      // An intent-originated patch names its affordance on the proposal: resolve
      // it against the block type here (after middleware ran) so an amended
      // affordance/params pair is checked exactly like the original one.
      if (proposed.affordance !== undefined) {
        const affordance = type.affordances?.find((a) => a.name === proposed.affordance);
        if (affordance === undefined) {
          return rejection("unknown-affordance", [
            diagnostic(
              "E_UNKNOWN_AFFORDANCE",
              `block ${block.type} has no affordance "${proposed.affordance}"`,
              { nodeId: proposed.blockId },
            ),
          ]);
        }
        if (affordance.params !== undefined) {
          const paramsDiags = validateParams(affordance.params, proposed.params);
          if (paramsDiags.length > 0) return rejection("validation", paramsDiags);
        }
      }

      // Decode inside the lock: a function delta recomputes against the
      // freshly-read current attrs (and the proposal's params, as middleware
      // left them), so no writer applies a stale precomputation.
      const isFunctionDelta = typeof proposed.delta === "function";
      const resolvedDelta: Record<string, unknown> =
        typeof proposed.delta === "function"
          ? proposed.delta(block.attrs, proposed.params)
          : proposed.delta;

      // VALIDATE the merged attrs (shallow merge; arrays replaced wholesale).
      const merged: Record<string, unknown> = { ...block.attrs, ...resolvedDelta };
      const diagnostics = [...validateBlock(type, merged)];
      if (diagnostics.length > 0) return rejection("validation", diagnostics);

      const enforced = enforceHistory(type, merged);
      if (enforced.diagnostics.length > 0) return rejection("validation", enforced.diagnostics);

      const currentVersion = docVersion(current);
      const decision = isFunctionDelta
        ? decideFunctionPatch(currentVersion, block.attrs, resolvedDelta, guards)
        : decidePatch(currentVersion, block.attrs, guards);
      if (decision.kind === "reject") {
        return rejection(
          decision.reason === "stale-version" ? "stale-version" : "expected-mismatch",
          [],
          block.attrs,
        );
      }

      const effectiveDelta: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(block.attrs), ...Object.keys(enforced.attrs)])) {
        if (!equal(block.attrs[key], enforced.attrs[key])) {
          effectiveDelta[key] = enforced.attrs[key];
        }
      }

      const { src, diagnostics: patchDiags } = applyPatch({
        src: current,
        block,
        delta: effectiveDelta,
      });
      if (patchDiags.length > 0) return rejection("patch", patchDiags);
      const overLimit = parseLimitRejection(deps, docId, src, "write");
      if (overLimit !== undefined) return overLimit;

      await deps.storage.writeAtomic(docId, src);
      const drafts = diffAndEmitDrafts(deps, docId, current, src, writer);
      const version = docVersion(src);
      const { records, appended } = await emit(deps, docId, version, drafts);
      return {
        ok: true,
        version,
        ...(decision.kind === "apply" && decision.rebased ? { rebased: true } : {}),
        events: records,
        eventsAppended: appended,
      };
    }),
  );
}

/**
 * Create a new document (rejects an existing id with `exists`), emitting a
 * `doc.created` event on success. Like `writeDoc`/`patchDoc`, it runs the
 * write-domain policy check (`mode: "create"`) and the write middleware chain;
 * middleware may amend `proposed.content` before commit or reject the create.
 * @param deps The injected pipeline dependencies.
 * @param docId The id of the document to create.
 * @param writer The write's author (audit provenance).
 * @param content The document's initial source text.
 * @returns The write result, including the new version and the `doc.created` event on success.
 */
export async function createDoc(
  deps: PipelineDeps,
  docId: DocId,
  writer: Writer,
  content: string,
): Promise<WriteResult> {
  if (deps.policy?.canWrite && !deps.policy.canWrite(writer, docId, "create")) {
    return rejection("write-domain", [
      diagnostic("E_WRITE_DOMAIN", `writer not allowed: ${docId}`),
    ]);
  }
  const ctx: WriteCtx = { docId, writer, mode: "create", proposed: { content } };
  return withLock(deps, docId, () =>
    withWriteMiddleware(deps, ctx, async () => {
      const proposed = ctx.proposed as { content: string };
      const existing = await deps.storage.read(docId);
      if (existing !== undefined) {
        return rejection("exists", [
          diagnostic("E_DOC_EXISTS", `document already exists: ${docId}`),
        ]);
      }
      const overLimit = parseLimitRejection(deps, docId, proposed.content, "write");
      if (overLimit !== undefined) return overLimit;
      const validated = validateAndTruncate(deps, docId, proposed.content);
      if (!validated.ok) return rejection("validation", validated.diagnostics);
      const grown = parseLimitRejection(deps, docId, validated.src, "write");
      if (grown !== undefined) return grown;
      await deps.storage.writeAtomic(docId, validated.src);
      const version = docVersion(validated.src);
      const { records, appended } = await emit(deps, docId, version, [
        { t: deps.clock(), type: "doc.created", docId, by: writer },
      ]);
      return {
        ok: true,
        version,
        events: records,
        eventsAppended: appended,
      };
    }),
  );
}

/** Options for {@link importDoc}. */
export interface ImportOptions {
  /**
   * Store content over `maxDocumentBytes` too. The document is then stored but
   * never parsed: its projection is `ok: false` with `E_DOCUMENT_TOO_LARGE`,
   * as for one written outside the engine. Default `false`.
   */
  readonly ignoreSizeLimit?: boolean;
}

/**
 * Import a document: store `content` byte for byte under a new id and emit
 * `doc.created` with `imported: true`. This is the restore path for a trash
 * or an undo, which must put back exactly what was there, including content
 * `createDoc` would reject (attrs that fail their schema, a document over a
 * complexity limit) or rewrite (bounded-history truncation).
 *
 * It skips content validation, history truncation and the complexity limits.
 * Everything else a commit does still runs: the write policy (mode
 * `"import"`), the document lock, the write middleware (mode `"import"`,
 * proposal `{ content }`), the self-echo record and the event. Middleware may
 * observe or reject an import but not change its bytes: an amended proposal
 * rejects the import with `import-amended`. Content over `maxDocumentBytes` is
 * rejected with `too-large` unless `opts.ignoreSizeLimit` is set. An existing
 * id is rejected with `exists`.
 * @param deps The injected pipeline dependencies.
 * @param docId The id of the document to import.
 * @param writer The write's author (audit provenance).
 * @param content The exact bytes to store.
 * @param opts `ignoreSizeLimit` to store content over the size limit.
 * @returns The write result, including the `doc.created` event on success.
 */
export async function importDoc(
  deps: PipelineDeps,
  docId: DocId,
  writer: Writer,
  content: string,
  opts: ImportOptions = {},
): Promise<WriteResult> {
  if (deps.policy?.canWrite && !deps.policy.canWrite(writer, docId, "import")) {
    return rejection("write-domain", [
      diagnostic("E_WRITE_DOMAIN", `writer not allowed: ${docId}`),
    ]);
  }
  const ctx: WriteCtx = { docId, writer, mode: "import", proposed: { content } };
  return withLock(deps, docId, () =>
    withWriteMiddleware(deps, ctx, async () => {
      const proposed = ctx.proposed as { content?: unknown };
      if (proposed.content !== content || Object.keys(proposed).length !== 1) {
        return rejection("import-amended", [
          diagnostic(
            "E_IMPORT_AMENDED",
            `write middleware amended an import of ${docId}; an import stores its bytes as given`,
          ),
        ]);
      }
      const existing = await deps.storage.read(docId);
      if (existing !== undefined) {
        return rejection("exists", [
          diagnostic("E_DOC_EXISTS", `document already exists: ${docId}`),
        ]);
      }
      if (opts.ignoreSizeLimit !== true) {
        const tooLarge = sizeRejection(deps, docId, content, "write");
        if (tooLarge !== undefined) return tooLarge;
      }
      await deps.storage.writeAtomic(docId, content);
      const version = docVersion(content);
      const { records, appended } = await emit(deps, docId, version, [
        { t: deps.clock(), type: "doc.created", docId, by: writer, imported: true },
      ]);
      return { ok: true, version, events: records, eventsAppended: appended };
    }),
  );
}

/**
 * Remove a document (rejects a missing id with `missing-doc`, and a Storage
 * without `delete` with `unsupported`), emitting a `doc.removed` event on
 * success. Like `writeDoc`/`patchDoc`, it runs the write-domain policy check
 * (`mode: "remove"`) and the write middleware chain; a removal has no content,
 * so `proposed` is `{}` and middleware can only observe or reject it.
 * @param deps The injected pipeline dependencies.
 * @param docId The id of the document to remove.
 * @param writer The write's author (audit provenance).
 * @returns The write result, including the `doc.removed` event on success.
 */
export async function removeDoc(
  deps: PipelineDeps,
  docId: DocId,
  writer: Writer,
): Promise<WriteResult> {
  if (deps.policy?.canWrite && !deps.policy.canWrite(writer, docId, "remove")) {
    return rejection("write-domain", [
      diagnostic("E_WRITE_DOMAIN", `writer not allowed: ${docId}`),
    ]);
  }
  const ctx: WriteCtx = { docId, writer, mode: "remove", proposed: {} };
  return withLock(deps, docId, () =>
    withWriteMiddleware(deps, ctx, async () => {
      const existing = await deps.storage.read(docId);
      if (existing === undefined) {
        return rejection("missing-doc", [
          diagnostic("E_DOC_MISSING", `document not found: ${docId}`),
        ]);
      }
      if (deps.storage.delete === undefined) {
        return rejection("unsupported", [
          diagnostic("E_UNSUPPORTED", "storage does not support delete"),
        ]);
      }
      await deps.storage.delete(docId);
      // `version` is the removed content's hash: the last committed state.
      const version = docVersion(existing);
      const { records, appended } = await emit(deps, docId, version, [
        { t: deps.clock(), type: "doc.removed", docId, by: writer },
      ]);
      return { ok: true, version, events: records, eventsAppended: appended };
    }),
  );
}
