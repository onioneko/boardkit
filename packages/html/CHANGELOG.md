# @onioneko/boardkit-html

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

## 0.2.0

### Patch Changes

- 6af5dc0: The write path gains `importDoc` for restoring a document's bytes as they were (#18), strict value-CAS by default (#15), and commit boundaries on every event (#17).

  - **Breaking (behaviour):** strict value-CAS is the default. A present `expected` on `engine.patch` or an `Intent` is now compared against the block's current attrs even when `expectedVersion` is absent or current, and a mismatch is rejected with `expected-mismatch` (with the current attrs in `rejection.current`). Before, a current `expectedVersion` applied the write without looking at `expected`. A host that sends `expected` values it does not keep in step with the version can opt out with `strictExpected: false`, either per call (`engine.patch` options, `Intent.strictExpected`, `PatchGuards.strictExpected`) or engine-wide (`EngineOptions.strictExpected`).
  - **Breaking (type):** `WriteMode`, and so the `mode` that `WritePolicy.canWrite` and `WriteCtx` receive, gains `"import"`. An exhaustive `switch` over it must handle the new case. `WriteResult` `rejection.reason` can now be `import-amended`.
  - **Breaking (type):** `Engine` gains `importDoc`, so a host that implements `Engine` itself (a mock, for example) must add it.
  - **New field on records:** every event the engine appends carries `commit: { id, index, size }`. All events of one commit (a write, patch, intent, create, import, remove, or one handled external write) share the `id`; `index` is the event's position from 0 and `size` the commit's event count, so a subscriber can act once per commit instead of debouncing. The id is unique per event log (`<docId>@<version>#<prefix>.<n>`, with a random per-engine prefix; pin it with the new `EngineOptions.commitIdPrefix` for reproducible ids). Records of commits on different documents can interleave in the log, so group by `id`, not by position. The field is named `size`, not the `count` proposed in #17. `EventRecord` and `EventDraft` declare the optional field, and the fs event log stores it. Records in an older log have no `commit` and still read. A custom `EventSink` that rebuilds records field by field must keep it.
  - **New:** `engine.importDoc(docId, { writer, content, ignoreSizeLimit? })` stores `content` byte for byte under a new id and emits `doc.created` with `imported: true`. It skips content validation, history truncation and the complexity limits, but runs the write policy and write middleware (mode `"import"`; middleware may veto but not amend), the lock, the watch self-echo record, and cache and reverse-index invalidation. Content over `maxDocumentBytes` is rejected with `too-large` unless `ignoreSizeLimit: true` is passed. An existing id is rejected with `exists`. Use it instead of writing to storage and appending a `doc.created` by hand.
  - **New exports from `@onioneko/boardkit-core`:** `intentExpected(blockType, affordance, attrs, params)`, which builds the `expected` payload for an intent (the current values of the attrs the affordance's patch changes); the `CommitInfo` and `ImportOptions` types; `EngineOptions.commitIdPrefix`; `PipelineDeps.commitId` and `ExternalWriteDeps.commitId`, to mint commit ids when calling the pipeline directly (without one, each commit gets a random unique id).
  - **New export from `@onioneko/boardkit-core/internal`:** `importDoc`, the pipeline function behind `engine.importDoc`.
  - **html:** the projector builds the `data-intent` `expected` payload with `intentExpected`. The payload is unchanged.
