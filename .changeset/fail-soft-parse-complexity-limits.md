---
"@onioneko/boardkit-core": minor
---

Parsing is now fail-soft, and a new complexity guard, on by default, refuses the known markdown shapes that overflow the parser's stack or cost time quadratic in their nesting depth.

- **Breaking (behaviour):** `EngineOptions.complexityLimits` is on by default, set to `DEFAULT_COMPLEXITY_LIMITS`:
  - at most 32 container markers (`>`, list markers, `[^x]:`) at the start of one line;
  - at most 160 columns of prefix indentation;
  - `[` nesting at most 32 deep in a paragraph;
  - runs of at most 64 `*`, `_` or `~` (a thematic break or fence line is not counted);
  - emphasis nesting at most 64 deep in a paragraph.

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
  - `documentComplexityDiagnostic` and `parseFailedDiagnostic`;
  - `LinkOptions.complexityLimits`, for `resolveIncludes`.
