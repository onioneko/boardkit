/**
 * The workbench's one static asset: `ui/index.html`.
 *
 * The file is read from disk on every request rather than cached at startup —
 * editing the page while the server runs and hitting reload is a feature, not
 * an accident. It lives outside `src/` because it is not TypeScript: the build
 * compiles `src/` only, so the path is resolved against the *package* directory
 * (which is one level above both `src/` and `dist/`).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { packageDir } from "../shared.js";

/**
 * Read the workbench page.
 * @returns The contents of `apps/demo/ui/index.html`.
 */
export function loadPage(): Promise<string> {
  return readFile(path.join(packageDir(), "ui", "index.html"), "utf8");
}

/**
 * Read one of the page's static assets, from the same `ui/` directory.
 * @param name Which asset (a closed set, so the name never reaches the path unchecked).
 * @returns The file's contents.
 */
export function loadAsset(name: "app.js" | "app.css"): Promise<string> {
  return readFile(path.join(packageDir(), "ui", name), "utf8");
}
