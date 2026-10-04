/**
 * Test-only support for the workbench's suites: the fixed clock and the inert
 * watch source every test opens a workspace with, the small async utilities,
 * the ephemeral-port listener, and one event-stream reader the three http
 * suites share.
 *
 * Nothing outside a `*.test.ts` may import this module. It is excluded from
 * `tsconfig.build.json`, so a production import would fail the build rather
 * than quietly ship a fixed clock; `tsconfig.json` still typechecks it.
 */
import { get, type IncomingMessage, type Server } from "node:http";
import type {
  Clock,
  Diagnostic,
  EventRecord,
  WatchSource,
  WriteResult,
} from "@onioneko/boardkit-core";

// ---------------------------------------------------------------------------
// Ports the tests substitute
// ---------------------------------------------------------------------------

/**
 * The fixed clock the tests stamp events and rejections with, so output is
 * comparable between runs. The workbench itself uses the wall clock.
 */
export const demoClock: Clock = () => "2026-08-21T00:00:00Z";

/**
 * A watch source that starts nothing and stops nothing: tests drive external
 * edits with `writeFile` + `engine.externalWrite(path)` rather than waiting on
 * chokidar, which is neither deterministic nor fast.
 */
export const noopWatchSource: WatchSource = { start: async () => async () => {} };

// ---------------------------------------------------------------------------
// Small async helpers
// ---------------------------------------------------------------------------

/**
 * Resolve after `ms` milliseconds — the tests' quiet period, for asserting that
 * a long-running subscriber did *not* write.
 * @param ms The delay in milliseconds.
 * @returns A promise resolving after the delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a condition until it holds or the budget runs out. Both shapes go
 * through here: a synchronous predicate and one that has to read the workspace.
 * @param check The condition to poll; awaited when it returns a promise.
 * @param attempts How many 10 ms polls to make (default 100 — one second).
 * @returns Whether the condition held before the budget ran out.
 */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  attempts = 100,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return true;
    await sleep(10);
  }
  return false;
}

/**
 * Listen on an ephemeral loopback port. Tests never bind a fixed port: two
 * suites running at once would fight over it.
 * @param server The server to start.
 * @returns The port the OS assigned.
 */
export function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

// ---------------------------------------------------------------------------
// Events and write results
// ---------------------------------------------------------------------------

/**
 * Collect an async event iterable into an array.
 * @param iterable The event stream to drain.
 * @returns Every record the stream yielded, in order.
 */
export async function collectEvents(iterable: AsyncIterable<EventRecord>): Promise<EventRecord[]> {
  const out: EventRecord[] = [];
  for await (const evt of iterable) out.push(evt);
  return out;
}

/**
 * The `seq` of the last event in a stream — the cursor a consumer would save,
 * in the units `events({ afterSeq })` compares against (a record count is not
 * the same thing once a log is compacted or seeded from elsewhere).
 * @param iterable The engine's event stream from seq 0.
 * @returns The last record's `seq`, or `0` for an empty log.
 */
export async function lastEventSeq(iterable: AsyncIterable<EventRecord>): Promise<number> {
  const events = await collectEvents(iterable);
  return events.length === 0 ? 0 : (events[events.length - 1]?.seq ?? 0);
}

/**
 * The reason a write was rejected. Failures are values here, not exceptions:
 * the pipeline returns a {@link WriteResult} rejection and never throws.
 * @param result The write result to narrow.
 * @returns The rejection reason, or `undefined` when the write committed.
 */
export function rejectionReason(result: WriteResult): string | undefined {
  return result.ok ? undefined : result.rejection.reason;
}

/**
 * The diagnostics explaining a rejection.
 * @param result The write result to narrow.
 * @returns The rejection's diagnostics (empty when the write committed).
 */
export function rejectionDiagnostics(result: WriteResult): readonly Diagnostic[] {
  return result.ok ? [] : result.rejection.diagnostics;
}

// ---------------------------------------------------------------------------
// Reading an event stream
// ---------------------------------------------------------------------------

/** One parsed `event:`/`id:`/`data:` frame off an event stream. */
export interface Frame {
  /** The `event:` field, or `"message"` when the frame names none. */
  readonly event: string;
  /** The `id:` field — the engine's `seq` on a commit, absent everywhere else. */
  readonly id: string | undefined;
  /** The `data:` payload, multi-line data rejoined with newlines. */
  readonly data: string;
}

/** A connected event-stream client: the frames it has seen, plus the raw bytes. */
export interface StreamClient {
  /** Every frame parsed so far, in arrival order. */
  readonly frames: readonly Frame[];
  /**
   * @returns Everything received verbatim, comment frames (`: ping`) included.
   */
  raw(): string;
  /**
   * Wait for something to arrive. The predicate is checked immediately and
   * again after every chunk.
   * @param predicate What the caller is waiting for.
   * @returns A promise resolving once the predicate holds.
   */
  waitFor(predicate: (client: StreamClient) => boolean): Promise<void>;
  /** Hang up. */
  close(): void;
}

/** Parse one wire frame; a comment-only frame (the keepalive) yields `undefined`. */
function parseFrame(block: string): Frame | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  let sawField = false;
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    sawField = true;
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  return sawField ? { event, id, data: data.join("\n") } : undefined;
}

/**
 * Open an event stream and keep parsing it until the caller closes it. Frames
 * are cut on the blank line that terminates them, so a frame split across two
 * reads is never parsed half-arrived.
 * @param url The `/api/events` url to connect to.
 * @param headers Extra request headers (`last-event-id`, for one).
 * @returns The connected client.
 */
export function openEventStream(url: string, headers: Record<string, string> = {}): StreamClient {
  const frames: Frame[] = [];
  const waiters: { predicate: (c: StreamClient) => boolean; resolve: () => void }[] = [];
  let raw = "";
  let pending = "";

  const client: StreamClient = {
    frames,
    raw: () => raw,
    waitFor(predicate) {
      if (predicate(client)) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ predicate, resolve }));
    },
    close() {
      req.destroy();
    },
  };

  const settle = (): void => {
    for (const waiter of waiters.splice(0).reverse()) {
      if (waiter.predicate(client)) waiter.resolve();
      else waiters.unshift(waiter);
    }
  };

  const req = get(url, { headers }, (res: IncomingMessage) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      raw += chunk;
      pending += chunk;
      let cut = pending.indexOf("\n\n");
      while (cut !== -1) {
        const frame = parseFrame(pending.slice(0, cut));
        if (frame !== undefined) frames.push(frame);
        pending = pending.slice(cut + 2);
        cut = pending.indexOf("\n\n");
      }
      settle();
    });
    res.on("error", () => {});
  });
  req.on("error", () => {});
  return client;
}

/**
 * True once the stream has said `ready` — the client is current.
 * @param client The connected client.
 * @returns Whether a `ready` frame has arrived.
 */
export function isReady(client: StreamClient): boolean {
  return client.frames.some((frame) => frame.event === "ready");
}

/**
 * Read an event stream up to and including its `ready` frame, then hang up.
 * @param url The `/api/events` url to connect to.
 * @param headers Extra request headers.
 * @returns Every frame through `ready`, in arrival order.
 */
export async function readUntilReady(
  url: string,
  headers: Record<string, string> = {},
): Promise<Frame[]> {
  const client = openEventStream(url, headers);
  await client.waitFor(isReady);
  client.close();
  const ready = client.frames.findIndex((frame) => frame.event === "ready");
  return client.frames.slice(0, ready + 1);
}

/**
 * Resolve with the first committed event that satisfies `match`, skipping the
 * replay of everything the caller is not waiting for.
 * @param url The `/api/events` url to connect to.
 * @param match Which committed event the caller wants (default: the first one).
 * @returns The matching event record, as the stream serialized it.
 */
export async function firstCommit(
  url: string,
  match: (event: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  const client = openEventStream(url);
  let found: Record<string, unknown> | undefined;
  await client.waitFor((c) =>
    c.frames.some((frame) => {
      if (found !== undefined || frame.event !== "commit") return false;
      const event = JSON.parse(frame.data) as Record<string, unknown>;
      if (!match(event)) return false;
      found = event;
      return true;
    }),
  );
  client.close();
  if (found === undefined) throw new Error(`no matching commit arrived on ${url}`);
  return found;
}
