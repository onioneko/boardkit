# Storage and watch

`Storage` is the port where document bytes, the write lock, and the event sink live — everything
about *where things persist*, distinct from the engine's read and write pipelines. Two adapters
ship with `@onioneko/boardkit-core`: an in-memory one for tests and ephemeral hosts, and a filesystem one
for a durable workspace.

## `createMemStorage` — in memory, non-durable

```ts
import { createEngine, createMemStorage } from "@onioneko/boardkit-core";

const engine = createEngine({ storage: createMemStorage() });
```

Backed by an in-process [memfs](https://github.com/streamich/memfs) volume — nothing touches
real disk. Documents live at `<docId>.md` paths inside it, mirroring the filesystem adapter's own
layout; its lock is a per-`docId` promise queue, and its event sink keeps events in an array in
memory. `MemStorage` (the return type) adds one extra method beyond the `Storage` port:
`getEvents()`, a convenience copy of everything appended so far, handy in tests and short-lived
scripts. Nothing here survives the process — recreate the engine and the workspace is gone.

## `createFsStorage` — a durable workspace

```ts
import { createEngine, createFsStorage } from "@onioneko/boardkit-core";

const engine = createEngine({ storage: createFsStorage({ root: "./workspace" }) });
```

Workspace layout on disk, under `root`:

- **`<docId>.md`** — one file per document, `writeAtomic`'d in place. A `docId` may contain `/`
  (nested paths create subdirectories, created on demand), and `list()` walks the whole tree back
  into `docId`s the same way, always with `/` separators (Windows is not supported yet). `list()`
  leaves out symlinks that resolve outside `root`.
- **`events.jsonl`** (configurable via `eventsPath`, default `"events.jsonl"`) — an append-only,
  newline-delimited JSON log, one committed `EventRecord` per line. `seq` is seeded from the
  number of existing lines the first time the sink is used, so reopening a workspace continues
  the same sequence rather than restarting it. Each record carries its `commit: { id, index,
  size }` (see [Commit boundaries](events.md#commit-boundaries)); lines written before 0.2 have
  no `commit` and still read.

Durability characteristics:

- writes are atomic (temp file + fsync + rename, via `write-file-atomic`), so a crash mid-write
  can't leave a document half-written;
- the default lock is a real, cross-process file lock (`proper-lockfile`, with stale-lock
  detection after 30s) at `<docId>.lock`, so two processes sharing a root still serialize their
  writes to the same document;
- the event log is append-only and replayable across a restart: `engine.events({ afterSeq })`
  (see [Events](events.md)) replays everything committed since a cursor, continuing exactly where
  the log left off — nothing is reseeded.

### Containment

Every path built from a document id stays inside `root`. `read`, `writeAtomic`, `delete` and the
default lock refuse, after checking only file metadata (no document is read or written):

- an id that is not a valid document id (`..`, `.` or empty segments, a leading `/`, backslashes,
  a trailing `.md`) with an error whose `code` is `"E_INVALID_ID"`;
- an id whose real path, after following symlinks, is outside `root` (for example a symlink inside
  the workspace pointing elsewhere) with an error whose `code` is `"E_PATH_OUTSIDE_ROOT"`.

When an `{{include:…}}` points at such a document, the engine does not throw: the include is
diagnosed with `E_INCLUDE_OUTSIDE_ROOT` and nothing is read. Any other failure to read an include
target (a directory named `x.md`, a symlink loop) is diagnosed with `E_INCLUDE_UNREADABLE`.

Containment is checked before each operation. A process that can already write inside `root` and
swaps a symlink between the check and the access is outside the threat model: the guarantee holds
against document content and API input, not against local users with write access to the
workspace. Keep `root` writable only by processes you trust.

## Watching for external edits

Someone editing a document's file directly — in an editor, not through the engine — bypasses the
commit pipeline by construction: the bytes are already truth the moment they hit disk. `watch`
closes that gap: it detects the edit, diffs it against the last version the engine knew about,
and events it like any other commit.

```ts
const engine = createEngine({
  storage: createFsStorage({ root }),
  watch: true,
});
```

`watch: true` resolves its root from `storage.rootDir` (set by `createFsStorage`; in-memory
storage has none, so `watch: true` there is a programming error — pass a `WatchOptions` object
with an explicit `rootDir` and `source` to watch a non-filesystem workspace). The default watch
source is chokidar, watching `rootDir` recursively and forwarding non-hidden `.md` files that
aren't lock files.

Two things make external-write handling safe:

- **self-echo suppression** — the engine records its own commit's content hash the instant the
  bytes land, before events emit and before the write lock releases, so a watch notification for
  the engine's own write is recognized and silently dropped rather than re-evented. This covers
  every engine write, `importDoc` included: restore a document through `importDoc` rather than
  writing to storage directly, or the watcher events the restore a second time;
- **fail-soft content** — a genuine external write is diffed and evented (`doc.updated`,
  `section.changed`, `block.updated`, and any matched transitions) exactly as a pipeline commit
  would be, stamped with writer `{ kind: "human", id: "external" }` by default — override the id
  with `WatchOptions.externalWriterId`. It is never rejected, even when it violates a block's
  shape: the content is already on disk, so a bad edit surfaces as diagnostics on the next read
  rather than as a blocked write (see [External writes](events.md#external-writes) in the events guide). The
  same fail-soft rule covers a document written before a block's schema was tightened: nothing on
  the read path re-validates persisted attrs, so it projects normally unless a hook itself
  assumes the newer shape and throws — and even then the whole projection degrades to the raw
  source with a diagnostic rather than crashing the host (see
  [Projector exceptions](projections.md#projector-exceptions)).

The events of one external write share one commit id (`commit: { id, index, size }`), counted
with the engine's own commits, so a subscriber can group them as it groups a pipeline commit
(see [Commit boundaries](events.md#commit-boundaries)).

An external edit that leaves the file over the engine's document size limit (`maxDocumentBytes`,
256 KiB by default) is the one exception to diffing: the file is not parsed, so it is not evented,
and the outcome carries an `E_DOCUMENT_TOO_LARGE` diagnostic. The same goes for a file over a
complexity limit (`E_DOCUMENT_TOO_COMPLEX`) or one whose parse throws (`E_PARSE_FAILED`). The next
edit that fits is diffed against the last version the engine parsed (see
[Document size limit](projections.md#document-size-limit)).

## `engine.close()`

Stop the watch source cleanly (a no-op when watching was never enabled); the workspace itself —
its files and event log — is untouched and reopens exactly where it left off:

```ts
process.on("SIGINT", () => {
  void engine.close().then(() => process.exit(0));
});
```

After `close()`, external writes are no longer detected until a new engine is constructed over
the same root.

## Try it

- [`examples/02-watch.ts`](../../examples/02-watch.ts) — a filesystem workspace with
  `watch: true`; edit `examples/.workspace/fin.md` yourself while it runs and watch the
  projection follow. Interactive, so CI only typechecks it (no `// Output:` block) — run it
  yourself: `pnpm example 02-watch.ts`.
- `apps/demo` — the workbench: a long-running server over a real filesystem workspace, exercising
  storage, watch, and external writes together from three surfaces at once — an editor, a
  browser, and a program. See "Try it: the workbench" in the [root README](../../README.md#try-it-the-workbench).

## Next

- [Events](events.md) — the event stream `watch` and every other write path emit.
- [Sources](sources.md) — live values, which storage never persists.
- [Projections](projections.md) — how a projection reads what storage holds.
