import type { MergedTree } from "../link/merge.js";
import type { Diagnostic } from "../model/diagnostic.js";
import type { ParsedDoc } from "../model/doc.js";
import type { BlockId, DocId } from "../model/ids.js";
import type { SourceValue } from "../ports/ports.js";
import type { PatchDeltaFn, WriteMode, WriteResult, Writer } from "../write/pipeline.js";

/**
 * Middleware chains: ecosystem code adds behavior along the two pipelines
 * without bypassing stages. Koa-style `(ctx, next)` composition — code before
 * `await next()` runs on the way in, code after on the way out. Middleware may
 * amend, reject, observe, and transform; it may not bypass stages (there is no
 * hook between LOCK and COMMIT, by design).
 */

/**
 * The proposal a write carries into the middleware chain, discriminated by mode.
 * A full-text write is `{ fullText }`; a patch is `{ blockId, delta }`; a create
 * is `{ content }` (the initial source text); an import is `{ content }` too
 * (the bytes to store, which middleware may read but not amend); a remove is
 * `{}` (nothing to amend — the target is `docId`).
 *
 * A patch that originated in an Intent also carries its origin — the
 * `affordance` name and the intent's `params` — so a host policy can see *what
 * the write means* ("transition to executed") rather than only an opaque
 * {@link PatchDeltaFn}. Those two fields are mutable: middleware may amend
 * `params` before `next()`, and the pipeline re-validates the amended params
 * against the affordance's schema before decoding the delta with them.
 * Amending `params` is the supported amendment; amending `affordance` only
 * re-targets the lookup the pipeline validates against (an unknown name
 * rejects the write) — the delta function itself is the one the route built.
 * Clearing `affordance` (setting it to `undefined`) skips that lookup and the
 * params validation entirely, while the delta still runs with `proposed.params`
 * as the chain left them: a middleware that clears it takes responsibility for
 * those params (block-level VALIDATE still runs on the resulting attrs).
 */
export type WriteProposal =
  | { readonly fullText: string }
  | {
      readonly blockId: BlockId;
      readonly delta: Record<string, unknown> | PatchDeltaFn;
      /** The affordance the patch decodes (intent-originated patches only). */
      affordance?: string;
      /** The affordance's params; amendable before `next()` and re-validated. */
      params?: unknown;
    }
  | { readonly content: string }
  | Record<string, never>;

/**
 * What {@link WriteCtx.parse} returns: the parse of the source, or the
 * rejection the commit pipeline gives a write of that source when it cannot be
 * parsed. The rejection has the shape of a rejected {@link WriteResult}, so a
 * middleware can pass it on with
 * `throw new WriteRejection(r.rejection.reason, r.rejection.diagnostics)`.
 */
export type WriteParseResult =
  | {
      /** True when the source was parsed. */
      readonly ok: true;
      /**
       * The parse. It may be the engine's cached parse, shared with every
       * reader: its block attrs are frozen, and it must not be modified.
       */
      readonly parsed: ParsedDoc;
    }
  | {
      /** False when the source was not parsed. */
      readonly ok: false;
      /** Why the source was not parsed. */
      readonly rejection: {
        /**
         * `too-large` (over `maxDocumentBytes`) and `too-complex` (over a
         * complexity limit) are found before any parse; `validation` means the
         * parser threw (`E_PARSE_FAILED`).
         */
        readonly reason: "too-large" | "too-complex" | "validation";
        /** The diagnostics explaining it. */
        readonly diagnostics: readonly Diagnostic[];
      };
    };

/** Per-write middleware context: mutable proposal before `next()`, result after. */
export interface WriteCtx {
  /** The document being written. */
  readonly docId: DocId;
  /** The write's author. */
  readonly writer: Writer;
  /** Which write mode is running (`full`, `patch`, `create`, `remove`, or `import`). */
  readonly mode: WriteMode;
  /**
   * The proposed change; mutable before `next()` (amend or reject). For a
   * full-text write it is `{ fullText }`; for a patch it is `{ blockId, delta }`
   * plus `{ affordance, params }` when the patch came from an Intent; for a
   * create it is `{ content }` (the initial source text); for an import it is
   * `{ content }`, which may be read but not amended (an amended import is
   * rejected with `import-amended`); for a remove it is
   * `{}` (a removal has nothing to amend — the target is `docId`). Amending an
   * intent's `params` re-decodes and re-validates the patch inside the lock.
   */
  proposed: WriteProposal;
  /** Populated by the pipeline after `next()`. */
  result?: WriteResult;
  /**
   * Parse a source the way the commit pipeline does, for a middleware that
   * needs the proposed text's structure (its blocks, sections or refs).
   *
   * The size limit and the complexity limits are checked first, and a source
   * over one is not parsed. In an engine the parse goes through the engine's
   * content-keyed parse cache, and the pipeline reuses a parse of the exact
   * text it validates: a middleware that parses `proposed.fullText` (or a
   * create's `proposed.content`) costs the write no second parse. A source
   * that is already cached is returned without parsing or checking it again.
   * Amending the proposal after parsing it leaves the amended text to be
   * parsed by the pipeline.
   *
   * It never throws for the source's content: a source that cannot be parsed
   * returns the rejection a write of it would get.
   * @param src The source to parse, usually the proposed text.
   * @returns The parse, or why the source was not parsed.
   */
  readonly parse: (src: string) => WriteParseResult;
}

/**
 * Write-pipeline middleware (Koa-style `(ctx, next)`). Throwing a
 * {@link WriteRejection} before `next()` rejects the write.
 * @param ctx The mutable write context (amend `proposed` before, read `result` after).
 * @param next Calls the next middleware (or the pipeline itself).
 * @returns A promise that settles when the chain settles.
 */
export type WriteMiddleware = (ctx: WriteCtx, next: () => Promise<void>) => Promise<void>;

/**
 * Per-projection middleware context. Before `next()` middleware may amend
 * `options` (the projector's options); after `next()` it may read or transform
 * `output`. `merged` and `values` are read-only — the merged tree and its
 * resolved values are shared, structural inputs.
 */
export interface ProjectionCtx {
  /** The document being projected. */
  readonly docId: DocId;
  /** The projector's id. */
  readonly projectorId: string;
  /** The merged include tree, shared with the projector's `options.merged`. */
  readonly merged: MergedTree;
  /** Resolved source values for every reachable document's refs. */
  readonly values: ReadonlyMap<string, SourceValue>;
  /** Projector options; mutable before `next()` (amend). */
  options: Record<string, unknown>;
  /** The projector's result; mutable after `next()` (transform). */
  output?: unknown;
}

/**
 * Projection-pipeline middleware (Koa-style `(ctx, next)`). Throwing a
 * {@link WriteRejection} before `next()` degrades the projection to the
 * projector's `degrade` output (the raw source when it declares none) with
 * the rejection's diagnostics attached. Output written after `next()` is not
 * checked: for an html projector, keeping it safe is the middleware's job.
 * @param ctx The mutable projection context (amend `options` before, transform `output` after).
 * @param next Calls the next middleware (or the projector itself).
 * @returns A promise that settles when the chain settles.
 */
export type ProjectionMiddleware = (ctx: ProjectionCtx, next: () => Promise<void>) => Promise<void>;

/** Thrown by write middleware to reject the write with diagnostics (fail-soft). */
export class WriteRejection extends Error {
  /** The diagnostics to attach to the rejected result. */
  readonly diagnostics: readonly { code: string; message: string }[];

  /**
   * @param reason A short human-readable reason (becomes `rejection.reason`).
   * @param diagnostics Optional diagnostics to attach to the rejected result.
   */
  constructor(reason: string, diagnostics: readonly { code: string; message: string }[] = []) {
    super(reason);
    this.name = "WriteRejection";
    this.diagnostics = diagnostics;
  }
}

/**
 * Koa-style middleware composition: runs each middleware in order, so code
 * before `next()` runs on the way in and code after on the way out.
 * @param middlewares The middleware chain, in outermost-first order.
 * @returns A function that runs the chain against a context.
 */
export function compose<T>(
  middlewares: readonly ((ctx: T, next: () => Promise<void>) => Promise<void>)[],
): (ctx: T, next?: () => Promise<void>) => Promise<void> {
  return (ctx, next) => {
    let index = -1;
    const dispatch = (i: number): Promise<void> => {
      if (i <= index) return Promise.reject(new Error("middleware called next() more than once"));
      index = i;
      const middleware = middlewares[i];
      if (middleware === undefined) return Promise.resolve(next?.() ?? Promise.resolve());
      return Promise.resolve(middleware(ctx, () => dispatch(i + 1)));
    };
    return dispatch(0);
  };
}

/**
 * Build the `{ blockId, delta }` shape a patch write's middleware context uses
 * for its `proposed` field. Intent-originated patches add `affordance`/`params`
 * to that shape; this helper builds the plain, concrete-delta form.
 * @param blockId The block being patched.
 * @param delta The attrs delta.
 * @returns The proposal payload.
 */
export function patchProposal(
  blockId: BlockId,
  delta: Record<string, unknown>,
): { blockId: BlockId; delta: Record<string, unknown> } {
  return { blockId, delta };
}
