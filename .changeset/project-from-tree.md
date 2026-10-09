---
"@onioneko/boardkit-core": minor
"@onioneko/boardkit-html": minor
---

The html projection reads the document's parsed mdast tree instead of parsing token-rewritten markdown again (#42). Projecting a version the engine has already parsed costs no markdown parse: on a 256 KiB document, `projectHtml` drops from about 420 ms to about 45 ms of CPU.

Behaviour changes (html). The old projection replaced each hole with an alphanumeric placeholder and parsed the result, so the placeholder could change what the markdown around it meant. The output now follows the source's own markdown in these cases; everything else renders byte for byte as before:

- **A typed block directly next to a text line** (no blank line between them) is no longer glued into that line's paragraph. ```` ```box … ``` ```` followed by `probe` rendered `<p><div class="box">…</div>\nprobe</p>` and now renders `<p><div class="box">…</div></p>\n<p>probe</p>`; the same holds for a text line right before the fence. Add a blank line between them if you relied on the old layout.
- **Emphasis next to a `{{source:…}}` reference** follows the source's flanking rules, where `{{` and `}}` are punctuation: `foo*{{source:a}}*bar` and `**{{source:a}}**bar` no longer render emphasis.
- **An email autolink next to a reference** is no longer formed: `{{source:p}}@example.com` is text, not a `mailto:` link, because `{` cannot start an email address.
- **A heading anchor next to a reference** is the one the parser finds: in `## {{source:p}}_a {#b_}` the `_`s are emphasis, so the heading has no anchor (and no `id`), matching its section id, where the old projection found `b_`.
- **A reference inside a reference-link label** now links: `[{{source:a}}]` with the definition `[{{source:a}}]: url` (or the collapsed `[x {{source:a}}][]`) renders a link to the definition's URL as written, showing the value, where it rendered as bracketed text.

Sanitizing, hole handlers, block hook output and include provenance are unchanged.

- **New, core:** `mdastOf(doc, src)` returns the mdast tree a parse was built from, or `undefined` when it is not kept. The tree is shared, so it is deeply frozen and typed with the new `DeepReadonly` type: copy any node you change.
- **New, core:** the projection walk passes each hole's `SourceSpan` to `onSource`, `onUnresolvedSource`, `onBlock` and `onInclude` as a new optional last argument.
- **New, core (internal):** `releaseMdast(doc)` and `mdastNodeCount(doc)` from `@onioneko/boardkit-core/internal`.
- **Memory, core:** a parse's tree takes about 330 to 370 bytes per mdast node, which is about 3 to 6 times the source for plain prose and over 100 times it for lists and tables. The internal `parseDoc` keeps it for as long as the returned `ParsedDoc` is reachable. The engine's parse cache keeps the trees of its most recently used parses up to 200,000 nodes in all (about 65 to 75 MiB), on top of its 16 MiB source budget for the parses; past that, the least recently used trees are released and their documents are parsed again when projected (once per projection), with the same output.
- **html:** `projectHast`'s `walk.unescapeRefs` has no effect any more: the prose comes from the parsed tree, where the parser already consumed a `\{{`'s backslash.
- **html:** the peer range on `@onioneko/boardkit-core` is now `>=0.4.0 <1.0.0`, for `mdastOf`.
