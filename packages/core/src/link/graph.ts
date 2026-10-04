import type { Diagnostic } from "../model/diagnostic.js";
import { diagnostic } from "../model/diagnostic.js";
import type { ParsedDoc, Section } from "../model/doc.js";
import type { DocId, SectionId } from "../model/ids.js";
import {
  type ComplexityLimits,
  complexityDiagnostic,
  resolveComplexityLimits,
} from "../parse/complexity.js";
import type { ParseOptions } from "../parse/options.js";
import { parseDoc, parseFailedDiagnostic } from "../parse/pipeline.js";
import {
  DEFAULT_MAX_DOCUMENT_BYTES,
  documentSizeDiagnostic,
  sizeOverLimit,
} from "../parse/size.js";
import type { Storage } from "../ports/ports.js";

/** A document loaded into an aggregation graph, together with its parse result and raw source. */
export interface LoadedDoc {
  /** The document's id. */
  readonly docId: DocId;
  /** The document's parse result. */
  readonly parsed: ParsedDoc;
  /** Raw source bytes of the document (for span rewriting at projection time). */
  readonly src: string;
}

/**
 * Resolution status of one include edge. `duplicate` marks a later occurrence
 * of an already-included `doc#section`; it renders nothing and emits an
 * informational diagnostic. `missing-doc` also covers a target that could not
 * be read or parsed, or is over the document size limit or a complexity limit;
 * its diagnostic says which.
 */
export type IncludeStatus = "ok" | "missing-doc" | "missing-section" | "cycle" | "duplicate";

/** One resolved include edge: who included what, and whether it resolved. */
export interface ResolvedInclude {
  /** The document containing the `{{include:…}}` reference. */
  readonly fromDoc: DocId;
  /** The referenced document. */
  readonly toDoc: DocId;
  /** The referenced section, when the include names one. */
  readonly sectionId?: SectionId;
  /** Whether the edge resolved (`ok`) or how it failed. */
  readonly status: IncludeStatus;
}

/** The LINK stage result: reachable docs, resolved edges, and diagnostics. */
export interface LinkResult {
  /** All reachable docs — the board first, then depth-first discovery order. */
  readonly docs: readonly LoadedDoc[];
  /** Every resolved include edge (both `ok` and failed). */
  readonly includes: readonly ResolvedInclude[];
  /** Include-resolution problems (cycles, missing docs/sections, duplicates). */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * The prose sections of a parsed document (typed blocks excluded).
 * @param parsed The parsed document.
 * @returns Its sections, in document order.
 */
export function sectionsOf(parsed: ParsedDoc): Section[] {
  return parsed.nodes.filter((n): n is Section => "sectionId" in n);
}

/** Build a resolved include edge (omitting an absent sectionId per exactOptionalPropertyTypes). */
function edge(
  fromDoc: DocId,
  toDoc: DocId,
  sectionId: SectionId | undefined,
  status: IncludeStatus,
): ResolvedInclude {
  return {
    fromDoc,
    toDoc,
    ...(sectionId !== undefined ? { sectionId } : {}),
    status,
  };
}

/** How {@link resolveIncludes} parses and bounds the documents it loads. */
export interface LinkOptions {
  /**
   * Parse one reachable document. Defaults to `parseDoc(src, options)`; the
   * engine passes its content-keyed parse cache here, so a document is parsed
   * once per content rather than once per resolution pass.
   */
  readonly parse?: (docId: DocId, src: string) => ParsedDoc;
  /**
   * An existing parse of `src`, or `undefined`. A parse it returns is used
   * as is, without the size and complexity checks: the engine passes its parse
   * cache here, which only ever holds content that passed them.
   */
  readonly cached?: (docId: DocId, src: string) => ParsedDoc | undefined;
  /**
   * Called once per resolution pass for every document the pass read: with
   * its source when it was parsed (whether or not the pass then visited it,
   * as for the target of a `missing-section` include), or `undefined` when it
   * could not be loaded (missing, unreadable, outside the workspace, over a
   * limit, or a parse that threw). The engine uses it to notice documents
   * that changed behind its back.
   */
  readonly onRead?: (docId: DocId, src: string | undefined) => void;
  /**
   * Documents over this many UTF-8 bytes are not parsed: the board yields an
   * empty result and an include of one is left unexpanded, each with an
   * `E_DOCUMENT_TOO_LARGE` diagnostic. Defaults to `DEFAULT_MAX_DOCUMENT_BYTES` (256 KiB).
   */
  readonly maxDocumentBytes?: number;
  /**
   * Documents over a markdown complexity limit are not parsed, with the same
   * outcome as an oversized one and an `E_DOCUMENT_TOO_COMPLEX` diagnostic.
   * Absent takes `DEFAULT_COMPLEXITY_LIMITS`; `false` turns the check off.
   * An invalid value is a programming error: `resolveIncludes` rejects with a
   * `TypeError`.
   */
  readonly complexityLimits?: ComplexityLimits | false;
}

/**
 * Resolve the include graph rooted at a board document: loads reachable docs,
 * checks include targets, detects cycles, dedupes repeated `doc#section`
 * references, and reports everything through diagnostics (fail-soft, never
 * throws for content errors). A document whose parse throws is reported with
 * an `E_PARSE_FAILED` diagnostic: as the board it contributes no documents or
 * edges, and as an include target its edge is `missing-doc`. A read error on
 * the board itself (other than a path outside the workspace) is rethrown.
 * @param boardDocId The document whose include graph is resolved.
 * @param storage Where documents are read from.
 * @param options Parse options used to parse each reachable document.
 * @param link How documents are parsed and the size limit they must fit.
 * @returns The reachable docs, resolved edges, and diagnostics.
 */
export async function resolveIncludes(
  boardDocId: DocId,
  storage: Storage,
  options: ParseOptions = {},
  link: LinkOptions = {},
): Promise<LinkResult> {
  const parse = link.parse ?? ((_docId: DocId, src: string) => parseDoc(src, options));
  const maxDocumentBytes = link.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const complexityLimits = resolveComplexityLimits(link.complexityLimits);
  // The limit checks once per document per pass, like its read and parse:
  // the complexity scan is linear in the document, and a document named by
  // many includes would otherwise be scanned once per include.
  const limitChecks = new Map<DocId, Diagnostic | null>();
  const overLimit = (id: DocId, src: string): Diagnostic | undefined => {
    let checked = limitChecks.get(id);
    if (checked === undefined) {
      checked =
        documentSizeDiagnostic(id, src, maxDocumentBytes, "read") ??
        complexityDiagnostic(id, src, complexityLimits, "read") ??
        null;
      limitChecks.set(id, checked);
    }
    return checked ?? undefined;
  };
  const docs = new Map<DocId, LoadedDoc>();
  const includes: ResolvedInclude[] = [];
  const diagnostics: Diagnostic[] = [];
  const visiting = new Set<DocId>();
  const visited = new Set<DocId>();
  const order: DocId[] = [];
  // Dedup keys: "docId#sectionId" for section includes, "docId#" for whole-doc includes.
  const seen = new Set<string>();

  const isOutsideRoot = (err: unknown): boolean =>
    (err as { code?: unknown } | null)?.code === "E_PATH_OUTSIDE_ROOT";
  const outsideRootDiagnostic = (id: DocId): Diagnostic =>
    diagnostic(
      "E_INCLUDE_OUTSIDE_ROOT",
      `document ${JSON.stringify(id)} resolves outside the workspace and was not read`,
      { nodeId: id },
    );

  // One read and one parse per document for the whole pass: a document named
  // by many includes (duplicates, or many sections of it) is fetched and
  // parsed once, and every include sees the same snapshot of it.
  // A document whose `Storage.size` is over the limit is not read: `tooLarge`
  // carries its diagnostic in place of the source.
  type ReadResult =
    | { readonly ok: true; readonly src: string | undefined; readonly tooLarge?: undefined }
    | { readonly ok: true; readonly src: undefined; readonly tooLarge: Diagnostic }
    | { readonly ok: false; readonly err: unknown };
  const reads = new Map<DocId, ReadResult>();
  const noted = new Set<DocId>();
  const note = (id: DocId, src: string | undefined): void => {
    if (link.onRead === undefined || noted.has(id)) return;
    noted.add(id);
    link.onRead(id, src);
  };
  const parses = new Map<DocId, ParsedDoc | Diagnostic>();
  const sectionIds = new Map<DocId, ReadonlySet<SectionId>>();

  async function read(id: DocId): Promise<ReadResult> {
    const cached = reads.get(id);
    if (cached !== undefined) return cached;
    let result: ReadResult;
    const tooLarge = await sizeOverLimit(storage, id, maxDocumentBytes);
    if (tooLarge !== undefined) {
      result = { ok: true, src: undefined, tooLarge };
    } else {
      try {
        result = { ok: true, src: await storage.read(id) };
      } catch (err) {
        result = { ok: false, err };
      }
    }
    reads.set(id, result);
    // A source that was read is noted when it is loaded (or fails to load).
    if (!result.ok || result.src === undefined) note(id, undefined);
    return result;
  }

  /** The document's parse, or the `E_PARSE_FAILED` diagnostic when the parser threw. */
  function parsedOf(id: DocId, src: string): ParsedDoc | Diagnostic {
    let parsed = parses.get(id);
    if (parsed === undefined) {
      try {
        parsed = parse(id, src);
      } catch (err) {
        parsed = parseFailedDiagnostic(id, err);
      }
      parses.set(id, parsed);
    }
    return parsed;
  }

  /**
   * The document's parse, or the diagnostic that kept it from being parsed:
   * over the size or a complexity limit, or a parse that threw. An existing
   * parse (`link.cached`) skips the checks.
   */
  function load(id: DocId, src: string): ParsedDoc | Diagnostic {
    const known = parses.get(id) ?? link.cached?.(id, src);
    if (known !== undefined) {
      parses.set(id, known);
      note(id, src);
      return known;
    }
    const loaded = overLimit(id, src) ?? parsedOf(id, src);
    note(id, "nodes" in loaded ? src : undefined);
    return loaded;
  }

  function hasSection(id: DocId, parsed: ParsedDoc, sectionId: SectionId): boolean {
    let ids = sectionIds.get(id);
    if (ids === undefined) {
      ids = new Set(sectionsOf(parsed).map((s) => s.sectionId));
      sectionIds.set(id, ids);
    }
    return ids.has(sectionId);
  }

  async function visit(docId: DocId): Promise<void> {
    if (visited.has(docId) || visiting.has(docId)) return;
    visiting.add(docId);

    const own = await read(docId);
    if (!own.ok) {
      if (!isOutsideRoot(own.err)) throw own.err;
      diagnostics.push(outsideRootDiagnostic(docId));
      visiting.delete(docId);
      return;
    }
    if (own.tooLarge !== undefined) {
      diagnostics.push(own.tooLarge);
      visiting.delete(docId);
      return;
    }
    const src = own.src;
    if (src === undefined) {
      if (docId === boardDocId) {
        diagnostics.push(diagnostic("E_BOARD_MISSING", `board document not found: ${docId}`));
      }
      visiting.delete(docId);
      return;
    }
    // Includes of an oversized, over-complex or unparseable document are
    // diagnosed before they get here; this catches the board itself.
    const parsed = load(docId, src);
    if (!("nodes" in parsed)) {
      diagnostics.push(parsed);
      visiting.delete(docId);
      return;
    }
    docs.set(docId, { docId, parsed, src });
    order.push(docId);

    for (const ref of parsed.refs) {
      if (ref.kind !== "include") continue;

      if (visiting.has(ref.docId)) {
        includes.push(edge(docId, ref.docId, ref.sectionId, "cycle"));
        diagnostics.push(
          diagnostic("E_INCLUDE_CYCLE", `include cycle: ${docId} → ${ref.docId}`, {
            nodeId: ref.docId,
          }),
        );
        continue;
      }

      const target = await read(ref.docId);
      if (!target.ok) {
        const err = target.err;
        includes.push(edge(docId, ref.docId, ref.sectionId, "missing-doc"));
        diagnostics.push(
          isOutsideRoot(err)
            ? outsideRootDiagnostic(ref.docId)
            : diagnostic(
                "E_INCLUDE_UNREADABLE",
                `included document ${JSON.stringify(ref.docId)} could not be read: ${
                  err instanceof Error ? err.message : String(err)
                }`,
                { nodeId: ref.docId },
              ),
        );
        continue;
      }
      if (target.tooLarge !== undefined) {
        includes.push(edge(docId, ref.docId, ref.sectionId, "missing-doc"));
        diagnostics.push(target.tooLarge);
        continue;
      }
      const targetSrc = target.src;
      if (targetSrc === undefined) {
        includes.push(edge(docId, ref.docId, ref.sectionId, "missing-doc"));
        diagnostics.push(
          diagnostic("E_INCLUDE_MISSING_DOC", `included document not found: ${ref.docId}`, {
            nodeId: ref.docId,
          }),
        );
        continue;
      }

      // Too large or too complex to parse, or its parse threw: the include
      // stays verbatim, like a missing document.
      const targetParsed = load(ref.docId, targetSrc);
      if (!("nodes" in targetParsed)) {
        includes.push(edge(docId, ref.docId, ref.sectionId, "missing-doc"));
        diagnostics.push(targetParsed);
        continue;
      }

      if (ref.sectionId !== undefined) {
        if (!hasSection(ref.docId, targetParsed, ref.sectionId)) {
          includes.push(edge(docId, ref.docId, ref.sectionId, "missing-section"));
          diagnostics.push(
            diagnostic(
              "E_INCLUDE_MISSING_SECTION",
              `section not found: ${ref.docId}#${ref.sectionId}`,
              {
                nodeId: ref.sectionId,
              },
            ),
          );
          continue;
        }
      }

      // Dedup: the same doc#section keeps its first position; later
      // occurrences become informational diagnostics and are not expanded.
      const dedupKey = `${ref.docId}#${ref.sectionId ?? ""}`;
      if (seen.has(dedupKey)) {
        includes.push(edge(docId, ref.docId, ref.sectionId, "duplicate"));
        diagnostics.push(
          diagnostic(
            "E_INCLUDE_DUPLICATE",
            `duplicate include of ${ref.docId}${ref.sectionId !== undefined ? `#${ref.sectionId}` : ""}`,
            { nodeId: ref.docId },
          ),
        );
        continue;
      }
      seen.add(dedupKey);

      includes.push(edge(docId, ref.docId, ref.sectionId, "ok"));
      await visit(ref.docId);
    }

    visiting.delete(docId);
    visited.add(docId);
  }

  await visit(boardDocId);
  return { docs: order.map((id) => docs.get(id) as LoadedDoc), includes, diagnostics };
}

/**
 * Build a reverse include index: docId → the set of documents that directly
 * include it (direct `ok` edges only). Transitive closures are computed by
 * consumers, e.g. dependency-scoped subscriptions.
 * @param includes The resolved include edges.
 * @returns A map from each included document to its direct includers.
 */
export function buildReverseIndex(
  includes: readonly ResolvedInclude[],
): Map<DocId, ReadonlySet<DocId>> {
  const index = new Map<DocId, Set<DocId>>();
  for (const edge of includes) {
    if (edge.status !== "ok") continue;
    let set = index.get(edge.toDoc);
    if (set === undefined) {
      set = new Set();
      index.set(edge.toDoc, set);
    }
    set.add(edge.fromDoc);
  }
  return new Map([...index.entries()].map(([docId, set]) => [docId, set as ReadonlySet<DocId>]));
}

/**
 * What {@link resolveIncludes} reads from a parsed document, as a comparable
 * string: its include references in order and its section ids. Two parses
 * with the same shape resolve to the same include edges, so a write that keeps
 * a document's shape cannot change any include graph it is part of.
 * @param parsed The parsed document.
 * @returns The shape.
 */
export function includeShape(parsed: ParsedDoc): string {
  const refs: string[] = [];
  for (const ref of parsed.refs) {
    if (ref.kind === "include") refs.push(`${ref.docId}#${ref.sectionId ?? ""}`);
  }
  return JSON.stringify([refs, sectionsOf(parsed).map((s) => s.sectionId)]);
}
