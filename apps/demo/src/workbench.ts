/**
 * The workbench: one long-running process holding a real filesystem workspace,
 * the engine over it, the feed that fans every commit and rejection out, the
 * automated writer, and the http server that exposes all of it.
 *
 * `startWorkbench` is the composition root — the only place the pieces are
 * wired together — so the CLI, the tests, and any embedding host all get the
 * identical assembly. Everything it opens, it closes: `close()` destroys open
 * event streams so the server actually stops, unsubscribes the reactor, closes
 * the feed, and closes the engine (which stops the watcher).
 */
import { createServer, type Server } from "node:http";
import type { Clock, Engine, WatchSource } from "@onioneko/boardkit-core";
import { createFeed, type Feed } from "./feed.js";
import { loadAsset, loadPage } from "./http/page.js";
import { createRouter } from "./http/router.js";
import { subscribeReactor } from "./reactor.js";
import { DEFAULT_PORT, demoSource } from "./shared.js";
import { openWorkspace } from "./workspace.js";

/**
 * The loopback address the workbench binds; there is no auth, by design. The
 * router's Host allow-list (`ALLOWED_HOSTNAMES`) assumes this is loopback.
 */
const HOST = "127.0.0.1";

/** Timestamps for rejections when the caller supplies no clock. */
const wallClock: Clock = () => new Date().toISOString();

/** How to start the workbench. */
export interface WorkbenchOptions {
  /** The workspace root to open (created and seeded when empty). */
  readonly rootDir: string;
  /** TCP port; `0` picks an ephemeral one (tests), default `4321`. */
  readonly port?: number;
  /** Empty the root before opening it. */
  readonly reset?: boolean;
  /** `false` leaves the automated writer unsubscribed. */
  readonly reactor?: boolean;
  /** `false` removes the humans-only write guard. */
  readonly guard?: boolean;
  /** Timestamp source for events and rejections. */
  readonly clock?: Clock;
  /** Watch source override; tests pass a no-op source instead of chokidar. */
  readonly watchSource?: WatchSource;
  /** `false` disables external-write watching entirely. */
  readonly watch?: boolean;
}

/** A running workbench: where it listens, what it opened, and how to stop it. */
export interface Workbench {
  /** The base url the browser and the API are served from. */
  readonly url: string;
  /** The workspace root that was opened. */
  readonly rootDir: string;
  /** The engine over that workspace. */
  readonly engine: Engine;
  /** The fan-out of commits and rejections. */
  readonly feed: Feed;
  /** True when this start seeded the workspace. */
  readonly seeded: boolean;
  /** Which optional parts are running. */
  readonly flags: { readonly reactor: boolean; readonly guard: boolean };
  /**
   * Stop everything this start opened. Idempotent: a second call returns the
   * same promise as the first.
   * @returns A promise that settles once the server, feed, and engine are closed.
   */
  close(): Promise<void>;
}

/** Resolve once the server is accepting connections, and report the bound port. */
function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      const address = server.address();
      server.removeListener("error", reject);
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });
}

/**
 * Open a workspace, wire the feed, reactor, and http server over it, and start
 * listening.
 * @param opts The root to open, the port to bind, and the optional flags.
 * @returns The running workbench.
 */
export async function startWorkbench(opts: WorkbenchOptions): Promise<Workbench> {
  const flags = { reactor: opts.reactor !== false, guard: opts.guard !== false };

  const { rootDir, engine, seeded } = await openWorkspace({
    rootDir: opts.rootDir,
    guard: flags.guard,
    ...(opts.reset !== undefined ? { reset: opts.reset } : {}),
    ...(opts.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts.watch !== undefined ? { watch: opts.watch } : {}),
    ...(opts.watchSource !== undefined ? { watchSource: opts.watchSource } : {}),
  });

  const feed = await createFeed(engine, opts.clock ?? wallClock);
  const reactor = flags.reactor
    ? subscribeReactor(engine, { onRejection: (notice) => feed.rejection(notice) })
    : undefined;

  let port = 0;
  const server = createServer(
    createRouter({
      engine,
      feed,
      source: demoSource(),
      rootDir,
      flags,
      pageHtml: loadPage,
      loadAsset,
      ownPort: () => port,
    }),
  );
  try {
    port = await listen(server, opts.port ?? DEFAULT_PORT);
  } catch (err) {
    // The caller never gets a handle, so nobody else can close what the two
    // steps above already opened: an occupied port would otherwise leave a live
    // watcher and an open engine over the workspace for the rest of the process.
    reactor?.unsubscribe();
    await reactor?.drain();
    feed.close();
    await engine.close();
    throw err;
  }

  let closing: Promise<void> | undefined;

  return {
    url: `http://${HOST}:${port}`,
    rootDir,
    engine,
    feed,
    seeded,
    flags,
    close(): Promise<void> {
      // Event streams never end on their own, so `server.close()` would wait
      // forever on them: drop the open sockets first, then wait for the close.
      closing ??= (async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        // Unsubscribing only stops the *next* reaction. A reaction already in
        // flight is still writing through this engine, so the close waits for
        // it — otherwise the last write lands in a workspace whose engine is
        // gone, or in a directory a test is already removing.
        reactor?.unsubscribe();
        await reactor?.drain();
        feed.close();
        await engine.close();
      })();
      return closing;
    },
  };
}
