import path from "node:path";
import type { EventRecord } from "@onioneko/boardkit-core";
import { describe, expect, it } from "vitest";
import { banner, feedLine, parseFlags, type WorkbenchFlags } from "./cli.js";
import type { FeedMessage } from "./feed.js";
import { DEFAULT_WORKSPACE_DIR } from "./shared.js";

// ---------------------------------------------------------------------------
// parseFlags
// ---------------------------------------------------------------------------

const DEFAULTS: WorkbenchFlags = {
  port: 4321,
  rootDir: DEFAULT_WORKSPACE_DIR,
  reset: false,
  reactor: true,
  guard: true,
};

/** The flags parsed from `argv`, or the failure message, as one comparable value. */
function parsed(argv: readonly string[]): WorkbenchFlags | string {
  const result = parseFlags(argv);
  return result.ok ? result.flags : result.message;
}

describe("parseFlags", () => {
  const accepted: readonly {
    readonly name: string;
    readonly argv: readonly string[];
    readonly expected: WorkbenchFlags;
  }[] = [
    { name: "no arguments — every default", argv: [], expected: DEFAULTS },
    { name: "--port <n>", argv: ["--port", "8080"], expected: { ...DEFAULTS, port: 8080 } },
    { name: "--port=<n>", argv: ["--port=8080"], expected: { ...DEFAULTS, port: 8080 } },
    { name: "--port 0 (ephemeral)", argv: ["--port", "0"], expected: { ...DEFAULTS, port: 0 } },
    {
      name: "--root <dir> (absolute)",
      argv: ["--root", "/tmp/ws"],
      expected: { ...DEFAULTS, rootDir: "/tmp/ws" },
    },
    {
      name: "--root <dir> (relative, resolved against cwd)",
      argv: ["--root", "ws"],
      expected: { ...DEFAULTS, rootDir: path.resolve("ws") },
    },
    { name: "--reset", argv: ["--reset"], expected: { ...DEFAULTS, reset: true } },
    { name: "--no-reactor", argv: ["--no-reactor"], expected: { ...DEFAULTS, reactor: false } },
    { name: "--no-guard", argv: ["--no-guard"], expected: { ...DEFAULTS, guard: false } },
    {
      name: "every flag at once",
      argv: ["--port", "0", "--root", "/tmp/ws", "--reset", "--no-reactor", "--no-guard"],
      expected: { port: 0, rootDir: "/tmp/ws", reset: true, reactor: false, guard: false },
    },
  ];

  for (const { name, argv, expected } of accepted) {
    it(`accepts ${name}`, () => {
      expect(parsed(argv)).toEqual(expected);
    });
  }

  const refused: readonly {
    readonly name: string;
    readonly argv: readonly string[];
    readonly match: RegExp;
  }[] = [
    { name: "a non-numeric port", argv: ["--port", "abc"], match: /--port/ },
    { name: "a negative port", argv: ["--port=-1"], match: /--port/ },
    { name: "a port above 65535", argv: ["--port=99999"], match: /0 to 65535/ },
    { name: "a fractional port", argv: ["--port", "1.5"], match: /--port/ },
    { name: "an empty port", argv: ["--port="], match: /--port/ },
    { name: "an unknown flag", argv: ["--nope"], match: /nope/ },
    { name: "a missing --port value", argv: ["--port"], match: /port/ },
    { name: "a missing --root value", argv: ["--root"], match: /root/ },
    { name: "a positional argument", argv: ["extra"], match: /./ },
  ];

  for (const { name, argv, match } of refused) {
    it(`refuses ${name} with a message, not a throw`, () => {
      expect(() => parseFlags(argv)).not.toThrow();
      const result = parseFlags(argv);
      expect(result.ok).toBe(false);
      expect(parsed(argv)).toMatch(match);
    });
  }
});

// ---------------------------------------------------------------------------
// banner
// ---------------------------------------------------------------------------

const BANNER_INPUT = {
  url: "http://127.0.0.1:4321",
  rootDir: "/tmp/ws",
  flags: { reactor: true, guard: true },
  lastSeq: 9,
  seeded: false,
};

describe("banner", () => {
  it("prints the banner shape, line for line", () => {
    expect(banner(BANNER_INPUT).split("\n")).toEqual([
      "BoardKit workbench",
      "  workspace  /tmp/ws                open this folder in your editor",
      "  browser    http://127.0.0.1:4321",
      "  api        GET  /api/state · /api/doc/{id} · /api/projection/{id}?format=html|text&reader=owner|guest",
      "             PUT  /api/doc/{id} · PATCH /api/doc/{id}/block/{blockId} · POST /api/intent",
      "             GET  /api/events?afterSeq=N   (server-sent events; Last-Event-ID resumes)",
      "             writers identify themselves with  X-Writer: program:<id> | agent:<id> | human:<id>",
      '  reactor    on   program:reactor-1 — when dec-macbook → approved it ticks "Buy MacBook" and appends a note',
      "  guard      on   only a human may transition a status to `executed`",
      "  events     /tmp/ws/events.jsonl   (last seq 9)",
      "Ctrl-C to stop.",
    ]);
  });

  const variants: readonly {
    readonly name: string;
    readonly input: Parameters<typeof banner>[0];
    readonly line: string;
  }[] = [
    {
      name: "a seeded run says so, under the workspace it seeded",
      input: { ...BANNER_INPUT, seeded: true },
      line: "  seeded     three documents were written to an empty workspace",
    },
    {
      name: "--no-reactor",
      input: { ...BANNER_INPUT, flags: { reactor: false, guard: true } },
      line: "  reactor    off  no automated writer is subscribed (--no-reactor)",
    },
    {
      name: "--no-guard",
      input: { ...BANNER_INPUT, flags: { reactor: true, guard: false } },
      line: "  guard      off  any writer may transition a status to `executed` (--no-guard)",
    },
  ];

  for (const { name, input, line } of variants) {
    it(name, () => {
      expect(banner(input).split("\n")).toContain(line);
    });
  }

  it("omits the seeded line when the workspace was already there", () => {
    expect(banner(BANNER_INPUT)).not.toContain("seeded");
  });

  it("places the seeded line directly under the workspace it describes", () => {
    const lines = banner({ ...BANNER_INPUT, seeded: true }).split("\n");
    expect(lines[1]?.startsWith("  workspace")).toBe(true);
    expect(lines[2]?.startsWith("  seeded")).toBe(true);
  });

  it("reports the port the workbench actually bound and the cursor it starts from", () => {
    const lines = banner({ ...BANNER_INPUT, url: "http://127.0.0.1:52341", lastSeq: 0 }).split(
      "\n",
    );
    expect(lines).toContain("  browser    http://127.0.0.1:52341");
    expect(lines.at(-2)).toBe("  events     /tmp/ws/events.jsonl   (last seq 0)");
  });

  it("ends with the stop instruction", () => {
    expect(banner(BANNER_INPUT).split("\n").at(-1)).toBe("Ctrl-C to stop.");
  });
});

// ---------------------------------------------------------------------------
// feedLine
// ---------------------------------------------------------------------------

/** A committed event, in the shape the engine appends it. */
function commit(
  event: Record<string, unknown> & { seq: number; t: string; type: string },
): FeedMessage {
  return { kind: "commit", event: event as EventRecord };
}

const EDITOR = { kind: "human", id: "editor" } as const;
const REACTOR = { kind: "program", id: "reactor-1" } as const;
const BROWSER = { kind: "human", id: "browser" } as const;

describe("feedLine", () => {
  const table: readonly {
    readonly name: string;
    readonly msg: FeedMessage;
    readonly line: string;
  }[] = [
    {
      name: "a status transition shows from → to",
      msg: commit({
        seq: 12,
        t: "2026-08-21T00:00:00Z",
        type: "status.changed",
        docId: "fin",
        blockId: "dec-macbook",
        from: "pending",
        to: "approved",
        by: EDITOR,
      }),
      line: "#12  status.changed     fin/dec-macbook   pending → approved      by human:editor",
    },
    {
      name: "a checklist tick shows its booleans",
      msg: commit({
        seq: 13,
        t: "2026-08-21T00:00:00Z",
        type: "checklist.item.done",
        docId: "fin",
        blockId: "subs",
        from: false,
        to: true,
        by: REACTOR,
      }),
      line: "#13  checklist.item.done fin/subs         false → true            by program:reactor-1",
    },
    {
      name: "an untick shows the other direction",
      msg: commit({
        seq: 13,
        t: "2026-08-21T00:00:00Z",
        type: "checklist.item.undone",
        docId: "fin",
        blockId: "subs",
        from: true,
        to: false,
        by: REACTOR,
      }),
      line: "#13  checklist.item.undone fin/subs       true → false            by program:reactor-1",
    },
    {
      name: "an event carrying no from/to leaves the detail column blank",
      msg: commit({
        seq: 14,
        t: "2026-08-21T00:00:00Z",
        type: "doc.updated",
        docId: "fin",
        by: REACTOR,
      }),
      line: "#14  doc.updated        fin                                       by program:reactor-1",
    },
    {
      name: "an event with no writer says so rather than inventing one",
      msg: commit({ seq: 3, t: "2026-08-21T00:00:00Z", type: "doc.updated", docId: "fin" }),
      line: "#3   doc.updated        fin                                       by —",
    },
    {
      name: "a rejection carrying a current value names it",
      msg: {
        kind: "rejection",
        notice: {
          at: "2026-08-21T00:00:00Z",
          by: BROWSER,
          surface: "intent",
          docId: "fin",
          blockId: "dec-macbook",
          reason: "expected-mismatch",
          current: { id: "dec-macbook", value: "approved" },
          diagnostics: [],
        },
      },
      line: " ✗   rejected           fin/dec-macbook   expected-mismatch       by human:browser   (current value: approved)",
    },
    {
      name: "a rejection with no current value stops at the writer",
      msg: {
        kind: "rejection",
        notice: {
          at: "2026-08-21T00:00:00Z",
          by: { kind: "program", id: "curl" },
          surface: "intent",
          docId: "fin",
          blockId: "dec-macbook",
          reason: "humans-only",
          diagnostics: [],
        },
      },
      line: " ✗   rejected           fin/dec-macbook   humans-only             by program:curl",
    },
    {
      name: "a rejection whose current carries no string value stays quiet about it",
      msg: {
        kind: "rejection",
        notice: {
          at: "2026-08-21T00:00:00Z",
          by: BROWSER,
          surface: "patch",
          docId: "fin",
          blockId: "subs",
          reason: "expected-mismatch",
          current: { items: [{ id: "a", done: true }] },
          diagnostics: [],
        },
      },
      line: " ✗   rejected           fin/subs          expected-mismatch       by human:browser",
    },
    {
      name: "a document-level rejection names only the document",
      msg: {
        kind: "rejection",
        notice: {
          at: "2026-08-21T00:00:00Z",
          by: EDITOR,
          surface: "write",
          docId: "research/q3-review",
          reason: "validation",
          diagnostics: [],
        },
      },
      line: " ✗   rejected           research/q3-review validation             by human:editor",
    },
    {
      name: "a reactor error arrives as a rejection like any other",
      msg: {
        kind: "rejection",
        notice: {
          at: "2026-08-21T00:00:00Z",
          by: REACTOR,
          surface: "reactor",
          docId: "fin",
          reason: "reactor-error",
          diagnostics: [],
        },
      },
      line: " ✗   rejected           fin               reactor-error           by program:reactor-1",
    },
  ];

  for (const { name, msg, line } of table) {
    it(name, () => {
      expect(feedLine(msg)).toBe(line);
    });
  }

  it("keeps the writer at column 66, even when a type overruns its column", () => {
    for (const { name, msg } of table) {
      expect([name, feedLine(msg).indexOf("by ")]).toEqual([name, 66]);
    }
  });

  it("stays on one line and uses no colour codes", () => {
    for (const { msg } of table) {
      const line = feedLine(msg);
      expect(line).not.toContain("\n");
      expect(line).not.toContain(String.fromCharCode(27));
    }
  });
});
