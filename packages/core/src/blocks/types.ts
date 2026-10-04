import type { Diagnostic } from "../model/diagnostic.js";
import type { SourceRef } from "../model/refs.js";

/** JSON Schema, expressed as a plain object; used for block attrs and validated with ajv. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * Declared state transition: an observed attr path mapped to event name(s). A
 * transition may name a single event for both directions (`event`) or distinct
 * events per direction (`events`).
 */
export interface StateTransition {
  /** Observed attr path, e.g. `"value"` or `"items[].done"`. */
  readonly attr: string;
  /**
   * Transition event name applied to both directions (used when `events` is
   * absent), e.g. `"status.changed"`.
   */
  readonly event?: string;
  /**
   * Per-direction event names keyed by the canonical direction key
   * `"${String(from)}→${String(to)}"` (U+2192 arrow; JSON-safe strings), e.g.
   * `{ "false→true": "checklist.item.done", "true→false": "checklist.item.undone" }`.
   * When present it takes precedence over `event`; a direction with no map entry
   * emits no transition event (fail-soft).
   */
  readonly events?: Readonly<Record<string, string>>;
}

/**
 * A consumer-requestable operation on a block.
 * @typeParam A The block type's attrs shape (defaults to an open record).
 */
export interface AffordanceDecl<A extends Record<string, unknown> = Record<string, unknown>> {
  /** The operation's name, as named in an Intent. */
  readonly name: string;
  /** Static JSON Schema for the operation's params; instance-dependent rules go through BlockType.validate. */
  readonly params?: JsonSchema;
  /**
   * Pure function mapping the block's current attrs plus the intent params to an
   * attrs delta for the patch pipeline.
   * @param attrs The block's current attrs (read-only).
   * @param params The intent's params (already schema-validated when a schema is declared).
   * @returns The top-level attrs delta to apply.
   */
  readonly patch: (attrs: Readonly<A>, params: unknown) => Record<string, unknown>;
}

/**
 * A per-projector text rendering hook. A projector without a hook for a block
 * falls back to the block's verbatim source.
 * @typeParam A The block type's attrs shape (defaults to an open record).
 * @param attrs The block's attrs.
 * @param values Resolved live values keyed by source id — one document-wide
 *   record, the same for every hook call on that document: its prose
 *   `{{source:…}}` refs plus the refs *any* of its blocks declare through
 *   {@link BlockType.sources} (not just this block's type), param-less ones
 *   only. A param-bearing ref is resolved (custom projectors see it in
 *   `input.values` by canonical key) but never lands here, and a stale or
 *   failed resolution is simply absent, so the hook renders its own fallback.
 * @returns The markdown to substitute for the block's span.
 */
export type ProjectionHook<A extends Record<string, unknown> = Record<string, unknown>> = (
  attrs: Readonly<A>,
  values: Readonly<Record<string, string>>,
) => string;

/**
 * An html-projector hook, returning a hast subtree (serialized and sanitized by
 * the projector).
 * @typeParam A The block type's attrs shape (defaults to an open record).
 * @param attrs The block's attrs.
 * @param values Resolved live values keyed by source id — one document-wide
 *   record, the same for every hook call on that document: its prose
 *   `{{source:…}}` refs plus the refs *any* of its blocks declare through
 *   {@link BlockType.sources} (not just this block's type), param-less ones
 *   only. A param-bearing ref is resolved (custom projectors see it in
 *   `input.values` by canonical key) but never lands here, and a stale or
 *   failed resolution is simply absent, so the hook renders its own fallback.
 * @returns A hast subtree rendered in place of the block.
 */
export type HtmlProjectionHook<A extends Record<string, unknown> = Record<string, unknown>> = (
  attrs: Readonly<A>,
  values: Readonly<Record<string, string>>,
) => import("hast").Nodes;

/**
 * A block type definition. Eight parts: `type` and `schema` are required; the
 * remaining six (`validate`, `transitions`, `affordances`, `history`, `sources`,
 * `project`) are optional.
 * @typeParam A The block's attrs shape, statically declared by the block author
 *   and threaded through `validate`, `sources`, `affordances[].patch`, and
 *   `project`'s hooks; defaults to an open record for callers that have no
 *   narrower shape to declare. A collection holding block types of differing
 *   `A` (a registry, `EngineOptions.blocks`, …) cannot be typed `BlockType[]`
 *   or `Map<string, BlockType>` — use {@link AnyBlockType} there instead.
 */
export interface BlockType<A extends Record<string, unknown> = Record<string, unknown>> {
  /** The type name, used as the fence's info string. */
  readonly type: string;
  /**
   * JSON Schema for the block's attrs (static shape rules). Each schema is
   * compiled on its own: a `$ref` may point inside the schema (`#`,
   * `#/$defs/…`), but not to another block type's schema by its `$id`.
   */
  readonly schema: JsonSchema;
  /**
   * Instance-level cross-field rules JSON Schema cannot express.
   * @param attrs The block's attrs to validate.
   * @returns Diagnostics for rule violations (empty when valid); never throws.
   */
  readonly validate?: (attrs: Readonly<A>) => readonly Diagnostic[];
  /** Attribute paths that emit named events when their value changes. */
  readonly transitions?: readonly StateTransition[];
  /** Consumer-requestable operations that produce an attrs delta. */
  readonly affordances?: readonly AffordanceDecl<A>[];
  /** Bounded-history mechanism: the named list attr is truncated to `max` on write. */
  readonly history?: { readonly attr: string; readonly max: number };
  /**
   * The live-value references this block instance depends on, declared by its
   * type instead of by prose. They are resolved at RESOLVE together with the
   * document's `{{source:…}}` refs (deduped with them by canonical key), so a
   * block renders its value even when no prose ref names the same source.
   * Must be pure and must never throw — a throwing `sources` contributes no
   * refs (fail-soft), leaving the block's own fallback to render.
   * @param attrs The block's attrs (read-only).
   * @returns The source refs this instance depends on (empty when it has none).
   */
  readonly sources?: (attrs: Readonly<A>) => readonly SourceRef[];
  /**
   * Per-projector rendering hooks, keyed by projector id (`text`, `html`).
   * Each hook's return is `unknown`: a projector may want markdown (`string`,
   * the `text` projector's contract), a hast subtree (the `html` projector's
   * contract), or any other shape a custom projector defines for itself (e.g.
   * structured JSON). A projector narrows the return at its own call site,
   * where it owns the id ↔ output-type contract; declare a hook against the
   * `text`/`html` contracts specifically with the named
   * {@link ProjectionHook}/{@link HtmlProjectionHook} aliases.
   *
   * The attrs are shared with other readers of the same parse and are frozen:
   * a hook must not modify them (an attempt throws, and the block falls back
   * to its verbatim source with `E_BLOCK_HOOK_ERROR`).
   */
  readonly project?: Readonly<
    Record<string, (attrs: Readonly<A>, values: Readonly<Record<string, string>>) => unknown>
  >;
}

/**
 * `BlockType` with its attrs type erased to `any`, for contexts that hold or
 * accept block types of differing, unrelated `A` — `EngineOptions.blocks`,
 * `Engine.registerBlock`, the engine's internal type registry, and
 * `ProjectionInput.blockTypes` among them.
 *
 * `BlockType`'s attrs-consuming members (`validate`, `sources`,
 * `affordances[].patch`, `project[id]`) are function-typed properties, which
 * TypeScript checks contravariantly in `A` under `strictFunctionTypes` — so a
 * `BlockType<ChecklistAttrs>` does not structurally satisfy
 * `BlockType<Record<string, unknown>>` (or any other concrete `A`), and a
 * plain array or map typed `BlockType[]` / `Map<string, BlockType>` cannot
 * hold block types of different `A` at all. `any` is the deliberate escape
 * hatch: it disables variance checking in both directions, so any
 * `BlockType<X>` is assignable to (and from) `AnyBlockType`.
 *
 * Do not "fix" this by switching `BlockType`'s members to method shorthand
 * (`sources(attrs: A): …` instead of `sources: (attrs: A) => …`) to get
 * bivariant checking instead — that would silently weaken type-checking for
 * every single-`A` use of `BlockType<A>` just to make the heterogeneous case
 * convenient.
 */
// biome-ignore lint/suspicious/noExplicitAny: deliberate variance escape hatch — see the doc comment above.
export type AnyBlockType = BlockType<any>;
