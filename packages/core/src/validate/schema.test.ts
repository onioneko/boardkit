import { describe, expect, it } from "vitest";
import type { BlockType } from "../blocks/types.js";
import { enforceHistory } from "./history.js";
import { validateAttrs, validateBlock, validateCrossField } from "./schema.js";

const statusBlock: BlockType = {
  type: "status",
  schema: {
    type: "object",
    required: ["id", "states", "value"],
    properties: {
      id: { type: "string" },
      states: { type: "array", items: { type: "string" } },
      value: { type: "string" },
    },
    additionalProperties: true,
  },
  // Cross-field rule JSON Schema cannot express: value must be a member of states.
  validate: (attrs: unknown) => {
    if (typeof attrs !== "object" || attrs === null) return [];
    const { value, states } = attrs as { value?: unknown; states?: unknown };
    if (Array.isArray(states) && typeof value === "string" && !states.includes(value)) {
      return [{ code: "E_STATUS_VALUE", message: `value "${value}" is not in states` }];
    }
    return [];
  },
};

describe("validateAttrs (static schema)", () => {
  it("accepts valid attrs", () => {
    expect(
      validateAttrs(statusBlock, { id: "d1", states: ["pending", "approved"], value: "pending" }),
    ).toEqual([]);
  });

  it("reports schema violations as diagnostics", () => {
    const diags = validateAttrs(statusBlock, { id: 42, states: "nope", value: "pending" });
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.every((d) => d.code === "E_BLOCK_SCHEMA")).toBe(true);
  });
});

describe("validateCrossField", () => {
  it("runs the block's own validate hook for instance-level rules", () => {
    const ok = validateCrossField(statusBlock, { id: "d1", states: ["pending"], value: "pending" });
    expect(ok).toEqual([]);
    const bad = validateCrossField(statusBlock, {
      id: "d1",
      states: ["pending"],
      value: "appproved",
    });
    expect(bad.map((d) => d.code)).toEqual(["E_STATUS_VALUE"]);
  });
});

describe("validateBlock", () => {
  it("combines static and cross-field diagnostics", () => {
    const diags = validateBlock(statusBlock, { id: 42, states: ["pending"], value: "nope" });
    expect(diags.some((d) => d.code === "E_BLOCK_SCHEMA")).toBe(true);
    expect(diags.some((d) => d.code === "E_STATUS_VALUE")).toBe(true);
  });
});

describe("enforceHistory", () => {
  const checklist: BlockType = {
    type: "checklist",
    schema: { type: "object" },
    history: { attr: "recent", max: 2 },
  };

  it("leaves lists within the bound untouched", () => {
    const r = enforceHistory(checklist, { id: "c", recent: ["a", "b"] });
    expect(r.attrs.recent).toEqual(["a", "b"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("truncates oldest entries beyond the bound", () => {
    const r = enforceHistory(checklist, { id: "c", recent: ["a", "b", "c", "d"] });
    expect(r.attrs.recent).toEqual(["c", "d"]);
  });

  it("diagnoses non-array history attrs", () => {
    const r = enforceHistory(checklist, { id: "c", recent: "oops" });
    expect(r.diagnostics.map((d) => d.code)).toEqual(["E_HISTORY_NOT_ARRAY"]);
  });
});

describe("validator cache", () => {
  it("validates each block type against its own schema when two types share a name", () => {
    const strict: BlockType = {
      type: "shared-name",
      schema: {
        type: "object",
        required: ["id", "value"],
        properties: { id: { type: "string" }, value: { type: "number" } },
      },
    };
    const loose: BlockType = {
      type: "shared-name",
      schema: {
        type: "object",
        required: ["id", "value"],
        properties: { id: { type: "string" }, value: { type: "string" } },
      },
    };
    const attrs = { id: "b", value: "text" };
    // Compile `strict` first: a cache keyed by type name would then validate
    // `loose` with the strict schema as well.
    expect(validateAttrs(strict, attrs).map((d) => d.code)).toEqual(["E_BLOCK_SCHEMA"]);
    expect(validateAttrs(loose, attrs)).toEqual([]);
    expect(validateAttrs(strict, attrs).map((d) => d.code)).toEqual(["E_BLOCK_SCHEMA"]);
  });

  it("compiles schemas that declare the same $id for different types", () => {
    const schema = (valueType: string): Record<string, unknown> => ({
      $id: "https://example.test/same-id",
      type: "object",
      properties: { value: { type: valueType } },
    });
    const a: BlockType = { type: "id-a", schema: schema("number") };
    const b: BlockType = { type: "id-b", schema: schema("string") };
    expect(validateAttrs(a, { value: 1 })).toEqual([]);
    expect(validateAttrs(b, { value: "x" })).toEqual([]);
    expect(validateAttrs(b, { value: 1 }).map((d) => d.code)).toEqual(["E_BLOCK_SCHEMA"]);
  });
});
