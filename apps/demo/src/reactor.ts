/**
 * The workbench's automated writer. It is a *script* standing in for any
 * automated writer — it has no reasoning — but it plugs into exactly the three
 * calls a real LLM agent would use: `engine.subscribe` (perceive),
 * `engine.getBlock`/`getDoc` (read), and `engine.applyIntent`/`write` (act). The
 * only difference is the writer kind: this one is `program`, an agent would be
 * `agent`, and the engine treats both identically.
 *
 * It watches `fin.md` and reacts to one thing: the decision block becoming
 * `approved`. Each reaction is two writes — tick "Buy MacBook" on the checklist
 * (unless it is already ticked) and append one note line naming the seq it saw.
 * Reactions are chained onto each other, so two approvals in flight never
 * interleave their reads and writes; neither write is ever retried, and a
 * rejected one is reported to `onRejection` instead.
 *
 * It never loops: its own writes emit no `status.changed`, and the engine's
 * self-echo suppression keeps the watcher from re-ingesting them.
 */
import {
  diagnostic,
  type Engine,
  type EventRecord,
  type WriteResult,
} from "@onioneko/boardkit-core";
import { noticeFromRejection, type RejectionNotice } from "./feed.js";
import {
  CHECKLIST_BLOCK,
  FIN_DOC,
  isPlainRecord,
  MACBOOK_BLOCK,
  MACBOOK_ITEM_ID,
  reactorWriter,
} from "./shared.js";

/** The state the reactor reacts to. */
const APPROVED = "approved";

/** The checklist item's label, as the note line quotes it. */
const MACBOOK_ITEM_LABEL = "Buy MacBook";

/** The reason stamped on a reaction that threw instead of returning a rejection. */
const REACTOR_ERROR_REASON = "reactor-error";

/** What the reactor reports back to its host. */
export interface ReactorOptions {
  /** Called with every rejected reactor write (the workbench posts it to the feed). */
  readonly onRejection?: (notice: Omit<RejectionNotice, "at">) => void;
  /** Called once per completed reaction, whatever its outcome. */
  readonly onReaction?: (r: ReactorReaction) => void;
}

/** A subscribed reactor: how to stop it, and how to wait for what it started. */
export interface ReactorHandle {
  /** Stop reacting. Reactions already queued still run to completion. */
  unsubscribe(): void;
  /**
   * Wait until the reaction queue is idle. Never rejects: a reaction that threw
   * has already been reported through {@link ReactorOptions.onRejection}, and a
   * host closing down must not be handed that failure a second time.
   * @returns A promise resolving once nothing is left in flight.
   */
  drain(): Promise<void>;
}

/** One completed reaction: the approval it saw and the two writes it made. */
export interface ReactorReaction {
  /** The `seq` of the `status.changed` event that triggered it. */
  readonly seq: number;
  /** The checklist write, or `"already-done"` when the item was ticked already. */
  readonly tick: WriteResult | "already-done";
  /** The note-appending write. */
  readonly note: WriteResult;
}

/**
 * The prose line the reactor appends after an approval. The note tells the
 * truth about all three outcomes — a rejected tick says so rather than claiming
 * the item was already ticked.
 * @param seq The `seq` of the approval event it reacted to.
 * @param tick What became of the checklist tick.
 * @returns The note line, without its trailing newline.
 */
export function reactorNoteLine(seq: number, tick: "ticked" | "already-done" | "rejected"): string {
  const outcome =
    tick === "ticked"
      ? `ticked "${MACBOOK_ITEM_LABEL}"`
      : tick === "already-done"
        ? `"${MACBOOK_ITEM_LABEL}" already ticked`
        : `tick of "${MACBOOK_ITEM_LABEL}" rejected`;
  return `> ${reactorWriter.id}: approval seen at seq ${seq} — ${outcome}`;
}

/** Whether an event is the decision block becoming `approved`. */
function isApproval(evt: EventRecord): boolean {
  return evt.type === "status.changed" && evt.blockId === MACBOOK_BLOCK && evt.to === APPROVED;
}

/** Report a rejected reactor write to the host, if it asked to hear about them. */
function reportRejection(
  opts: ReactorOptions,
  result: WriteResult & { ok: false },
  blockId: string | undefined,
): void {
  opts.onRejection?.(
    noticeFromRejection({
      by: reactorWriter,
      surface: "reactor",
      docId: FIN_DOC,
      ...(blockId !== undefined ? { blockId } : {}),
      result,
    }),
  );
}

/** Whether the "Buy MacBook" checklist item is already ticked. */
async function macbookTicked(engine: Engine): Promise<boolean> {
  const block = await engine.getBlock(FIN_DOC, CHECKLIST_BLOCK);
  const items = block?.attrs.items;
  if (!Array.isArray(items)) return false;
  return items.some(
    (item) => isPlainRecord(item) && item.id === MACBOOK_ITEM_ID && item.done === true,
  );
}

/**
 * Tick the "Buy MacBook" item unless it is ticked already. The toggle is applied
 * as an intent, so the delta is decoded inside the write lock and commutes with
 * a human toggling another item at the same instant.
 */
async function tickMacbook(
  engine: Engine,
  opts: ReactorOptions,
): Promise<WriteResult | "already-done"> {
  if (await macbookTicked(engine)) return "already-done";
  const result = await engine.applyIntent(
    {
      docId: FIN_DOC,
      blockId: CHECKLIST_BLOCK,
      affordance: "toggle",
      params: { itemId: MACBOOK_ITEM_ID },
    },
    { writer: reactorWriter },
  );
  if (!result.ok) reportRejection(opts, result, CHECKLIST_BLOCK);
  return result;
}

/**
 * Append one note line to `fin.md` with `expectedVersion` set to the version the
 * reactor read: if anyone else commits in between, the note is rejected as
 * `stale-version` rather than silently overwriting their edit.
 */
async function appendNote(
  engine: Engine,
  seq: number,
  tick: "ticked" | "already-done" | "rejected",
  opts: ReactorOptions,
): Promise<WriteResult> {
  const doc = await engine.getDoc(FIN_DOC);
  if (doc === undefined) {
    const missing: WriteResult = {
      ok: false,
      rejection: {
        reason: "missing-doc",
        diagnostics: [diagnostic("E_DOC_MISSING", `document not found: ${FIN_DOC}`)],
      },
    };
    reportRejection(opts, missing, undefined);
    return missing;
  }
  const separator = doc.src.endsWith("\n") ? "" : "\n";
  const result = await engine.write(FIN_DOC, {
    writer: reactorWriter,
    fullText: `${doc.src}${separator}${reactorNoteLine(seq, tick)}\n`,
    expectedVersion: doc.version,
  });
  if (!result.ok) reportRejection(opts, result, undefined);
  return result;
}

/** One reaction: tick the item, then append the note naming what happened. */
async function react(engine: Engine, seq: number, opts: ReactorOptions): Promise<void> {
  const tick = await tickMacbook(engine, opts);
  const outcome = tick === "already-done" ? "already-done" : tick.ok ? "ticked" : "rejected";
  const note = await appendNote(engine, seq, outcome, opts);
  opts.onReaction?.({ seq, tick, note });
}

/**
 * Report an unexpected reaction error — a throwing host callback, a storage
 * failure, a workspace pulled out from under a reaction — on the same channel
 * as a rejected write, so it is visible rather than silent. Expected failures
 * never come through here: those are `WriteResult` rejections.
 */
function reportReactorError(opts: ReactorOptions, err: unknown): void {
  try {
    opts.onRejection?.({
      by: reactorWriter,
      surface: "reactor",
      docId: FIN_DOC,
      reason: REACTOR_ERROR_REASON,
      diagnostics: [diagnostic("E_REACTOR_THREW", String(err))],
    });
  } catch {
    // The host's own handler threw: there is no channel left to report on, and
    // the queue must stay alive for the next approval.
  }
}

/**
 * Subscribe the reactor to `fin.md` for the lifetime of the process.
 *
 * Reactions are queued behind one another rather than fired in parallel: each
 * one is chained onto the previous reaction's promise, so a burst of approvals
 * is handled in order and no reaction ever reads a document another reaction is
 * halfway through writing.
 *
 * The queue is kept resolvable: an unexpected throw anywhere in a reaction is
 * routed to `onRejection` as a `reactor-error` notice rather than becoming an
 * unhandled rejection, and the tail stays fulfilled so the *next* approval is
 * still reacted to. A poisoned queue would be a reactor that is silently dead.
 * @param engine The engine to subscribe to and write through.
 * @param opts Optional reaction and rejection callbacks.
 * @returns The handle: `unsubscribe()` stops new reactions, `drain()` waits for
 *   the ones already queued.
 */
export function subscribeReactor(engine: Engine, opts: ReactorOptions = {}): ReactorHandle {
  let queue: Promise<void> = Promise.resolve();
  const unsubscribe = engine.subscribe(FIN_DOC, (evt) => {
    if (!isApproval(evt)) return;
    const seq = evt.seq;
    queue = queue
      .then(() => react(engine, seq, opts))
      .catch((err: unknown) => reportReactorError(opts, err));
  });

  return {
    unsubscribe,
    async drain(): Promise<void> {
      // The tail moves while we wait on it: a reaction can chain another onto
      // the promise we are already awaiting. Idle is when the tail stops
      // changing, not when the first one we saw settles.
      let awaited: Promise<void> | undefined;
      while (awaited !== queue) {
        awaited = queue;
        await awaited;
      }
    },
  };
}
