---
"@onioneko/boardkit-core": minor
---

Hosts that let a reader jump to part of a large document can now ask where things are. `Section.span` is the section's whole extent (heading start to close, subsections included) and `Section.anchored` marks ids that come from a literal `{#anchor}` rather than a slug. `engine.docInfo` gains `sections[].span`, `parent`, `position` and `anchored`, `blocks[].span` and `position`, and `frontmatterSpan`. Two pure functions are new: `findText(src, info, query, { limit, ignoreCase })`, a bounded literal search (query cut to a fixed window, then capped by graphemes and bytes; whitespace runs match any whitespace; at most 25 hits, with `more`), and `locateOffset(info, offset)`, which returns the section and block that hold an offset. `MAX_ID_LENGTH` (256) is the shared id-length bound. Every offset is an index into the source as given.
