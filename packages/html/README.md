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
| `panelSchema()` | The `hast-util-sanitize` schema the whole projected document is sanitized against. |
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
   through `panelSchema()`, then `pruneLabelAttributes`, before they are
   serialized. Event-handler attributes, `style`, and elements such as
   `script`, `iframe`, `form` and `base` are dropped. In `href`, only `http:`,
   `https:` and `mailto:` URLs (any letter case) plus relative and fragment
   URLs are kept; in `src`, only `http:`/`https:` plus relative. Every other
   scheme (`javascript:`, `vbscript:`, `data:`, …) is dropped. "Relative"
   includes protocol-relative `//host/path` links, so a link can still point
   at another site — it just cannot run script. `srcset` is not allowed at
   all. Raw HTML in the markdown is never rendered. A `<label>` keeps only its
   `className`: it exists so a checklist item's text can wrap its input, and
   the sanitizer's `'*'` wildcard cannot be revoked per tag.
3. **Failure is inert, too.** A block whose `html` hook throws renders as its
   escaped source in `<pre><code>`, the rest of the document renders normally,
   and the projection reports `E_BLOCK_HOOK_ERROR`. If the projection fails as
   a whole (the projector throws, or a projection middleware rejects it), the
   engine returns `htmlProjector.degrade`'s output — the escaped source — not
   the raw markdown.
4. **Middleware output is yours.** A projection middleware that changes
   `ctx.output` after `next()` replaces sanitized HTML with whatever it
   writes; that host code is responsible for keeping it safe.
5. **Nothing but the public core API.** This package imports only from
   `@onioneko/boardkit-core`'s root — the merged-tree walk, the block registry, and
   provenance are all reached the way any custom projector reaches them.

## License

[MIT](https://github.com/onioneko/boardkit/blob/main/packages/html/LICENSE)
