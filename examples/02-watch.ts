// 02-watch.ts — edit the file on disk yourself, watch the projection follow.
// Interactive: it waits on your editor and stops on Ctrl-C, so CI only
// typechecks this file (no `// Output:` block). Run it yourself:
// `pnpm example 02-watch.ts`.

import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { starterBlocks } from "@onioneko/boardkit-blocks";
import {
  createEngine,
  createFsStorage,
  type EventRecord,
  type Source,
  type Writer,
} from "@onioneko/boardkit-core";

// 1. A filesystem workspace that persists across runs, with watching on.
const root = fileURLToPath(new URL("./.workspace/", import.meta.url));
await mkdir(root, { recursive: true });
const writer: Writer = { kind: "human", id: "me" };
const engine = createEngine({
  storage: createFsStorage({ root }),
  blocks: starterBlocks,
  watch: true,
});

// 2. Text in: seed the shared document only the first time it runs.
const existing = await engine.getDoc("fin");
if (existing === undefined) {
  const fin = await readFile(new URL("./fin.md", import.meta.url), "utf8");
  await engine.createDoc("fin", { writer, content: fin });
  console.log("seeded examples/.workspace (fresh event log)");
} else {
  console.log("reopened examples/.workspace (event log continues)");
}
console.log(`edit ${root}fin.md in your editor — Ctrl-C to stop`);

// The Source port answers {{source:…}} lookups at projection time.
const source: Source = {
  async resolve(ref) {
    return ref.source === "bank_balance" ? "¥23,450" : "—";
  },
};

// Who made each commit: "human:me" seeded the file; "human:external" is you, via the watcher.
function authorTag(evt: EventRecord): string {
  const by = evt.by as Writer;
  return `${by.kind}:${by.id}`;
}

// 3. Watch: every edit you save lands as a doc.updated event; re-project it.
engine.subscribe(async (evt) => {
  console.log(`${evt.seq} ${evt.type} by ${authorTag(evt)}`);
  if (evt.type !== "doc.updated") return;
  const projected = await engine.projection<string>("fin", "text", { source });
  console.log(projected.output);
});

// 4. Stop cleanly on Ctrl-C: close the watcher (the workspace itself stays).
process.on("SIGINT", () => {
  void engine.close().then(() => process.exit(0));
});
