/**
 * The `// Output:` runner (Go's testable-examples convention): a file with a
 * `// Output:` block has its `tsx` stdout diffed against it; a file with none
 * is typechecked only (by `pnpm typecheck`), listed below for visibility.
 */
import { type ExecFileException, execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = path.dirname(fileURLToPath(import.meta.url));
const self = path.basename(fileURLToPath(import.meta.url));
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

/** The expected stdout from a file's `// Output:` block, or `undefined` when it has none. */
function expectedOutput(src: string): string | undefined {
  const lines = src.split("\n");
  const start = lines.indexOf("// Output:");
  if (start === -1) return undefined;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "//") {
      out.push("");
      continue;
    }
    if (!line.startsWith("// ")) break;
    out.push(line.slice(3));
  }
  return out.join("\n");
}

/** Run one example under `tsx` and capture its outcome (never rejects). */
function runExample(file: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const opts = {
    cwd: dir,
    timeout: 30_000,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  };
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tsxCli, file],
      opts,
      (err: ExecFileException | null, stdout, stderr) => {
        resolve({
          code: err === null ? 0 : typeof err.code === "number" ? err.code : 1,
          stdout,
          stderr,
        });
      },
    );
  });
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && f !== self)
  .sort();
const withOutput = files.filter(
  (f) => expectedOutput(readFileSync(path.join(dir, f), "utf8")) !== undefined,
);
const typecheckedOnly = files.filter((f) => !withOutput.includes(f));

describe("examples", () => {
  it.each(withOutput)("%s prints its documented Output block", async (file) => {
    const expected = expectedOutput(readFileSync(path.join(dir, file), "utf8")) ?? "";
    const { code, stdout, stderr } = await runExample(file);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.trimEnd()).toBe(expected.trimEnd());
  });

  it.skip(`typechecked only: ${typecheckedOnly.join(", ")}`, () => {});
});
