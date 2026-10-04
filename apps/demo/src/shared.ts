/**
 * Shared primitives of the workbench: the canonical document and block ids, the
 * package-directory resolver, the workspace root and default port derived from
 * it, the writers every surface stamps, the fixtures loader that seeds an empty
 * workspace, the demo's Source port, and the two shape predicates its modules
 * read untrusted values with. Nothing here reaches for
 * the engine — it is the leaf every other module imports. Test-only helpers
 * live in `testing/helpers.ts`, which the build excludes.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventRecord, Source, Writer } from "@onioneko/boardkit-core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The canonical board document id (`fin.md`). */
export const FIN_DOC = "fin";
/** The included research document id (`research/q3-review.md`). */
export const Q3_DOC = "research/q3-review";
/** The viewpoint document id (`overview.md`) — a board that includes other boards. */
export const OVERVIEW_DOC = "overview";
/** The status block id in the canonical document. */
export const MACBOOK_BLOCK = "dec-macbook";
/** The checklist block id in the canonical document. */
export const CHECKLIST_BLOCK = "subs";
/** The checklist item the reactor ticks when the purchase is approved. */
export const MACBOOK_ITEM_ID = "c";

// ---------------------------------------------------------------------------
// Package layout
// ---------------------------------------------------------------------------

/**
 * The `apps/demo` package directory, resolved from this module's own url: both
 * `src/` (tests, `tsx`) and `dist/` (the built demo) sit exactly one level below
 * it, so the same expression works before and after the build.
 * @returns The absolute path of the demo package root.
 */
export function packageDir(): string {
  return path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
}

/**
 * The workbench's default workspace root: `apps/demo/.workspace` (git-ignored).
 * A fixed, durable directory is the point — documents and `events.jsonl` persist
 * between runs, so a restart continues the same event log.
 */
export const DEFAULT_WORKSPACE_DIR = path.join(packageDir(), ".workspace");

/**
 * The TCP port the workbench binds when neither `--port` nor a caller names
 * one. Defined here rather than in `cli.ts` or `workbench.ts` so the flag's
 * default and the server's default cannot drift apart.
 */
export const DEFAULT_PORT = 4321;

// ---------------------------------------------------------------------------
// Writers and ports
// ---------------------------------------------------------------------------

/**
 * The writer a request that sends no `X-Writer` header is recorded as: a person
 * at the page this server serves. Every other writer says so in the header.
 */
export const browserWriter: Writer = { kind: "human", id: "browser" };
/**
 * The writer stamped on the reactor's reaction writes. `program` is the kind for
 * a script, job, or service; an LLM-driven agent would use `agent` and a person
 * `human`. All three are provenance labels the pipeline treats identically.
 */
export const reactorWriter: Writer = { kind: "program", id: "reactor-1" };
/** The writer stamped on the three documents the workbench seeds into an empty workspace. */
export const seedWriter: Writer = { kind: "human", id: "seed" };
/**
 * The writer id stamped on edits the engine's watcher picks up off disk. The
 * engine's own default is `"external"`; `editor` is what the event log should
 * say, because an editor save is exactly what produced it.
 */
export const EXTERNAL_WRITER_ID = "editor";

/** A writer reduced to the two fields the demo prints. */
export interface WriterLabel {
  readonly kind: string;
  readonly id: string;
}

// ---------------------------------------------------------------------------
// Fixtures and the Source port
// ---------------------------------------------------------------------------

/** The three canonical demo fixtures (`fin.md`, `research/q3-review.md`, `overview.md`). */
export interface DemoFixtures {
  readonly fin: string;
  readonly q3review: string;
  readonly overview: string;
}

/**
 * Load the canonical fixtures from `apps/demo/fixtures`.
 * @returns The three fixture documents as raw markdown.
 */
export function loadFixtures(): DemoFixtures {
  const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));
  return {
    fin: readFileSync(path.join(fixturesDir, "fin.md"), "utf8"),
    q3review: readFileSync(path.join(fixturesDir, "research", "q3-review.md"), "utf8"),
    overview: readFileSync(path.join(fixturesDir, "overview.md"), "utf8"),
  };
}

/** The value the demo's Source resolves `bank_balance` to. */
export const DEMO_CASH = "¥23,450";

/**
 * The call-scoped Source port: `bank_balance` → ¥23,450 and `monthly_spend` →
 * ¥8,120, returned in the API 2.0 `{ value, stale? }` object shape (unknown
 * refs degrade to the plain-string `"—"`).
 * @returns A fresh Source resolving the demo's two source ids.
 */
export function demoSource(): Source {
  return {
    resolve: async (ref) => {
      if (ref.source === "bank_balance") return { value: DEMO_CASH };
      if (ref.source === "monthly_spend") return { value: "¥8,120" };
      return "—";
    },
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * True when `value` is a non-array object (a JSON object literal).
 * @param value The value to test.
 * @returns Whether the value is a plain record.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `by` writer field of an event, narrowed to `{kind, id}`.
 * @param evt The event record.
 * @returns The writer label, or `undefined` when the event carries none.
 */
export function byOf(evt: EventRecord): WriterLabel | undefined {
  const by = evt.by;
  if (!isPlainRecord(by)) return undefined;
  const kind = by.kind;
  const id = by.id;
  if (typeof kind !== "string" || typeof id !== "string") return undefined;
  return { kind, id };
}
