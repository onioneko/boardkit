import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EventRecord } from "@onioneko/boardkit-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeedMessage, RejectionNotice } from "../feed.js";
import {
  CHECKLIST_BLOCK,
  demoSource,
  FIN_DOC,
  MACBOOK_BLOCK,
  OVERVIEW_DOC,
  Q3_DOC,
  seedWriter,
} from "../shared.js";
import {
  collectEvents,
  demoClock,
  firstCommit,
  listenOnEphemeralPort,
  noopWatchSource,
  waitFor,
} from "../testing/helpers.js";
import { startWorkbench, type Workbench } from "../workbench.js";
import { createRouter, type Router, type RouterDeps } from "./router.js";

/** A document whose `status` fence has an unterminated quote — valid markdown, invalid YAML. */
const BROKEN_SCRATCH = `# Scratch

A note that parses fine, above a block that does not.

\`\`\`status
id: broken
title: "unterminated
states: [pending, approved]
value: pending
\`\`\`
`;

/** Decode the character references rehype writes into a `data-intent` attribute. */
function decodeEntities(value: string): string {
  return value
    .replaceAll("&#x22;", '"')
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&#x26;", "&")
    .replaceAll("&amp;", "&");
}

/** A request the tests build: the standard init, with headers as a plain record. */
type ApiInit = Omit<RequestInit, "headers"> & { readonly headers?: Record<string, string> };

/** The content type every write route demands. */
const JSON_HEADERS: Record<string, string> = { "content-type": "application/json" };

/** Every `data-intent` payload in an html projection, as the browser would read it. */
function intentsOf(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/data-intent="([^"]*)"/g)) {
    if (match[1] !== undefined) out.push(decodeEntities(match[1]));
  }
  return out;
}

describe("the workbench router", () => {
  let rootDir = "";
  let workbench: Workbench;
  const extraServers: Server[] = [];

  /** The parsed JSON body of a response. */
  async function body(res: Response): Promise<Record<string, unknown>> {
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Call the running workbench. Anything carrying a body declares JSON, the way
   * the page does — a test that means to send something else says so in its own
   * `headers`, which win.
   */
  function api(pathname: string, init: ApiInit = {}): Promise<Response> {
    const { headers, ...rest } = init;
    return fetch(`${workbench.url}${pathname}`, {
      ...rest,
      headers: { ...(init.body !== undefined ? JSON_HEADERS : {}), ...headers },
    });
  }

  /** POST an intent payload (already-serialized JSON, as the page sends it). */
  function postIntent(payload: string, writer?: string): Promise<Response> {
    return api("/api/intent", {
      method: "POST",
      body: payload,
      ...(writer !== undefined ? { headers: { "x-writer": writer } } : {}),
    });
  }

  /** Listen on an ephemeral port, remembering the server so it is closed after the test. */
  async function listen(server: Server): Promise<number> {
    extraServers.push(server);
    return listenOnEphemeralPort(server);
  }

  /** The port the next `router()` claims as its own; set by tests that bind one. */
  let claimedPort = 0;

  /** A router over the running workbench, with one dependency swapped out. */
  function router(overrides: Partial<RouterDeps>): Router {
    return createRouter({
      ownPort: () => claimedPort,
      loadAsset: () => Promise.resolve(""),
      engine: workbench.engine,
      feed: workbench.feed,
      source: demoSource(),
      rootDir,
      flags: workbench.flags,
      pageHtml: () => Promise.resolve(""),
      ...overrides,
    });
  }

  /** Every rejection notice the feed fans out while `run` executes. */
  async function noticesDuring(run: () => Promise<void>): Promise<RejectionNotice[]> {
    const seen: RejectionNotice[] = [];
    const unsubscribe = workbench.feed.subscribe((msg: FeedMessage) => {
      if (msg.kind === "rejection") seen.push(msg.notice);
    });
    try {
      await run();
    } finally {
      unsubscribe();
    }
    return seen;
  }

  /** Move the decision block back to `pending` between hands. */
  async function resetDecision(): Promise<void> {
    await workbench.engine.patch(FIN_DOC, MACBOOK_BLOCK, {
      writer: seedWriter,
      attrs: { value: "pending" },
    });
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "boardkit-router-"));
    workbench = await startWorkbench({
      rootDir,
      port: 0,
      reactor: false,
      watchSource: noopWatchSource,
      clock: demoClock,
    });
  });

  afterEach(async () => {
    for (const server of extraServers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await workbench.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // GET / — the page
  // -------------------------------------------------------------------------

  it("serves the page, and the page names every api route it calls", async () => {
    const res = await api("/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain('src="/app.js"');
    const page = await (await api("/app.js")).text();
    expect(page).toContain("[data-intent]");
    for (const route of [
      "/api/state",
      "/api/doc/",
      "/api/projection/",
      "/api/intent",
      "/api/events",
    ]) {
      expect(page).toContain(route);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/doc/{docId}
  // -------------------------------------------------------------------------

  it("reads a nested document by its url-decoded path", async () => {
    const res = await api("/api/doc/research/q3-review");

    expect(res.status).toBe(200);
    const doc = await body(res);
    expect(doc.docId).toBe("research/q3-review");
    expect(String(doc.src)).toContain("## Summary");
    expect(typeof doc.version).toBe("string");
  });

  it("answers 404 missing-doc for a document that is not there", async () => {
    const res = await api("/api/doc/nope");

    expect(res.status).toBe(404);
    expect(await body(res)).toMatchObject({ ok: false, rejection: { reason: "missing-doc" } });
  });

  // -------------------------------------------------------------------------
  // PUT /api/doc/{docId}
  // -------------------------------------------------------------------------

  it("replaces a document's full text", async () => {
    const before = await body(await api(`/api/doc/${FIN_DOC}`));
    const fullText = String(before.src).replace("value: pending", "value: approved");

    const res = await api(`/api/doc/${FIN_DOC}`, {
      method: "PUT",
      body: JSON.stringify({ fullText, expectedVersion: before.version }),
    });

    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ ok: true });
    expect((await workbench.engine.getBlock(FIN_DOC, MACBOOK_BLOCK))?.attrs.value).toBe("approved");
  });

  it("creates a document that does not exist yet when no expectedVersion is sent", async () => {
    const res = await api("/api/doc/notes", {
      method: "PUT",
      body: JSON.stringify({ fullText: "# Notes\n" }),
    });

    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ ok: true });
    expect(await workbench.engine.listDocs()).toContain("notes");
  });

  it("rejects a stale expectedVersion with 409 and posts it to the feed", async () => {
    let res: Response | undefined;
    const notices = await noticesDuring(async () => {
      res = await api(`/api/doc/${FIN_DOC}`, {
        method: "PUT",
        body: JSON.stringify({ fullText: "# gone\n", expectedVersion: "deadbeef" }),
      });
    });

    expect(res?.status).toBe(409);
    expect(await body(res as Response)).toMatchObject({
      ok: false,
      rejection: { reason: "stale-version" },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      surface: "write",
      docId: FIN_DOC,
      reason: "stale-version",
      by: { kind: "human", id: "browser" },
    });
  });

  it("answers 400 when the body carries no fullText", async () => {
    const res = await api(`/api/doc/${FIN_DOC}`, { method: "PUT", body: JSON.stringify({}) });

    expect(res.status).toBe(400);
    expect(await body(res)).toMatchObject({ ok: false, rejection: { reason: "bad-request" } });
  });

  it("answers 400 for a body that is not JSON", async () => {
    const res = await api(`/api/doc/${FIN_DOC}`, { method: "PUT", body: "{" });

    expect(res.status).toBe(400);
    expect(await body(res)).toMatchObject({ ok: false, rejection: { reason: "bad-request" } });
  });

  // -------------------------------------------------------------------------
  // Malformed input, both ways
  // -------------------------------------------------------------------------

  it("refuses an unterminated YAML quote through the write path, and still projects it off disk", async () => {
    const write = await api("/api/doc/scratch", {
      method: "PUT",
      body: JSON.stringify({ fullText: BROKEN_SCRATCH }),
    });

    expect(write.status).toBe(409);
    const rejection = (await body(write)).rejection as Record<string, unknown>;
    expect(rejection.reason).toBe("validation");
    const codes = (rejection.diagnostics as { code: string }[]).map((d) => d.code);
    expect(codes).toContain("E_BLOCK_YAML");

    // The same bytes, left on disk by a careless editor: the read path degrades
    // locally instead of failing.
    const scratchPath = path.join(rootDir, "scratch.md");
    await writeFile(scratchPath, BROKEN_SCRATCH, "utf8");
    await workbench.engine.externalWrite(scratchPath);

    const read = await body(await api("/api/projection/scratch?format=text"));
    expect(read.ok).toBe(true);
    expect(String(read.output)).toContain("A note that parses fine");
    expect((read.diagnostics as { code: string }[]).map((d) => d.code)).toContain("E_BLOCK_YAML");
  });

  // -------------------------------------------------------------------------
  // PATCH /api/doc/{docId}/block/{blockId}
  // -------------------------------------------------------------------------

  it("patches one block's attrs", async () => {
    const res = await api(`/api/doc/${FIN_DOC}/block/${MACBOOK_BLOCK}`, {
      method: "PATCH",
      body: JSON.stringify({ attrs: { value: "approved" } }),
    });

    expect(res.status).toBe(200);
    expect((await workbench.engine.getBlock(FIN_DOC, MACBOOK_BLOCK))?.attrs.value).toBe("approved");
  });

  it("refuses a compare-and-set guard of the wrong type rather than dropping it", async () => {
    const version = await api(`/api/doc/${FIN_DOC}/block/${MACBOOK_BLOCK}`, {
      method: "PATCH",
      body: JSON.stringify({ attrs: { value: "approved" }, expectedVersion: 7 }),
    });
    const guard = await postIntent(
      JSON.stringify({
        docId: FIN_DOC,
        blockId: MACBOOK_BLOCK,
        affordance: "transition",
        params: { to: "approved" },
        expected: "value: pending",
      }),
    );
    const put = await api(`/api/doc/${FIN_DOC}`, {
      method: "PUT",
      body: JSON.stringify({ fullText: "# gone\n", expectedVersion: 7 }),
    });

    expect([version.status, guard.status, put.status]).toEqual([400, 400, 400]);
    expect((await workbench.engine.getBlock(FIN_DOC, MACBOOK_BLOCK))?.attrs.value).toBe("pending");
  });

  it("answers 400 when a patch carries no attrs object", async () => {
    const res = await api(`/api/doc/${FIN_DOC}/block/${MACBOOK_BLOCK}`, {
      method: "PATCH",
      body: JSON.stringify({ attrs: "approved" }),
    });

    expect(res.status).toBe(400);
    expect(await body(res)).toMatchObject({ ok: false, rejection: { reason: "bad-request" } });
  });

  // -------------------------------------------------------------------------
  // Write routes demand a JSON content type (the CSRF guard)
  // -------------------------------------------------------------------------

  /** The three write routes, each as the smallest request that would commit. */
  const writeRoutes: readonly {
    readonly name: string;
    readonly pathname: string;
    readonly method: string;
    readonly payload: string;
  }[] = [
    {
      name: "PUT /api/doc/{id}",
      pathname: `/api/doc/${FIN_DOC}`,
      method: "PUT",
      payload: JSON.stringify({ fullText: "# clobbered\n" }),
    },
    {
      name: "PATCH /api/doc/{id}/block/{blockId}",
      pathname: `/api/doc/${FIN_DOC}/block/${MACBOOK_BLOCK}`,
      method: "PATCH",
      payload: JSON.stringify({ attrs: { value: "approved" } }),
    },
    {
      name: "POST /api/intent",
      pathname: "/api/intent",
      method: "POST",
      payload: JSON.stringify({
        docId: FIN_DOC,
        blockId: MACBOOK_BLOCK,
        affordance: "transition",
        params: { to: "approved" },
      }),
    },
  ];

  for (const route of writeRoutes) {
    it(`refuses ${route.name} without a JSON content type, and writes nothing`, async () => {
      // `text/plain` is what a cross-origin form post or a `fetch` with a string
      // body sends: the content types a browser is allowed to use with no
      // preflight. Demanding `application/json` is what forces the preflight
      // this server never answers.
      const res = await api(route.pathname, {
        method: route.method,
        body: route.payload,
        headers: { "content-type": "text/plain;charset=UTF-8" },
      });

      expect(res.status).toBe(400);
      const rejection = (await body(res)).rejection as Record<string, unknown>;
      expect(rejection.reason).toBe("bad-request");
      const diagnostics = rejection.diagnostics as { code: string; message: string }[];
      expect(diagnostics.map((d) => d.code)).toEqual(["E_CONTENT_TYPE"]);
      expect(diagnostics[0]?.message).toContain("application/json");
      // The seeding wrote three events; the refused request wrote none.
      expect(await collectEvents(workbench.engine.events({ afterSeq: 3 }))).toEqual([]);
    });

    it(`accepts ${route.name} with application/json and a charset parameter`, async () => {
      const res = await api(route.pathname, {
        method: route.method,
        body: route.payload,
        headers: { "content-type": "application/json; charset=utf-8" },
      });

      expect(res.status).toBe(200);
      expect(await body(res)).toMatchObject({ ok: true });
    });
  }

  // -------------------------------------------------------------------------
  // Concurrency and value-CAS
  // -------------------------------------------------------------------------

  it("commits two toggles issued together, and refuses the stale array behind them", async () => {
    const stale = await workbench.engine.getBlock(FIN_DOC, CHECKLIST_BLOCK);
    const staleItems = stale?.attrs.items as { id: string; done: boolean }[];

    const [first, second] = await Promise.all([
      postIntent(
        JSON.stringify({
          docId: FIN_DOC,
          blockId: CHECKLIST_BLOCK,
          affordance: "toggle",
          params: { itemId: "a" },
        }),
      ),
      postIntent(
        JSON.stringify({
          docId: FIN_DOC,
          blockId: CHECKLIST_BLOCK,
          affordance: "toggle",
          params: { itemId: "b" },
        }),
      ),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    const items = (await workbench.engine.getBlock(FIN_DOC, CHECKLIST_BLOCK))?.attrs.items as {
      id: string;
      done: boolean;
    }[];
    expect(items.find((i) => i.id === "a")?.done).toBe(true);
    expect(items.find((i) => i.id === "b")?.done).toBe(false);

    // A writer that computed its array from the pre-toggle snapshot loses.
    let res: Response | undefined;
    const notices = await noticesDuring(async () => {
      res = await api(`/api/doc/${FIN_DOC}/block/${CHECKLIST_BLOCK}`, {
        method: "PATCH",
        body: JSON.stringify({
          attrs: { items: staleItems.map((i) => (i.id === "a" ? { ...i, done: true } : i)) },
          expectedVersion: stale?.version,
          expected: { items: staleItems },
        }),
      });
    });

    expect(res?.status).toBe(409);
    const rejection = (await body(res as Response)).rejection as Record<string, unknown>;
    expect(rejection.reason).toBe("expected-mismatch");
    expect(rejection.current).toBeDefined();
    expect(notices[0]).toMatchObject({
      surface: "patch",
      docId: FIN_DOC,
      blockId: CHECKLIST_BLOCK,
      reason: "expected-mismatch",
    });
    expect(notices[0]?.current).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // POST /api/intent
  // -------------------------------------------------------------------------

  it("applies a data-intent payload lifted from the served projection, as human:browser", async () => {
    const projection = await body(await api(`/api/projection/${FIN_DOC}?format=html`));
    const payload = intentsOf(String(projection.output)).find((raw) =>
      raw.includes('"affordance":"transition"'),
    );
    expect(payload).toBeDefined();

    const res = await postIntent(payload as string);

    expect(res.status).toBe(200);
    const events = await collectEvents(workbench.engine.events({ afterSeq: 0 }));
    const changed = events.filter((evt) => evt.type === "status.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]?.by).toEqual({ kind: "human", id: "browser" });

    // The board the click came from now renders the new state.
    const after = await body(await api(`/api/projection/${FIN_DOC}?format=html`));
    expect(String(projection.output)).not.toBe(String(after.output));
    expect(String(after.output)).toContain(String(changed[0]?.to));
  });

  it("serves checklist inputs enabled and reflecting real state, and a click on one toggles it (user report: checklist boxes don't respond to clicks and every box renders unchecked)", async () => {
    const projection = await body(await api(`/api/projection/${FIN_DOC}?format=html`));
    const html = String(projection.output);
    const inputTags = html.match(/<input\b[^>]*>/g) ?? [];

    expect(inputTags).toHaveLength(3);
    expect(inputTags.every((tag) => !tag.includes("disabled"))).toBe(true);
    expect(inputTags.filter((tag) => /\bchecked\b/.test(tag))).toHaveLength(1);

    const toggleA = intentsOf(html).find(
      (raw) => raw.includes('"affordance":"toggle"') && raw.includes('"itemId":"a"'),
    );
    expect(toggleA).toBeDefined();

    const res = await postIntent(toggleA as string);

    expect(res.status).toBe(200);
    const events = await collectEvents(workbench.engine.events({ afterSeq: 0 }));
    const done = events.find((evt) => evt.type === "checklist.item.done");
    expect(done).toBeDefined();
    expect(done?.by).toEqual({ kind: "human", id: "browser" });
    const items = (await workbench.engine.getBlock(FIN_DOC, CHECKLIST_BLOCK))?.attrs.items as {
      id: string;
      done: boolean;
    }[];
    expect(items.find((i) => i.id === "a")?.done).toBe(true);
  });

  it("answers 400 for an intent payload with no docId", async () => {
    const res = await postIntent(JSON.stringify({ blockId: MACBOOK_BLOCK, affordance: "toggle" }));

    expect(res.status).toBe(400);
    expect(await body(res)).toMatchObject({ ok: false, rejection: { reason: "bad-request" } });
  });

  it("answers 400 for a malformed X-Writer header", async () => {
    const res = await postIntent(JSON.stringify({}), "not-a-writer");

    expect(res.status).toBe(400);
    const rejection = (await body(res)).rejection as Record<string, unknown>;
    expect(rejection.reason).toBe("bad-request");
    expect(JSON.stringify(rejection.diagnostics)).toContain("X-Writer");
  });

  it("answers 413 for a body over the size cap", async () => {
    const res = await postIntent("x".repeat(1024 * 1024 + 8));

    expect(res.status).toBe(413);
    expect(await body(res)).toMatchObject({ ok: false, rejection: { reason: "bad-request" } });
  });

  it("settles the handler when a client hangs up in the middle of an upload", async () => {
    // A truncated upload emits no `end`, so the body reader has to settle on
    // something else or the handler awaits a promise that never resolves —
    // invisible from outside, so the test watches the handler itself. (On this
    // Node a destroyed socket also emits `error`; the reader covers `close` too,
    // for the hangups that do not.)
    let settled = false;
    const handler = router({});
    const port = await listen(
      createServer((req, res) => {
        void handler(req, res).then(() => {
          settled = true;
        });
      }),
    );

    await new Promise<void>((resolve) => {
      const req = request(`http://127.0.0.1:${port}/api/intent`, {
        method: "POST",
        headers: { ...JSON_HEADERS, "content-length": "4096" },
      });
      req.on("error", () => {});
      req.write('{"docId":"fin"', () => {
        req.destroy();
        resolve();
      });
    });

    expect(await waitFor(() => settled)).toBe(true);
    expect((await collectEvents(workbench.engine.events({ afterSeq: 3 }))).length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The guard, through X-Writer
  // -------------------------------------------------------------------------

  it("lets a human execute a decision and refuses a program the same intent", async () => {
    const execute = JSON.stringify({
      docId: FIN_DOC,
      blockId: MACBOOK_BLOCK,
      affordance: "transition",
      params: { to: "executed" },
    });

    let refused: Response | undefined;
    const notices = await noticesDuring(async () => {
      refused = await postIntent(execute, "program:x");
    });

    expect(refused?.status).toBe(409);
    expect(await body(refused as Response)).toMatchObject({
      ok: false,
      rejection: { reason: "humans-only" },
    });
    expect(notices[0]).toMatchObject({
      surface: "intent",
      docId: FIN_DOC,
      blockId: MACBOOK_BLOCK,
      reason: "humans-only",
      by: { kind: "program", id: "x" },
    });

    // The same intent with no header is the browser — a human — and commits.
    const allowed = await postIntent(execute);
    expect(allowed.status).toBe(200);
    expect((await workbench.engine.getBlock(FIN_DOC, MACBOOK_BLOCK))?.attrs.value).toBe("executed");
  });

  // -------------------------------------------------------------------------
  // GET /api/projection/{docId}
  // -------------------------------------------------------------------------

  it("expands the board's includes with visible provenance in html", async () => {
    const res = await api(`/api/projection/${OVERVIEW_DOC}`);

    expect(res.status).toBe(200);
    const projection = await body(res);
    expect(projection).toMatchObject({ docId: OVERVIEW_DOC, format: "html", reader: "owner" });
    expect(projection.ok).toBe(true);
    const html = String(projection.output);
    expect(html).toContain('<section data-doc="fin" data-section="now">');
    expect(html).toContain('<section data-doc="research/q3-review" data-section="recommendation">');
  });

  it("renders the board's includes as text", async () => {
    const projection = await body(await api(`/api/projection/${OVERVIEW_DOC}?format=text`));

    expect(projection.format).toBe("text");
    expect(String(projection.output)).toContain(
      "> Now:\n> Cash: ¥23,450\n> Spend this month: ¥8,120",
    );
  });

  // -------------------------------------------------------------------------
  // The `chart` starter block, shown as the engine renders it — no renderer
  // -------------------------------------------------------------------------

  it("serves the chart section in html as an opaque <pre>, with no renderer (no <svg anywhere)", async () => {
    const projection = await body(await api(`/api/projection/${OVERVIEW_DOC}?format=html`));

    expect(projection.ok).toBe(true);
    const html = String(projection.output);
    const section = html.match(
      /<section data-doc="research\/q3-review" data-section="spend">.*?<\/section>/s,
    )?.[0];
    expect(section).toBeDefined();
    expect(section).toContain('<pre class="chart" data-source="ledger">');
    expect(section).toContain("pie title Q3 spend");
    expect(html).not.toContain("<svg");
  });

  it("renders the chart section in text as the heading on its own line, then every spec line blockquoted", async () => {
    const projection = await body(await api(`/api/projection/${OVERVIEW_DOC}?format=text`));

    expect(String(projection.output)).toContain(
      '> Spend:\n> pie title Q3 spend\n>   "Travel" : 45\n>   "Food" : 30\n>   "Subscriptions" : 15\n>   "Other" : 10',
    );
  });

  it("patches the chart's opaque spec through the block route, recording a validated block.updated", async () => {
    const newSpec = 'pie title Q3 spend\n  "Travel" : 50\n';
    const res = await api(`/api/doc/${Q3_DOC}/block/q3-spend`, {
      method: "PATCH",
      body: JSON.stringify({ attrs: { spec: newSpec } }),
    });

    expect(res.status).toBe(200);
    const events = await collectEvents(workbench.engine.events({ afterSeq: 0 }));
    const updated = events.find(
      (evt) => evt.type === "block.updated" && evt.blockId === "q3-spend",
    );
    expect(updated).toBeDefined();
    expect(updated?.by).toEqual({ kind: "human", id: "browser" });

    const after = await body(await api(`/api/projection/${OVERVIEW_DOC}?format=html`));
    expect(String(after.output)).toContain('"Travel" : 50');
    expect(String(after.output)).not.toContain('"Travel" : 45');
  });

  it("masks the cash for a guest and shows it to the owner", async () => {
    const guest = await body(await api(`/api/projection/${OVERVIEW_DOC}?reader=guest`));
    const owner = await body(await api(`/api/projection/${OVERVIEW_DOC}?reader=owner`));

    expect(guest.reader).toBe("guest");
    expect(String(guest.output)).toContain("¥••••");
    expect(String(guest.output)).not.toContain("¥23,450");
    expect(String(owner.output)).toContain("¥23,450");
  });

  it("answers 400 for an unknown format or an unknown reader", async () => {
    const format = await api(`/api/projection/${FIN_DOC}?format=pdf`);
    const reader = await api(`/api/projection/${FIN_DOC}?reader=auditor`);

    expect([format.status, reader.status]).toEqual([400, 400]);
    expect(await body(format)).toMatchObject({ ok: false, rejection: { reason: "bad-request" } });
    expect(await body(reader)).toMatchObject({ ok: false, rejection: { reason: "bad-request" } });
  });

  // -------------------------------------------------------------------------
  // Four hands
  // -------------------------------------------------------------------------

  it("produces the identical status.changed shape from all four write surfaces", async () => {
    const finPath = path.join(rootDir, "fin.md");

    // 1. An editor saving the file on disk.
    const onDisk = await workbench.engine.getDoc(FIN_DOC);
    await writeFile(
      finPath,
      (onDisk?.src ?? "").replace("value: pending", "value: approved"),
      "utf8",
    );
    await workbench.engine.externalWrite(finPath);
    await resetDecision();

    // 2. A browser click.
    await postIntent(
      JSON.stringify({
        docId: FIN_DOC,
        blockId: MACBOOK_BLOCK,
        affordance: "transition",
        params: { to: "approved" },
      }),
    );
    await resetDecision();

    // 3. A script patching the block.
    await api(`/api/doc/${FIN_DOC}/block/${MACBOOK_BLOCK}`, {
      method: "PATCH",
      body: JSON.stringify({ attrs: { value: "approved" } }),
    });
    await resetDecision();

    // 4. A full-text write.
    const current = await workbench.engine.getDoc(FIN_DOC);
    await api(`/api/doc/${FIN_DOC}`, {
      method: "PUT",
      body: JSON.stringify({
        fullText: (current?.src ?? "").replace("value: pending", "value: approved"),
      }),
    });

    const approvals = (await collectEvents(workbench.engine.events({ afterSeq: 0 })))
      .filter((evt: EventRecord) => evt.type === "status.changed" && evt.to === "approved")
      .map((evt) => ({
        docId: evt.docId,
        blockId: evt.blockId,
        from: evt.from,
        to: evt.to,
      }));

    expect(approvals).toHaveLength(4);
    expect(approvals).toEqual(
      Array.from({ length: 4 }, () => ({
        docId: FIN_DOC,
        blockId: MACBOOK_BLOCK,
        from: "pending",
        to: "approved",
      })),
    );
  });

  // -------------------------------------------------------------------------
  // Unknown routes and unexpected failures
  // -------------------------------------------------------------------------

  it("answers 404 for any method but PATCH on a /block/ path", async () => {
    // `/block/` names a block inside a document, never a document. Treating the
    // whole path as a docId would let a PUT create the shadow document
    // `fin/block/dec-macbook` — a `fin/` directory beside the real `fin.md`.
    const put = await api(`/api/doc/${FIN_DOC}/block/${MACBOOK_BLOCK}`, {
      method: "PUT",
      body: JSON.stringify({ fullText: "# not a document\n" }),
    });
    const read = await api(`/api/doc/${FIN_DOC}/block/${MACBOOK_BLOCK}`);

    expect([put.status, read.status]).toEqual([404, 404]);
    for (const res of [put, read]) {
      expect(await body(res)).toEqual({
        ok: false,
        rejection: { reason: "not-found", diagnostics: [] },
      });
    }
    expect(await workbench.engine.listDocs()).toEqual(["fin", "overview", "research/q3-review"]);
    await expect(stat(path.join(rootDir, FIN_DOC))).rejects.toThrow();
  });

  it("answers 404 not-found for an unknown route", async () => {
    const res = await api("/api/nope");

    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({
      ok: false,
      rejection: { reason: "not-found", diagnostics: [] },
    });
  });

  // -------------------------------------------------------------------------
  // Host and Origin checks, and the page's Content-Security-Policy
  // -------------------------------------------------------------------------

  /** One raw request, so a test can set `Host` (which `fetch` forbids). */
  function raw(
    pathname: string,
    opts: { method?: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
    const url = new URL(workbench.url);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: url.hostname,
          port: url.port,
          path: pathname,
          method: opts.method ?? "GET",
          headers: opts.headers,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            text += c;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: text, headers: { ...res.headers } }),
          );
        },
      );
      req.on("error", reject);
      req.end(opts.body);
    });
  }

  const portOf = (): string => new URL(workbench.url).port;

  it.each([["127.0.0.1"], ["localhost"], ["[::1]"]])("accepts Host %s:<port>", async (host) => {
    const res = await raw("/api/state", { headers: { host: `${host}:${portOf()}` } });
    expect(res.status).toBe(200);
  });

  it.each([
    ["evil.example"],
    ["evil.example:80"],
    ["127.0.0.1"],
    ["127.0.0.1:1"],
    ["localhost.evil.example:PORT"],
    ["127.0.0.1.evil.example:PORT"],
  ])("rejects Host %j with 421 and no app content", async (host) => {
    const res = await raw("/api/state", {
      headers: { host: host.replace("PORT", portOf()) },
    });
    expect(res.status).toBe(421);
    expect(res.body).not.toContain("rootDir");
    expect(res.body).toBe("");
  });

  it("rejects a foreign Host on the page and on a write too", async () => {
    expect((await raw("/", { headers: { host: "evil.example" } })).status).toBe(421);
    const write = await raw("/api/intent", {
      method: "POST",
      headers: { host: "evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(write.status).toBe(421);
  });

  it("refuses a write whose Origin is foreign, before reading it", async () => {
    for (const origin of [
      "http://evil.example",
      "http://127.0.0.1:1",
      "null",
      "https://127.0.0.1",
    ]) {
      const res = await api("/api/intent", {
        method: "POST",
        body: "{}",
        headers: { origin },
      });
      expect(res.status).toBe(403);
    }
  });

  it("refuses a foreign Origin on PUT, PATCH, and DELETE as well", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await api("/api/doc/overview", {
        method,
        body: "{}",
        headers: { origin: "http://evil.example" },
      });
      expect(res.status).toBe(403);
    }
  });

  it("accepts a write with the server's own Origin, and with no Origin", async () => {
    const own = await api("/api/intent", {
      method: "POST",
      body: "{}",
      headers: { origin: workbench.url },
    });
    expect(own.status).toBe(400); // past the origin check, refused as a bad intent
    const none = await api("/api/intent", { method: "POST", body: "{}" });
    expect(none.status).toBe(400);
  });

  it("does not check Origin on reads", async () => {
    const res = await api("/api/state", { headers: { origin: "http://evil.example" } });
    expect(res.status).toBe(200);
  });

  it("serves the page with a CSP that forbids inline script", async () => {
    const res = await api("/");
    const csp = res.headers.get("content-security-policy") ?? "";
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("serves the page without inline script, inline style, or inline handlers", async () => {
    const { loadPage } = await import("./page.js");
    const html = await loadPage();
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
  });

  it("serves the script and stylesheet the page links, with the CSP", async () => {
    const js = await api("/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("EventSource");
    const css = await api("/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers 500 internal instead of throwing at the socket", async () => {
    const port = await listen(
      createServer(router({ pageHtml: () => Promise.reject(new Error("the page is on fire")) })),
    );
    claimedPort = port;

    const res = await fetch(`http://127.0.0.1:${port}/`);

    expect(res.status).toBe(500);
    const rejection = (await body(res)).rejection as Record<string, unknown>;
    expect(rejection.reason).toBe("internal");
    expect(JSON.stringify(rejection.diagnostics)).toContain("the page is on fire");
  });

  // -------------------------------------------------------------------------
  // The event stream is reachable from the router
  // -------------------------------------------------------------------------

  it("streams an editor's save to a connected client as human:editor", async () => {
    const streamed = firstCommit(
      `${workbench.url}/api/events`,
      (evt) => evt.type === "status.changed",
    );
    const finPath = path.join(rootDir, "fin.md");
    const doc = await workbench.engine.getDoc(FIN_DOC);
    await writeFile(finPath, (doc?.src ?? "").replace("value: pending", "value: approved"), "utf8");
    await workbench.engine.externalWrite(finPath);

    const event = await streamed;

    expect(event.by).toEqual({ kind: "human", id: "editor" });
  });

  it("answers 400 for a non-numeric afterSeq", async () => {
    const res = await api("/api/events?afterSeq=soon");

    expect(res.status).toBe(400);
    expect(await body(res)).toMatchObject({ ok: false, rejection: { reason: "bad-request" } });
  });
});
