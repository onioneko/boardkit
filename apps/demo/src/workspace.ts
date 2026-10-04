/**
 * The workbench's workspace: a real directory on disk plus the engine that owns
 * it. Opening is idempotent — a root that already holds `fin.md` is opened as
 * is, so documents and `events.jsonl` survive a restart and the log continues
 * where it stopped; an empty root (or one just emptied by `reset`) is seeded
 * with the three canonical fixtures through `createDoc`, which is what puts the
 * `doc.created` events in the log.
 *
 * Everything the workbench's flags select is decided here: whether the watcher
 * runs, which source it uses, and whether the humans-only guard is installed.
 */
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { starterBlocks } from "@onioneko/boardkit-blocks";
import {
  type Clock,
  createEngine,
  createFsStorage,
  type Engine,
  type WatchOptions,
  type WatchSource,
} from "@onioneko/boardkit-core";
import { htmlProjector } from "@onioneko/boardkit-html";
import { humansOnlyExecute, maskCashForGuests } from "./middleware.js";
import {
  EXTERNAL_WRITER_ID,
  FIN_DOC,
  loadFixtures,
  OVERVIEW_DOC,
  Q3_DOC,
  seedWriter,
} from "./shared.js";

/** How to open a workspace root. */
export interface OpenWorkspaceOptions {
  /** The workspace root directory; created when it does not exist. */
  readonly rootDir: string;
  /** Empty the root before opening it (a reseed from the fixtures). */
  readonly reset?: boolean;
  /** Install the humans-only write guard; `false` leaves the write chain empty. */
  readonly guard?: boolean;
  /** Timestamp source for events; defaults to the engine's wall clock. */
  readonly clock?: Clock;
  /** `false` disables external-write watching entirely. */
  readonly watch?: boolean;
  /** Watch source override; tests pass a no-op source instead of chokidar. */
  readonly watchSource?: WatchSource;
}

/** An opened workspace: where it lives, the engine over it, and whether this call seeded it. */
export interface OpenedWorkspace {
  /** The workspace root directory. */
  readonly rootDir: string;
  /** The engine owning that directory. */
  readonly engine: Engine;
  /** True when this call seeded the three canonical documents. */
  readonly seeded: boolean;
}

/** The event log a workspace keeps at the top of its root. */
const EVENTS_LOG = "events.jsonl";

/**
 * Refuse to empty a directory that is not a BoardKit workspace.
 *
 * This is the one precondition in the workbench that is a *throw* rather than a
 * value: `--reset` deletes, and a mistyped `--root` is not something a rejection
 * value further down the pipeline can undo. A workspace always shows either its
 * event log or at least one markdown document at the top level; a directory
 * with contents and neither is somebody else's.
 * @param rootDir The root the caller asked to reset (named in the message).
 * @param entries Its top-level entries.
 * @throws Error when the root holds entries and looks like nothing this
 *   workbench wrote.
 */
function assertResettable(rootDir: string, entries: readonly string[]): void {
  if (entries.length === 0) return;
  if (entries.includes(EVENTS_LOG) || entries.some((entry) => entry.endsWith(".md"))) return;
  throw new Error(
    `refusing --reset: ${rootDir} holds ${entries.length} entries and is not a BoardKit workspace`,
  );
}

/**
 * Remove every entry inside `rootDir` while keeping the directory itself — the
 * root may be the user's own `--root`, and an editor watching it should not see
 * it disappear and come back.
 */
async function emptyDir(rootDir: string, entries: readonly string[]): Promise<void> {
  for (const entry of entries) {
    await rm(path.join(rootDir, entry), { recursive: true, force: true });
  }
}

/**
 * Resolve the engine's watch option. `watch: false` turns watching off (external
 * writes become no-ops); otherwise the root is watched with the `editor` writer
 * id, through the shipped chokidar source unless a source is supplied.
 */
function watchOption(opts: OpenWorkspaceOptions): false | WatchOptions {
  if (opts.watch === false) return false;
  return {
    rootDir: opts.rootDir,
    externalWriterId: EXTERNAL_WRITER_ID,
    ...(opts.watchSource !== undefined ? { source: opts.watchSource } : {}),
  };
}

/**
 * Open (and if needed create and seed) a workspace root and the engine over it.
 * @param opts The root to open plus the reset/guard/watch/clock selections.
 * @returns The opened workspace: root, engine, and whether it was seeded here.
 * @throws Error when `reset` is set on a directory that is not a BoardKit
 *   workspace — a startup precondition, checked before anything is removed.
 */
export async function openWorkspace(opts: OpenWorkspaceOptions): Promise<OpenedWorkspace> {
  const rootDir = opts.rootDir;
  await mkdir(rootDir, { recursive: true });
  if (opts.reset === true) {
    const entries = await readdir(rootDir);
    assertResettable(rootDir, entries);
    await emptyDir(rootDir, entries);
  }

  const engine = createEngine({
    storage: createFsStorage({ root: rootDir }),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    blocks: starterBlocks,
    watch: watchOption(opts),
    middleware: {
      write: opts.guard === false ? [] : [humansOnlyExecute],
      projection: [maskCashForGuests],
    },
  });

  // The engine ships `text` as its only default projector; the workbench serves
  // `?format=html` too, so it registers that one itself.
  engine.registerProjector(htmlProjector);

  const seeded = (await engine.getDoc(FIN_DOC)) === undefined;
  if (seeded) {
    const { fin, q3review, overview } = loadFixtures();
    await engine.createDoc(FIN_DOC, { writer: seedWriter, content: fin });
    await engine.createDoc(Q3_DOC, { writer: seedWriter, content: q3review });
    await engine.createDoc(OVERVIEW_DOC, { writer: seedWriter, content: overview });
  }

  return { rootDir, engine, seeded };
}
