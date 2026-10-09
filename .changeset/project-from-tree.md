---
"@onioneko/boardkit-core": minor
"@onioneko/boardkit-html": minor
---

The html projection reads the document's parsed mdast tree instead of parsing token-rewritten markdown again (#42). Projecting a version the engine has already parsed costs no markdown parse: on a 256 KiB document, `projectHtml` drops from about 420 ms to about 45 ms of CPU.

Behaviour changes (html). The old projection replaced each hole with an alphanumeric placeholder and parsed the result, so the placeholder could change what the markdown around it meant. The output now follows the source's own markdown in two places; everything else renders byte for byte as before:

- **A typed block directly next to a text line** (no blank line between them) is no longer glued into that line's paragraph. ```` ```box … ``` ```` followed by `probe` rendered `<p><div class="box">…</div>\nprobe</p>` and now renders `<p><div class="box">…</div></p>\n<p>probe</p>`, as the parser reads it; the same holds for a text line right before the fence. Add a blank line between them if you relied on the old layout in a stylesheet or a test.
- **Inline syntax right next to a `{{source:…}}` reference** follows the source's rules, because `{{` and `}}` are punctuation where the placeholder was letters. `foo*{{source:a}}*bar` and `**{{source:a}}**bar` no longer render emphasis; `{{source:p}}@example.com` is text, no longer an email autolink; and a heading such as `## {{source:p}}_a {#b_}` has the anchor the parser finds (none here) rather than a different one. Put spaces or other text between the delimiter and the reference if you want the old reading.

Sanitizing, hole handlers, block hook output and include provenance are unchanged.

- **New, core:** `mdastOf(doc, src)` returns the mdast tree a parse was built from, or `undefined` when it is not kept. The tree is shared: copy any node you change.
- **New, core:** the projection walk passes each hole's `SourceSpan` to `onSource`, `onUnresolvedSource`, `onBlock` and `onInclude` as a new optional last argument.
- **New, core (internal):** `releaseMdast(doc)` from `@onioneko/boardkit-core/internal` drops a parse's tree.
- **Memory, core:** a parse's tree takes about 10 to 14 times its source in memory. The internal `parseDoc` keeps it for as long as the returned `ParsedDoc` is reachable. The engine's parse cache keeps the trees of its most recently used parses whose sources add up to at most 4 MiB (about 40 to 56 MiB of trees), on top of its 16 MiB source budget for the parses; past that, the least recently used trees are released and their documents are parsed again when projected (once per projection), with the same output.
- **html:** `projectHast`'s `walk.unescapeRefs` has no effect any more: the prose comes from the parsed tree, where the parser already consumed a `\{{`'s backslash.
- **html:** the peer range on `@onioneko/boardkit-core` is now `>=0.4.0 <1.0.0`, for `mdastOf`.
