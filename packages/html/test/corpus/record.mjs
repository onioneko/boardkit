// Re-records `parse-inputs.jsonl.gz`: every distinct source the core test
// suite passes to `parseDoc`, sorted, one JSON string per line. Run it from
// the repository root after `pnpm build`:
//
//   node packages/html/test/corpus/record.mjs
//
// Sources over 200,000 characters are left out, to keep the differential test
// quick. Re-record when the core tests gain new kinds of documents.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = fileURLToPath(new URL(".", import.meta.url));
const core = join(here, "../../../core");
const dir = mkdtempSync(join(tmpdir(), "boardkit-corpus-"));
const raw = join(dir, "inputs.jsonl");
writeFileSync(raw, "");
try {
  const run = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "--config", join(here, "record.config.ts")],
    { cwd: core, stdio: "inherit", env: { ...process.env, BOARDKIT_CORPUS_OUT: raw } },
  );
  if (run.status !== 0) throw new Error(`the core test suite failed (${run.status})`);
  const sources = new Set();
  for (const line of readFileSync(raw, "utf8").split("\n")) {
    if (line.length > 0) sources.add(JSON.parse(line));
  }
  const kept = [...sources].filter((s) => s.length <= 200_000).sort();
  const body = `${kept.map((s) => JSON.stringify(s)).join("\n")}\n`;
  writeFileSync(join(here, "parse-inputs.jsonl.gz"), gzipSync(body, { level: 9 }));
  console.log(`recorded ${kept.length} sources`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
