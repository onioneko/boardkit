import path from "node:path";
import chokidar from "chokidar";
import type { WatchSource } from "./source.js";

const MARKDOWN_EXT = ".md";

/** Minimal structural shape of a watcher (injectable for tests). */
export interface ChokidarLike {
  /**
   * Subscribe to a watcher event.
   * @param event The event name (`add`, `change`, `unlink`, …).
   * @param callback Called with the affected path.
   */
  on(event: string, callback: (path: string) => void): void;
  /** @returns A promise that resolves when the watcher is closed. */
  close(): Promise<void>;
}

/**
 * Decide whether a watcher-emitted path is a document change worth forwarding.
 * Reproduces the `**\/*.md` selection chokidar v3 applied for us: markdown
 * files only, excluding dotfiles and lock files (lock files never carry the
 * `.md` extension, so the explicit checks document intent rather than change
 * behavior).
 * @param p The path the watcher reported (absolute when `rootDir` is absolute).
 * @returns True when the path names a non-hidden markdown document.
 */
function isMarkdownDocPath(p: string): boolean {
  const base = path.basename(p);
  if (base.startsWith(".")) return false;
  if (base.endsWith(".lock")) return false;
  return base.endsWith(MARKDOWN_EXT);
}

/**
 * chokidar-backed WatchSource over a workspace directory. chokidar v4 removed
 * glob support, so the adapter watches the ROOT DIRECTORY recursively (v4 is
 * recursive by default) and filters events down to `.md` document paths here.
 * @param rootDir The directory to watch recursively (markdown files under it).
 * @param watchFactory Injectable watcher constructor (defaults to chokidar, ignoring initial files).
 * @returns A WatchSource that forwards add/change/unlink of `.md` documents.
 */
export function createChokidarSource(
  rootDir: string,
  watchFactory: (dir: string) => ChokidarLike = (dir) =>
    chokidar.watch(dir, { ignoreInitial: true }),
): WatchSource {
  return {
    async start(onChange) {
      const watcher = watchFactory(rootDir);
      const forward = (p: string): void => {
        if (isMarkdownDocPath(p)) onChange({ path: p });
      };
      watcher.on("add", forward);
      watcher.on("change", forward);
      watcher.on("unlink", forward);
      return async () => {
        await watcher.close();
      };
    },
  };
}
