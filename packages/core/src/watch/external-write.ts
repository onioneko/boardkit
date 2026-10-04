import path from "node:path";
import type { AnyBlockType } from "../blocks/types.js";
import { diffDocs } from "../diff/diff.js";
import { synthesizeEvents } from "../diff/synthesize.js";
import { docVersion } from "../engine/version.js";
import type { Diagnostic } from "../model/diagnostic.js";
import type { ParsedDoc } from "../model/doc.js";
import { asDocId, type DocId } from "../model/ids.js";
import { type ComplexityLimits, complexityDiagnostic } from "../parse/complexity.js";
import type { ParseOptions } from "../parse/options.js";
import { parseDoc, parseFailedDiagnostic } from "../parse/pipeline.js";
import {
  DEFAULT_MAX_DOCUMENT_BYTES,
  documentSizeDiagnostic,
  exceedsDocumentLimit,
} from "../parse/size.js";
import type { Clock, EventDraft, EventRecord, Storage } from "../ports/ports.js";

/**
 * External write handling: humans editing files directly bypass the pipeline by
 * nature, so the watcher detects their writes. Self-echoes (the engine's own
 * commits) are suppressed by content-hash comparison; everything else is treated
 * as already-committed truth: parsed, diffed against the last known tree,
 * evented with writer `{kind:"human", id:"external"}` (id configurable), and
 * appended to the event sink. Content violating block schemas is NOT rejected —
 * it is already on disk (the source is truth); violations surface as
 * diagnostics on the next read.
 */

/** Everything external-write handling needs, injected at construction. */
export interface ExternalWriteDeps {
  /** Where document bytes live. */
  readonly storage: Storage;
  /** Timestamp source for synthesized events. */
  readonly clock: Clock;
  /** Registered block types, used to match transition events. */
  readonly blockTypes: ReadonlyMap<string, AnyBlockType>;
  /** Parse options used to re-parse the edited file. */
  readonly parseOptions?: ParseOptions;
  /** Workspace root: watcher paths are resolved to docIds relative to it. */
  readonly rootDir: string;
  /** Writer id stamped on external-write events (defaults to `"external"`). */
  readonly externalWriterId?: string;
  /**
   * Document size limit in UTF-8 bytes; defaults to
   * `DEFAULT_MAX_DOCUMENT_BYTES` (256 KiB). An edited file over it is not parsed
   * or evented: the outcome carries an `E_DOCUMENT_TOO_LARGE` diagnostic.
   */
  readonly maxDocumentBytes?: number;
  /**
   * Markdown complexity limits; absent takes `DEFAULT_COMPLEXITY_LIMITS`, and
   * `false` turns the check off. An edited file over a limit is not parsed or
   * evented: the outcome carries an `E_DOCUMENT_TOO_COMPLEX` diagnostic. A
   * file whose parse throws is not evented either (`E_PARSE_FAILED`).
   */
  readonly complexityLimits?: ComplexityLimits | false;
}

/** The outcome of handling one watch event. */
export interface ExternalWriteOutcome {
  /** The document the event concerns. */
  readonly docId: DocId;
  /** True when the event was a self-echo (the engine's own commit) and was ignored. */
  readonly suppressed: boolean;
  /** True when the event was treated as a genuine external write (and possibly evented). */
  readonly external: boolean;
  /** The events appended for a genuine external write (empty for suppressed echoes). */
  readonly events: readonly EventRecord[];
  /** Parse diagnostics from the (already-committed) edited content. */
  readonly diagnostics: readonly Diagnostic[];
}

/** External-write detector: suppresses self-echoes, events external writes, tracks last-known trees. */
export interface ExternalWriteHandler {
  /**
   * Record the committed source of a document so a later watch event hashing
   * to it is suppressed as a self-echo. The engine calls this when the
   * committed bytes land (inside its `writeAtomic` wrapper), before events are
   * emitted and before the document lock releases: a watcher delivering during
   * EMIT would otherwise read the new content, find the recorded version stale,
   * and event the engine's own commit as an external write.
   * @param docId The document that was committed.
   * @param src Its committed source.
   */
  recordCommitted(docId: DocId, src: string): void;
  /**
   * Handle one watch notification.
   * @param watchPath The filesystem path the watcher reported.
   * @returns The outcome, or `undefined` when the path is outside `rootDir` or not a markdown file.
   */
  handle(watchPath: string): Promise<ExternalWriteOutcome | undefined>;
}

/**
 * Create an external-write handler bound to a workspace.
 * @param deps The handler's dependencies (storage, clock, block types, root, writer id).
 * @returns A handler that detects external writes and suppresses self-echoes.
 */
export function createExternalWriteHandler(deps: ExternalWriteDeps): ExternalWriteHandler {
  const lastVersion = new Map<DocId, string>();
  const lastTree = new Map<DocId, ParsedDoc>();
  const maxDocumentBytes = deps.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  /** The size or complexity diagnostic for a source, or `undefined` when it may be parsed. */
  const overLimit = (docId: DocId, src: string): Diagnostic | undefined =>
    documentSizeDiagnostic(docId, src, maxDocumentBytes, "read") ??
    complexityDiagnostic(docId, src, deps.complexityLimits, "read");
  /** Parse, or `undefined` when the parser throws. */
  const tryParse = (src: string): ParsedDoc | undefined => {
    try {
      return parseDoc(src, deps.parseOptions);
    } catch {
      return undefined;
    }
  };

  const toDocId = (watchPath: string): DocId | undefined => {
    const rel = path.relative(deps.rootDir, watchPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    if (!rel.endsWith(".md")) return undefined;
    return asDocId(rel.slice(0, -".md".length).split(path.sep).join("/"));
  };

  return {
    recordCommitted(docId, src) {
      lastVersion.set(docId, docVersion(src));
      const parsed =
        exceedsDocumentLimit(src, maxDocumentBytes) ||
        complexityDiagnostic(docId, src, deps.complexityLimits, "read") !== undefined
          ? undefined
          : tryParse(src);
      if (parsed === undefined) lastTree.delete(docId);
      else lastTree.set(docId, parsed);
    },

    async handle(watchPath) {
      const docId = toDocId(watchPath);
      if (docId === undefined) return undefined;

      let src: string | undefined;
      try {
        src = await deps.storage.read(docId);
      } catch (err) {
        // A path that is not a valid document id, or resolves outside the
        // workspace (a symlink), is not a document.
        const code = (err as { code?: unknown } | null)?.code;
        if (code === "E_PATH_OUTSIDE_ROOT" || code === "E_INVALID_ID") return undefined;
        throw err;
      }
      if (src === undefined) return undefined; // deleted outside the pipeline; nothing to event
      const version = docVersion(src);
      if (lastVersion.get(docId) === version) {
        return { docId, suppressed: true, external: false, events: [], diagnostics: [] };
      }

      // Over the size or a complexity limit: not parsed, so there is nothing
      // to diff or event. The last parsed tree stays as the baseline for the
      // next edit that fits. A parse that throws is treated the same way.
      const tooLarge = overLimit(docId, src);
      if (tooLarge !== undefined) {
        lastVersion.set(docId, version);
        return { docId, suppressed: false, external: true, events: [], diagnostics: [tooLarge] };
      }

      let parsed: ParsedDoc;
      try {
        parsed = parseDoc(src, deps.parseOptions);
      } catch (err) {
        lastVersion.set(docId, version);
        const failed = parseFailedDiagnostic(docId, err);
        return { docId, suppressed: false, external: true, events: [], diagnostics: [failed] };
      }
      const before = lastTree.get(docId) ?? parseDoc("", deps.parseOptions);
      const diff = diffDocs(before, parsed);
      const writer = { kind: "human", id: deps.externalWriterId ?? "external" } as const;
      const drafts: EventDraft[] = synthesizeEvents(diff, docId, {
        clock: deps.clock,
        blockTypes: deps.blockTypes,
      }).map((draft) => ({ ...draft, by: writer }));

      const sink = deps.storage.defaultEventSink?.();
      const records: EventRecord[] = [];
      if (sink !== undefined) {
        for (const draft of drafts) records.push(await sink.append(draft));
      }

      lastVersion.set(docId, version);
      lastTree.set(docId, parsed);
      return {
        docId,
        suppressed: false,
        external: true,
        events: records,
        diagnostics: parsed.diagnostics,
      };
    },
  };
}
