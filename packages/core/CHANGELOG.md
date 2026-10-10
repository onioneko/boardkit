# @onioneko/boardkit-core

## 0.5.0

### Minor Changes

- 97455e1: Hosts that let a reader jump to part of a large document can now ask where things are. `Section.span` is the section's whole extent (heading start to close, subsections included) and `Section.anchored` marks ids that come from a literal `{#anchor}` rather than a slug. `engine.docInfo` gains `sections[].span`, `parent`, `position` and `anchored`, `blocks[].span` and `position`, and `frontmatterSpan`. Two pure functions are new: `findText(src, info, query, { limit, ignoreCase })`, a bounded literal search (query cut to a fixed window, then capped by graphemes and bytes; whitespace runs match any whitespace; a query over the bounds is not searched and reports `truncated`; at most 25 hits, with `more`), and `locateOffset(info, offset)`, which returns the section and block that hold an offset. Every offset is an index into the source as given.

### Patch Changes

- 2b280d1: On a document that starts with a byte order mark (U+FEFF), every public offset (`Block.span`, `Section.contentSpans`, `ParsedDoc.frontmatterSpan`, `RefSpan`) and every offset in the tree `mdastOf` returns is now an index into the source as given, BOM included. Patches on such documents work again and keep the BOM byte-identical, and `{#anchor}` heading ids on them are read (they were ignored). Hosts that shifted these offsets by one themselves should stop doing so.

## 0.4.0

### Minor Changes

- c95c1c7: An edit re-parses only the sections it touches (#43). The engine cuts a document into sections before each column-1 heading line, parses each on its own and keeps the parsed sections, so the next version re-parses only the sections whose text changed. On a 256 KiB board a one-paragraph edit costs about 17 ms of parsing instead of about 0.38 s, for writes, patches, intents, external edits and reads alike.

  No output changes: the parse is exactly the one a whole parse gives, mdast positions included, and a differential test in the repository checks it on recorded documents, the CommonMark examples and random edits (`pnpm --filter @onioneko/boardkit-core test:differential` runs the long version). A construct that spans headings (an unclosed fence or HTML block, a table a heading would continue) is parsed together with the sections after it; a document that opens frontmatter and never closes it, or whose sections may use a link or footnote definition from another section, is parsed whole.

  - **Memory:** the engine's parse cache keeps the parsed sections beside its parses, up to 8,192 sections, 100,000 mdast nodes (about 33 to 37 MiB) and 4 MiB of source (4 Mi UTF-16 code units, up to about 8 MiB in memory). Sections past that budget are dropped, least recently used first.
  - **Cost:** the first parse of a document costs about what a whole parse costs. The worst edit, an HTML block that never closes typed near the top of a document, costs about two to three whole parses.
  - No API changes.

- 04bd935: A block patch now changes only its target block; it can no longer close the block early and add or hide blocks after it.

  - String values that hold a fence run (three or more backticks or tildes) are written on one line, and line folding cannot put a fence at the start of a line. A patch whose new body could still close the block is refused with `E_PATCH_FENCE`.
  - A block inside a list item or block quote is refused with `E_PATCH_SPAN` instead of being corrupted. `Block` gains an optional `contained: true` flag that marks such blocks. A full-text write that must truncate the bounded history of such a block is now rejected with reason `validation`.
  - A fence indented 1–3 spaces keeps its body's indentation, so nested values stay nested.
  - A block body that is not valid YAML is refused with `E_PATCH_YAML` instead of throwing.
  - Tilde fences and fences longer than three backticks are located correctly.

  In every refusal the document is left unchanged. The codes are listed in the blocks guide under "Patch semantics".

- 5d0558b: The html projection reads the document's parsed mdast tree instead of parsing token-rewritten markdown again (#42). Projecting a version the engine has already parsed costs no markdown parse: on a 256 KiB document, `projectHtml` drops from about 420 ms to about 45 ms of CPU.

  Behaviour changes (html). The old projection replaced each hole with an alphanumeric placeholder and parsed the result, so the placeholder could change what the markdown around it meant. The output now follows the source's own markdown in these cases; everything else renders byte for byte as before:

  - **A typed block directly next to a text line** (no blank line between them) is no longer glued into that line's paragraph. ` ```box … ``` ` followed by `probe` rendered `<p><div class="box">…</div>\nprobe</p>` and now renders `<p><div class="box">…</div></p>\n<p>probe</p>`; the same holds for a text line right before the fence. Add a blank line between them if you relied on the old layout.
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

- 3fb7b35: Write middleware can parse the proposed text through the engine's parse cache, and the write reuses that parse (#41).

  - **New:** `WriteCtx.parse(src)` returns a new `WriteParseResult`: `{ ok: true, parsed }` with the `ParsedDoc` the commit pipeline makes of `src`, or `{ ok: false, rejection: { reason, diagnostics } }` with the rejection a write of `src` would get. The size and complexity limits are checked before anything is parsed (`too-large`, `too-complex`), and a parser that throws gives `validation` with `E_PARSE_FAILED`; it never throws for the source's content. In an engine it parses through the content-keyed parse cache, so a parse it returns may be shared and its block attrs are frozen.
  - **Parse once:** a full-text write or a create reuses a cached parse of the exact text it validates, so a middleware that parses `proposed.fullText` or `proposed.content` with `ctx.parse` costs the write no second parse, and the write does not scan that text against the complexity limits again. Results, stored text and events are unchanged.
  - **New (additive) field:** `PipelineDeps.parseCache`, through which the engine shares its parse cache with the pipeline.
  - **Breaking (type), `WriteCtx`:** `parse` is a required field. The pipeline always provides it; code that builds a `WriteCtx` by hand (a middleware unit test, for example) must add a `parse` function.

## 0.3.0

### Minor Changes

- 76b4604: Helpers for structured projectors, and heading anchors in HTML. The new exports are additive.

  - **html:** `projectHast(walk, handlers)` projects one node to unsanitized hast, with every reference, block and include left as a hole the caller fills (`HastHoleHandlers`, with the `SourceHole`, `UnresolvedHole`, `BlockHole` and `IncludeHole` kinds). `sanitizePanelHast(tree)` is the html projector's whole sanitize pass (it does not modify its input), `panelAttributeNames()` lists the schema's allowed attribute names without value constraints, and `includeWrapper(include, children)` builds the include provenance wrapper. `projectHtml` is built on these, and its output is unchanged except as listed below.
  - **core:** `splitHeadingAnchor(text)` splits a trailing `{#anchor}` off heading text, the rule the parser reads section ids with.

  Behaviour changes:

  - **html:** a heading's `{#anchor}` no longer renders as text. It is removed from the heading and becomes its `id`, prefixed as `user-content-…`.
  - **html:** `data-doc` and `data-section` survive only on include wrappers built by `includeWrapper` on the projector's include path. Block hook output is copied as plain data before it joins the tree, so nothing a hook returns can carry provenance, not even a wrapper the hook built with `includeWrapper` itself. Hook output that cannot be copied (a `Proxy`, a function) renders as the block's escaped source with `E_BLOCK_HOOK_ERROR`, like a throwing hook.
  - **html:** `panelSchema()` no longer allows `action`, `method` or `encType` on any element.
  - **html:** diagnostics from block hooks (`E_BLOCK_HOOK_ERROR`) are reported in document order, including blocks in included documents.
  - **html:** the peer range on `@onioneko/boardkit-core` is now `>=0.3.0 <1.0.0`.
  - **core:** a heading's `{#anchor}` is read only when it is written literally in the heading's last run of plain text. An anchor in a code span (`` `{#id}` ``), split by inline formatting (`{#_x_}`), escaped (`\{#id}`) or written with a character reference is heading text, and the section id is the slug. Ids of such headings change accordingly.

- bbe51bf: Read-side additions. They are additive for consumers; a hand-written `Engine` implementation (a mock, for example) must add `docInfo`.

  - `engine.docInfo(docId)` returns a document's title, frontmatter, headings and blocks, plus its parse diagnostics, as a new `DocInfo` type. It reads through the engine's parse cache, so a document the engine wrote or projected costs no parse. The title is a non-blank frontmatter `title` (trimmed), otherwise the first non-empty level-1 heading (ATX or setext). Heading text is plain text with its `{#anchor}` removed, and the anchor is the section id; ids are not guaranteed unique. A missing, invalid, oversized, over-complex or unparseable document gives `undefined`.
  - `ProjectionWalkHandlers` gains an optional `onUnresolvedSource(ref, state, raw, ctx)`. A `{{source:…}}` span whose value is stale or missing reaches it, so a structured projector can key every reference. Without it, such a span stays verbatim prose as before. `hookValues` is unchanged, so block hooks still never see a stale or missing value.

## 0.2.0

### Minor Changes

- 85fa8a0: Parsing is now fail-soft, and a new complexity guard, on by default, refuses the known markdown shapes that overflow the parser's stack or cost time quadratic in their nesting depth.

  - **Breaking (behaviour):** `EngineOptions.complexityLimits` is on by default, set to `DEFAULT_COMPLEXITY_LIMITS`:

    - at most 32 container markers (`>`, list markers, `[^x]:`) at the start of one line;
    - at most 160 columns of prefix indentation;
    - `[` nesting at most 32 deep in a paragraph;
    - runs of at most 64 `*`, `_` or `~` (a thematic break or fence line is not counted);
    - emphasis nesting at most 256 deep in a paragraph, estimated as an upper bound (code spans are counted, so a long table or list of globs such as `` `src/**/*.ts` `` can be refused).

    Fenced code that the scan can follow exactly is not counted for brackets, delimiter runs or emphasis.

    A linear scan runs before every parse. Documents over a limit that were accepted before are now refused. A write, patch or intent is rejected. A stored document is treated like one over `maxDocumentBytes`: its projection is `ok: false`, an include of it stays verbatim, `getBlock` returns `undefined`, and an external write of it is not evented. The diagnostic is `E_DOCUMENT_TOO_COMPLEX`. To accept such documents, raise the field that refuses them, or pass `complexityLimits: false` to turn the scan off.

    The guard does not bound parse time. Some content within the limits still parses in superlinear time. At the default `maxDocumentBytes` (256 KiB), a long list or dense emphasis can still parse for tens of seconds. A host that accepts untrusted writes should keep `maxDocumentBytes` low (every measured shape parses in under a second at 32 KiB) or parse off the main thread. The projections guide, under "Document size limit", has the measurements.

  - **Breaking (behaviour):** a projection middleware that throws an error other than `WriteRejection` no longer rejects `engine.projection()`. The projection degrades the same way it does for a throwing projector, with an `E_MIDDLEWARE_ERROR` diagnostic carrying the error's message. A host that relied on the rejection should check `diagnostics` for that code instead.
  - **Breaking (type of values):** `WriteResult` `rejection.reason` can now be `too-complex`. Code that switches over the reasons should handle it.
  - **Fix:** a parse that throws no longer escapes `createDoc`, `write`, `patch`, `applyIntent`, `projection`, `refGraph` or `getBlock`. For example, a `RangeError` stack overflow on input the scan does not catch.
    - A write is rejected with reason `validation` and an `E_PARSE_FAILED` diagnostic.
    - A board that cannot be parsed contributes no include edges, and an include of one becomes a `missing-doc` edge.
    - The engine remembers a failed parse by content, so it is not parsed again on every read.
  - **Fix:** a scoped subscriber whose board cannot be read or parsed no longer makes every later write reject, including writes to unrelated documents. That board contributes no include edges.
  - **New exports from `@onioneko/boardkit-core`:**
    - `ComplexityLimits` and `DEFAULT_COMPLEXITY_LIMITS`;
    - the `complexityLimits` field on the exported `PipelineDeps` (`applyIntent`) and `ExternalWriteDeps` (`createExternalWriteHandler`). An invalid value throws a `TypeError`, as in `createEngine`.
  - **New exports from `@onioneko/boardkit-core/internal`:**
    - `documentComplexityDiagnostic`, `fencedCodeLines` and `parseFailedDiagnostic`;
    - `LinkOptions.complexityLimits`, for `resolveIncludes`.

- 66ea8b0: A write parses its content once, seeds the parse cache, and the scoped-subscription include index is rebuilt through that cache; a stored document can be sized before it is read (#3).

  - **Parse once:** a full-text write, a patch, an intent and a create each parse the stored content once and scan it against the complexity limits once. The parse of the content being replaced comes from the parse cache when it is there. The write's parse seeds the cache, so the next projection or `getBlock` of the document parses nothing, and content found in the cache is not scanned again. With `watch` on, recording the self-echo no longer parses (the baseline for the next external edit is parsed only when that edit arrives). A write whose bounded history is truncated still parses twice: once to validate, once for the truncated result.
  - **Include index rebuilds parse nothing new:** scoped subscriptions still rebuild the include index from every subscriber's include closure before a write delivers, after any commit, reported external write, subscribe, unsubscribe or `registerBlock`, so writes still re-read those closures. The rebuild now reuses the parse of every unchanged document, including the one the previous write stored, so it no longer parses or scans anything the engine has already seen. A rebuild that could not read a document (a transient `EIO`, say) is redone before the next write, even when the write that triggered it was rejected. A document changed in storage with no watch and no `engine.externalWrite` gets no events of its own, and its include edges are picked up by the next rebuild, as before. Document ids are compared exactly, case included.
  - **New:** optional `Storage.size(docId)`, implemented by `createFsStorage` and `createMemStorage`. When a storage has it, the engine refuses a stored document over `maxDocumentBytes` with `E_DOCUMENT_TOO_LARGE` (`too-large` for patches and intents) before reading it, in projections, include graphs, `refGraph`, `getBlock`, patches and intents. A missing, unknown or throwing size falls back to reading the document. A custom storage's `size` must not exceed the UTF-8 byte length of what its `read` returns.
  - **New (additive) fields:** `PipelineDeps.cachedParse` and `PipelineDeps.onCommit` (with the new exported `CommitEffect` type), and `ExternalWriteDeps.cachedParse` and `ExternalWriteDeps.parse`, through which the engine shares its parse cache with the pipeline and the watch handler. `LinkOptions.cached` (from `@onioneko/boardkit-core/internal`) lets `resolveIncludes` reuse an existing parse without re-checking it against the limits.
  - **Breaking (type), `ExternalWriteHandler`:** the interface gains `recordRemoved(docId)`, which forgets the self-echo record of a deleted document, so the same bytes restored later (a `git checkout`, an undo) are handled as an external write. Before, they were suppressed as a self-echo. `createExternalWriteHandler` implements it; a host that implements the interface itself must add it.
  - **Validate hooks:** a block type's `validate` hook receives a copy of the attrs on a full-text write or a create, as it already did on a patch, so a hook that changes the attrs in place no longer affects what is stored or cached.
  - **Events:** the `values` of `block.updated` and the `from` and `to` of transition events are copies, never objects shared with a parse.

- 6af5dc0: The write path gains `importDoc` for restoring a document's bytes as they were (#18), strict value-CAS by default (#15), and commit boundaries on every event (#17).

  - **Breaking (behaviour):** strict value-CAS is the default. A present `expected` on `engine.patch` or an `Intent` is now compared against the block's current attrs even when `expectedVersion` is absent or current, and a mismatch is rejected with `expected-mismatch` (with the current attrs in `rejection.current`). Before, a current `expectedVersion` applied the write without looking at `expected`. A host that sends `expected` values it does not keep in step with the version can opt out with `strictExpected: false`, either per call (`engine.patch` options, `Intent.strictExpected`, `PatchGuards.strictExpected`) or engine-wide (`EngineOptions.strictExpected`).
  - **Breaking (type):** `WriteMode`, and so the `mode` that `WritePolicy.canWrite` and `WriteCtx` receive, gains `"import"`. An exhaustive `switch` over it must handle the new case. `WriteResult` `rejection.reason` can now be `import-amended`.
  - **Breaking (type):** `Engine` gains `importDoc`, so a host that implements `Engine` itself (a mock, for example) must add it.
  - **New field on records:** every event the engine appends carries `commit: { id, index, size }`. All events of one commit (a write, patch, intent, create, import, remove, or one handled external write) share the `id`; `index` is the event's position from 0 and `size` the commit's event count, so a subscriber can act once per commit instead of debouncing. The id is unique per event log (`<docId>@<version>#<prefix>.<n>`, with a random per-engine prefix; pin it with the new `EngineOptions.commitIdPrefix` for reproducible ids). Records of commits on different documents can interleave in the log, so group by `id`, not by position. The field is named `size`, not the `count` proposed in #17. `EventRecord` and `EventDraft` declare the optional field, and the fs event log stores it. Records in an older log have no `commit` and still read. A custom `EventSink` that rebuilds records field by field must keep it.
  - **New:** `engine.importDoc(docId, { writer, content, ignoreSizeLimit? })` stores `content` byte for byte under a new id and emits `doc.created` with `imported: true`. It skips content validation, history truncation and the complexity limits, but runs the write policy and write middleware (mode `"import"`; middleware may veto but not amend), the lock, the watch self-echo record, and cache and reverse-index invalidation. Content over `maxDocumentBytes` is rejected with `too-large` unless `ignoreSizeLimit: true` is passed. An existing id is rejected with `exists`. Use it instead of writing to storage and appending a `doc.created` by hand.
  - **New exports from `@onioneko/boardkit-core`:** `intentExpected(blockType, affordance, attrs, params)`, which builds the `expected` payload for an intent (the current values of the attrs the affordance's patch changes); the `CommitInfo` and `ImportOptions` types; `EngineOptions.commitIdPrefix`; `PipelineDeps.commitId` and `ExternalWriteDeps.commitId`, to mint commit ids when calling the pipeline directly (without one, each commit gets a random unique id).
  - **New export from `@onioneko/boardkit-core/internal`:** `importDoc`, the pipeline function behind `engine.importDoc`.
  - **html:** the projector builds the `data-intent` `expected` payload with `intentExpected`. The payload is unchanged.
