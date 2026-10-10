---
"@onioneko/boardkit-core": patch
"@onioneko/boardkit-html": patch
---

On a document that starts with a byte order mark (U+FEFF), every public offset (`Block.span`, `Section.contentSpans`, `ParsedDoc.frontmatterSpan`, `RefSpan`) and every offset in the tree `mdastOf` returns is now an index into the source as given, BOM included. Patches on such documents work again and keep the BOM byte-identical, and `{#anchor}` heading ids on them are read (they were ignored). Hosts that shifted these offsets by one themselves should stop doing so.
