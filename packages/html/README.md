# @onioneko/boardkit-html

The html projector for BoardKit: a document rendered to sanitized HTML suitable
for embedding in a panel, with live values injected, typed blocks rendered
through their `project.html` hooks, and `{{include:…}}` spans expanded into
provenance-carrying `<section>` elements.

The engine registers only the `text` projector by default. Register this one:

```ts
import { createEngine, createMemStorage } from "@onioneko/boardkit-core";
import { htmlProjector } from "@onioneko/boardkit-html";

const engine = createEngine({ storage: createMemStorage() });
engine.registerProjector(htmlProjector);

const { output } = await engine.projection<string>("fin", "html", { source });
```

or at construction, alongside the built-in `text` projector (passing
`projectors` replaces the default set):

```ts
import { createEngine, textProjector } from "@onioneko/boardkit-core";
import { htmlProjector } from "@onioneko/boardkit-html";

const engine = createEngine({ storage, projectors: [textProjector, htmlProjector] });
```

## Exports

| Export | What it is |
|---|---|
| `htmlProjector` | A ready `Projector<string>` with `id: "html"` — register it. |
| `projectHtml(doc, src, values, opts?)` | The projection itself, for wrapping it in your own projector. |
| `HtmlProjectionOptions` | `blockTypes`, `merged` and `report` — the options `projectHtml` accepts. |
| `projectHast(walk, handlers)` | One node's markdown as unsanitized hast, with every reference, block and include left as a hole `handlers` fill. The html projector's own pipeline, for a projector whose output is structured. See [Structured projectors](#structured-projectors). |
| `HastHoleHandlers`, `Hole` | The handlers `projectHast` takes, and the hole kinds: `SourceHole`, `UnresolvedHole`, `BlockHole`, `IncludeHole`. |
| `includeWrapper(include, children)` | The `<section data-doc data-section>` provenance wrapper around an expanded include, the only element whose provenance survives `sanitizePanelHast`. |
| `sanitizePanelHast(tree)` | The whole sanitize pass `projectHtml` runs: a read-once plain copy with the provenance check, scheme lowercasing, `panelSchema()`, `pruneLabelAttributes`, footnote links. Returns a new sanitized tree and does not modify its input. |
| `panelSchema()` | The `hast-util-sanitize` schema the whole projected document is sanitized against. |
| `panelAttributeNames()` | The attribute names `panelSchema()` allows, per tag plus `"*"`, as plain lists without value constraints. |
| `pruneLabelAttributes(node)` | The post-sanitize `<label>` hardening the schema cannot express. |
| `degradedHtml(src)` | The fail-soft output `htmlProjector.degrade` returns: the escaped source in `<pre class="projection-degraded"><code>`. Use it as the `degrade` of a projector that wraps `projectHtml`. |
| `escapeHtml(value)` | Minimal escaping of the five HTML-significant characters, for hosts that build markup around the output. |

## Options

`projectHtml`'s fourth argument is an `HtmlProjectionOptions` object; every field
is optional. `htmlProjector` fills them from the engine's projection input, and
accepts no options of its own.

| Option | Type | Default | Effect |
|---|---|---|---|
| `blockTypes` | `ReadonlyMap<string, AnyBlockType>` | none (no block types) | Registered block types whose `project.html` hooks render blocks. A block whose type is absent is rendered as its escaped source in `<pre><code>`. The engine passes its block registry. |
| `merged` | `MergedTree` | none | The merged include tree. When present, includes are expanded into provenance-carrying `<section>` elements and `data-intent` carries the document identity. When absent, only the document's own spans are rewritten, includes stay unexpanded, and `data-intent` enrichment is skipped. The engine passes its MERGE result. |
| `report` | `(diagnostic: Diagnostic) => void` | none (diagnostics are dropped) | Receives non-fatal diagnostics, such as `E_BLOCK_HOOK_ERROR` for a block hook that threw. The engine passes a collector that surfaces them in the projection's `diagnostics`. |

## Notes

1. **`data-intent` enrichment.** A block hook that annotates an element with
   `{"affordance": …, "params": …}` gets the full Intent payload merged in —
   `docId`, `blockId`, `affordance`, `params`, `expectedVersion`, `expected` —
   so a view adapter can post the click straight back to the engine. Identity
   and version come from the merged node's provenance, so a block from an
   included document embeds *that* document, not the board.
2. **Sanitization covers the whole document.** Prose, block hook subtrees,
   live values and expanded includes are assembled as one hast tree and pass
   through `sanitizePanelHast` (`panelSchema()`, then `pruneLabelAttributes`)
   before they are serialized. Event-handler attributes, `style`, form-submission attributes
   (`action`, `method`, `encType`), and elements such as `script`, `iframe`,
   `form` and `base` are dropped. In `href`, only `http:`,
   `https:` and `mailto:` URLs (any letter case) plus relative and fragment
   URLs are kept; in `src`, only `http:`/`https:` plus relative. Every other
   scheme (`javascript:`, `vbscript:`, `data:`, …) is dropped. "Relative"
   includes protocol-relative `//host/path` links, so a link can still point
   at another site — it just cannot run script. `srcset` is not allowed at
   all. Raw HTML in the markdown is never rendered. A `<label>` keeps only its
   `className`: it exists so a checklist item's text can wrap its input, and
   the sanitizer's `'*'` wildcard cannot be revoked per tag. `data-doc` and
   `data-section` survive only on the projector's own include wrappers, so a
   block hook's output cannot claim to come from another document: hook
   output is copied as plain data before it joins the tree, so even a wrapper
   a hook builds with `includeWrapper` loses its provenance. (Code that runs
   in-process outside the hook contract, patching globals for instance, is
   out of scope.) Hook output that cannot be copied, such as a `Proxy`,
   renders as the block's escaped source with `E_BLOCK_HOOK_ERROR`.
3. **Heading anchors.** A heading's trailing `{#anchor}` is removed from its
   text, by the same rule the parser reads section ids with, and becomes the
   heading's `id` (prefixed, like every id, as `user-content-…`):
   `## Risk limits {#risk-limits}` renders as
   `<h2 id="user-content-risk-limits">Risk limits</h2>`. An anchor in a code
   span, split by formatting, or escaped is ordinary text. The projections
   guide's "Heading anchors" section has the full rule, and two limits: `_` or
   `*` touching a `{{source:…}}` in an anchored heading can make the html
   projection and the parser disagree on the anchor, and ids are not made
   unique, so a repeated anchor, a section included twice, or `{#fn-1}` next
   to a footnote gives the page duplicate ids.
4. **Failure is inert, too.** A block whose `html` hook throws renders as its
   escaped source in `<pre><code>`, the rest of the document renders normally,
   and the projection reports `E_BLOCK_HOOK_ERROR`. If the projection fails as
   a whole (the projector throws, or a projection middleware rejects it), the
   engine returns `htmlProjector.degrade`'s output — the escaped source — not
   the raw markdown.
5. **Middleware output is yours.** A projection middleware that changes
   `ctx.output` after `next()` replaces sanitized HTML with whatever it
   writes; that host code is responsible for keeping it safe.
6. **Nothing but the public core API.** This package imports only from
   `@onioneko/boardkit-core`'s root — the merged-tree walk, the block registry, and
   provenance are all reached the way any custom projector reaches them.

## Structured projectors

A projector whose output is a component tree or a JSON view rather than an
HTML string can reuse the html projector's pipeline in two halves:

```ts
import {
  type HastHoleHandlers,
  includeWrapper,
  projectHast,
  sanitizePanelHast,
} from "@onioneko/boardkit-html";

const walkOf = (node) => ({ node, values: input.values, projectorId: "view", blockTypes: input.blockTypes });
const handlers: HastHoleHandlers = {
  onHole: async (hole) => {
    if (hole.kind === "source") return [{ type: "text", value: hole.value }];
    if (hole.kind === "block") return [{ type: "text", value: hole.block.raw }];
    const inner = await projectHast(walkOf(hole.include.node), handlers);
    return [includeWrapper(hole.include, inner.children)];
  },
};
const tree = sanitizePanelHast(await projectHast(walkOf(input.merged.root), handlers));
// …convert `tree` to your own structure.
```

- **No second parse.** The node's prose is the document's own parse: its
  top-level mdast nodes are copied out of the tree the parser made
  (`mdastOf` in `@onioneko/boardkit-core`), a placeholder token is spliced in
  at each hole's source offset, and the copy goes to hast in one pass. So a
  paragraph that holds a reference or a block stays one paragraph, the
  markdown around a hole reads as the parser read it, and projecting a version
  the engine has already parsed parses nothing. When the parse kept no tree,
  the document's source is parsed once per projection walk cache. The tokens
  carry a random value chosen per call and absent from the source, so text an
  author writes is never mistaken for one.
- **Holes.** `source` (a resolved value), `block` (the block with its hook
  already dispatched for `walk.projectorId`) and `include` (the merged child
  node) reach `onHole`, once each, in document order; the handler may be
  async. A block's trailing whitespace text is trimmed. A paragraph that holds
  only an include's token is replaced by the include's content.
- **Unresolved references.** A stale or missing `{{source:…}}` stays verbatim
  prose unless `onUnresolved` is supplied, which then receives it as an
  `unresolved` hole (`ref`, `raw`, `stale`, and for a stale one the source's
  degradation marker as `value`).
- **Attributes.** A reference in an autolink (`www.example.com/{{source:p}}`,
  `<https://example.com/{{source:p}}>`) is in its `href` too. There a hole
  becomes `onHoleInAttribute(hole)`, by default the value's text for `source`,
  the raw reference for `unresolved`, and `""` for an include. A link written
  with a destination (`[text](url)`) keeps its URL as written.
- **Unsanitized.** `projectHast` returns the tree as built, hook output and
  all. Run `sanitizePanelHast` on it before anything renders it. Build
  include wrappers with `includeWrapper`: the sanitizer keeps provenance on
  that exact object and removes it everywhere else, copies included. A block
  hole's `output` is already a structured clone of what the hook returned.

[`examples/06-structured-projector.ts`](https://github.com/onioneko/boardkit/blob/main/examples/06-structured-projector.ts)
is a complete JSON view projector built this way.

## License

[MIT](https://github.com/onioneko/boardkit/blob/main/packages/html/LICENSE)
