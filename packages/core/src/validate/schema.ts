import { Ajv, type ValidateFunction } from "ajv";
import type { AnyBlockType } from "../blocks/types.js";
import { type Diagnostic, diagnostic } from "../model/diagnostic.js";

/**
 * Static JSON Schema validation of block attrs. Cross-field rules are NOT
 * expressed here — they live in BlockType.validate. Failures are diagnostics,
 * never thrown (fail-soft).
 */

const ajv = new Ajv({ allErrors: true, strict: true });
// Compiled validators are keyed by the schema object itself, not by the block
// type's name: two engines (or two registrations) may use one type name with
// different schemas, and each must validate against its own. The WeakMap lets
// a validator go once its schema is no longer referenced.
const compiled = new WeakMap<object, ValidateFunction>();

function compile(schema: Readonly<Record<string, unknown>>): ValidateFunction {
  const cached = compiled.get(schema);
  if (cached !== undefined) return cached;
  // ajv is passed a plain object; the readonly wrapper is a compile-time discipline only.
  const fn = ajv.compile(schema as Record<string, unknown>);
  // The compiled function is self-contained. Dropping the schema from ajv's
  // own registry keeps ajv from holding every schema ever compiled, and lets a
  // later schema reuse the same `$id` without a "schema already exists" error.
  ajv.removeSchema(schema as Record<string, unknown>);
  compiled.set(schema, fn);
  return fn;
}

/**
 * Validate attrs against the block type's static JSON Schema.
 * @param blockType The block type whose schema to validate against.
 * @param attrs The attrs to validate.
 * @returns Schema-violation diagnostics (empty when valid).
 */
export function validateAttrs(blockType: AnyBlockType, attrs: unknown): readonly Diagnostic[] {
  const validate = compile(blockType.schema);
  if (validate(attrs)) return [];
  return (validate.errors ?? []).map((err) => {
    const id =
      typeof attrs === "object" && attrs !== null ? (attrs as { id?: unknown }).id : undefined;
    return diagnostic(
      "E_BLOCK_SCHEMA",
      `${blockType.type} attrs: ${err.instancePath || "/"} ${err.message ?? "invalid"}`,
      id !== undefined && typeof id === "string" ? { nodeId: id } : undefined,
    );
  });
}

/**
 * Run the block type's cross-field validation hook (instance-level rules).
 * @param blockType The block type whose `validate` hook to run.
 * @param attrs The attrs to validate.
 * @returns The hook's diagnostics (empty when there is no hook or it passes).
 */
export function validateCrossField(blockType: AnyBlockType, attrs: unknown): readonly Diagnostic[] {
  if (blockType.validate === undefined) return [];
  // `attrs` is `unknown` here (this function validates without assuming a shape),
  // but the hook's declared param is `Readonly<A>` (A = `any` on AnyBlockType) —
  // `Readonly<any>` does not structurally accept `unknown` the way bare `any`
  // does, so this narrows to the same `Record<string, unknown>` shape every
  // Block.attrs already carries. Type-only; the value passed through is unchanged.
  return blockType.validate(attrs as Record<string, unknown>);
}

/**
 * All validation diagnostics for a block: static schema + cross-field hook.
 * @param blockType The block type to validate against.
 * @param attrs The attrs to validate.
 * @returns Combined schema and cross-field diagnostics (empty when valid).
 */
export function validateBlock(blockType: AnyBlockType, attrs: unknown): readonly Diagnostic[] {
  return [...validateAttrs(blockType, attrs), ...validateCrossField(blockType, attrs)];
}

const paramCompiled = new Map<string, ValidateFunction>();

/**
 * Validate affordance params against a static JSON Schema (instance-dependent
 * rules stay in the block's validate hook).
 * @param schema The params JSON Schema to validate against.
 * @param params The params to validate.
 * @returns Param-violation diagnostics (empty when valid).
 */
export function validateParams(
  schema: Readonly<Record<string, unknown>>,
  params: unknown,
): readonly Diagnostic[] {
  const key = JSON.stringify(schema);
  let validate = paramCompiled.get(key);
  if (validate === undefined) {
    validate = ajv.compile(schema as Record<string, unknown>);
    paramCompiled.set(key, validate);
  }
  if (validate(params)) return [];
  return (validate.errors ?? []).map((err) =>
    diagnostic("E_PARAM_SCHEMA", `params: ${err.instancePath || "/"} ${err.message ?? "invalid"}`),
  );
}
