import type { Writer } from "@onioneko/boardkit-core";
import { describe, expect, it } from "vitest";
import { browserWriter } from "./shared.js";
import { parseWriterHeader } from "./writer.js";

describe("parseWriterHeader (the workbench's X-Writer header)", () => {
  it("falls back to the browser writer when the header is absent", () => {
    const parsed = parseWriterHeader(undefined);
    expect(parsed).toEqual({ ok: true, writer: browserWriter });
  });

  const accepted: readonly (readonly [string, Writer])[] = [
    ["program:reactor-2", { kind: "program", id: "reactor-2" }],
    ["agent:my-agent", { kind: "agent", id: "my-agent" }],
    ["human:alice", { kind: "human", id: "alice" }],
  ];

  it.each(accepted)("parses %s into its writer", (value, writer) => {
    expect(parseWriterHeader(value)).toEqual({ ok: true, writer });
  });

  const rejected: readonly string[] = ["bot:x", "program:", "program", "program:a b", ""];

  it.each(rejected)("rejects %j with a message naming the expected form", (value) => {
    const parsed = parseWriterHeader(value);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("human|agent|program");
    expect(parsed.message).toContain(value);
  });
});
