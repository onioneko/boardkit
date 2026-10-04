import equal from "fast-deep-equal";
import type { StateTransition } from "./types.js";

/**
 * State-transition matching. The path grammar is deliberately tiny: a top-level
 * attr name (`value`) or one array hop with a terminal field (`items[].done`) —
 * never JSON Pointer/JSONPath. Richer observation belongs in host code reading
 * `block.updated`.
 */

/** A changed attribute path ("value" or "items[].done") with its before/after values. */
export interface AttrChange {
  /** Changed path: a top-level key or `arrayAttr[].field`. */
  readonly path: string;
  /** The attribute's value before the change. */
  readonly from: unknown;
  /** The attribute's value after the change. */
  readonly to: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Compute changed attribute paths between two attrs objects, recursing one level
 * into arrays (records inside arrays diff field-by-field).
 * @param before The attrs before the change.
 * @param after The attrs after the change.
 * @returns One AttrChange per changed path (empty when the attrs are equal).
 */
export function attributeChanges(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): AttrChange[] {
  const changes: AttrChange[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const from = before[key];
    const to = after[key];
    if (equal(from, to)) continue;
    if (Array.isArray(from) && Array.isArray(to)) {
      const len = Math.max(from.length, to.length);
      for (let i = 0; i < len; i += 1) {
        const itemFrom = from[i];
        const itemTo = to[i];
        if (equal(itemFrom, itemTo)) continue;
        if (isRecord(itemFrom) && isRecord(itemTo)) {
          for (const field of new Set([...Object.keys(itemFrom), ...Object.keys(itemTo)])) {
            if (!equal(itemFrom[field], itemTo[field])) {
              changes.push({ path: `${key}[].${field}`, from: itemFrom[field], to: itemTo[field] });
            }
          }
        } else {
          changes.push({ path: `${key}[]`, from: itemFrom, to: itemTo });
        }
      }
    } else {
      changes.push({ path: key, from, to });
    }
  }
  return changes;
}

/** A matched transition event ready for emission. */
export interface TransitionEvent {
  /** The declared event name, e.g. `"status.changed"`. */
  readonly event: string;
  /** The observed value before the transition. */
  readonly from: unknown;
  /** The observed value after the transition. */
  readonly to: unknown;
}

/** Canonical direction key: `${String(from)}→${String(to)}` (U+2192 arrow, JSON-safe). */
function directionKey(from: unknown, to: unknown): string {
  return `${String(from)}→${String(to)}`;
}

/**
 * Match declared transitions against computed attr changes (writer-agnostic).
 * With an `events` map, the event name is looked up by the change's from→to
 * direction; without one, `event` applies to both directions. A direction that
 * has no map entry emits no transition event (fail-soft).
 * @param transitions The block type's declared transitions (or `undefined`).
 * @param changes The attr changes observed on the block.
 * @returns One TransitionEvent per matched transition, ready for emission.
 */
export function matchTransitions(
  transitions: readonly StateTransition[] | undefined,
  changes: readonly AttrChange[],
): TransitionEvent[] {
  if (transitions === undefined) return [];
  const out: TransitionEvent[] = [];
  for (const t of transitions) {
    for (const change of changes) {
      if (change.path !== t.attr) continue;
      const event =
        t.events !== undefined ? t.events[directionKey(change.from, change.to)] : t.event;
      if (event === undefined) continue;
      out.push({ event, from: change.from, to: change.to });
    }
  }
  return out;
}
