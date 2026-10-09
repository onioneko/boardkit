---
"@onioneko/boardkit-core": minor
---

Write middleware can parse the proposed text through the engine's parse cache, and the write reuses that parse (#41).

- **New:** `WriteCtx.parse(src)` returns a new `WriteParseResult`: `{ ok: true, parsed }` with the `ParsedDoc` the commit pipeline makes of `src`, or `{ ok: false, rejection: { reason, diagnostics } }` with the rejection a write of `src` would get. The size and complexity limits are checked before anything is parsed (`too-large`, `too-complex`), and a parser that throws gives `validation` with `E_PARSE_FAILED`; it never throws for the source's content. In an engine it parses through the content-keyed parse cache, so a parse it returns may be shared and its block attrs are frozen.
- **Parse once:** a full-text write or a create reuses a cached parse of the exact text it validates, so a middleware that parses `proposed.fullText` or `proposed.content` with `ctx.parse` costs the write no second parse, and the write does not scan that text against the complexity limits again. Results, stored text and events are unchanged.
- **New (additive) field:** `PipelineDeps.parseCache`, through which the engine shares its parse cache with the pipeline.
- **Breaking (type), `WriteCtx`:** `parse` is a required field. The pipeline always provides it; code that builds a `WriteCtx` by hand (a middleware unit test, for example) must add a `parse` function.
