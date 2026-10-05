---
"@onioneko/boardkit-core": minor
"@onioneko/boardkit-html": minor
---

Helpers for structured projectors, and heading anchors in HTML. The new exports are additive.

- **html:** `projectHast(walk, handlers)` projects one node to unsanitized hast, with every reference, block and include left as a hole the caller fills (`HastHoleHandlers`, with the `SourceHole`, `UnresolvedHole`, `BlockHole` and `IncludeHole` kinds). `sanitizePanelHast(tree)` is the html projector's whole sanitize pass, `panelAttributeNames()` lists the schema's allowed attribute names without value constraints, and `includeWrapper(include, children)` builds the include provenance wrapper. `projectHtml` is built on these, and its output is unchanged except as listed below.
- **core:** `splitHeadingAnchor(text)` splits a trailing `{#anchor}` off heading text, the rule the parser reads section ids with.

Behaviour changes:

- **html:** a heading's `{#anchor}` no longer renders as text. It is removed from the heading and becomes its `id`, prefixed as `user-content-…`.
- **html:** `data-doc` and `data-section` survive only on the projector's own include wrappers. A block hook's output loses them, so it cannot fake another document's provenance.
- **html:** `panelSchema()` no longer allows `action`, `method` or `encType` on any element.
- **html:** diagnostics from block hooks (`E_BLOCK_HOOK_ERROR`) are reported in document order, including blocks in included documents.
- **html:** the peer range on `@onioneko/boardkit-core` is now `>=0.3.0 <1.0.0`.
- **core:** a heading's `{#anchor}` is read only when it is written literally in the heading's last run of plain text. An anchor in a code span (`` `{#id}` ``), split by inline formatting (`{#_x_}`), escaped (`\{#id}`) or written with a character reference is heading text, and the section id is the slug. Ids of such headings change accordingly.
