import { describe, expect, it } from "vitest";
import { validateFrontmatter } from "./frontmatter.js";

describe("validateFrontmatter", () => {
  it("accepts empty frontmatter", () => {
    const r = validateFrontmatter({});
    expect(r.diagnostics).toEqual([]);
    expect(r.stability).toBeUndefined();
    expect(r.stableSections).toBeUndefined();
  });

  it("accepts valid stability and stable_sections", () => {
    const r = validateFrontmatter({ stability: "volatile", stable_sections: ["principles"] });
    expect(r.diagnostics).toEqual([]);
    expect(r.stability).toBe("volatile");
    expect(r.stableSections).toEqual(["principles"]);
  });

  it("flags invalid stability", () => {
    const r = validateFrontmatter({ stability: "sometimes" });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]?.code).toBe("E_FRONTMATTER_STABILITY");
  });

  it("flags non-array stable_sections", () => {
    const r = validateFrontmatter({ stable_sections: "principles" });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]?.code).toBe("E_FRONTMATTER_STABLE_SECTIONS");
  });

  it("flags stable_sections containing non-strings", () => {
    const r = validateFrontmatter({ stable_sections: ["ok", 3] });
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]?.code).toBe("E_FRONTMATTER_STABLE_SECTIONS");
  });

  it("passes unknown keys through without diagnostics", () => {
    const r = validateFrontmatter({ title: "Family Finance", stability: "volatile" });
    expect(r.diagnostics).toEqual([]);
    expect(r.stability).toBe("volatile");
  });

  it("omits invalid values from the validated result", () => {
    const r = validateFrontmatter({ stability: 42 });
    expect(r.stability).toBeUndefined();
  });

  it("accepts refs: false", () => {
    const r = validateFrontmatter({ refs: false });
    expect(r.diagnostics).toEqual([]);
    expect(r.refs).toBe(false);
  });

  it("accepts refs: [include]", () => {
    const r = validateFrontmatter({ refs: ["include"] });
    expect(r.diagnostics).toEqual([]);
    expect(r.refs).toEqual(["include"]);
  });

  it("accepts refs: [source, include]", () => {
    const r = validateFrontmatter({ refs: ["source", "include"] });
    expect(r.diagnostics).toEqual([]);
    expect(r.refs).toEqual(["source", "include"]);
  });

  it("flags invalid refs values", () => {
    expect(validateFrontmatter({ refs: true }).diagnostics[0]?.code).toBe("E_FRONTMATTER_REFS");
    expect(validateFrontmatter({ refs: "include" }).diagnostics[0]?.code).toBe(
      "E_FRONTMATTER_REFS",
    );
    expect(validateFrontmatter({ refs: ["nope"] }).diagnostics[0]?.code).toBe("E_FRONTMATTER_REFS");
    expect(validateFrontmatter({ refs: [3] }).diagnostics[0]?.code).toBe("E_FRONTMATTER_REFS");
    expect(validateFrontmatter({ refs: 42 }).diagnostics[0]?.code).toBe("E_FRONTMATTER_REFS");
  });

  it("omits invalid refs values from the validated result", () => {
    const r = validateFrontmatter({ refs: "include" });
    expect(r.refs).toBeUndefined();
    expect(r.diagnostics).toHaveLength(1);
  });
});
