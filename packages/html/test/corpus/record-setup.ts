/**
 * Setup file for recording the parse corpus (see `record.mjs`): every source
 * the core test suite parses is appended, one JSON string per line, to the
 * file named by `BOARDKIT_CORPUS_OUT`.
 */
import { appendFileSync } from "node:fs";
import { vi } from "vitest";

vi.mock(import("../../../core/src/parse/pipeline.js"), async (importOriginal) => {
  const actual = await importOriginal();
  const out = process.env.BOARDKIT_CORPUS_OUT;
  if (out === undefined) throw new Error("BOARDKIT_CORPUS_OUT is not set");
  return {
    ...actual,
    parseDoc: (...args: Parameters<typeof actual.parseDoc>) => {
      appendFileSync(out, `${JSON.stringify(args[0])}\n`);
      return actual.parseDoc(...args);
    },
  };
});
