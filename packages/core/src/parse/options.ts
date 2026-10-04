/** Options controlling document parsing. */
export interface ParseOptions {
  /**
   * Registered block types. Fenced code blocks whose info string is in this
   * set become Block nodes; all other fences stay ordinary code (fail-soft).
   * Omit (or pass an empty set) to treat every fence as ordinary code.
   */
  blockTypes?: ReadonlySet<string>;
  /**
   * Which inline-reference kinds to recognize. Defaults to both `"source"` and
   * `"include"`; a document's own frontmatter `refs` field narrows this per
   * document (`refs: false` disables recognition, `refs: ["include"]` recognizes
   * only includes). Any other `{{…}}` is literal text.
   */
  refs?: ReadonlySet<"source" | "include">;
}
