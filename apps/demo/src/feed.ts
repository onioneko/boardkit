/**
 * The feed: one fan-out point for everything that happens in the workspace.
 *
 * Two kinds of message travel it. A **commit** is an engine event, whatever
 * surface produced it — a browser click, a `curl`, the reactor, or an editor
 * save the watcher picked up. A **rejection** is a write the engine refused;
 * rejections are not persisted anywhere, so the handler that saw one posts it
 * here and the feed is the only place other surfaces can learn about it.
 *
 * The feed also tracks `lastSeq` — the cursor a reconnecting consumer resumes
 * from — by scanning the log once at creation and then following live events.
 */
import type {
  Clock,
  Diagnostic,
  Engine,
  EventRecord,
  WriteResult,
  Writer,
} from "@onioneko/boardkit-core";

/** Which write surface a rejection came from. */
export type RejectionSurface = "intent" | "write" | "patch" | "reactor";

/** A rejected write, in the shape every surface of the workbench reports it. */
export interface RejectionNotice {
  /** When the rejection was posted, from the workbench's clock. */
  readonly at: string;
  /** The writer whose write was rejected. */
  readonly by: Writer;
  /** The surface that made the attempt. */
  readonly surface: RejectionSurface;
  /** The document the write targeted. */
  readonly docId: string;
  /** The block the write targeted, for a patch or an intent. */
  readonly blockId?: string;
  /** The engine's machine-readable rejection reason. */
  readonly reason: string;
  /** The live value the write conflicted with, when the engine reported one. */
  readonly current?: unknown;
  /** The diagnostics explaining the rejection. */
  readonly diagnostics: readonly Diagnostic[];
}

/** One message on the feed: a committed event, or a refused write. */
export type FeedMessage =
  | {
      /** Discriminant: an engine event that committed. */
      readonly kind: "commit";
      /** The event as the engine appended it. */
      readonly event: EventRecord;
    }
  | {
      /** Discriminant: a write the engine refused. */
      readonly kind: "rejection";
      /** The rejection, stamped with the feed's clock. */
      readonly notice: RejectionNotice;
    };

/** The live fan-out of commits and rejections. */
export interface Feed {
  /**
   * Receive every message from now on (live only — the log replays through
   * `engine.events`, not through here).
   * @param handler Called with each message as it is fanned out.
   * @returns An unsubscribe function.
   */
  subscribe(handler: (msg: FeedMessage) => void): () => void;
  /**
   * Post a rejected write to every subscriber, stamping `at` from the clock.
   * @param notice The rejection, without its timestamp.
   */
  rejection(notice: Omit<RejectionNotice, "at">): void;
  /**
   * @returns The highest event `seq` the feed has seen (initial scan plus live).
   */
  lastSeq(): number;
  /** Stop listening to the engine and release every subscriber. */
  close(): void;
}

/**
 * Create the feed over an engine: subscribe to every event, then scan the log
 * once so `lastSeq` starts current.
 * @param engine The engine whose events the feed mirrors.
 * @param clock The timestamp source rejections are stamped with.
 * @returns The feed, already listening.
 */
export async function createFeed(engine: Engine, clock: Clock): Promise<Feed> {
  const subscribers = new Set<(msg: FeedMessage) => void>();
  let lastSeq = 0;

  function emit(msg: FeedMessage): void {
    for (const handler of [...subscribers]) {
      try {
        handler(msg);
      } catch {
        // One bad surface must not starve the others, and must not unwind into
        // the commit that produced the event: engine subscribers are called
        // inside the write pipeline's EMIT step.
      }
    }
  }

  // Subscribe before the scan: an event that lands while the log is being read
  // is counted by `Math.max` rather than lost between the two steps.
  const unsubscribe = engine.subscribe((event) => {
    lastSeq = Math.max(lastSeq, event.seq);
    emit({ kind: "commit", event });
  });

  for await (const event of engine.events({ afterSeq: 0 })) {
    lastSeq = Math.max(lastSeq, event.seq);
  }

  return {
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    rejection(notice) {
      emit({ kind: "rejection", notice: { at: clock(), ...notice } });
    },
    lastSeq() {
      return lastSeq;
    },
    close() {
      unsubscribe();
      // A closed feed carries nothing, so it holds nothing: dropping the
      // handlers releases whatever they close over (an open SSE response,
      // typically) instead of keeping it alive behind a dead feed.
      subscribers.clear();
    },
  };
}

/**
 * Turn a rejected {@link WriteResult} into the notice the feed carries, keeping
 * the engine's own `reason`, `current`, and `diagnostics` verbatim.
 * @param args The writer and surface that attempted the write, what it targeted,
 *   and the rejected result.
 * @returns The notice, ready for `feed.rejection` to stamp.
 */
export function noticeFromRejection(args: {
  by: Writer;
  surface: RejectionSurface;
  docId: string;
  blockId?: string;
  result: WriteResult & { ok: false };
}): Omit<RejectionNotice, "at"> {
  const { reason, current, diagnostics } = args.result.rejection;
  return {
    by: args.by,
    surface: args.surface,
    docId: args.docId,
    ...(args.blockId !== undefined ? { blockId: args.blockId } : {}),
    reason,
    ...(current !== undefined ? { current } : {}),
    diagnostics,
  };
}
