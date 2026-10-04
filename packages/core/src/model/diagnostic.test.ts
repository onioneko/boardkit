import { describe, expect, it } from "vitest";
import { diagnostic } from "./diagnostic.js";

describe("diagnostic", () => {
  it("creates a bare diagnostic", () => {
    expect(diagnostic("E_X", "msg")).toEqual({ code: "E_X", message: "msg", severity: "error" });
  });

  it("defaults severity to 'error'", () => {
    expect(diagnostic("E_X", "msg").severity).toBe("error");
  });

  it("accepts an explicit severity", () => {
    expect(diagnostic("E_X", "msg", { severity: "info" }).severity).toBe("info");
  });

  it("carries position when provided", () => {
    expect(diagnostic("E_X", "msg", { line: 3, col: 7 })).toEqual({
      code: "E_X",
      message: "msg",
      line: 3,
      col: 7,
      severity: "error",
    });
  });

  it("carries nodeId when provided", () => {
    expect(diagnostic("E_X", "msg", { nodeId: "n1" })).toEqual({
      code: "E_X",
      message: "msg",
      nodeId: "n1",
      severity: "error",
    });
  });

  it("omits unspecified optional fields other than severity", () => {
    expect(Object.hasOwn(diagnostic("E_X", "msg"), "line")).toBe(false);
    expect(Object.hasOwn(diagnostic("E_X", "msg"), "nodeId")).toBe(false);
  });
});
