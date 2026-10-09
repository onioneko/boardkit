import type { DeepReadonly } from "@onioneko/boardkit-core";
import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import { spliceTokens } from "./splice.js";

const at = (offset: number) => ({ line: 1, column: offset + 1, offset });

/** A one-paragraph tree whose only text node spans `src` and reads `value`. */
function treeOf(src: string, value: string): DeepReadonly<Root> {
  const position = { start: at(0), end: at(src.length) };
  return {
    type: "root",
    children: [{ type: "paragraph", position, children: [{ type: "text", value, position }] }],
  } as DeepReadonly<Root>;
}

function textOf(root: Root): string {
  const [paragraph] = root.children;
  const [text] = paragraph?.type === "paragraph" ? paragraph.children : [];
  return text?.type === "text" ? text.value : "";
}

describe("spliceTokens: placing a reference in a text node", () => {
  const src = "ab {{source:a}}";
  const ref = { kind: "text" as const, start: 3, end: 15, token: "TOKEN" };

  it("puts the token where the reference's source is", () => {
    const root = spliceTokens(treeOf(src, src), src, [{ start: 0, end: src.length }], [ref]);
    expect(textOf(root)).toBe("ab TOKEN");
  });

  it("fails closed: a reference it cannot align with `{{…}}` stays as the text was", () => {
    // The value does not follow from the source, so the reference's span
    // cannot be found in it. The `{{lit}}` later in the value is other text
    // and must not receive the token.
    const value = "zz {{lit}} cc";
    const root = spliceTokens(treeOf(src, value), src, [{ start: 0, end: src.length }], [ref]);
    expect(textOf(root)).toBe(value);
  });
});
