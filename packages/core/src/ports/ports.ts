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
 * write) appends its events one after another; each carries the same `id`,
 * its position `index` (0-based), and the commit's event count `size`. The
 * event with `index === size - 1` closes the commit, so a subscriber can
 * re-render once per commit, and a log reader can group records exactly.
 */
export interface CommitInfo {
  /**
   * The commit's id: `<docId>@<version>#<n>`, where `version` is the committed
   * content's hash (the removed content's for `doc.removed`) and `n` counts
   * the engine's commits from 1. Unique within one engine instance and the
   * same for the same sequence of writes (no clock or randomness); a new
   * engine starts counting again, so across restarts group by consecutive
   * records rather than by id alone.
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
