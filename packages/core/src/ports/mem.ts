import path from "node:path";
import { Volume } from "memfs";
import { asDocId, type DocId } from "../model/ids.js";
import type { EventDraft, EventRecord, EventSink, Storage } from "./ports.js";

const EXT = ".md";

/**
 * In-memory Storage/Lock/EventSink over a memfs Volume — for tests and for
 * hosts that want a non-durable workspace. Path layout mirrors the fs adapter.
 */
export interface MemStorageOptions {
  /** The memfs volume to back the workspace; defaults to a fresh in-memory Volume. */
  volume?: Volume;
  /** Event log path relative to the volume root; defaults to `"events.jsonl"`. */
  eventsPath?: string;
}

/** A non-durable in-memory workspace Storage (with lock and event sink). */
export interface MemStorage extends Storage {
  /**
   * The events appended so far, in append order (a convenience for tests and
   * short-lived in-memory workspaces).
   * @returns A copy of the in-memory event log.
   */
  getEvents(): EventRecord[];
}

/**
 * Create a non-durable in-memory Storage backed by a memfs volume, including a
 * default lock and event sink. Documents live at `<docId>.md` paths under the
 * volume root, mirroring the fs adapter's layout.
 * @param opts Configuration; every field is optional and defaults are non-durable.
 * @returns An in-memory Storage with lock, event sink, and a `getEvents()` helper.
 * @example
 * ```ts
 * const storage = createMemStorage();
 * const engine = createEngine({ storage });
 * ```
 */
export function createMemStorage(opts: MemStorageOptions = {}): MemStorage {
  const volume = opts.volume ?? new Volume();
  const fs = volume.promises;
  const eventsPath = path.join("/", opts.eventsPath ?? "events.jsonl");
  const events: EventRecord[] = [];
  // Per-docId lock queues live at the storage level so that two separate
  // defaultLock(docId) calls for the same document still mutually exclude.
  const queues = new Map<string, Promise<unknown>>();
  let seq = 0;

  const docPath = (docId: DocId): string => path.join("/", `${docId}${EXT}`);

  return {
    async read(docId) {
      try {
        return (await fs.readFile(docPath(docId), "utf8")) as string;
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw err;
      }
    },

    async size(docId) {
      try {
        const st = await fs.stat(docPath(docId));
        return st.isFile() ? Number(st.size) : undefined;
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw err;
      }
    },

    async writeAtomic(docId, content) {
      await fs.mkdir(path.dirname(docPath(docId)), { recursive: true });
      await fs.writeFile(docPath(docId), content);
    },

    async delete(docId) {
      try {
        await fs.unlink(docPath(docId));
      } catch (err) {
        if (!(err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT")) throw err;
      }
    },

    async list() {
      const out: DocId[] = [];
      async function walk(dir: string): Promise<void> {
        let entries: Awaited<ReturnType<typeof fs.readdir>>;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return; // missing dir
        }
        for (const entry of entries) {
          if (typeof entry === "string" || Buffer.isBuffer(entry)) continue; // dirents expected
          const name = String(entry.name);
          const full = path.join(dir, name);
          if (entry.isDirectory()) {
            await walk(full);
            continue;
          }
          if (name.endsWith(EXT)) {
            out.push(asDocId(path.relative("/", full).slice(0, -EXT.length)));
          }
        }
      }
      await walk("/");
      return out.sort();
    },

    defaultLock(docId) {
      return {
        async withLock<T>(fn: () => Promise<T>): Promise<T> {
          const prev = queues.get(docId) ?? Promise.resolve();
          let release: () => void = () => {};
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          queues.set(
            docId,
            prev.then(() => gate),
          );
          await prev;
          try {
            return await fn();
          } finally {
            release();
          }
        },
      };
    },

    defaultEventSink(): EventSink {
      return {
        async append(record: EventDraft): Promise<EventRecord> {
          seq += 1;
          const full: EventRecord = { ...record, seq };
          events.push(full);
          await fs.mkdir(path.dirname(eventsPath), { recursive: true });
          await fs.appendFile(eventsPath, `${JSON.stringify(full)}\n`);
          return full;
        },
        async read(opts) {
          return events.filter((record) => record.seq > opts.afterSeq);
        },
      };
    },

    getEvents() {
      return [...events];
    },
  };
}
