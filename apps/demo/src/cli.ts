/**
 * The workbench's command line, as pure functions: the flags a run was started
 * with, the banner it prints once, and the one line it prints per feed message.
 *
 * Nothing here has a side effect and nothing here throws — `main.ts` owns the
 * process, and a bad flag is a *value* (`{ ok: false, message }`) exactly as a
 * refused write is a value everywhere else in this repo. That is what makes the
 * banner's shape and the console mirror's columns testable without starting a
 * server.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import type { EventRecord } from "@onioneko/boardkit-core";
import type { FeedMessage } from "./feed.js";
import { byOf, DEFAULT_PORT, DEFAULT_WORKSPACE_DIR, isPlainRecord } from "./shared.js";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/** The highest port a TCP socket can bind. */
const MAX_PORT = 65535;

/** Everything the command line decides about a run. */
export interface WorkbenchFlags {
  /** TCP port to bind; `0` asks the OS for an ephemeral one. */
  readonly port: number;
  /** The workspace root to open, resolved to an absolute path. */
  readonly rootDir: string;
  /** Empty the root before opening it. */
  readonly reset: boolean;
  /** Subscribe the automated writer. */
  readonly reactor: boolean;
  /** Install the humans-only write guard. */
  readonly guard: boolean;
}

/** The outcome of reading a command line: the flags, or why they were refused. */
export type FlagsResult =
  | {
      /** True when every flag parsed. */
      readonly ok: true;
      /** The flags the run should start with. */
      readonly flags: WorkbenchFlags;
    }
  | {
      /** False when the command line was malformed. */
      readonly ok: false;
      /** What was wrong with it, ready to print to stderr. */
      readonly message: string;
    };

/**
 * Parse the workbench's command line.
 *
 * `parseArgs` throws on an unknown option, a missing value, or a stray
 * positional; every one of those is caught and returned as a message, so the
 * caller decides what a bad command line costs (`main.ts` prints it and exits
 * 2). `--port` is validated here too: anything that is not an integer in
 * `0..65535` is refused rather than silently becoming `NaN` and binding
 * nothing.
 *
 * @param argv The arguments after the node executable and the script
 *   (`process.argv.slice(2)`).
 * @returns The parsed flags, or the reason the command line was refused.
 */
export function parseFlags(argv: readonly string[]): FlagsResult {
  let values: {
    port?: string;
    root?: string;
    reset?: boolean;
    "no-reactor"?: boolean;
    "no-guard"?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        port: { type: "string" },
        root: { type: "string" },
        reset: { type: "boolean" },
        "no-reactor": { type: "boolean" },
        "no-guard": { type: "boolean" },
      },
    }));
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const rawPort = values.port;
  const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
  if (
    rawPort !== undefined &&
    (rawPort.trim() === "" || !Number.isInteger(port) || port < 0 || port > MAX_PORT)
  ) {
    return { ok: false, message: `--port "${rawPort}": expected an integer from 0 to ${MAX_PORT}` };
  }

  return {
    ok: true,
    flags: {
      port,
      rootDir: values.root === undefined ? DEFAULT_WORKSPACE_DIR : path.resolve(values.root),
      reset: values.reset === true,
      reactor: values["no-reactor"] !== true,
      guard: values["no-guard"] !== true,
    },
  };
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

/** Width of the banner's label column; the value starts one space after it. */
const LABEL_WIDTH = 10;

/** Width of the on/off column on the `reactor` and `guard` lines. */
const STATE_WIDTH = 5;

/** The three api lines under the first, indented to the value column. */
const API_LINES: readonly string[] = [
  "GET  /api/state · /api/doc/{id} · /api/projection/{id}?format=html|text&reader=owner|guest",
  "PUT  /api/doc/{id} · PATCH /api/doc/{id}/block/{blockId} · POST /api/intent",
  "GET  /api/events?afterSeq=N   (server-sent events; Last-Event-ID resumes)",
  "writers identify themselves with  X-Writer: program:<id> | agent:<id> | human:<id>",
];

/** What the reactor line says, per flag. */
const REACTOR_TEXT = {
  on: 'program:reactor-1 — when dec-macbook → approved it ticks "Buy MacBook" and appends a note',
  off: "no automated writer is subscribed (--no-reactor)",
} as const;

/** What the guard line says, per flag. */
const GUARD_TEXT = {
  on: "only a human may transition a status to `executed`",
  off: "any writer may transition a status to `executed` (--no-guard)",
} as const;

/** One `  label      value` line; an empty label continues the line above it. */
function labelled(label: string, value: string): string {
  return `  ${label.padEnd(LABEL_WIDTH)} ${value}`;
}

/** What the banner needs to know about the workbench it is describing. */
export interface BannerInput {
  /** The base url the server bound. */
  readonly url: string;
  /** The workspace root that was opened. */
  readonly rootDir: string;
  /** Which optional parts are running. */
  readonly flags: { readonly reactor: boolean; readonly guard: boolean };
  /** The event cursor the run starts from. */
  readonly lastSeq: number;
  /** True when this start seeded the workspace. */
  readonly seeded: boolean;
}

/**
 * The startup banner: where the workspace is, where the browser and the API
 * are, what the two optional parts are doing, and where the log the run
 * continues lives. The right-hand notes on the `workspace` and `events` lines
 * share a column, three spaces past the longer of the two paths.
 * @param wb The running workbench, as the CLI knows it.
 * @returns The banner, newline-separated and without a trailing newline.
 */
export function banner(wb: BannerInput): string {
  const eventsPath = path.join(wb.rootDir, "events.jsonl");
  const noteColumn = eventsPath.length + 3;
  const reactor = wb.flags.reactor ? "on" : "off";
  const guard = wb.flags.guard ? "on" : "off";

  const lines: string[] = [
    "BoardKit workbench",
    labelled("workspace", `${wb.rootDir.padEnd(noteColumn)}open this folder in your editor`),
  ];
  if (wb.seeded) {
    lines.push(labelled("seeded", "three documents were written to an empty workspace"));
  }
  lines.push(labelled("browser", wb.url));
  lines.push(labelled("api", API_LINES[0] ?? ""));
  for (const line of API_LINES.slice(1)) lines.push(labelled("", line));
  lines.push(labelled("reactor", `${reactor.padEnd(STATE_WIDTH)}${REACTOR_TEXT[reactor]}`));
  lines.push(labelled("guard", `${guard.padEnd(STATE_WIDTH)}${GUARD_TEXT[guard]}`));
  lines.push(labelled("events", `${eventsPath.padEnd(noteColumn)}(last seq ${wb.lastSeq})`));
  lines.push("Ctrl-C to stop.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Console mirror
// ---------------------------------------------------------------------------

/**
 * Where each field of a mirror line starts: the seq, the event type, its
 * target, the detail, and the writer. Absolute positions rather than widths, so
 * a field that overruns its own column steals only from the next one and every
 * later field — the writer above all — stays where the eye expects it.
 */
const MIRROR_COLUMNS: readonly number[] = [0, 5, 24, 42, 66];

/**
 * Lay fields out at {@link MIRROR_COLUMNS}. A field that reaches or passes the
 * next column's start is followed by a single space and the line re-aligns at
 * the column after that.
 */
function mirrorRow(fields: readonly string[]): string {
  let line = "";
  for (const [index, field] of fields.entries()) {
    const start = MIRROR_COLUMNS[index] ?? line.length + 1;
    line = (line.length >= start && line.length > 0 ? `${line} ` : line.padEnd(start)) + field;
  }
  return line;
}

/** A `from`/`to` value as the mirror prints it: strings bare, everything else as JSON. */
function detailValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

/** `docId/blockId`, or just `docId` when the message names no block. */
function target(docId: unknown, blockId: unknown): string {
  if (typeof docId !== "string") return "";
  return typeof blockId === "string" ? `${docId}/${blockId}` : docId;
}

/** `by kind:id`, or `by —` for an event that carries no writer. */
function writerColumn(by: { readonly kind: string; readonly id: string } | undefined): string {
  return by === undefined ? "by —" : `by ${by.kind}:${by.id}`;
}

/**
 * The detail column of a commit: `from → to` for any event carrying both (a
 * status transition, a checklist item flipping), blank for everything else.
 * The event payload rides on the record's top level, so this reads it there.
 */
function commitDetail(event: EventRecord): string {
  const from = event.from;
  const to = event.to;
  if (from === undefined || to === undefined) return "";
  return `${detailValue(from)} → ${detailValue(to)}`;
}

/**
 * One feed message as one console line — the mirror of what every connected
 * browser is seeing. Commits lead with `#<seq>`, rejections with ` ✗`, and both
 * end with the writer, so the log answers "who changed what" at a glance. No
 * colour codes: this output is as often read from a redirected file as from a
 * terminal.
 * @param msg The commit or rejection to render.
 * @returns The single line to print (no newline, no escape sequences).
 */
export function feedLine(msg: FeedMessage): string {
  if (msg.kind === "commit") {
    const { event } = msg;
    return mirrorRow([
      `#${event.seq}`,
      event.type,
      target(event.docId, event.blockId),
      commitDetail(event),
      writerColumn(byOf(event)),
    ]);
  }
  const { notice } = msg;
  const current = notice.current;
  const value = isPlainRecord(current) ? current.value : undefined;
  const suffix = typeof value === "string" ? `   (current value: ${value})` : "";
  return (
    mirrorRow([
      " ✗",
      "rejected",
      target(notice.docId, notice.blockId),
      notice.reason,
      writerColumn(notice.by),
    ]) + suffix
  );
}
