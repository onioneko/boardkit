import { describe, expect, it } from "vitest";
import { docVersion } from "./version.js";

describe("docVersion", () => {
  it("is a stable hash of the source content", () => {
    const a = docVersion("# A");
    const b = docVersion("# A");
    const c = docVersion("# A\n");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
