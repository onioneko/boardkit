---
"@onioneko/boardkit-core": minor
---

An edit re-parses only the sections it touches (#43). The engine cuts a document into sections before each column-1 heading line, parses each on its own and keeps the parsed sections, so the next version re-parses only the sections whose text changed. On a 256 KiB board a one-paragraph edit costs about 17 ms of parsing instead of about 0.38 s, for writes, patches, intents, external edits and reads alike.

No output changes: the parse is exactly the one a whole parse gives, mdast positions included, and a differential test in the repository checks it on recorded documents, the CommonMark examples and random edits (`pnpm --filter @onioneko/boardkit-core test:differential` runs the long version). A construct that spans headings (an unclosed fence or HTML block, a table a heading would continue) is parsed together with the sections after it; a document that opens frontmatter and never closes it, or whose sections may use a link or footnote definition from another section, is parsed whole.

- **Memory:** the engine's parse cache keeps the parsed sections beside its parses, up to 8,192 sections, 100,000 mdast nodes (about 33 to 37 MiB) and 4 MiB of source. Sections past that budget are dropped, least recently used first.
- **Cost:** the first parse of a document costs about what a whole parse costs. The worst edit, an HTML block that never closes typed near the top of a document, costs about two to three whole parses.
- No API changes.
