import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EventRecord, Intent, Writer } from "@onioneko/boardkit-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  byOf,
  DEFAULT_WORKSPACE_DIR,
  FIN_DOC,
  loadFixtures,
  MACBOOK_BLOCK,
  packageDir,
} from "./shared.js";
import { collectEvents, noopWatchSource, rejectionReason } from "./testing/helpers.js";
import { type OpenedWorkspace, type OpenWorkspaceOptions, openWorkspace } from "./workspace.js";

/** The `transition → executed` intent both guard tests send. */
const executeIntent: Intent = {
  docId: FIN_DOC,
  blockId: MACBOOK_BLOCK,
  affordance: "transition",
  params: { to: "executed" },
};

const programWriter: Writer = { kind: "program", id: "x" };

describe("openWorkspace", () => {
  let rootDir = "";
  const opened: OpenedWorkspace[] = [];

  /** Open the shared temp root, remembering the workspace so it is closed after the test. */
  async function open(opts: Omit<OpenWorkspaceOptions, "rootDir"> = {}): Promise<OpenedWorkspace> {
    const workspace = await openWorkspace({ rootDir, ...opts });
    opened.push(workspace);
    return workspace;
  }

  /** Every event in the workspace's log, oldest first. */
  async function eventsOf(workspace: OpenedWorkspace): Promise<EventRecord[]> {
    return collectEvents(workspace.engine.events({ afterSeq: 0 }));
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "boardkit-workspace-"));
  });

  afterEach(async () => {
    for (const workspace of opened.splice(0)) await workspace.engine.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("seeds an empty root with the three canonical documents", async () => {
    const workspace = await open({ watch: false });

    expect(workspace.seeded).toBe(true);
    expect(workspace.rootDir).toBe(rootDir);
    expect(await workspace.engine.listDocs()).toEqual(["fin", "overview", "research/q3-review"]);
    await expect(
      readFile(path.join(rootDir, "research", "q3-review.md"), "utf8"),
    ).resolves.toContain("## Summary");
    await expect(readFile(path.join(rootDir, "events.jsonl"), "utf8")).resolves.toContain(
      "doc.created",
    );

    const created = (await eventsOf(workspace)).filter((evt) => evt.type === "doc.created");
    expect(created.map((evt) => evt.docId)).toEqual(["fin", "research/q3-review", "overview"]);
    expect(created.map(byOf)).toEqual([
      { kind: "human", id: "seed" },
      { kind: "human", id: "seed" },
      { kind: "human", id: "seed" },
    ]);
  });

  it("opens an already-seeded root without reseeding it", async () => {
    const first = await open({ watch: false });
    const before = await eventsOf(first);

    const second = await open({ watch: false });

    expect(second.seeded).toBe(false);
    expect(await eventsOf(second)).toEqual(before);
  });

  it("reseeds a modified root and starts a fresh event log when reset is set", async () => {
    await open({ watch: false });
    const finPath = path.join(rootDir, "fin.md");
    await writeFile(finPath, "# clobbered\n", "utf8");

    const reset = await open({ watch: false, reset: true });

    expect(reset.seeded).toBe(true);
    expect(await readFile(finPath, "utf8")).toBe(loadFixtures().fin);
    const events = await eventsOf(reset);
    expect(events.map((evt) => evt.seq)).toEqual([1, 2, 3]);
    expect(events.every((evt) => evt.type === "doc.created")).toBe(true);
  });

  it("refuses --reset on a directory that is not a workspace, and deletes nothing", async () => {
    // A mistyped `--root` is the whole risk: emptying someone's directory is not
    // an operation they can undo, so a root that shows neither an event log nor
    // a single markdown document is not one this flag is allowed to empty.
    const stray = path.join(rootDir, "thesis.tex");
    await writeFile(stray, "\\documentclass{article}\n", "utf8");

    await expect(open({ watch: false, reset: true })).rejects.toThrow(
      `refusing --reset: ${rootDir} holds 1 entries and is not a BoardKit workspace`,
    );

    await expect(readFile(stray, "utf8")).resolves.toContain("documentclass");
  });

  it("resets an empty root", async () => {
    const workspace = await open({ watch: false, reset: true });

    expect(workspace.seeded).toBe(true);
    expect(await workspace.engine.listDocs()).toEqual(["fin", "overview", "research/q3-review"]);
  });

  it("resets a root that holds an event log but no documents yet", async () => {
    await writeFile(path.join(rootDir, "events.jsonl"), "", "utf8");

    const workspace = await open({ watch: false, reset: true });

    expect(workspace.seeded).toBe(true);
  });

  it("rejects a program's transition → executed with humans-only by default", async () => {
    const workspace = await open({ watch: false });

    const result = await workspace.engine.applyIntent(executeIntent, { writer: programWriter });

    expect(result.ok).toBe(false);
    expect(rejectionReason(result)).toBe("humans-only");
  });

  it("lets a program transition → executed when the guard is off", async () => {
    const workspace = await open({ watch: false, guard: false });

    const result = await workspace.engine.applyIntent(executeIntent, { writer: programWriter });

    expect(result.ok).toBe(true);
    expect((await workspace.engine.getBlock(FIN_DOC, MACBOOK_BLOCK))?.attrs.value).toBe("executed");
  });

  it("ignores external writes when watching is off", async () => {
    const workspace = await open({ watch: false });
    const finPath = path.join(rootDir, "fin.md");
    await writeFile(
      finPath,
      loadFixtures().fin.replace("value: pending", "value: approved"),
      "utf8",
    );

    expect(await workspace.engine.externalWrite(finPath)).toBeUndefined();
  });

  it("stamps an edit picked up off disk as the editor", async () => {
    const workspace = await open({ watchSource: noopWatchSource });
    const finPath = path.join(rootDir, "fin.md");
    await writeFile(
      finPath,
      loadFixtures().fin.replace("value: pending", "value: approved"),
      "utf8",
    );

    const outcome = await workspace.engine.externalWrite(finPath);

    expect(outcome?.external).toBe(true);
    const statusChanged = outcome?.events.find((evt) => evt.type === "status.changed");
    expect(statusChanged?.to).toBe("approved");
    expect(byOf(statusChanged as EventRecord)).toEqual({ kind: "human", id: "editor" });
  });
});

describe("the default workspace location", () => {
  it("resolves apps/demo from this module's url", () => {
    expect(packageDir().endsWith(path.join("apps", "demo"))).toBe(true);
  });

  it("defaults the workspace root to the package's .workspace directory", () => {
    expect(DEFAULT_WORKSPACE_DIR).toBe(path.join(packageDir(), ".workspace"));
    expect(DEFAULT_WORKSPACE_DIR.endsWith(path.join("apps", "demo", ".workspace"))).toBe(true);
  });
});
