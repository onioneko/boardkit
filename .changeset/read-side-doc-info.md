---
"@onioneko/boardkit-core": minor
---

Read-side additions. They are additive for consumers; a hand-written `Engine` implementation (a mock, for example) must add `docInfo`.

- `engine.docInfo(docId)` returns a document's title, frontmatter, headings and blocks, plus its parse diagnostics, as a new `DocInfo` type. It reads through the engine's parse cache, so a document the engine wrote or projected costs no parse. The title is a non-blank frontmatter `title` (trimmed), otherwise the first non-empty level-1 heading (ATX or setext). Heading text is plain text with its `{#anchor}` removed, and the anchor is the section id; ids are not guaranteed unique. A missing, invalid, oversized, over-complex or unparseable document gives `undefined`.
- `ProjectionWalkHandlers` gains an optional `onUnresolvedSource(ref, state, raw, ctx)`. A `{{source:…}}` span whose value is stale or missing reaches it, so a structured projector can key every reference. Without it, such a span stays verbatim prose as before. `hookValues` is unchanged, so block hooks still never see a stale or missing value.
