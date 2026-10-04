import type { DocId } from "../model/ids.js";
import type { SourceRef } from "../model/refs.js";

/** A resolved live value (the normalized internal shape). Failures mark stale instead of throwing. */
export interface SourceValue {
  /** The resolved value text (or a degradation marker when stale). */
  readonly value: string;
  /** True when resolution failed and `value` is a degradation marker, not real data. */
  readonly stale: boolean;
}

/**
 * Storage: where document bytes live. Atomic replace of a document's content is
 * the adapter's obligation (the fs default uses temp + fsync + rename).
 */
export interface Storage {
  /**
   * Read a document's source.
   * @param docId The document to read.
   * @returns The raw source, or `undefined` when the document does not exist.
   */
  read(docId: DocId): Promise<string | undefined>;
  /**
   * Atomically replace a document's content.
   * @param docId The document to write.
   * @param content The new raw source.
   */
  writeAtomic(docId: DocId, content: string): Promise<void>;
  /**
   * Optional: a document's stored size in bytes, without reading it. The
   * engine calls it before reading a document it may have to refuse, so a
   * stored document over `maxDocumentBytes` is diagnosed without being loaded
   * into memory. The size must not exceed the UTF-8 byte length of the
   * source `read` returns, since a document is refused on its size alone: the
   * byte size of a file read as UTF-8 meets this (decoding never shortens it).
   *
   * Return `undefined` when the document does not exist or its size is not
   * known: the engine then reads it and measures the source, as it does for a
   * storage without `size`. A size within the limit is always followed by a
   * read, which checks the source itself, so a size that is too small costs
   * nothing but the call. A `size` that throws is treated as unknown.
   * @param docId The document to measure.
   * @returns Its size in bytes, or `undefined` when missing or unknown.
   */
  size?(docId: DocId): Promise<number | undefined>;
  /**
   * Delete a document (used by `removeDoc`); a missing document is a no-op.
   * @param docId The document to delete.
   */
  delete?(docId: DocId): Promise<void>;
  /** @returns All document ids currently in the workspace. */
  list(): Promise<DocId[]>;
  /**
   * Optional default lock adapter, used to serialize writes per document.
   * @param docId The document to lock.
   * @returns A lock for that document.
   */
  defaultLock?(docId: DocId): Lock;
  /** @returns The default event sink the engine appends commit events to. */
  defaultEventSink?(): EventSink;
  /**
   * The workspace root directory, set by filesystem-backed storage adapters.
   * `EngineOptions.watch: true` resolves its watch root from here; in-memory
   * storage leaves it absent, so `watch: true` is a programming error there.
   */
  readonly rootDir?: string;
}

/** Mutual exclusion spanning a write pipeline's critical section. */
export interface Lock {
  /**
   * Run `fn` while holding the lock, releasing it when `fn` settles (success
   * or failure).
   * @param fn The critical-section work to run under the lock.
   * @returns The value `fn` resolves to.
   */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Where an event sits in the commit that appended it. One commit (a write, a
 * patch, an intent, a create, an import, a remove, or one handled external
 * write) appends its events in order; each carries the same `id`, its
 * position `index` (0-based), and the commit's event count `size`. The event
 * with `index === size - 1` closes the commit. Commits on different documents
 * can run at the same time, so their records may interleave in the log: group
 * records by `id`, not by position. Within one commit the records keep their
 * order. Every event of a commit has the same `docId`, so a subscriber scoped
 * to a document sees whole commits.
 */
export interface CommitInfo {
  /**
   * The commit's id, unique per event log: `<docId>@<version>#<prefix>.<n>`
   * from an engine, where `version` is the committed content's hash (the
   * removed content's for `doc.removed`), `prefix` identifies the engine
   * (random unless `EngineOptions.commitIdPrefix` pins it), and `n` counts
   * that engine's commits from 1. Treat it as opaque except for grouping.
   */
  readonly id: string;
  /** The event's position in its commit, from 0. */
  readonly index: number;
  /** How many events the commit appended. */
  readonly size: number;
}

/** An append-only event record; `seq` is assigned monotonically by the sink. */
export interface EventRecord {
  /** Monotonic sequence number assigned by the sink at append time. */
  readonly seq: number;
  /** Event timestamp from the engine's Clock. */
  readonly t: string;
  /** Event name, e.g. `"status.changed"`. */
  readonly type: string;
  /**
   * The commit this event belongs to. Every event the engine appends carries
   * it; a record from an older log, or one a host appended by hand, may not.
   */
  readonly commit?: CommitInfo;
  /** Type-specific payload fields (docId, blockId, from/to, …), carried on the top level. */
  readonly [key: string]: unknown;
}

/** An event record before the sink assigns `seq` (payload fields ride on the top level). */
export type EventDraft = {
  /** Event timestamp from the engine's Clock. */
  readonly t: string;
  /** Event name, e.g. `"status.changed"`. */
  readonly type: string;
  /** The commit this event belongs to (stamped by the engine when it appends). */
  readonly commit?: CommitInfo;
  /** Type-specific payload fields, carried on the top level. */
  readonly [key: string]: unknown;
};

/** An append-only event log the engine writes commit events to. */
export interface EventSink {
  /**
   * Append one event draft; the sink assigns `seq`.
   * @param record The event without a sequence number.
   * @returns The full record including its assigned `seq`.
   */
  append(record: EventDraft): Promise<EventRecord>;
  /**
   * Optional replay: read records with `seq > afterSeq`, in sequence order.
   * @param opts The cursor; only records newer than `afterSeq` are returned.
   * @returns Records newer than the cursor, in sequence order (empty when none).
   */
  read?(opts: { readonly afterSeq: number }): Promise<EventRecord[]>;
}

/** Timestamp source, returning an ISO-8601-ish string (injectable for tests/determinism). */
export type Clock = () => string;

/**
 * Call-scoped evaluation of `{{source:…}}` references. Passed per projection
 * call, not fixed at engine construction, so different projections can resolve
 * the same reference against different data.
 */
export interface Source {
  /**
   * Resolve one source reference to a live value.
   * @param ref The reference to resolve (its source id and params).
   * @returns The resolved value as a plain string, or as `{ value, stale? }`
   * where `stale: true` degrades the value instead of throwing. An omitted
   * `stale` means `false`.
   */
  resolve(ref: SourceRef): Promise<string | { readonly value: string; readonly stale?: boolean }>;
}
