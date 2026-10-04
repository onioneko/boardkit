---
"@onioneko/boardkit-core": minor
---

Parsing is now fail-soft, and a new complexity guard, on by default, refuses markdown that is too deeply nested to parse safely.

- **Breaking (behaviour):** `EngineOptions.complexityLimits` is on by default with `DEFAULT_COMPLEXITY_LIMITS`: 32 container markers (`>`, list markers, `[^x]:`) at the start of one line, 160 columns of prefix indentation, `[` nesting 32 deep in a paragraph, and runs of 64 `*`, `_` or `~`. A linear scan runs before every parse. Documents over a limit that were accepted before are now refused: a write, patch or intent is rejected, and a stored document is treated like one over `maxDocumentBytes`, so its projection is `ok: false`, an include of it stays verbatim, `getBlock` returns `undefined`, and an external write of it is not evented. The diagnostic is `E_DOCUMENT_TOO_COMPLEX`. To accept such documents, raise the field that refuses them, or pass `complexityLimits: false` to turn the scan off.
- **Breaking (behaviour):** a projection middleware that throws an error other than `WriteRejection` no longer rejects `engine.projection()`. The projection degrades the same way a throwing projector does, with an `E_MIDDLEWARE_ERROR` diagnostic carrying the error's message. A host that relied on the rejection should check `diagnostics` for that code instead.
- **Breaking (type of values):** `WriteResult` `rejection.reason` can now be `too-complex`. Code that switches over the reasons should handle it.
- **Fix:** a parse that throws (a `RangeError` stack overflow on deep nesting, for example) no longer escapes `createDoc`, `write`, `patch`, `applyIntent`, `projection`, `refGraph` or `getBlock`. A write is rejected with reason `validation` and an `E_PARSE_FAILED` diagnostic. A board that cannot be parsed contributes no include edges, and an include of one becomes a `missing-doc` edge.
- **Fix:** a scoped subscriber whose board cannot be read or parsed no longer makes every later write reject, including writes to unrelated documents. That board contributes no include edges.
- New exports: `ComplexityLimits` and `DEFAULT_COMPLEXITY_LIMITS` from `@onioneko/boardkit-core`; `documentComplexityDiagnostic` and `parseFailedDiagnostic` from `@onioneko/boardkit-core/internal`.
