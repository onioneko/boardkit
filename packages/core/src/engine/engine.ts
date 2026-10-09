import { randomUUID } from "node:crypto";
import type { AnyBlockType } from "../blocks/types.js";
import { applyIntent as applyIntentRoute, type Intent } from "../intent/apply.js";
import {
  buildReverseIndex,
  type LinkResult,
  type ResolvedInclude,
  resolveIncludes,
} from "../link/graph.js";
import {
  buildMergedTree,
  type IncludeLimits,
  type MergedNode,
  type MergedTree,
  resolveIncludeLimits,
  resolveMergedValues,
} from "../link/merge.js";
import {
  compose,
  type ProjectionCtx,
  type ProjectionMiddleware,
  type WriteMiddleware,
  WriteRejection,
} from "../middleware/compose.js";
import type { Diagnostic } from "../model/diagnostic.js";
import { diagnostic } from "../model/diagnostic.js";
import type { Block, ParsedDoc } from "../model/doc.js";
import { asDocId, type DocId, tryBlockId, tryDocId } from "../model/ids.js";
import {
  type ComplexityLimits,
  documentComplexityDiagnostic,
  resolveComplexityLimits,
} from "../parse/complexity.js";
import type { ParseOptions } from "../parse/options.js";
import { bindChunkCache, parseDoc } from "../parse/pipeline.js";
import {
  documentSizeDiagnostic,
  exceedsDocumentLimit,
  resolveMaxDocumentBytes,
  sizeOverLimit,
} from "../parse/size.js";
import type {
  Clock,
  EventDraft,
  EventRecord,
  EventSink,
  Lock,
  Source,
  SourceValue,
  Storage,
} from "../ports/ports.js";
import { textProjector } from "../project/text.js";
import { createChokidarSource } from "../watch/chokidar.js";
import { createExternalWriteHandler, type ExternalWriteOutcome } from "../watch/external-write.js";
import type { WatchSource } from "../watch/source.js";
import {
  type CommitEffect,
  createDoc as createDocPipeline,
  importDoc as importDocPipeline,
  type PipelineDeps,
  patchDoc as patchDocPipeline,
  removeDoc as removeDocPipeline,
  type WriteResult,
  type Writer,
  writeDoc as writeDocPipeline,
} from "../write/pipeline.js";
import { type DocInfo, summarizeDoc } from "./doc-info.js";
import { createParseCache } from "./parse-cache.js";
import { docVersion } from "./version.js";

/**
 * Engine assembly: the composition root wiring storage, clock, block types,
 * projectors, and write policy into the pipelines. The read path runs LOAD →
 * PARSE → LINK → MERGE → RESOLVE → PROJECT: LINK resolves the include graph,
 * MERGE builds the merged tree (cached per content-hash set), and RESOLVE
 * values every reachable document's source refs per projection through the
 * call-scoped Source — the merge cache holds only the tree, never
 * resolved values. The merged tree is handed to projectors through
 * `options.merged` (projectors that ignore it are unaffected).
 */

export type { DocInfo } from "./doc-info.js";

/** Bound for the engine-internal merge cache (a bounded FIFO Map). */
const MERGE_CACHE_MAX = 64;

/** Projector options: an open, read-only bag of option values. */
export type ProjectionOptions = Readonly<Record<string, unknown>>;

/** The typed input handed to a projector on every projection call. */
export interface ProjectionInput {
  /** The parsed document being projected. */
  readonly doc: ParsedDoc;
  /** The document's raw source. */
  readonly src: string;
  /** Resolved live values, keyed by canonical key. */
  readonly values: ReadonlyMap<string, SourceValue>;
  /** The merged include tree (set by the engine's MERGE stage); expands includes when present. */
  readonly merged?: MergedTree;
  /** Registered block types, keyed by type name. */
  readonly blockTypes: ReadonlyMap<string, AnyBlockType>;
  /** Projection options (the engine's own plus any the caller supplied). */
  readonly options: ProjectionOptions;
  /**
   * Report a non-fatal problem found while projecting — for instance a block
   * whose hook threw and was rendered as its verbatim source instead
   * (`ProjectionWalkBlock.hookError`). The engine always supplies it and adds
   * every reported diagnostic to the projection result; a host calling a
   * projector directly may leave it out.
   */
  readonly report?: (diagnostic: Diagnostic) => void;
}

/** A registered projector: an id plus a pure projection function. */
export interface Projector<T = unknown> {
  /** The projector's unique id, used as the second argument to `engine.projection`. */
  readonly id: string;
  /**
   * Render a document. The output type is unconstrained: the built-in `text`
   * projector (and `htmlProjector` from `@onioneko/boardkit-html`) are
   * `Projector<string>`, but a custom projector may return a react component
   * tree, an email body, terminal output, a pdf, or any other value — the
   * engine passes it through untouched.
   * @param input The projection inputs (doc, source, values, merged tree, block types, options).
   * @returns The projected output, or a promise of one.
   */
  project(input: ProjectionInput): T | Promise<T>;
  /**
   * The output to fall back to when the projection cannot complete: the
   * projector threw, or a projection middleware threw (a `WriteRejection` or
   * any other error). Without this hook the engine falls back to the raw
   * source text, which is right for a projector whose output *is* source
   * text (`text`) but wrong for one whose output is interpreted — raw
   * markdown handed to an HTML sink is unsanitized markup. A projector whose
   * output is rendered (html, a component tree) implements this to return
   * something inert built from `src`, such as the escaped source. It must not
   * throw; if it does, the projection's output is the empty string `""` —
   * whatever the projector's output type `T` — never the raw source, and the
   * error is reported as a second `E_PROJECTOR_ERROR`.
   * @param src The document's raw source.
   * @param diagnostics Why the projection degraded: the `E_PROJECTOR_ERROR`
   *   for a throwing projector, a `WriteRejection`'s own diagnostics, or the
   *   `E_MIDDLEWARE_ERROR` for any other error a projection middleware threw.
   * @returns The degraded output.
   */
  degrade?(src: string, diagnostics: readonly Diagnostic[]): T;
}

/**
 * External-write watching configuration. `EngineOptions.watch: true` resolves
 * the root from `storage.rootDir` (filesystem storage); an object enables it
 * with an explicit root and (optionally) a custom source and writer id.
 */
export interface WatchOptions {
  /** Workspace root: watcher paths are resolved to docIds relative to it. */
  readonly rootDir: string;
  /** Writer id stamped on external-write events (defaults to `"external"`). */
  readonly externalWriterId?: string;
  /** Custom watch source; defaults to chokidar watching the root's markdown files. */
  readonly source?: WatchSource;
}

/** Everything the engine needs at construction. */
export interface EngineOptions {
  /** Where document bytes live (required). */
  readonly storage: Storage;
  /** Timestamp source for events; defaults to the wall clock. */
  readonly clock?: Clock;
  /**
   * A lock override used for every write, ahead of `storage.defaultLock`. When
   * provided, all commits serialize through this one lock.
   */
  readonly lock?: Lock;
  /**
   * An event-sink override used for every append, ahead of
   * `storage.defaultEventSink`. Subscribers still receive events appended
   * through this sink.
   */
  readonly eventSink?: EventSink;
  /**
   * Projectors registered at construction. Defaults to `[textProjector]` — the
   * only built-in default. Passing this option *replaces* that default, so
   * include {@link textProjector} explicitly to keep it; every other projector
   * (`htmlProjector` from `@onioneko/boardkit-html`, or your own) is registered here or
   * through {@link Engine.registerProjector}.
   */
  readonly projectors?: readonly Projector[];
  /** Block types registered at construction; defaults to none. */
  readonly blocks?: readonly AnyBlockType[];
  /** Write-domain policy; absent means allow-all. */
  readonly writePolicy?: PipelineDeps["policy"];
  /**
   * Middleware chains: `write` wraps the whole commit pipeline
   * (amend/reject/observe), `projection` wraps the PROJECT stage's projector
   * call (amend `options` before, transform `output` after). Neither may bypass
   * pipeline stages. Absent or empty chains are no-ops.
   */
  readonly middleware?: {
    /** Write middleware, in outermost-first order. */
    readonly write?: readonly WriteMiddleware[];
    /** Projection middleware, in outermost-first order. */
    readonly projection?: readonly ProjectionMiddleware[];
  };
  /**
   * Parse options used throughout the engine. `blockTypes` is rarely needed:
   * types passed via {@link EngineOptions.blocks} or `engine.registerBlock` are
   * recognized as fences automatically. The option only adds extra fence names
   * on top of those (e.g. a fence whose type is not registered yet).
   */
  readonly parseOptions?: ParseOptions;
  /**
   * Bounds on include expansion per projection. The same document may be
   * included in several places (`{{include:x}}`, `{{include:x#s}}`, or through
   * different includers), and each place expands its own copy, so the merged
   * tree can grow much faster than the documents behind it. Includes are
   * admitted breadth-first (the board's own includes before anything nested in
   * them) against three bounds: `maxNodes` included documents or sections
   * (default 1,000), `maxBytes` of included source in UTF-8 (default 1 MiB),
   * and `maxDepth` levels of nesting (default 64); the board document itself
   * never counts. An include too large for the remaining `maxBytes` is skipped
   * on its own and later includes that fit are still expanded; the first
   * include past `maxNodes` or `maxDepth` stops expansion, together with every
   * include not yet admitted. Skipped includes stay verbatim `{{include:…}}`
   * text, documents reachable only through them are left out of the result's
   * `versions`, and each kind of miss adds one `E_INCLUDE_LIMIT` diagnostic
   * naming the first include it left out and the bound it hit. Each field is a
   * non-negative integer or
   * `Infinity`; any other value (or an unknown field) is a programming error
   * and throws a `TypeError` at construction.
   * @example
   * ```ts
   * createEngine({ storage, includeLimits: { maxNodes: 5_000 } });
   * ```
   */
  readonly includeLimits?: IncludeLimits;
  /**
   * The largest document the engine will store or parse, in UTF-8 bytes
   * (default `DEFAULT_MAX_DOCUMENT_BYTES`, 256 KiB). Parsing cost grows with
   * document size, faster than linearly for some markdown, so the limit
   * bounds the work one document can cause:
   * - a write (`write`, `patch`, `applyIntent`, `createDoc`, `importDoc`)
   *   whose result would exceed it is rejected with reason `too-large` and an
   *   `E_DOCUMENT_TOO_LARGE` diagnostic, and nothing is stored (`importDoc`
   *   with `ignoreSizeLimit: true` stores it anyway, unparsed);
   * - a stored document over it (written outside the engine) is never parsed:
   *   its projection comes back `ok: false` with that diagnostic, an include of
   *   it stays verbatim `{{include:…}}` text with that diagnostic, `getBlock`
   *   treats it as absent, patches and intents against it are rejected with
   *   reason `too-large`, and an external write of it is not evented. A
   *   full-text `write` that fits may still replace it.
   *
   * `getDoc` still returns its raw source. The value is a non-negative integer
   * or `Infinity`; anything else is a programming error and throws a
   * `TypeError` at construction.
   * @example
   * ```ts
   * createEngine({ storage, maxDocumentBytes: 4 * 1024 * 1024 });
   * ```
   */
  readonly maxDocumentBytes?: number;
  /**
   * Bounds on markdown shapes that are costly or unsafe to parse, checked by a
   * linear scan before any parse. Deep nesting is the worst case: the markdown
   * parser's time grows quadratically with the depth of nested containers or
   * emphasis, and a few thousand levels (a few KB) overflow the call stack.
   * On by default with {@link DEFAULT_COMPLEXITY_LIMITS} (32 container markers
   * on a line, 160 columns of prefix indentation, `[` nesting 32 deep in a
   * paragraph, delimiter runs of 64, emphasis nesting 256 deep in a paragraph;
   * fenced code is not counted for the last three);
   * an object overrides the fields it sets,
   * and `false` turns the check off. A document over any limit is treated
   * like one over {@link EngineOptions.maxDocumentBytes}, with an
   * `E_DOCUMENT_TOO_COMPLEX` diagnostic:
   * - a write (`write`, `patch`, `applyIntent`, `createDoc`) whose result
   *   exceeds a limit is rejected with reason `too-complex`, and nothing is
   *   stored (`importDoc` does not check these limits: it restores bytes as
   *   they were);
   * - a stored document over a limit is never parsed: its projection comes
   *   back `ok: false`, an include of it stays verbatim, `getBlock` treats it
   *   as absent, patches and intents against it are rejected with reason
   *   `too-complex`, and an external write of it is not evented. A full-text
   *   `write` within the limits may still replace it.
   *
   * The limits do not make every document cheap to parse: long lists and
   * dense inline markup within them still cost superlinear time, tens of
   * seconds near the default `maxDocumentBytes` (see the projections guide).
   * The scan only approximates the parser, so other input may still overflow
   * its stack; that is caught as described next.
   * Each field is a non-negative integer or `Infinity`; any other value (or
   * an unknown field) is a programming error and throws a `TypeError` at
   * construction. Whatever the limits, a parse that throws never escapes the
   * engine: writes are rejected with an `E_PARSE_FAILED` diagnostic and reads
   * degrade as above.
   * @example
   * ```ts
   * createEngine({ storage, complexityLimits: { maxContainerDepth: 64 } });
   * ```
   */
  readonly complexityLimits?: ComplexityLimits | false;
  /**
   * Enable external-write watching. `true` resolves the root from
   * `storage.rootDir` (set by filesystem storage); a {@link WatchOptions} object
   * pins `rootDir`/`source`/writer id. Absent or `false` disables watching.
   * `watch: true` with a storage that has no `rootDir` (e.g. `createMemStorage`)
   * is a programming error and throws a `TypeError` — pass a `WatchOptions`
   * object with an explicit `rootDir` (and a `source`) to watch a non-fs
   * workspace.
   */
  readonly watch?: boolean | WatchOptions;
  /**
   * Strict value-CAS for `patch` and `applyIntent`, on by default. A present
   * `expected` is then compared against the block's current attrs even when
   * `expectedVersion` is absent or current, and a mismatch is rejected with
   * `expected-mismatch`: a client whose version and values come from
   * different snapshots never overwrites values it did not see. `false`
   * restores the 0.1 rules, where `expected` is only consulted once the
   * version has moved. A call's own `strictExpected` (on `patch` options or
   * the {@link Intent}) overrides this.
   */
  readonly strictExpected?: boolean;
  /**
   * The engine's part of every commit id it mints (`CommitInfo.id` is
   * `<docId>@<version>#<prefix>.<n>`, with `n` counting this engine's commits
   * from 1). Absent, each engine draws a random 12-hex-digit prefix, so ids
   * stay unique in a log that several engines or restarts append to. Pin it
   * for reproducible ids (in tests, for example); a pinned prefix must then
   * differ between engines that share an event log, or their ids collide.
   */
  readonly commitIdPrefix?: string;
}

/** The result of one projection: output, diagnostics, and committed versions of reachable docs. */
export interface ProjectionResult<T = unknown> {
  /**
   * True when the projection produced output; false when it could not run at
   * all (a missing/invalid document, one over
   * {@link EngineOptions.maxDocumentBytes} or a
   * {@link EngineOptions.complexityLimits} limit, one whose parse threw, or an
   * unknown projector) and
   * `output` is the empty string with the reason carried in `diagnostics`.
   */
  readonly ok: boolean;
  /**
   * The projected output, passed through from the projector's return value
   * untouched (a string for the built-in `text` projector, but arbitrary — a
   * react component tree, an email body, terminal output, a pdf, …). The empty
   * string when `ok` is false. When the projection degrades (the projector
   * threw, or a projection middleware threw), `ok` stays true and
   * `output` is the projector's {@link Projector.degrade} result, or the raw
   * source text when the projector declares none; if `degrade` itself throws,
   * it is the empty string. The cause is carried in `diagnostics`.
   */
  readonly output: T;
  /** Parse/link/projection diagnostics (empty on a clean projection). */
  readonly diagnostics: readonly Diagnostic[];
  /**
   * Committed versions of the board and every document expanded into the
   * projection through includes (one cut off by `includeLimits`, or over
   * {@link EngineOptions.maxDocumentBytes}, is not).
   */
  readonly versions: Readonly<Record<string, string>>;
}

/** A neutral summary of the include/reference graph for one document (`engine.refGraph(docId)`). */
export interface RefGraph {
  /** Every reachable document id, the board first. */
  readonly docs: readonly DocId[];
  /** Every resolved include edge. */
  readonly includes: readonly ResolvedInclude[];
  /** Include-resolution diagnostics. */
  readonly diagnostics: readonly Diagnostic[];
}

/** The assembled engine: read projections, dual writes, events, and the open registries. */
export interface Engine {
  /**
   * Project one document through a projector. Fail-soft: a throwing projector
   * degrades to its {@link Projector.degrade} output (the raw source text when
   * it declares none) plus an `E_PROJECTOR_ERROR` diagnostic, and a projection
   * middleware that throws degrades the same way, with a
   * {@link WriteRejection}'s own diagnostics or, for any other error, an
   * `E_MIDDLEWARE_ERROR` diagnostic carrying its message. A document that
   * cannot be parsed (over a limit, or its parse threw) comes back `ok: false`
   * with a diagnostic. None of these throw out of this method; an error from
   * the storage port itself (an unreadable board) still does. A block whose
   * hook throws degrades alone: the built-in projectors render it as its
   * verbatim source and report `E_BLOCK_HOOK_ERROR`.
   * @typeParam T The projector's output type, asserted by the caller: the engine
   *   passes the projector's return value through untouched and does not check
   *   it. Defaults to `unknown`, which forces narrowing at the call site.
   * @param docId The document to project.
   * @param projectorId The projector to run: `"text"` out of the box, or any
   *   id registered through {@link EngineOptions.projectors} or
   *   {@link Engine.registerProjector}. An unregistered id is not an error —
   *   it comes back `ok: false` with an `E_UNKNOWN_PROJECTOR` diagnostic.
   * @param opts The Source port used to resolve `{{source:…}}` refs (optional —
   *   absent resolves no refs), plus any projector options.
   * @returns The projection output, diagnostics, and reachable-doc versions.
   * @example
   * ```ts
   * const r = await engine.projection<string>("fin", "text", { source });
   * r.output.length;
   * console.log(r.versions);
   * ```
   */
  projection<T = unknown>(
    docId: string,
    projectorId: string,
    opts: { readonly source?: Source; readonly options?: ProjectionOptions },
  ): Promise<ProjectionResult<T>>;
  /**
   * Replace a document's full text through the commit pipeline.
   * @param docId The document to replace.
   * @param opts The write's author, the new full source text, and an optional
   *   `expectedVersion` compare-and-set guard.
   * @returns The write result (new version and emitted events on success).
   * @example
   * ```ts
   * const result = await engine.write("fin", { writer, fullText: newText });
   * console.log(result.ok);
   * ```
   */
  write(
    docId: string,
    opts: { readonly writer: Writer; readonly fullText: string; readonly expectedVersion?: string },
  ): Promise<WriteResult>;
  /**
   * Apply an attrs delta to one block through the commit pipeline.
   * @param docId The document containing the block.
   * @param blockId The block whose attrs change.
   * @param opts The write's author, the top-level attrs delta (shallow merge;
   *   arrays replaced wholesale), and optional compare-and-set guards.
   * @returns The write result (new version and emitted events on success).
   * @example
   * ```ts
   * const result = await engine.patch("fin", "dec-macbook", {
   *   writer,
   *   attrs: { value: "approved" },
   * });
   * ```
   */
  patch(
    docId: string,
    blockId: string,
    opts: {
      readonly writer: Writer;
      readonly attrs: Record<string, unknown>;
      readonly expectedVersion?: string;
      readonly expected?: Record<string, unknown>;
      /** Override {@link EngineOptions.strictExpected} for this call. */
      readonly strictExpected?: boolean;
    },
  ): Promise<WriteResult>;
  /**
   * Decode an affordance and apply it as a patch with the intent's guards.
   * @param intent The request (doc, block, affordance, params, guards).
   * @param opts The write's author.
   * @returns The write result from the patch pipeline.
   * @example
   * ```ts
   * const result = await engine.applyIntent(
   *   {
   *     docId: "fin",
   *     blockId: "dec-macbook",
   *     affordance: "transition",
   *     params: { to: "approved" },
   *   },
   *   { writer },
   * );
   * ```
   */
  applyIntent(intent: Intent, opts: { readonly writer: Writer }): Promise<WriteResult>;
  /**
   * Create a new document (rejects an existing id), emitting `doc.created`.
   * @param docId The id of the document to create.
   * @param opts The write's author and the document's initial source text.
   * @returns The write result, including the `doc.created` event on success.
   */
  createDoc(
    docId: string,
    opts: { readonly writer: Writer; readonly content: string },
  ): Promise<WriteResult>;
  /**
   * Import a document: store `content` byte for byte under a new id and emit
   * `doc.created` with `imported: true`. This is the restore path for a trash
   * or an undo: unlike {@link Engine.createDoc} it skips content validation,
   * bounded-history truncation and {@link EngineOptions.complexityLimits}, so
   * a document that would fail them comes back exactly as it was and reports
   * its problems as diagnostics on read. Everything else a commit does still
   * runs: the write policy and write middleware (both with mode `"import"`;
   * middleware may observe or veto but not amend, which rejects with
   * `import-amended`), the document lock, the self-echo record for `watch`,
   * and the reverse-index and cache invalidation. Content over
   * {@link EngineOptions.maxDocumentBytes} is rejected with `too-large` unless
   * `ignoreSizeLimit` is set; then it is stored but never parsed, like a
   * document written outside the engine. An existing id is rejected with
   * `exists`. Subscribers that switch on the event type see a plain
   * `doc.created`; check `imported` to tell a restore from a create.
   * @param docId The id of the document to import.
   * @param opts The write's author, the exact bytes, and `ignoreSizeLimit`.
   * @returns The write result, including the `doc.created` event on success.
   * @example
   * ```ts
   * const r = await engine.importDoc("notes/q3", { writer, content: trashed.src });
   * ```
   */
  importDoc(
    docId: string,
    opts: {
      readonly writer: Writer;
      readonly content: string;
      readonly ignoreSizeLimit?: boolean;
    },
  ): Promise<WriteResult>;
  /**
   * Remove a document, emitting `doc.removed` (requires a Storage with `delete`).
   * @param docId The id of the document to remove.
   * @param opts The write's author.
   * @returns The write result, including the `doc.removed` event on success.
   */
  removeDoc(docId: string, opts: { readonly writer: Writer }): Promise<WriteResult>;
  /**
   * Read a document's raw source and its committed version.
   * @param docId The document to read.
   * @returns `{ src, version }`, or `undefined` when the document does not exist
   *   or the id is invalid (an invalid id is treated as absent, fail-soft).
   */
  getDoc(docId: string): Promise<{ readonly src: string; readonly version: string } | undefined>;
  /**
   * Read one block's committed attrs, its registered type name, and the owning
   * document's version.
   * @param docId The document containing the block.
   * @param blockId The block to read.
   * @returns `{ attrs, type, version }`, or `undefined` when the document or
   *   block does not exist (or either id is invalid, or the document is over
   *   {@link EngineOptions.maxDocumentBytes} or a
   *   {@link EngineOptions.complexityLimits} limit, or its parse threw —
   *   treated as absent, fail-soft).
   */
  getBlock(
    docId: string,
    blockId: string,
  ): Promise<
    | { readonly attrs: Record<string, unknown>; readonly type: string; readonly version: string }
    | undefined
  >;
  /**
   * Read a document's title, frontmatter, headings and blocks without parsing
   * it again: the summary is built from the engine's parse cache, so a document
   * the engine has written or projected costs no parse, and any other is parsed
   * once (and cached) like a projection would.
   *
   * The title is the frontmatter `title` when it is a non-blank string
   * (trimmed), otherwise the first non-empty level-1 heading (see
   * {@link DocInfo.title}). Headings carry their plain text without the
   * `{#anchor}`, and the anchor is the section id; ids are not guaranteed
   * unique.
   * @param docId The document to summarize.
   * @returns A copy of the summary (the cached parse is never handed out), or
   *   `undefined` when the document does not exist or the id is invalid, the
   *   document is over {@link EngineOptions.maxDocumentBytes} or a
   *   {@link EngineOptions.complexityLimits} limit, or its parse (or the copy
   *   of it) threw — treated as absent, fail-soft, like {@link Engine.getBlock}.
   * @example
   * ```ts
   * const ids = await engine.listDocs();
   * const titles = await Promise.all(ids.map(async (id) => (await engine.docInfo(id))?.title ?? id));
   * ```
   */
  docInfo(docId: string): Promise<DocInfo | undefined>;
  /** @returns Every document id currently in the workspace (sorted, untyped strings). */
  listDocs(): Promise<string[]>;
  /**
   * Stop the engine's watch source (a no-op when watching was never enabled).
   * After `close()`, external writes are no longer detected until a new engine
   * is created.
   * @returns A promise that settles once the watch source's closer has run.
   */
  close(): Promise<void>;
  /**
   * Handle one external-write notification. Resolves `undefined` when watching
   * is disabled (fail-soft), the path is outside `rootDir`, or it names a
   * non-markdown file. Self-echoes of the engine's own commits are suppressed;
   * anything else is evented as an external write.
   * @param watchPath The filesystem path the watcher reported.
   * @returns The outcome, or `undefined` when it does not apply.
   */
  externalWrite(watchPath: string): Promise<ExternalWriteOutcome | undefined>;
  /**
   * Subscribe to every event workspace-wide. The returned function unsubscribes.
   * @param handler Called synchronously with each appended event.
   * @returns An unsubscribe function.
   * @example
   * ```ts
   * const unsubscribe = engine.subscribe((evt) => console.log(evt.type));
   * // ... later, to stop receiving events:
   * unsubscribe();
   * ```
   */
  subscribe(handler: (evt: EventRecord) => void): () => void;
  /**
   * Subscribe to events for one document and everything it transitively
   * includes (its projection inputs). The handler fires for events whose
   * document is `docId` itself or any document `docId` includes. The returned
   * function unsubscribes.
   * @param docId The document to scope delivery to.
   * @param handler Called synchronously with each scoped event.
   * @returns An unsubscribe function.
   * @example
   * ```ts
   * const unsubscribe = engine.subscribe("fin", (evt) => console.log(evt.type));
   * ```
   */
  subscribe(docId: string, handler: (evt: EventRecord) => void): () => void;
  /**
   * Replay events after a cursor as an async iterable. Consume with
   * `for await`: it yields the sink's records with `seq > afterSeq` in
   * sequence order, or nothing when the sink has no `read` port or no newer
   * records.
   * @param opts The cursor; only records with a higher `seq` are yielded.
   * @returns An async iterable of the matching records.
   * @example
   * ```ts
   * let seen = 0;
   * for await (const evt of engine.events({ afterSeq: seen })) {
   *   seen = evt.seq;
   *   console.log(evt.type);
   * }
   * ```
   */
  events(opts: { readonly afterSeq: number }): AsyncIterable<EventRecord>;
  /**
   * Summarize the include/reference graph of one document.
   * @param docId The document whose include graph is summarized.
   * @returns The graph summary (`docs`/`includes`/`diagnostics`), or a graph
   *   with only an `E_INVALID_ID` diagnostic for an invalid id. A document over
   *   {@link EngineOptions.maxDocumentBytes} is not parsed: as the board it
   *   yields no `docs` and an `E_DOCUMENT_TOO_LARGE` diagnostic, and as an
   *   include target its edge is `missing-doc` with that diagnostic. A
   *   document over a {@link EngineOptions.complexityLimits} limit
   *   (`E_DOCUMENT_TOO_COMPLEX`), or whose parse throws (`E_PARSE_FAILED`),
   *   is treated the same way.
   */
  refGraph(docId: string): Promise<RefGraph>;
  /**
   * Register (or replace) a projector by id.
   * @param projector The projector to register.
   */
  registerProjector(projector: Projector): void;
  /**
   * Register (or replace) a block type by name. The type's name is added to the
   * live fence-recognition set, and because that changes how already-parsed
   * documents should read, the call invalidates the parse and merge caches: the
   * next projection re-parses every document, so fences of that type become
   * blocks (and its `sources`/`project` hooks take effect) without a rewrite.
   * @param block The block type to register.
   */
  registerBlock(block: AnyBlockType): void;
  /**
   * Register one write and/or one projection middleware at runtime, appended to
   * the end of each chain after anything provided via
   * {@link EngineOptions.middleware}; chains that were never configured start
   * empty. Appended write middleware wraps the whole commit pipeline
   * (amend/reject/observe) and appended projection middleware wraps the PROJECT
   * stage's projector call, exactly like construction-time middleware.
   * @param m The middleware to append (either or both chains).
   */
  use(m: { readonly write?: WriteMiddleware; readonly projection?: ProjectionMiddleware }): void;
}

/** A rejected WriteResult for an invalid boundary id (fail-soft, never throws). */
function invalidIdRejection(d: Diagnostic): WriteResult {
  return { ok: false, rejection: { reason: "invalid-id", diagnostics: [d] } };
}

/**
 * Resolve the watch root for `watch: true`: filesystem storage carries
 * `rootDir`; any other storage is a programming error (there is no directory to
 * watch), so a `TypeError` documents the requirement at construction time.
 * @param storage The engine's storage.
 * @returns A `WatchOptions` pinned to `storage.rootDir`.
 */
function resolveWatchTrue(storage: Storage): WatchOptions {
  const rootDir = storage.rootDir;
  if (rootDir === undefined) {
    throw new TypeError(
      "BoardKit: watch: true requires a storage with rootDir (set by createFsStorage). " +
        "Pass a WatchOptions object with an explicit rootDir (and source) to watch a non-filesystem workspace.",
    );
  }
  return { rootDir };
}

/** Each engine's include-index snapshot reader, for {@link includeIndexSnapshot}. */
const indexSnapshotReaders = new WeakMap<
  Engine,
  () => Promise<ReadonlyMap<DocId, readonly DocId[]>>
>();

/**
 * Test-only and read-only (not exported from the package): the reverse
 * include index the engine's next write would deliver against, brought up to
 * date first exactly as a write would (which may read storage, never write
 * it). Maps each included document to its direct includers, sorted. Tests
 * compare it with an index built from scratch over current storage.
 * @param engine An engine from {@link createEngine}.
 * @returns The index, or an empty map for an object that is not one.
 * @internal
 */
export async function includeIndexSnapshot(
  engine: Engine,
): Promise<ReadonlyMap<DocId, readonly DocId[]>> {
  return (await indexSnapshotReaders.get(engine)?.()) ?? new Map();
}

/**
 * Assemble an Engine from storage, optional clock, block types, projectors, and
 * write policy. The engine wires the read path (LOAD → PARSE → LINK → MERGE →
 * RESOLVE → PROJECT) and the write pipeline (VALIDATE → LOCK → COMMIT → DIFF →
 * EMIT) over the supplied ports, and starts watching if `opts.watch` is set.
 * @param opts The engine's configuration (only `storage` is required).
 * @returns The assembled engine.
 * @example
 * ```ts
 * const engine = createEngine({
 *   storage: createMemStorage(),
 *   blocks: starterBlocks,
 * });
 * ```
 */
export function createEngine(opts: EngineOptions): Engine {
  const clock = opts.clock ?? (() => new Date().toISOString());
  const projectors = new Map<string, Projector<unknown>>(
    (opts.projectors ?? [textProjector]).map((p) => [p.id, p]),
  );
  const blockTypes = new Map<string, AnyBlockType>((opts.blocks ?? []).map((b) => [b.type, b]));
  // Live fence-recognition set: the block type names whose fences
  // become Block nodes. Initialized from the union of explicit
  // `parseOptions.blockTypes` and the block registry, and kept live so a
  // runtime `registerBlock()` adds to it. The SAME Set instance is handed to
  // every parse option the pipelines use, so recognition never goes stale even
  // though `parseOptions` is fixed at construction.
  const fenceTypes = new Set<string>([
    ...(opts.parseOptions?.blockTypes ?? []),
    ...(opts.blocks ?? []).map((b) => b.type),
  ]);
  const parseOptions: ParseOptions = { ...(opts.parseOptions ?? {}), blockTypes: fenceTypes };
  const includeLimits = resolveIncludeLimits(opts.includeLimits);
  const maxDocumentBytes = resolveMaxDocumentBytes(opts.maxDocumentBytes);
  const complexityLimits = resolveComplexityLimits(opts.complexityLimits);
  const strictExpectedDefault = opts.strictExpected ?? true;
  /** The complexity diagnostic for a stored document, or `undefined` when within the limits or off. */
  const complexityOf = (id: DocId, src: string): Diagnostic | undefined =>
    complexityLimits === false
      ? undefined
      : documentComplexityDiagnostic(id, src, complexityLimits, "read");
  const watchOptions: WatchOptions | undefined =
    opts.watch === undefined || opts.watch === false
      ? undefined
      : opts.watch === true
        ? resolveWatchTrue(opts.storage)
        : opts.watch;

  const globalSubscribers = new Set<(evt: EventRecord) => void>();
  const scopedSubscribers = new Map<DocId, Set<(evt: EventRecord) => void>>();

  // Dependency-scoped subscription index. The reverse include
  // index maps a document to the set of documents whose projections directly
  // include it (`buildReverseIndex` over every subscribed document's resolved
  // `ok` include edges). Delivery walks it transitively from an event's docId
  // to find every subscribed document whose projection inputs contain that
  // docId — the set {S} ∪ (docs transitively included by S).
  //
  // Maintenance (chosen mechanism — "rebuilt after EMIT"): the index is
  // invalidated when a subscriber is added or removed, after every commit and
  // after every handled external write, then rebuilt in full lazily at the
  // start of the next write's commit pipeline, before that write emits
  // anything. Delivery is therefore synchronous and always reads an index
  // consistent with pre-write storage: a new include edge written by write N
  // is visible to deliveries of write N+1, and a doc.removed event is
  // delivered against the pre-removal graph. Inputs come only from the
  // include graph (link/graph.ts): nothing else is consulted. A rebuild reads
  // every subscriber's include closure, but parses go through the parse
  // cache, which writes seed: unchanged content is neither parsed nor scanned
  // again.
  let reverseIndex: ReadonlyMap<DocId, ReadonlySet<DocId>> = new Map();
  let reverseIndexGeneration = 0;
  let reverseIndexBuiltGeneration = -1;
  let reverseIndexBuild: Promise<void> | undefined;
  /**
   * Set when the last rebuild could not read a document (a board or an
   * include target threw: EIO, EACCES, a network glitch). That read may
   * succeed next time, and nothing else would invalidate the index if the
   * write that triggered the rebuild is then rejected: rebuild once more
   * before the next write. One retry per write, so a document that never
   * reads costs one rebuild per write, never a loop.
   */
  let rebuildAfterReadFailure = false;

  function invalidateReverseIndex(): void {
    reverseIndexGeneration += 1;
  }

  /** Rebuild the reverse include index if it is stale (generation-guarded against concurrent writes). */
  async function ensureReverseIndex(): Promise<void> {
    if (rebuildAfterReadFailure) {
      rebuildAfterReadFailure = false;
      invalidateReverseIndex();
    }
    while (reverseIndexBuiltGeneration < reverseIndexGeneration) {
      const target = reverseIndexGeneration;
      if (reverseIndexBuild === undefined) {
        reverseIndexBuild = buildReverseIndexNow(target).finally(() => {
          reverseIndexBuild = undefined;
        });
      }
      await reverseIndexBuild;
    }
  }

  async function buildReverseIndexNow(target: number): Promise<void> {
    const subscribed = [...scopedSubscribers.keys()];
    const edges: ResolvedInclude[] = [];
    for (const docId of subscribed) {
      // One subscriber whose board cannot be read contributes no edges; it
      // must never fail the write that triggered the rebuild (or any other).
      try {
        const link = await resolveIncludes(docId, opts.storage, parseOptions, linkOptions);
        for (const e of link.includes) edges.push(e);
        // A target outside the workspace is diagnosed differently and is final.
        if (link.diagnostics.some((d) => d.code === "E_INCLUDE_UNREADABLE")) {
          rebuildAfterReadFailure = true;
        }
      } catch {
        // Fail-soft: the board's own projection reports the error when read.
        rebuildAfterReadFailure = true;
      }
    }
    reverseIndex = buildReverseIndex(edges);
    reverseIndexBuiltGeneration = target;
  }

  /**
   * The subscribed documents whose projection inputs include `docId`: the
   * event's own document plus every subscribed document that transitively
   * includes it, reached by walking the reverse include index from `docId`
   * through its direct includers. `resolveIncludes`' reachable set already
   * captures the transitive include closure (cycles collapse into the already
   * visited set; missing/duplicate targets contribute no `ok` edge), so this
   * walk reconstructs exactly the projection inputs of every subscriber.
   * Deterministic: a visited-set guards against cycles and duplicate delivery.
   */
  function dependencyScopedRecipients(docId: DocId): ReadonlySet<DocId> {
    const recipients = new Set<DocId>([docId]);
    const stack: DocId[] = [docId];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      const includers = reverseIndex.get(current);
      if (includers === undefined) continue;
      for (const includer of includers) {
        if (recipients.has(includer)) continue;
        recipients.add(includer);
        stack.push(includer);
      }
    }
    return recipients;
  }

  // Decorate the raw sink so every append notifies subscribers. `opts.eventSink`
  // overrides the storage's default sink; either way the decorated sink is what
  // the write pipeline appends through.
  const rawSink = opts.eventSink ?? opts.storage.defaultEventSink?.();
  const sink: EventSink | undefined =
    rawSink === undefined
      ? undefined
      : rawSink.read === undefined
        ? {
            async append(record: EventDraft) {
              const full = await rawSink.append(record);
              notifySubscribers(full);
              return full;
            },
          }
        : {
            async append(record: EventDraft) {
              const full = await rawSink.append(record);
              notifySubscribers(full);
              return full;
            },
            read: (readOpts) =>
              (rawSink.read as (o: { afterSeq: number }) => Promise<EventRecord[]>)(readOpts),
          };

  function notifySubscribers(full: EventRecord): void {
    for (const handler of globalSubscribers) handler(full);
    if (scopedSubscribers.size === 0) return;
    const eventDocId = full.docId;
    if (typeof eventDocId !== "string") return;
    const docId = asDocId(eventDocId);
    for (const subscriber of dependencyScopedRecipients(docId)) {
      scopedSubscribers.get(subscriber)?.forEach((handler) => {
        handler(full);
      });
    }
  }

  // The write lock: `opts.lock` overrides the storage's per-document default
  // (one shared lock for every write); otherwise the storage default is used.
  const lockOverride = opts.lock;
  const defaultLockFn: ((docId: DocId) => Lock) | undefined =
    lockOverride !== undefined ? () => lockOverride : opts.storage.defaultLock;

  // The pipeline reads its sink via storage.defaultEventSink(): hand it the decorated one.
  const wrappedStorage: Storage = {
    read: (docId) => opts.storage.read(docId),
    // The committed source is recorded for self-echo suppression here,
    // in the continuation of the underlying write — the moment the bytes land,
    // with the exact content that landed (no re-read), before the pipeline
    // emits events and before the document lock releases. Recording after the
    // commit resolves loses a race: a file watcher delivers in a few
    // milliseconds, well inside EMIT, and its handler would then find the
    // recorded version stale and event the engine's own commit as external.
    writeAtomic: async (docId, content) => {
      await opts.storage.writeAtomic(docId, content);
      recordCommitted(docId, content);
    },
    list: () => opts.storage.list(),
    ...(opts.storage.size !== undefined
      ? {
          size: (docId: DocId) =>
            (opts.storage.size as (d: DocId) => Promise<number | undefined>)(docId),
        }
      : {}),
    ...(opts.storage.rootDir !== undefined ? { rootDir: opts.storage.rootDir } : {}),
    ...(opts.storage.delete !== undefined
      ? {
          // A removal forgets the self-echo record, so the same bytes coming
          // back from outside are an external write.
          delete: async (docId: DocId) => {
            await (opts.storage.delete as (d: DocId) => Promise<void>)(docId);
            externalHandler?.recordRemoved(docId);
          },
        }
      : {}),
    ...(defaultLockFn !== undefined ? { defaultLock: defaultLockFn } : {}),
    ...(sink !== undefined ? { defaultEventSink: () => sink } : {}),
  };

  // Runtime-extensible middleware chains. Always-start-empty
  // arrays are passed by reference into the write deps and read at invocation
  // time (`withWriteMiddleware` reads `deps.middleware` per call; projection()
  // reads `projectionMiddlewares` per call), so `use()` appends are visible to
  // the next write/projection.
  const writeMiddlewares: WriteMiddleware[] = [...(opts.middleware?.write ?? [])];
  const projectionMiddlewares: ProjectionMiddleware[] = [...(opts.middleware?.projection ?? [])];

  // Commit ids: `<docId>@<version>#<prefix>.<n>`, n counting this engine's
  // commits (engine writes and handled external writes alike) from 1. The
  // prefix tells engines apart in a shared or reopened log: random unless the
  // host pins it, in which case the same writes mint the same ids (B8).
  const commitIdPrefix = opts.commitIdPrefix ?? randomUUID().replaceAll("-", "").slice(0, 12);
  let commitCount = 0;
  const commitId = (docId: DocId, version: string): string => {
    commitCount += 1;
    return `${docId}@${version}#${commitIdPrefix}.${commitCount}`;
  };

  const deps: PipelineDeps = {
    storage: wrappedStorage,
    commitId,
    clock,
    blockTypes,
    parseOptions,
    ...(opts.writePolicy !== undefined ? { policy: opts.writePolicy } : {}),
    middleware: writeMiddlewares,
    maxDocumentBytes,
    complexityLimits,
    cachedParse,
    // `WriteCtx.parse` and the write's own VALIDATE share the parse cache
    // (declared below, read only once a write runs).
    parseCache: {
      parse: (src) => parseCache.parse(src),
      peek: (src) => parseCache.peek(src),
    },
    onCommit,
  };

  // ── Engine-internal caches ────────────────────────────────
  // Parse cache: content hash → ParsedDoc. Keyed by the SHA-256 of the source
  // (docVersion), so identical content parses once per engine instance and a
  // changed document naturally misses. A bounded LRU: at most
  // PARSE_CACHE_MAX_ENTRIES parses and PARSE_CACHE_MAX_SOURCE_BYTES (16 MiB) of
  // source in total, because a parse can retain tens of times its source. The
  // most recently used parses also keep their mdast tree, for projectors that
  // read it instead of parsing again (`mdastOf`), within a separate budget of
  // PARSE_CACHE_MAX_TREE_NODES (200,000 mdast nodes, about 65 to 75 MiB at
  // about 330 to 370 bytes per node); past it the least recently used trees
  // are released. Each
  // engine instance owns its own in-memory state, with no cross-process
  // coordination; content-hash keying is what
  // makes a stale entry unreachable (different content → different key), so
  // multi-process cache correctness is not required beyond that keying.
  const parseCache = createParseCache((src) => parseDoc(src, parseOptions));
  // Every parse with the engine's own options (reads, writes, external
  // writes) re-parses only the sections that changed since a version whose
  // chunks the cache still holds.
  bindChunkCache(parseOptions, parseCache.chunks);
  /** Bumped by `registerBlock`: parses made under an older value are stale. */
  let registryEpoch = 0;
  // docId → the content hash under which that doc's ParsedDoc is currently
  // cached, so a successful write/external-write can drop the affected entry.
  const parseHashByDoc = new Map<DocId, string>();

  /**
   * PARSE through the cache: one ParsedDoc per content hash. Every read path
   * (LINK for the board and each included document, `getBlock`) goes through
   * here, so a document is parsed once per content and its cost is paid on the
   * first read after a write, not on every projection. Callers check the size
   * and complexity limits first: a document over one never reaches this
   * function. A parse that throws anyway propagates, and callers catch it; the
   * cache remembers the failure by content hash, so an unparseable document
   * that stays subscribed or keeps being read is not parsed again each time.
   */
  function parseCached(docId: DocId, src: string): ParsedDoc {
    const { doc, hash } = parseCache.parse(src);
    parseHashByDoc.set(docId, hash);
    return doc;
  }

  /**
   * The cached parse of `src`, without parsing on a miss. The cache only ever
   * holds content that passed the size and complexity limits (every caller of
   * `parseCached` checks them first, and a write seeds only content it
   * checked), so a hit skips those checks: no complexity scan of content the
   * engine has already parsed.
   */
  function cachedParse(docId: DocId, src: string): ParsedDoc | undefined {
    const hit = parseCache.peek(src);
    if (hit === undefined) return undefined;
    parseHashByDoc.set(docId, hit.hash);
    return hit.doc;
  }

  /**
   * Read a stored document and its parse, through the cache, for the
   * single-document reads (`getBlock`, `docInfo`). `undefined` when the
   * document does not exist, is over the size or a complexity limit (checked
   * before the read when the storage can size it, and never parsed), or its
   * parse threw — fail-soft, treated as absent.
   */
  async function readParsed(
    id: DocId,
  ): Promise<{ readonly src: string; readonly parsed: ParsedDoc } | undefined> {
    if ((await sizeOverLimit(opts.storage, id, maxDocumentBytes)) !== undefined) return undefined;
    const src = await opts.storage.read(id);
    if (src === undefined) return undefined;
    const cached = cachedParse(id, src);
    if (cached !== undefined) return { src, parsed: cached };
    if (exceedsDocumentLimit(src, maxDocumentBytes)) return undefined;
    if (complexityOf(id, src) !== undefined) return undefined;
    try {
      return { src, parsed: parseCached(id, src) };
    } catch {
      return undefined; // fail-soft: an unparseable document reads as absent
    }
  }

  /**
   * The pipeline dependencies for one write call. Its `onCommit` knows the
   * block registry the call started under: a `registerBlock` during the call
   * changes fence recognition, so the write's parse may be stale by the time
   * it commits.
   */
  function depsForCall(): PipelineDeps {
    const epoch = registryEpoch;
    return { ...deps, onCommit: (commit) => onCommit(commit, epoch) };
  }

  /**
   * After every commit (engine writes of all kinds), before its events are
   * appended: seed the parse cache with the write's own parse of what it
   * stored, so the next read (the include-index rebuild included) does not
   * parse it again; drop the replaced content's parse and the merged trees
   * involving the document; and invalidate the reverse include index.
   */
  function onCommit(commit: CommitEffect, epoch = registryEpoch): void {
    const { docId, src, version } = commit;
    // A parse made before a `registerBlock` is not seeded.
    const parsed = epoch === registryEpoch ? commit.parsed : undefined;
    const old = parseHashByDoc.get(docId);
    if (old !== undefined && old !== version) parseCache.delete(old);
    if (src !== undefined && version !== undefined && parsed !== undefined) {
      parseHashByDoc.set(docId, parseCache.seed(src, parsed, version));
    } else {
      parseHashByDoc.delete(docId);
    }
    invalidateMergeForDoc(docId);
    invalidateReverseIndex();
  }

  /** LINK reads documents through the parse cache and the size limit. */
  const linkOptions = {
    parse: parseCached,
    cached: cachedParse,
    maxDocumentBytes,
    complexityLimits,
  };

  // Merge cache: board docId + the hash set of every involved document →
  // MergedTree. Keyed by the sorted (docId, content-hash) pairs of all
  // reachable docs (deterministic, B8), so a change to any involved document
  // changes the key. A bounded FIFO Map (oldest evicted past MERGE_CACHE_MAX);
  // correctness first per CONTRIBUTING B7 — the bound is documented, not an
  // LRU optimization. It caches ONLY the tree (structure/provenance/ranges/
  // srcs), never resolved values: RESOLVE is a separate per-projection stage
  // so a ticking or swapped Source changes values without any doc edit.
  const mergeCache = new Map<string, MergedTree>();
  // Reverse index for precise invalidation: docId → merge-cache keys involving it.
  const mergeKeysByDoc = new Map<DocId, Set<string>>();
  // key → involved docs (for eviction/invalidation cleanup).
  const mergeInvolvedDocs = new Map<string, readonly DocId[]>();

  /** The merge-cache key: board docId + the deterministic (docId, hash) set of involved docs. */
  function mergeCacheKey(boardDocId: DocId, link: LinkResult): string {
    const docs = link.docs
      .map((d) => [d.docId, docVersion(d.src)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return JSON.stringify([boardDocId, docs]);
  }

  /** Remove one merge-cache entry from the cache and both indexes. */
  function evictMergeKey(key: string): void {
    mergeCache.delete(key);
    const involved = mergeInvolvedDocs.get(key);
    mergeInvolvedDocs.delete(key);
    if (involved === undefined) return;
    for (const docId of involved) {
      const keys = mergeKeysByDoc.get(docId);
      if (keys === undefined) continue;
      keys.delete(key);
      if (keys.size === 0) mergeKeysByDoc.delete(docId);
    }
  }

  /** Invalidate every merge-cache entry whose involved-doc set contains `docId`. */
  function invalidateMergeForDoc(docId: DocId): void {
    const keys = mergeKeysByDoc.get(docId);
    if (keys === undefined) return;
    for (const key of [...keys]) evictMergeKey(key);
  }

  /** Insert a merged tree, wire the reverse index, and enforce the FIFO bound. */
  function storeMerge(key: string, merged: MergedTree, involved: readonly DocId[]): void {
    mergeCache.set(key, merged);
    mergeInvolvedDocs.set(key, involved);
    for (const docId of involved) {
      let keys = mergeKeysByDoc.get(docId);
      if (keys === undefined) {
        keys = new Set();
        mergeKeysByDoc.set(docId, keys);
      }
      keys.add(key);
    }
    while (mergeCache.size > MERGE_CACHE_MAX) {
      const oldest = mergeCache.keys().next().value;
      if (oldest === undefined) break;
      evictMergeKey(oldest);
    }
  }

  // External-write handling is wired through wrappedStorage so
  // synthesized events reach subscribers via the decorated sink.
  const externalHandler =
    watchOptions === undefined
      ? undefined
      : createExternalWriteHandler({
          storage: wrappedStorage,
          clock,
          blockTypes,
          parseOptions,
          rootDir: watchOptions.rootDir,
          commitId,
          maxDocumentBytes,
          complexityLimits,
          cachedParse,
          parse: parseCached,
          ...(watchOptions.externalWriterId !== undefined
            ? { externalWriterId: watchOptions.externalWriterId }
            : {}),
        });

  async function externalWrite(watchPath: string): Promise<ExternalWriteOutcome | undefined> {
    if (externalHandler === undefined) return undefined; // fail-soft: no watch configured
    await ensureReverseIndex();
    const outcome = await externalHandler.handle(watchPath);
    invalidateReverseIndex();
    // A genuine external write (changed content) drops the merged trees
    // involving the document; its parse, when it fit the limits, is already
    // cached by content through `parseCached`. A suppressed self-echo
    // (external: false) left content unchanged.
    if (outcome?.external) invalidateMergeForDoc(outcome.docId);
    return outcome;
  }

  /**
   * Remember a document's committed source so a later watch event hashing to it
   * is suppressed as a self-echo. Called from `wrappedStorage.writeAtomic`
   * the moment the bytes land, so the recording always precedes the handler's
   * comparison (the handler awaits a `storage.read` first). Without `watch`
   * there is no handler and nothing is recorded. `removeDoc` needs no recording:
   * the handler returns `undefined` for a missing source.
   */
  function recordCommitted(docId: DocId, src: string): void {
    if (externalHandler === undefined) return; // fail-soft: no watch configured
    try {
      externalHandler.recordCommitted(docId, src);
    } catch {
      // Fail-soft: recording parses the document; a
      // failure there costs at most one spurious external-write event and must
      // never fail a commit whose bytes are already on disk.
    }
  }

  // Auto-start the watch source (best-effort): a start failure must never break
  // engine creation. `close()` awaits the start (so the closer is assigned) and
  // then runs the closer; it is a no-op when watching was never enabled.
  let _watchClose: (() => Promise<void>) | undefined;
  let _watchStart: Promise<void> | undefined;
  if (watchOptions !== undefined) {
    const source = watchOptions.source ?? createChokidarSource(watchOptions.rootDir);
    // External writes invalidate the affected caches inside
    // `externalWrite` (below), so watch-detected edits never serve a stale parse
    // or merge result on the next projection.
    _watchStart = source
      .start((evt) => {
        void externalWrite(evt.path).catch(() => {});
      })
      .then((closer) => {
        _watchClose = closer;
      })
      .catch(() => {});
  }

  async function close(): Promise<void> {
    if (_watchStart !== undefined) await _watchStart;
    await _watchClose?.();
  }

  function subscribe(handler: (evt: EventRecord) => void): () => void;
  function subscribe(docId: string, handler: (evt: EventRecord) => void): () => void;
  function subscribe(
    handlerOrDocId: string | ((evt: EventRecord) => void),
    handlerOrUndefined?: (evt: EventRecord) => void,
  ): () => void {
    if (typeof handlerOrDocId === "function") {
      globalSubscribers.add(handlerOrDocId);
      return () => {
        globalSubscribers.delete(handlerOrDocId);
      };
    }
    const handler = handlerOrUndefined;
    if (handler === undefined) return () => {};
    const validated = tryDocId(handlerOrDocId);
    if (!validated.ok) return () => {}; // invalid id: fail-soft, no delivery scope
    const docId = validated.id;
    let set = scopedSubscribers.get(docId);
    if (set === undefined) {
      set = new Set();
      scopedSubscribers.set(docId, set);
    }
    set.add(handler);
    // A new subscriber's include edges are not yet in the reverse index.
    invalidateReverseIndex();
    return () => {
      const handlers = scopedSubscribers.get(docId);
      if (handlers === undefined) return;
      handlers.delete(handler);
      if (handlers.size > 0) return;
      scopedSubscribers.delete(docId);
      // Its edges leave the index at the next rebuild.
      invalidateReverseIndex();
    };
  }

  const engine: Engine = {
    async projection<T = unknown>(
      docId: string,
      projectorId: string,
      { source, options = {} }: { readonly source?: Source; readonly options?: ProjectionOptions },
    ): Promise<ProjectionResult<T>> {
      // `T` is caller-asserted — the engine passes the projector's return value
      // through untouched and never inspects it — so the documented fail-soft
      // empty output is cast to it once, here.
      const emptyOutput = "" as unknown as T;
      const validated = tryDocId(docId);
      if (!validated.ok) {
        return {
          ok: false,
          output: emptyOutput,
          diagnostics: [validated.diagnostic],
          versions: {},
        };
      }
      const id = validated.id;
      // A document whose stored size is over the limit is not even read.
      const sizedOut = await sizeOverLimit(opts.storage, id, maxDocumentBytes);
      if (sizedOut !== undefined) {
        return { ok: false, output: emptyOutput, diagnostics: [sizedOut], versions: {} };
      }
      const stored = await opts.storage.read(id);
      if (stored === undefined) {
        return {
          ok: false,
          output: emptyOutput,
          diagnostics: [diagnostic("E_DOC_MISSING", `document not found: ${id}`)],
          versions: {},
        };
      }
      // A document over the size limit is never parsed (fail-soft: diagnosed).
      const tooLarge = documentSizeDiagnostic(id, stored, maxDocumentBytes, "read");
      if (tooLarge !== undefined) {
        return { ok: false, output: emptyOutput, diagnostics: [tooLarge], versions: {} };
      }

      // LINK checks the complexity limits and PARSEs every reachable document,
      // the board first, once each per pass (through the parse cache). A
      // board it could not load (over a complexity limit, a parse that threw,
      // or gone since the read above) fails the projection with LINK's
      // diagnostic for it.
      const link = await resolveIncludes(id, opts.storage, parseOptions, linkOptions);
      const board = link.docs[0];
      if (board === undefined || board.docId !== id) {
        return { ok: false, output: emptyOutput, diagnostics: [...link.diagnostics], versions: {} };
      }
      const doc = board.parsed;
      const src = board.src;
      const diagnostics: Diagnostic[] = [...doc.diagnostics, ...link.diagnostics];

      // RESOLVE: a separate, per-projection stage after MERGE. It re-runs
      // with the call-scoped Source every projection, producing a FRESH values
      // object per call — never cached, never shared across projections (values are
      // injected at projection, never persisted; Source is call-scoped).
      // Projectors and middleware receive this object, so two
      // interleaved projections with different Sources cannot cross-contaminate.
      // It is computed before the merge-cache lookup below only because it
      // depends on LINK's refs (not on the tree) — letting a cache miss attach
      // these exact values without re-resolving. An absent Source resolves no
      // refs (fine for documents that carry none). The live `blockTypes`
      // registry travels with it so blocks that declare their own refs
      // (`BlockType.sources`) resolve too, including types added by a runtime
      // `registerBlock()` (the map is read per projection, never captured).
      const values =
        source === undefined ? new Map() : await resolveMergedValues(link, source, blockTypes);

      // MERGE through the cache: one merged tree per (board + involved
      // hash set). The key captures every reachable doc's content hash, so any
      // involved document change produces a new key; write-time invalidation is
      // belt-and-suspenders (frees the stale entry eagerly). The tree is pure
      // structure — provenance/ranges/srcs — because buildMergedTree resolves
      // nothing; the per-call `values` above travel beside it to the projector.
      const mergeKey = mergeCacheKey(id, link);
      // A tree cut short by `includeLimits` carries its E_INCLUDE_LIMIT
      // diagnostic, so a cached tree reports it on every projection.
      let merged = mergeCache.get(mergeKey);
      if (merged === undefined) {
        merged = await buildMergedTree({ boardDocId: id, link, limits: includeLimits });
        storeMerge(
          mergeKey,
          merged,
          link.docs.map((d) => d.docId),
        );
      }
      for (const d of merged.diagnostics ?? []) diagnostics.push(d);

      const projector = projectors.get(projectorId);
      if (projector === undefined) {
        return {
          ok: false,
          output: emptyOutput,
          diagnostics: [
            ...diagnostics,
            diagnostic("E_UNKNOWN_PROJECTOR", `unknown projector: ${projectorId}`),
          ],
          versions: {},
        };
      }

      // PROJECT: the projector call is wrapped in the projection
      // middleware chain. The same options object the projector
      // receives is the middleware context's mutable `options`, so an amend
      // before `next()` reaches the projector.
      const projectorOptions: Record<string, unknown> = {
        ...options,
        blockTypes: blockTypes,
        merged,
      };
      const ctx: ProjectionCtx = {
        docId: id,
        projectorId,
        merged,
        values,
        options: projectorOptions,
      };

      // Fail-soft output: the projector's own degraded form when it declares
      // one, the raw source otherwise (the projection never throws).
      const degraded = (why: readonly Diagnostic[]): unknown => {
        if (projector.degrade === undefined) return src;
        try {
          return projector.degrade(src, why);
        } catch (err) {
          diagnostics.push(
            diagnostic(
              "E_PROJECTOR_ERROR",
              `projector "${projectorId}" degrade threw: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          return "";
        }
      };

      const runProjector = async (): Promise<void> => {
        const reported: Diagnostic[] = [];
        try {
          const input: ProjectionInput = {
            doc,
            src,
            values,
            merged,
            blockTypes,
            options: ctx.options,
            report: (d) => {
              reported.push(d);
            },
          };
          ctx.output = await projector.project(input);
          for (const d of reported) diagnostics.push(d);
        } catch (err) {
          // Fail-soft: a throwing projector degrades
          // rather than propagating (the projection never throws).
          const failure = diagnostic(
            "E_PROJECTOR_ERROR",
            `projector "${projectorId}" threw: ${err instanceof Error ? err.message : String(err)}`,
          );
          for (const d of reported) diagnostics.push(d);
          diagnostics.push(failure);
          ctx.output = degraded([failure]);
        }
      };

      if (projectionMiddlewares.length === 0) {
        await runProjector();
      } else {
        try {
          await compose(projectionMiddlewares)(ctx, runProjector);
        } catch (err) {
          // Fail-soft: a projection middleware that throws rejects the
          // projection. Degrade the output and attach the rejection's own
          // diagnostics, or an E_MIDDLEWARE_ERROR for any other error, so one
          // misbehaving plugin never takes the whole view down.
          const why =
            err instanceof WriteRejection
              ? err.diagnostics
              : [
                  diagnostic(
                    "E_MIDDLEWARE_ERROR",
                    `projection middleware threw: ${err instanceof Error ? err.message : String(err)}`,
                  ),
                ];
          ctx.output = degraded(why);
          for (const d of why) diagnostics.push(d);
        }
      }
      const output = ctx.output as T;

      // Versions of every document in the merged tree (the board plus
      // everything reachable through `ok` include edges), read back from the
      // LINK snapshot so a mid-projection write cannot leak in.
      const versions: Record<string, string> = {};
      const srcByDocId = new Map(link.docs.map((d) => [d.docId, d.src]));
      const mergedDocIds = new Set<DocId>();
      (function collect(node: MergedNode): void {
        mergedDocIds.add(node.provenance.docId);
        for (const include of node.includes) collect(include.node);
      })(merged.root);
      for (const docId2 of mergedDocIds) {
        const loadedSrc = srcByDocId.get(docId2);
        if (loadedSrc !== undefined) versions[docId2] = docVersion(loadedSrc);
      }
      return { ok: true, output, diagnostics, versions };
    },

    async write(docId, { writer, fullText, expectedVersion }) {
      const validated = tryDocId(docId);
      if (!validated.ok) return invalidIdRejection(validated.diagnostic);
      const id = validated.id;
      const callDeps = depsForCall();
      return ensureReverseIndex().then(() =>
        writeDocPipeline(callDeps, id, writer, fullText, {
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        }),
      );
    },
    async patch(docId, blockId, { writer, attrs, expectedVersion, expected, strictExpected }) {
      const vDoc = tryDocId(docId);
      if (!vDoc.ok) return invalidIdRejection(vDoc.diagnostic);
      const vBlock = tryBlockId(blockId);
      if (!vBlock.ok) return invalidIdRejection(vBlock.diagnostic);
      const callDeps = depsForCall();
      return ensureReverseIndex().then(() =>
        patchDocPipeline(callDeps, vDoc.id, vBlock.id, attrs, writer, {
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          ...(expected !== undefined ? { expected } : {}),
          strictExpected: strictExpected ?? strictExpectedDefault,
        }),
      );
    },
    applyIntent(intent, { writer }) {
      const callDeps = depsForCall();
      return ensureReverseIndex().then(() =>
        applyIntentRoute(
          callDeps,
          { ...intent, strictExpected: intent.strictExpected ?? strictExpectedDefault },
          writer,
        ),
      );
    },
    async createDoc(docId, { writer, content }) {
      const validated = tryDocId(docId);
      if (!validated.ok) return invalidIdRejection(validated.diagnostic);
      const id = validated.id;
      const callDeps = depsForCall();
      return ensureReverseIndex().then(() => createDocPipeline(callDeps, id, writer, content));
    },
    async importDoc(docId, { writer, content, ignoreSizeLimit }) {
      const validated = tryDocId(docId);
      if (!validated.ok) return invalidIdRejection(validated.diagnostic);
      const id = validated.id;
      const callDeps = depsForCall();
      return ensureReverseIndex().then(() =>
        importDocPipeline(callDeps, id, writer, content, {
          ...(ignoreSizeLimit !== undefined ? { ignoreSizeLimit } : {}),
        }),
      );
    },
    async removeDoc(docId, { writer }) {
      const validated = tryDocId(docId);
      if (!validated.ok) return invalidIdRejection(validated.diagnostic);
      const id = validated.id;
      const callDeps = depsForCall();
      return ensureReverseIndex().then(() => removeDocPipeline(callDeps, id, writer));
    },

    async getDoc(docId) {
      const validated = tryDocId(docId);
      if (!validated.ok) return undefined;
      const src = await opts.storage.read(validated.id);
      if (src === undefined) return undefined;
      return { src, version: docVersion(src) };
    },

    async getBlock(docId, blockId) {
      const vDoc = tryDocId(docId);
      if (!vDoc.ok) return undefined;
      const vBlock = tryBlockId(blockId);
      if (!vBlock.ok) return undefined;
      const read = await readParsed(vDoc.id);
      if (read === undefined) return undefined;
      const { src, parsed } = read;
      const block = parsed.nodes.find((n): n is Block => "blockId" in n && n.blockId === vBlock.id);
      if (block === undefined) return undefined;
      // The parse is shared through the cache: hand out a copy of the attrs.
      return { attrs: structuredClone(block.attrs), type: block.type, version: docVersion(src) };
    },

    async docInfo(docId) {
      const validated = tryDocId(docId);
      if (!validated.ok) return undefined;
      const read = await readParsed(validated.id);
      if (read === undefined) return undefined;
      // The parse is shared through the cache: the summary copies out of it.
      // The copy is inside the fail-soft boundary too: frontmatter nested
      // deeper than the clone's stack reads as absent, not as a rejection.
      try {
        return summarizeDoc(validated.id, docVersion(read.src), read.parsed);
      } catch {
        return undefined;
      }
    },

    listDocs() {
      return opts.storage.list();
    },

    close,

    externalWrite,

    subscribe,

    use(m) {
      if (m.write !== undefined) writeMiddlewares.push(m.write);
      if (m.projection !== undefined) projectionMiddlewares.push(m.projection);
    },

    async *events(opts2) {
      if (sink?.read === undefined) return;
      const records = await sink.read({ afterSeq: opts2.afterSeq });
      for (const record of records) yield record;
    },

    async refGraph(docId) {
      const validated = tryDocId(docId);
      if (!validated.ok) {
        return { docs: [], includes: [], diagnostics: [validated.diagnostic] };
      }
      const link = await resolveIncludes(validated.id, opts.storage, parseOptions, linkOptions);
      return {
        docs: link.docs.map((d) => d.docId),
        includes: link.includes,
        diagnostics: link.diagnostics,
      };
    },

    registerProjector(projector) {
      projectors.set(projector.id, projector);
    },
    registerBlock(block) {
      blockTypes.set(block.type, block);
      fenceTypes.add(block.type);
      // Registering (or replacing) a type changes fence recognition, so every
      // parse and every merged tree built before this call is stale. The parse
      // cache is keyed by content hash alone and the merge cache by the
      // involved docs' hashes — neither key moves when only the registry
      // changes, so both must be cleared outright. Registration is a rare,
      // wiring-time operation; a full clear is the correct, cheap answer.
      registryEpoch += 1;
      parseCache.clear();
      parseHashByDoc.clear();
      for (const key of [...mergeCache.keys()]) evictMergeKey(key);
      // Fence recognition decides which references are include references,
      // so any include edge may have moved.
      invalidateReverseIndex();
    },
  };
  indexSnapshotReaders.set(engine, async () => {
    await ensureReverseIndex();
    return new Map(
      [...reverseIndex.entries()]
        .filter(([, includers]) => includers.size > 0)
        .map(([docId, includers]) => [docId, [...includers].sort()]),
    );
  });
  return engine;
}
