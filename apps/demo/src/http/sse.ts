/**
 * One client's event stream: replay-then-live, with the engine's `seq` as the
 * SSE `id`.
 *
 * A connection is an idempotent consumer. The order matters and is the whole
 * point: the stream subscribes to the live feed **first**, buffering whatever
 * arrives, then replays the log from the client's cursor, then flushes the
 * buffer skipping anything the replay already sent, and only then declares
 * itself `ready`. A commit landing in the middle of a long replay therefore
 * arrives exactly once, in order, instead of being lost in the seam.
 *
 * Because `id` is the `seq`, a browser `EventSource` that reconnects sends
 * `Last-Event-ID` and resumes exactly after what it saw — the cursor round-trip
 * is literally the protocol. Rejections carry no `id`: they are not persisted
 * and are never replayed.
 */
import type { ServerResponse } from "node:http";
import type { Engine, EventRecord } from "@onioneko/boardkit-core";
import type { Feed, FeedMessage, RejectionNotice } from "../feed.js";

/** The slice of the engine a stream reads: the replay log. */
export type EventLog = Pick<Engine, "events">;

/** How long the stream waits before writing a keepalive comment. */
const DEFAULT_KEEPALIVE_MS = 15000;

/** What one event stream needs. */
export interface EventStreamOptions {
  /** The log the connection replays from. */
  readonly engine: EventLog;
  /** The live fan-out the connection follows once the replay is done. */
  readonly feed: Feed;
  /** The client's cursor: only events with a higher `seq` are replayed. */
  readonly afterSeq: number;
  /** Keepalive comment interval in milliseconds (default 15 000). */
  readonly keepaliveMs?: number;
}

/** The SSE frame for one committed event, carrying its `seq` as the id. */
function commitFrame(event: EventRecord): string {
  return `event: commit\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The SSE frame for one refused write (live only, so no id). */
function rejectionFrame(notice: RejectionNotice): string {
  return `event: rejection\ndata: ${JSON.stringify(notice)}\n\n`;
}

/**
 * Take over a response as a server-sent event stream and keep it open.
 *
 * The returned promise settles once the client is current (the `ready` frame has
 * been written); the connection itself lives until the client goes away, at
 * which point the feed subscription and the keepalive timer are dropped.
 * @param res The response to stream over.
 * @param opts The log to replay, the feed to follow, the cursor, and the
 *   keepalive interval.
 * @returns A promise that settles when the replay is done and `ready` is sent.
 */
export async function attachEventStream(
  res: ServerResponse,
  opts: EventStreamOptions,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  let lastSeq = opts.afterSeq;
  let closed = false;
  let replaying = true;
  const buffered: FeedMessage[] = [];

  /** Write one frame, unless the client has already gone. */
  const send = (frame: string): void => {
    if (closed || res.writableEnded) return;
    res.write(frame);
  };

  /** Send a commit unless this client has already seen that `seq`. */
  const sendCommit = (event: EventRecord): void => {
    if (event.seq <= lastSeq) return;
    lastSeq = event.seq;
    send(commitFrame(event));
  };

  /** Send one feed message in its own frame. */
  const sendMessage = (msg: FeedMessage): void => {
    if (msg.kind === "commit") sendCommit(msg.event);
    else send(rejectionFrame(msg.notice));
  };

  // Subscribe before the replay so nothing falls into the seam between them.
  const unsubscribe = opts.feed.subscribe((msg) => {
    if (replaying) buffered.push(msg);
    else sendMessage(msg);
  });

  const keepalive = setInterval(() => send(": ping\n\n"), opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS);
  keepalive.unref();

  const stop = (): void => {
    closed = true;
    unsubscribe();
    clearInterval(keepalive);
  };
  res.on("close", stop);
  // A socket error is the client leaving mid-write, not a server fault.
  res.on("error", stop);

  try {
    for await (const event of opts.engine.events({ afterSeq: opts.afterSeq })) {
      if (closed) break;
      sendCommit(event);
    }
  } catch {
    // A log that cannot be read is not a reason to drop the live stream: the
    // client still gets everything from here on, and `ready` says where it is.
  }

  // No `await` from here to `ready`: the buffer cannot grow underneath us.
  replaying = false;
  for (const msg of buffered.splice(0)) sendMessage(msg);
  send(`event: ready\ndata: ${JSON.stringify({ lastSeq })}\n\n`);
}
