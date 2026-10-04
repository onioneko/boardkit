/**
 * The workbench's JSON API: one route table over the engine's write and read
 * surfaces, plus the page and the event stream.
 *
 * Two rules shape every handler. First, **failures are values**: a rejected
 * write answers 409 with the engine's own `WriteResult` verbatim, a malformed
 * request answers 400 with the same envelope and reason `bad-request`, and
 * nothing ever throws to the socket — an unexpected error is caught and
 * answered 500. Second, **every rejection the workbench sees is posted to the
 * feed** before the response goes out, so the other connected surfaces learn
 * about a refused write even though rejections are never persisted.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Diagnostic,
  diagnostic,
  type Engine,
  type Intent,
  type Source,
  type WriteResult,
  type Writer,
} from "@onioneko/boardkit-core";
import { type Feed, noticeFromRejection, type RejectionSurface } from "../feed.js";
import { isPlainRecord } from "../shared.js";
import { parseWriterHeader } from "../writer.js";
import { attachEventStream } from "./sse.js";

/** Everything the router needs; supplied once by `startWorkbench`. */
export interface RouterDeps {
  /** The engine every route reads and writes through. */
  readonly engine: Engine;
  /** The fan-out every rejected write is posted to. */
  readonly feed: Feed;
  /** The Source port projections resolve `{{source:…}}` refs with. */
  readonly source: Source;
  /** The workspace root, echoed by `/api/state` so the page can name it. */
  readonly rootDir: string;
  /** Which optional parts of the workbench are running, echoed by `/api/state`. */
  readonly flags: { readonly reactor: boolean; readonly guard: boolean };
  /** Loads the page served at `GET /`. */
  readonly pageHtml: () => Promise<string>;
  /** Loads one of the page's static assets (`app.js`, `app.css`). */
  readonly loadAsset: (name: AssetName) => Promise<string>;
  /**
   * The TCP port the server is bound to. A function because the port is only
   * known once the socket is listening, which is after the router is built.
   */
  readonly ownPort: () => number;
}

/** The static files the page links; anything else under `/` is a 404. */
export type AssetName = "app.js" | "app.css";

/** The request handler `node:http` calls; it settles when the response is written. */
export type Router = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Origin used only to parse the request target — the server binds loopback. */
const REQUEST_ORIGIN = "http://127.0.0.1";

/**
 * The hostnames a request may name in `Host`, each paired with the bound port.
 * The demo binds loopback only (`HOST` in `workbench.ts`), so these three
 * spellings of loopback are the whole allowed set: a DNS-rebinding page reaches
 * the socket under its own name, which is not in this list. Binding any other
 * address would require extending this list deliberately.
 */
const ALLOWED_HOSTNAMES: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/** Methods that change state; these get the `Origin` check. */
const WRITE_METHODS: readonly string[] = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * The policy the page is served under. No inline script or style is allowed:
 * the page is `index.html` plus `/app.js` and `/app.css`, all same-origin.
 * `connect-src` falls back to `default-src 'self'`, which covers the fetches
 * and the event stream.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** The largest request body the API reads before refusing it. */
const MAX_BODY_BYTES = 1024 * 1024;

/** The projectors the API exposes. */
const FORMATS: readonly string[] = ["html", "text"];

/** The reader identities the projection middleware understands. */
const READERS: readonly string[] = ["owner", "guest"];

/** The only content type the three write routes accept. */
const JSON_MEDIA_TYPE = "application/json";

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** Write a JSON body with a status code. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Answer with the rejection envelope every failing route uses — the same shape
 * the engine returns, so a client parses one thing whatever went wrong.
 */
function sendRejection(
  res: ServerResponse,
  status: number,
  reason: string,
  diagnostics: readonly Diagnostic[],
): void {
  sendJson(res, status, { ok: false, rejection: { reason, diagnostics } });
}

/** Answer `bad-request` with one diagnostic carrying the message. */
function sendBadRequest(res: ServerResponse, code: string, message: string, status = 400): void {
  sendRejection(res, status, "bad-request", [diagnostic(code, message)]);
}

/** Answer 404 `not-found` (an unknown route). */
function sendNotFound(res: ServerResponse): void {
  sendRejection(res, 404, "not-found", []);
}

// ---------------------------------------------------------------------------
// Request parsing — the handlers never trust the body
// ---------------------------------------------------------------------------

/** A parsed request body, or the refusal to send back. */
type BodyOutcome =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

/**
 * Read and parse a JSON request body, refusing anything over the size cap
 * before it is buffered. Never throws and always settles: a read error, an
 * oversized body, unparseable bytes, and a client that hangs up mid-upload
 * are all outcomes.
 */
function readJsonBody(req: IncomingMessage): Promise<BodyOutcome> {
  return new Promise((resolve) => {
    let text = "";
    let size = 0;
    let settled = false;
    const finish = (outcome: BodyOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (settled) return; // over the cap: keep the socket flowing, drop the bytes
      size += Buffer.byteLength(chunk, "utf8");
      if (size > MAX_BODY_BYTES) {
        finish({
          ok: false,
          status: 413,
          code: "E_BODY_TOO_LARGE",
          message: `request body exceeds ${MAX_BODY_BYTES} bytes`,
        });
        return;
      }
      text += chunk;
    });
    req.on("end", () => {
      if (text === "") {
        finish({ ok: true, value: undefined });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(text) });
      } catch (err) {
        finish({
          ok: false,
          status: 400,
          code: "E_BAD_JSON",
          message: `body is not JSON: ${String(err)}`,
        });
      }
    });
    req.on("error", (err) => {
      finish({ ok: false, status: 400, code: "E_BODY_READ", message: String(err) });
    });
    // A client that hangs up mid-upload never emits `end`. A destroyed socket
    // also emits `error`, but not every hangup does — and a body promise that
    // never settles is a handler that never answers.
    req.on("close", () => {
      finish({
        ok: false,
        status: 400,
        code: "E_BODY_ABORTED",
        message: "request body was not fully received",
      });
    });
  });
}

/**
 * Whether the request declares a JSON body — the workbench's only defence
 * against another website writing to it.
 *
 * A browser will send a cross-origin `POST` with no preflight at all as long as
 * the content type is one of the three a form can produce (`text/plain`,
 * `application/x-www-form-urlencoded`, `multipart/form-data`). Demanding
 * `application/json` therefore forces a preflight, and this server answers no
 * `OPTIONS`: the write never leaves the other site. Parameters
 * (`; charset=utf-8`) are part of a legitimate header and are allowed.
 */
function declaresJsonBody(req: IncomingMessage): boolean {
  const raw = req.headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.split(";")[0]?.trim().toLowerCase() === JSON_MEDIA_TYPE;
}

/** The `X-Writer` header value, if the request sent exactly one. */
function writerHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-writer"];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The cursor an event-stream request resumes from: `Last-Event-ID` wins over
 * `?afterSeq`, and nothing at all means "from the beginning". `undefined` means
 * the client sent something that is not a cursor.
 */
function afterSeqOf(req: IncomingMessage, url: URL): number | undefined {
  const header = req.headers["last-event-id"];
  const raw = (Array.isArray(header) ? header[0] : header) ?? url.searchParams.get("afterSeq");
  if (raw === null || raw === undefined || raw === "") return 0;
  const seq = Number(raw);
  return Number.isInteger(seq) && seq >= 0 ? seq : undefined;
}

/** URL-decode one path remainder; `undefined` when the escaping is malformed. */
function decodePath(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** The compare-and-set guards a write body may carry. */
interface Guards {
  readonly expectedVersion?: string;
  readonly expected?: Record<string, unknown>;
}

/**
 * The optional compare-and-set guards in a request body. A guard of the wrong
 * type is refused rather than dropped: silently applying an unguarded write
 * because `expectedVersion` arrived as a number is exactly the lost update the
 * guard exists to prevent.
 */
function guardsOf(
  payload: Record<string, unknown>,
):
  | { readonly ok: true; readonly guards: Guards }
  | { readonly ok: false; readonly message: string } {
  const expectedVersion = payload.expectedVersion;
  const expected = payload.expected;
  if (expectedVersion !== undefined && typeof expectedVersion !== "string") {
    return { ok: false, message: "expectedVersion must be a string when present" };
  }
  if (expected !== undefined && !isPlainRecord(expected)) {
    return { ok: false, message: "expected must be an object when present" };
  }
  return {
    ok: true,
    guards: {
      ...(typeof expectedVersion === "string" ? { expectedVersion } : {}),
      ...(isPlainRecord(expected) ? { expected } : {}),
    },
  };
}

/**
 * Re-brand a decoded `data-intent` payload as an applyable {@link Intent}. The
 * payload is untrusted input, so a missing field is a value, not a throw.
 */
function intentFromPayload(
  payload: Record<string, unknown>,
):
  | { readonly ok: true; readonly intent: Intent }
  | { readonly ok: false; readonly message: string } {
  const docId = payload.docId;
  const blockId = payload.blockId;
  const affordance = payload.affordance;
  if (typeof docId !== "string" || typeof blockId !== "string" || typeof affordance !== "string") {
    return { ok: false, message: "intent payload needs string docId, blockId, and affordance" };
  }
  const guards = guardsOf(payload);
  if (!guards.ok) return guards;
  const params = payload.params;
  return {
    ok: true,
    intent: {
      docId,
      blockId,
      affordance,
      ...(params !== undefined ? { params } : {}),
      ...guards.guards,
    },
  };
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

/**
 * Build the request handler.
 * @param deps The engine, feed, source, workspace root, flags, and page loader.
 * @returns A handler that answers every request and never throws.
 */
export function createRouter(deps: RouterDeps): Router {
  /**
   * Answer a write: 200 with the engine's result, or 409 with its rejection —
   * posted to the feed first, so every connected surface sees the refusal.
   */
  function answerWrite(
    res: ServerResponse,
    result: WriteResult,
    context: { by: Writer; surface: RejectionSurface; docId: string; blockId?: string },
  ): void {
    if (result.ok) {
      sendJson(res, 200, result);
      return;
    }
    deps.feed.rejection(noticeFromRejection({ ...context, result }));
    sendJson(res, 409, result);
  }

  /** `GET /` — the workbench page, re-read from disk on every request. */
  async function servePage(res: ServerResponse): Promise<void> {
    const html = await deps.pageHtml();
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
    });
    res.end(html);
  }

  /** `GET /app.js` and `GET /app.css` — the page's own script and stylesheet. */
  async function serveAsset(res: ServerResponse, name: AssetName): Promise<void> {
    const body = await deps.loadAsset(name);
    res.writeHead(200, {
      "content-type":
        name === "app.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  }

  /** The `Host` values this server answers to, one per allowed hostname. */
  function allowedHosts(): string[] {
    return ALLOWED_HOSTNAMES.map((name) => `${name}:${deps.ownPort()}`);
  }

  /** Refuse a request outright: a bare status line, nothing from the app. */
  function refuse(res: ServerResponse, status: number): void {
    res.writeHead(status, { "content-length": "0" });
    res.end();
  }

  /**
   * The Host and Origin gates, run before any routing. A `Host` outside the
   * allowed set is 421 (DNS rebinding); a state-changing request whose `Origin`
   * is present and is not one of this server's own origins is 403. No `Origin`
   * is allowed — curl and scripts do not send one.
   * @returns True when the request may proceed.
   */
  function admit(req: IncomingMessage, res: ServerResponse, method: string): boolean {
    const hosts = allowedHosts();
    const host = req.headers.host;
    if (host === undefined || !hosts.includes(host.toLowerCase())) {
      refuse(res, 421);
      return false;
    }
    if (WRITE_METHODS.includes(method)) {
      const origin = req.headers.origin;
      if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) {
        refuse(res, 403);
        return false;
      }
    }
    return true;
  }

  /** `GET /api/state` — what the page needs to draw itself. */
  async function serveState(res: ServerResponse): Promise<void> {
    sendJson(res, 200, {
      rootDir: deps.rootDir,
      docs: await deps.engine.listDocs(),
      lastSeq: deps.feed.lastSeq(),
      reactor: deps.flags.reactor,
      guard: deps.flags.guard,
    });
  }

  /** `GET /api/doc/{docId}` — the raw source and the version to write against. */
  async function serveDoc(res: ServerResponse, docId: string): Promise<void> {
    const doc = await deps.engine.getDoc(docId);
    if (doc === undefined) {
      sendRejection(res, 404, "missing-doc", [
        diagnostic("E_DOC_MISSING", `document not found: ${docId}`),
      ]);
      return;
    }
    sendJson(res, 200, { docId, src: doc.src, version: doc.version });
  }

  /** `PUT /api/doc/{docId}` — a full-text write, or a create when the doc is new. */
  async function putDoc(
    res: ServerResponse,
    docId: string,
    writer: Writer,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const fullText = payload.fullText;
    if (typeof fullText !== "string") {
      sendBadRequest(res, "E_BAD_BODY", "PUT body needs a string fullText");
      return;
    }
    const guards = guardsOf(payload);
    if (!guards.ok) {
      sendBadRequest(res, "E_BAD_BODY", guards.message);
      return;
    }
    const { expectedVersion } = guards.guards;
    // Racy by construction: a concurrent create between this read and the write
    // makes `createDoc` reject with `exists`, which is the safe side of the race
    // — a 409 rather than a silent overwrite of someone else's new document.
    const exists = (await deps.engine.getDoc(docId)) !== undefined;
    const result =
      !exists && expectedVersion === undefined
        ? await deps.engine.createDoc(docId, { writer, content: fullText })
        : await deps.engine.write(docId, {
            writer,
            fullText,
            ...(expectedVersion !== undefined ? { expectedVersion } : {}),
          });
    answerWrite(res, result, { by: writer, surface: "write", docId });
  }

  /** `PATCH /api/doc/{docId}/block/{blockId}` — an attrs delta with optional guards. */
  async function patchBlock(
    res: ServerResponse,
    docId: string,
    blockId: string,
    writer: Writer,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const attrs = payload.attrs;
    if (!isPlainRecord(attrs)) {
      sendBadRequest(res, "E_BAD_BODY", "PATCH body needs an attrs object");
      return;
    }
    const guards = guardsOf(payload);
    if (!guards.ok) {
      sendBadRequest(res, "E_BAD_BODY", guards.message);
      return;
    }
    const result = await deps.engine.patch(docId, blockId, {
      writer,
      attrs,
      ...guards.guards,
    });
    answerWrite(res, result, { by: writer, surface: "patch", docId, blockId });
  }

  /** `POST /api/intent` — the `data-intent` payload the html projector emitted. */
  async function postIntent(
    res: ServerResponse,
    writer: Writer,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const parsed = intentFromPayload(payload);
    if (!parsed.ok) {
      sendBadRequest(res, "E_BAD_INTENT", parsed.message);
      return;
    }
    const { intent } = parsed;
    const result = await deps.engine.applyIntent(intent, { writer });
    answerWrite(res, result, {
      by: writer,
      surface: "intent",
      docId: intent.docId,
      blockId: intent.blockId,
    });
  }

  /** `GET /api/projection/{docId}` — one projector's output for one reader. */
  async function serveProjection(res: ServerResponse, docId: string, url: URL): Promise<void> {
    const format = url.searchParams.get("format") ?? "html";
    const reader = url.searchParams.get("reader") ?? "owner";
    if (!FORMATS.includes(format)) {
      sendBadRequest(res, "E_BAD_FORMAT", `unknown format "${format}": expected html or text`);
      return;
    }
    if (!READERS.includes(reader)) {
      sendBadRequest(res, "E_BAD_READER", `unknown reader "${reader}": expected owner or guest`);
      return;
    }
    const result = await deps.engine.projection<string>(docId, format, {
      source: deps.source,
      options: { reader },
    });
    sendJson(res, 200, {
      docId,
      format,
      reader,
      ok: result.ok,
      output: result.output,
      diagnostics: result.diagnostics,
      versions: result.versions,
    });
  }

  /** `GET /api/events` — replay from the client's cursor, then follow the feed. */
  async function serveEvents(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const afterSeq = afterSeqOf(req, url);
    if (afterSeq === undefined) {
      sendBadRequest(res, "E_BAD_CURSOR", "afterSeq must be a non-negative integer");
      return;
    }
    await attachEventStream(res, { engine: deps.engine, feed: deps.feed, afterSeq });
  }

  /** Read the body and the writer, then hand both to a write route. */
  async function withWrite(
    req: IncomingMessage,
    res: ServerResponse,
    apply: (writer: Writer, payload: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    // Before the writer, before the body: a request that does not declare JSON
    // is refused without being read at all.
    if (!declaresJsonBody(req)) {
      sendBadRequest(
        res,
        "E_CONTENT_TYPE",
        `write routes require content-type: ${JSON_MEDIA_TYPE}`,
      );
      return;
    }
    const writer = parseWriterHeader(writerHeader(req));
    if (!writer.ok) {
      sendBadRequest(res, "E_BAD_WRITER", writer.message);
      return;
    }
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendBadRequest(res, parsed.code, parsed.message, parsed.status);
      return;
    }
    if (!isPlainRecord(parsed.value)) {
      sendBadRequest(res, "E_BAD_BODY", "body must be a JSON object");
      return;
    }
    await apply(writer.writer, parsed.value);
  }

  /** Dispatch everything under `/api/doc/…` by method. */
  async function routeDoc(
    req: IncomingMessage,
    res: ServerResponse,
    rest: string,
    method: string,
  ): Promise<void> {
    const marker = "/block/";
    const split = rest.lastIndexOf(marker);
    if (split !== -1) {
      // `/block/` names a block inside a document, never a document. Any other
      // method here would read the whole path as a docId — and a `PUT` would
      // create the shadow document `fin/block/dec-macbook` on disk.
      if (method !== "PATCH") {
        sendNotFound(res);
        return;
      }
      const docId = decodePath(rest.slice(0, split));
      const blockId = decodePath(rest.slice(split + marker.length));
      if (docId === undefined || blockId === undefined) {
        sendBadRequest(res, "E_BAD_PATH", `malformed url escape in ${rest}`);
        return;
      }
      await withWrite(req, res, (writer, payload) =>
        patchBlock(res, docId, blockId, writer, payload),
      );
      return;
    }
    const docId = decodePath(rest);
    if (docId === undefined) {
      sendBadRequest(res, "E_BAD_PATH", `malformed url escape in ${rest}`);
      return;
    }
    if (method === "GET") return serveDoc(res, docId);
    if (method === "PUT") {
      await withWrite(req, res, (writer, payload) => putDoc(res, docId, writer, payload));
      return;
    }
    sendNotFound(res);
  }

  /** Dispatch one request to its handler, or 404. */
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", REQUEST_ORIGIN);
    const method = req.method ?? "GET";
    const pathname = url.pathname;

    if (!admit(req, res, method)) return;
    if (method === "GET" && pathname === "/") return servePage(res);
    if (method === "GET" && pathname === "/app.js") return serveAsset(res, "app.js");
    if (method === "GET" && pathname === "/app.css") return serveAsset(res, "app.css");
    if (method === "GET" && pathname === "/api/state") return serveState(res);
    if (method === "GET" && pathname === "/api/events") return serveEvents(req, res, url);
    if (method === "POST" && pathname === "/api/intent") {
      await withWrite(req, res, (writer, payload) => postIntent(res, writer, payload));
      return;
    }
    if (pathname.startsWith("/api/doc/")) {
      return routeDoc(req, res, pathname.slice("/api/doc/".length), method);
    }
    if (method === "GET" && pathname.startsWith("/api/projection/")) {
      const docId = decodePath(pathname.slice("/api/projection/".length));
      if (docId === undefined) {
        sendBadRequest(res, "E_BAD_PATH", `malformed url escape in ${pathname}`);
        return;
      }
      return serveProjection(res, docId, url);
    }

    sendNotFound(res);
  }

  return async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      // Nothing reaches the socket as a throw: an unexpected failure is a 500
      // with the same envelope as every other refusal.
      if (res.headersSent) {
        res.end();
        return;
      }
      sendRejection(res, 500, "internal", [diagnostic("E_INTERNAL", String(err))]);
    }
  };
}
