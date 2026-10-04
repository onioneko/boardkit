import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { asDocId, type DocId, tryDocId } from "../model/ids.js";
import type { EventDraft, EventRecord, EventSink, Lock, Storage } from "./ports.js";

const EXT = ".md";

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function outsideRoot(docId: string): Error {
  return Object.assign(
    new Error(`document id ${JSON.stringify(docId)} resolves outside the storage root`),
    {
      code: "E_PATH_OUTSIDE_ROOT",
    },
  );
}

/** Absolute path for an id, refusing (lexically) anything that leaves the root. */
function containedPath(root: string, docId: string, suffix: string): string {
  const valid = tryDocId(docId);
  if (!valid.ok) {
    throw Object.assign(new Error(valid.diagnostic.message), { code: "E_INVALID_ID" });
  }
  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, `${docId}${suffix}`);
  if (target === absRoot || !isInside(absRoot, target)) throw outsideRoot(docId);
  return target;
}

/**
 * Real path of `p`, or of its deepest existing ancestor joined with the
 * missing remainder. A dangling symlink is followed to its target so it cannot
 * smuggle a write out of the root.
 */
async function realOfDeepest(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    let link: string | undefined;
    try {
      if ((await lstat(p)).isSymbolicLink()) link = await readlink(p);
    } catch {
      // not present at all: fall through to the ancestor walk
    }
    if (link !== undefined) {
      return realOfDeepest(path.resolve(await realOfDeepest(path.dirname(p)), link));
    }
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(await realOfDeepest(parent), path.basename(p));
  }
}

/** Confirm the real (symlink-resolved) location of `target` is inside the real root. */
async function assertRealInside(root: string, target: string, docId: string): Promise<void> {
  const realRoot = await realOfDeepest(path.resolve(root));
  if (!isInside(realRoot, await realOfDeepest(target))) throw outsideRoot(docId);
}

async function docPath(root: string, docId: DocId): Promise<string> {
  const target = containedPath(root, docId, EXT);
  await assertRealInside(root, target, docId);
  return target;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Create a file-backed lock using proper-lockfile (cross-process, with stale-lock
 * detection). The lock file's parent directory is created first (recursive) so a
 * nested document's first write can lock before its directory exists — matching
 * `writeAtomic`'s own mkdir behavior. Fail-soft: if the mkdir itself fails, the
 * lock attempt below surfaces the same error it would have without this step.
 * @param lockPath The lock file path.
 * @returns A Lock that serializes concurrent critical sections on that path.
 */
export function createLock(lockPath: string): Lock {
  return {
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      try {
        await mkdir(path.dirname(lockPath), { recursive: true });
      } catch {
        // The lock attempt is the authoritative failure path: if the parent
        // directory cannot be created, `lockfile.lock` surfaces that error.
      }
      const release = await lockfile.lock(lockPath, {
        realpath: false,
        stale: 30_000,
        retries: { retries: 20, factor: 1.2, minTimeout: 20, maxTimeout: 500 },
      });
      try {
        return await fn();
      } finally {
        await release();
      }
    },
  };
}

/**
 * Create a JSONL event sink; `seq` is a per-process counter seeded from the
 * number of existing lines in the file at first use. The sink has no clock of
 * its own: every record's `t` arrives on the draft, stamped by the engine's
 * clock at synthesis.
 * @param eventsPath The JSONL file to append to.
 * @returns An EventSink that appends one JSON object per line and supports replay.
 */
export function createFsEventSink(eventsPath: string): EventSink {
  let seq = 0;
  let seeded = false;

  async function seed(): Promise<void> {
    if (seeded) return;
    seeded = true;
    try {
      const content = await readFile(eventsPath, "utf8");
      seq = content.split("\n").filter((l) => l.length > 0).length;
    } catch {
      seq = 0; // missing file: start from zero
    }
  }

  return {
    async append(record: EventDraft): Promise<EventRecord> {
      await seed();
      await mkdir(path.dirname(eventsPath), { recursive: true });
      seq += 1;
      const full: EventRecord = { ...record, seq };
      await appendFile(eventsPath, `${JSON.stringify(full)}\n`, "utf8");
      return full;
    },

    async read(opts) {
      await seed();
      try {
        const content = await readFile(eventsPath, "utf8");
        return content
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line): EventRecord => JSON.parse(line) as EventRecord)
          .filter((record) => record.seq > opts.afterSeq);
      } catch {
        return [];
      }
    },
  };
}

/** Configuration for the local-filesystem workspace Storage. */
export interface FsStorageOptions {
  /** Workspace root directory; documents live at `<root>/<docId>.md`. */
  root: string;
  /** Event log path relative to root; defaults to `"events.jsonl"`. */
  eventsPath?: string;
}

/**
 * Create a durable workspace Storage over the local filesystem. Documents are
 * stored at `<root>/<docId>.md`; writes are atomic (temp + fsync + rename) and
 * a per-document lock and JSONL event sink are provided by default. Storage
 * takes no clock: event timestamps come from the engine's clock, on the drafts
 * it hands the sink.
 *
 * Every id-derived path (read, write, delete, lock) stays inside `root`. An id
 * that is not a valid document id is refused with an error whose `code` is
 * `"E_INVALID_ID"`; an id whose real path, after resolving symlinks, lies
 * outside the root is refused with `"E_PATH_OUTSIDE_ROOT"`, with no document
 * read or write (only file metadata is inspected). `list()` omits symlinks that
 * point outside the root, and any it cannot resolve. Containment is checked before each operation, so a local process that can already write
 * inside `root` and swaps a symlink between the check and the access is outside
 * the threat model: the guarantee is against document content and API input,
 * not against local users with write access to the workspace. Ids use `/`
 * separators; Windows path separators are not supported yet.
 * @param opts Configuration; only `root` is required.
 * @returns A filesystem-backed Storage with lock and event sink adapters.
 */
export function createFsStorage(opts: FsStorageOptions): Storage {
  const root = opts.root;
  const eventsPath = path.join(root, opts.eventsPath ?? "events.jsonl");

  return {
    rootDir: root,

    async read(docId) {
      try {
        return await readFile(await docPath(root, docId), "utf8");
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw err;
      }
    },

    async writeAtomic(docId, content) {
      const target = await docPath(root, docId);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFileAtomic(target, content);
    },

    async delete(docId) {
      await rm(await docPath(root, docId), { force: true });
    },

    async list() {
      const out: DocId[] = [];
      async function walk(dir: string): Promise<void> {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            // A link is listed only when it resolves inside the root; one that
            // cannot be resolved at all (a loop, a permission error) is skipped.
            try {
              await assertRealInside(root, full, entry.name);
            } catch {
              continue;
            }
          }
          if (entry.isDirectory()) {
            await walk(full);
            continue;
          }
          if (entry.name.endsWith(EXT)) {
            const id = path.relative(root, full).slice(0, -EXT.length).split(path.sep).join("/");
            if (tryDocId(id).ok) out.push(asDocId(id));
          }
        }
      }
      try {
        await walk(root);
      } catch (err) {
        if (!isNotFound(err)) throw err; // missing workspace root = empty
      }
      return out.sort();
    },

    defaultLock(docId) {
      const lockPath = containedPath(root, docId, ".lock");
      const lock = createLock(lockPath);
      return {
        async withLock<T>(fn: () => Promise<T>): Promise<T> {
          await assertRealInside(root, lockPath, docId);
          return lock.withLock(fn);
        },
      };
    },

    defaultEventSink() {
      return createFsEventSink(eventsPath);
    },
  };
}
