import { matchTransitions } from "../blocks/transitions.js";
import type { AnyBlockType } from "../blocks/types.js";
import type { DocId } from "../model/ids.js";
import type { Clock, EventDraft } from "../ports/ports.js";
import type { Writer } from "../write/pipeline.js";
import type { StructuralDiff } from "./diff.js";

/**
 * Core + transition event synthesis from a structural diff. Core events: node
 * added/removed, `section.changed`, and `doc.updated`/`block.updated`.
 * Transition events: block-declared transitions matched against attr changes.
 * Domain events are a host mapping on top — never produced here.
 */

/** Clock, block-type, and writer context for event synthesis. */
export interface SynthesizeOptions {
  /** Timestamp source for every synthesized event's `t` field. */
  readonly clock: Clock;
  /** Registered block types, used to match transition events. */
  readonly blockTypes: ReadonlyMap<string, AnyBlockType>;
  /**
   * The write's author, stamped as `by` on every synthesized event. Omit when
   * the caller stamps `by` itself (the external-write path does, with its own
   * writer id).
   */
  readonly writer?: Writer;
}

/**
 * Synthesize core + transition events from a structural diff (domain events are
 * host-mapped). Every event carries `by` (when `opts.writer` is provided) so an
 * audit consumer can answer "who changed what" from the event alone.
 * `section.changed` carries the sectionId of a section whose prose changed;
 * `block.updated` keeps its `changes` path array for compatibility and adds a
 * `values` record (`path → to`) carrying the new value for each changed path.
 * @param diff The structural diff of one document.
 * @param docId The document the diff belongs to.
 * @param opts Clock, block-type, and writer context.
 * @returns The event drafts to append (in emission order).
 */
export function synthesizeEvents(
  diff: StructuralDiff,
  docId: DocId,
  opts: SynthesizeOptions,
): EventDraft[] {
  const { clock, blockTypes, writer } = opts;
  const t = clock();
  const by = writer !== undefined ? { by: writer } : {};
  const events: EventDraft[] = [];
  events.push({ t, type: "doc.updated", docId, ...by });

  for (const node of diff.added) {
    events.push({
      t,
      type: "sectionId" in node ? "section.added" : "block.added",
      docId,
      ...nodeRef(node),
      ...by,
    });
  }
  for (const node of diff.removed) {
    events.push({
      t,
      type: "sectionId" in node ? "section.removed" : "block.removed",
      docId,
      ...nodeRef(node),
      ...by,
    });
  }
  for (const change of diff.sectionChanges) {
    events.push({ t, type: "section.changed", docId, ...nodeRef(change.section), ...by });
  }
  // Values are copied out of the parses: a parse may be the engine's cached
  // one, shared with every reader and frozen, and an event belongs to whoever
  // receives it.
  for (const { block, changes } of diff.attrChanges) {
    const values: Record<string, unknown> = {};
    for (const change of changes) values[change.path] = structuredClone(change.to);
    events.push({
      t,
      type: "block.updated",
      docId,
      blockId: block.blockId,
      changes: changes.map((c) => c.path),
      values,
      ...by,
    });
    const type = blockTypes.get(block.type);
    for (const te of matchTransitions(type?.transitions, changes)) {
      events.push({
        t,
        type: te.event,
        docId,
        blockId: block.blockId,
        from: structuredClone(te.from),
        to: structuredClone(te.to),
        ...by,
      });
    }
  }
  return events;
}

function nodeRef(node: { sectionId?: string; blockId?: string }): Record<string, unknown> {
  return "sectionId" in node && node.sectionId !== undefined
    ? { sectionId: node.sectionId }
    : node.blockId !== undefined
      ? { blockId: node.blockId }
      : {};
}
