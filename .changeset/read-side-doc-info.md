---
"@onioneko/boardkit-core": minor
---

Read-side additions, all additive:

- `engine.docInfo(docId)` returns a document's title, frontmatter, headings and blocks, plus its parse diagnostics, as a new `DocInfo` type. It reads through the engine's parse cache, so a document the engine wrote or projected costs no parse. The title is a non-blank frontmatter `title`, otherwise the first level-1 heading (ATX or setext). Heading text has its `{#anchor}` removed, and the anchor is the section id. A missing, invalid, oversized, over-complex or unparseable document gives `undefined`. Hosts that implement `Engine` themselves, for example as a mock, must add `docInfo`.
- `ProjectionWalkHandlers` gains an optional `onUnresolvedSource(ref, state, raw, ctx)`. A `{{source:…}}` span whose value is stale or missing reaches it, so a structured projector can key every reference. Without it, such a span stays verbatim prose as before. `hookValues` is unchanged, so block hooks still never see a stale or missing value.
