import type { DocId, SectionId } from "./ids.js";

/**
 * Inline references recognized in ordinary prose text:
 * - `{{source:ID param=value ...}}` — a live value injected at projection time
 * - `{{include:docId}}` / `{{include:docId#sectionId}}` — projection-time aggregation
 */

/** A live-value reference resolved at projection time through the Source port. */
export interface SourceRef {
  /** Discriminator: always `"source"`. */
  readonly kind: "source";
  /** The source id to resolve, e.g. the `bank_balance` in `{{source:bank_balance}}`. */
  readonly source: string;
  /** Named parameters in the reference (each value is kept as a string). */
  readonly params: Record<string, string>;
}

/** An aggregation reference expanded at projection time (the source is never copied). */
export interface IncludeRef {
  /** Discriminator: always `"include"`. */
  readonly kind: "include";
  /** The included document's id. */
  readonly docId: DocId;
  /** When present, only this section of the included document is expanded. */
  readonly sectionId?: SectionId;
}

/** Either a live-value reference or an aggregation reference. */
export type InlineRef = SourceRef | IncludeRef;
