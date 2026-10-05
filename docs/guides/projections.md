# Projections

A projection renders one document through a named projector without touching the source. The
engine's read path is `LOAD → PARSE → LINK → MERGE → RESOLVE → PROJECT`: it loads the document,
resolves its `{{include:…}}` graph, merges the reachable documents into a tree, and resolves
every `{{source:…}}` reference once before handing the result to the projector.

```ts
const projection = await engine.projection<string>("fin", "text", { source });
console.log(projection.output);      // rendered text
console.log(projection.diagnostics); // [] on a clean document
console.log(projection.versions);    // committed versions of every reachable document
```

The type parameter is the projector's output type, asserted by the caller: the engine passes
the projector's return value through untouched, so `projection<string>` gives you a `string`
`output` with no narrowing at the call site. It defaults to `unknown` — say what you expect,
and a projector whose contract you do not control stays honest.

## The Projector interface

A projector is a small object with an `id`, a `project` function, and optionally a `degrade`
function for when a projection cannot complete (see [Projector exceptions](#projector-exceptions)). It receives a typed
`ProjectionInput` — the parsed document, its raw source, the resolved source values, the merged
include tree, the registered block types, and the projection options — and returns its output
(or a promise of one). The built-in `text` projector — and `htmlProjector` from
`@onioneko/boardkit-html` — return strings, but the output type is unconstrained: a react component
tree, an email body, a pdf buffer all pass through the engine untouched.

```ts
import type { Projector } from "@onioneko/boardkit-core";

const titleProjector: Projector = {
  id: "title",
  project: (input) => String(input.doc.frontmatter["title"] ?? ""),
};
```

Register yours with `engine.registerProjector` or pass it to `createEngine({ projectors })`.
`text` is the engine's only default; passing `projectors` replaces that default, so include
`textProjector` explicitly to keep it. The `html` projector ships separately, in
`@onioneko/boardkit-html`:

```ts
import { createEngine, textProjector } from "@onioneko/boardkit-core";
import { htmlProjector } from "@onioneko/boardkit-html";

const engine = createEngine({ storage, projectors: [textProjector, htmlProjector] });
// or, after construction: engine.registerProjector(htmlProjector);
```

An unregistered projector id is not a programming error: `engine.projection` comes back
`ok: false` with an `E_UNKNOWN_PROJECTOR` diagnostic.

## Source-faithful span rewriting

Both `text` and `html` rewrite spans in the original source (they share one walk): a `{{source:…}}` span becomes
its resolved value, a block span becomes its `project` hook's output, and an include span
becomes the referenced content's projection. Every untouched byte is preserved verbatim, so a
document you never edit round-trips exactly.

Stale values keep the original reference text rather than fabricating data.

## Include expansion at projection time

An include target is a document id, exactly like the ids the engine API accepts: `a/b/c`, without
`.md`, no `.` or `..` segments, no leading `/`, no backslashes. A target of any other shape (for
example `{{include:../x}}` or `{{include:notes.md}}`) is diagnosed with `E_INCLUDE_INVALID_TARGET`
on the including document and stays literal text. Because it is a reference syntax error, a write
containing one is rejected, like any other malformed reference. A target that resolves outside the
workspace through a symlink is diagnosed with `E_INCLUDE_OUTSIDE_ROOT` and is not read.

Includes are expanded when the engine's merge stage supplies a merged tree (via
`options.merged`, which the engine sets automatically). A whole-document include is projected
in place; a section include is wrapped with its provenance:

- **text** — a section renders as a blockquote whose heading is the human-readable
  provenance: a single-line body stays on the heading line (`> <heading>: <content>`), while a
  multi-line body — a list, or several paragraphs — puts `> <heading>:` on its own line
  followed by the body lines, so the first line is not glued to the heading.
- **html** — an include renders inside a `<section>` element carrying `data-doc` (and, for a
  section slice, `data-section`) attributes.

The full `{ docId, sectionId }` provenance lives on the merged nodes themselves and on the
html projector's `data-*` attributes. Only the projector's own include wrappers keep `data-doc`
and `data-section`: the sanitizer removes them from block hook output, so a hook cannot make its
markup look as though it came from another document.

### Expansion limit

Every place a document is included expands its own copy: `{{include:x}}` and `{{include:x#s}}`
are separate includes, and a document reached through two includers is expanded under each. A
handful of small documents that include each other this way can multiply into an enormous tree,
so expansion is bounded per projection by three limits, whichever is reached first:

- `maxNodes` — included documents and sections, at most **1,000** by default;
- `maxBytes` — source text contributed by included documents and sections, measured in UTF-8
  bytes, at most **1 MiB** by default;
- `maxDepth` — how deeply includes nest (the board's own includes are depth 1), at most **64**
  by default.

The board document itself never counts toward any limit. Includes are admitted breadth-first:
every include in the board is considered before any include nested inside them, and siblings in
document order, so the includes nested inside one of the board's includes cannot crowd out the
board's other includes.

- An include whose content does not fit in what is left of `maxBytes` is skipped on its own: it
  stays verbatim `{{include:…}}` text, and later includes that fit are still expanded.
- The first include that would go past `maxNodes` or `maxDepth` stops expansion: it and every
  include not yet admitted stay verbatim `{{include:…}}` text.

Each kind of miss adds one `E_INCLUDE_LIMIT` diagnostic naming the first include it left out,
the document containing it, the limit it hit, and how many more it left out, if any. The rest
of the projection is unaffected and nothing throws. These diagnostics are reported on every
projection of that content, including ones served from the engine's merge cache. A document
reachable only through includes that were not expanded is not part of the projection, so it is
absent from the result's `versions`.

Raise or lower the limits with `includeLimits` when creating the engine. Each is a non-negative
integer, or `Infinity` to remove that bound; any other value, or an unknown field, throws a
`TypeError`:

```ts
const engine = createEngine({
  storage,
  includeLimits: { maxNodes: 5_000, maxBytes: 4 * 1024 * 1024 },
});
```

The defaults are exported as `DEFAULT_INCLUDE_LIMITS`.

## Document size limit

Parsing markdown takes more than linear time for some content, so the engine never parses a
document larger than `maxDocumentBytes`: **256 KiB** of UTF-8 by default, exported as
`DEFAULT_MAX_DOCUMENT_BYTES`.

- A write whose result would be larger (`write`, `patch`, `applyIntent`, `createDoc`) is rejected
  with reason `too-large` and an `E_DOCUMENT_TOO_LARGE` diagnostic, and nothing is stored.
- A stored document that is larger (it was written outside the engine) is diagnosed with
  `E_DOCUMENT_TOO_LARGE` and not parsed:
  - projecting it returns `ok: false` with empty output;
  - an include of it stays verbatim `{{include:…}}` text, like an include of a missing document,
    the rest of the board projects normally, and the document is left out of `versions`;
  - `refGraph` on it returns no documents, only the diagnostic;
  - `getBlock` and `docInfo` treat it as absent, and patches and intents against it are rejected
    with reason `too-large`;
  - `getDoc` still returns its raw source.

  When the storage implements `Storage.size`, a stored document over the limit is diagnosed from
  its size, before it is read (see
  [Sizing a document before reading it](storage-and-watch.md#sizing-a-document-before-reading-it)).
- A full-text `write` that fits may replace it. The engine never parsed the old version, so it
  cannot diff against it: the write's events start with `doc.removed` and `doc.created`, followed
  by the new content's events as if it were created from empty. A consumer that replays the log
  ends with exactly the new document.

The limit bounds the cost of one document, but it does not make parsing linear. Some markdown
still parses in superlinear time well below the limit, and a write parses its content more than
once. Measured on Node 24, parse alone, each shape filled to 256 KiB and within the
[complexity limits](#complexity-limits) below:

| Shape | 64 KiB | 256 KiB |
|---|---|---|
| Plain prose | 0.03 s | 0.14 s |
| A long flat list (`- x` on every line) | 1.2 s | 13 s |
| A list 32 levels deep on every line (`- - - … x`) | 1.8–2.0 s | 35–50 s |
| Dense emphasis (`*a* ` repeated) | 0.9 s | 16 s |

Long runs of escaped characters, many footnote references, and long paragraphs of many short
lines or references (`{{source:a}}` on every line) are slow too. A host that accepts writes from
untrusted parties should keep the limit low (each of the costs above is under a second at
32 KiB), or parse off the main thread (for example by running the engine in a worker).

Set the limit when creating the engine. It is a non-negative integer, or `Infinity` to remove it;
any other value throws a `TypeError`:

```ts
const engine = createEngine({ storage, maxDocumentBytes: 64 * 1024 });
```

### Complexity limits

Some shapes are worse than slow. The markdown parser's work grows quadratically with how deeply
containers nest, and a few thousand levels on one line overflow the call stack: an 8 KB line of
`>` characters is enough. Nested emphasis behaves the same way: a 36 KB paragraph of
alternating `*a _b` openers parses for about 16 seconds and then overflows. So before any parse,
the engine runs a linear scan of the source against five limits, set by `complexityLimits` and
exported as `DEFAULT_COMPLEXITY_LIMITS`:

| Field | Default | What it counts |
|---|---|---|
| `maxContainerDepth` | 32 | Container markers at the start of one line: `>`, list markers (`-`, `*`, `+`, `1.`, `1)`) and footnote definitions (`[^x]:`) |
| `maxIndentColumns` | 160 | Columns of whitespace in one line's prefix, a tab advancing to the next multiple of 4 |
| `maxBracketDepth` | 32 | `[` nesting in one paragraph; escapes are skipped, and a blank line or a line of only `>` markers resets the count (an empty list item does not, since it cannot end a paragraph) |
| `maxDelimiterRun` | 64 | A run of one of `*`, `_` or `~`; a line of one such character (or `-` or a backtick) and whitespace, a thematic break or code fence, is not counted |
| `maxEmphasisDepth` | 256 | Emphasis and strikethrough nesting in one paragraph, estimated with the parser's own rules for which `*`, `_` and `~` runs can open or close: a run that can open adds its length, and a run that can only close cancels openers of its own marker that could not also close |

A document over any limit is handled exactly like one over the size limit, with an
`E_DOCUMENT_TOO_COMPLEX` diagnostic that gives the line, and reason `too-complex` for a rejected
write, patch or intent.

Fenced code holds no markdown, so the scan does not count brackets, delimiter runs or emphasis
inside it. It follows CommonMark's fence rules (3 or more backticks or tildes, closed by a run
of the same character at least as long, indented at most 3 spaces; an unclosed fence runs to
the end of the document or of its block quote), but only where it can follow them exactly: a
fence at the top level or in block quotes, indented at most 1 space. A fence it cannot follow
(in a list item, indented 2 or more spaces, or after a tab), or a line that may start an HTML
block, ends fence skipping for the rest of the document, so the code after it is counted like
prose. That never lets a fence hide prose from the scan; a seeded property test checks every
skipped line against the parser. Front matter is never searched for fences.

The counts are upper bounds, so some ordinary text is over-counted. Code spans are not skipped,
and a `*` inside one, or between two letters or digits (`2*3`), can count as opening emphasis.
A paragraph, table or tight list with more than about 256 such runs is refused: for example a
table of roughly 85 rows of globs like `` `src/**/*.ts` ``, or about 250 rows of `` `*.md` ``.
Raise `maxEmphasisDepth` if your documents need more. The default of 256 still bounds the cost:
paragraphs nested 256 deep, filled to 256 KiB, parse in about 4 seconds, well under the costs
in the table above and far from the depth that overflows the stack (about 3,000).

The limits are on by default. Raise one, or set it to `Infinity`, if real documents need it, or
pass `false` to turn the scan off:

```ts
const engine = createEngine({ storage, complexityLimits: { maxDelimiterRun: 200 } });
```

Each field is a non-negative integer or `Infinity`; any other value, or an unknown field, throws
a `TypeError`. Each count is meant as an upper bound on the nesting the parser builds: the
emphasis estimate follows the parser's own open and close rules, and a seeded property test
checks that nothing the scan accepts parses deeper than the limit. That rules out the known
stack overflows (deep containers, brackets and emphasis) and the worst nesting costs. The scan
is still a model of the parser, not the parser, so treat this as tested rather than proven, and
it does not bound every superlinear shape: see the table above. A parse that overflows anyway
is caught, as described next.

Whatever the limits, a parse that throws never escapes the engine. A write is rejected with
reason `validation` and an `E_PARSE_FAILED` diagnostic. A stored document that fails to parse is
treated as over a limit: its projection returns `ok: false`, an include of it stays verbatim, it
contributes no include edges to scoped subscriptions, and `getBlock` and `docInfo` treat it as
absent. The
engine remembers the failure by content, so the document is not parsed again until it changes.

The engine parses each document once per content: projections, `refGraph`, `getBlock` and
`docInfo` reuse
the parse of a document that has not changed since it was last read, through includes too, so
repeated projections do not pay for parsing again. A write keeps the parse it made of the content
it stored, so the next read of a document the engine wrote parses nothing, and content already
parsed is not scanned against the complexity limits again. The cache of parses is bounded (at most
16 MiB of source), and block attrs in a cached parse are frozen. A block hook that modifies its
attrs throws, and that block falls back to its verbatim source (`E_BLOCK_HOOK_ERROR`). A
projector that modifies `input.doc` throws, and the projection falls back to the raw source
(`E_PROJECTOR_ERROR`, see [Projector exceptions](#projector-exceptions)).

## The projection input

Every projector receives a `ProjectionInput` whose fields the engine fills in:

- `doc` — the parsed document being projected (`ParsedDoc`).
- `src` — that document's raw source text.
- `values` — a `ReadonlyMap<string, SourceValue>` of every resolved live value, keyed by the
  ref's canonical key (so param-bearing refs are here too).
- `merged` — the merged include tree, which enables include expansion. Optional: it is present
  whenever the engine's MERGE stage ran. A projector that also needs to run without one — the
  built-ins do — walks `input.merged?.root ?? documentNode(input.doc, input.src)` instead of
  assuming `merged` is set.
- `blockTypes` — a `ReadonlyMap<string, AnyBlockType>` of registered block types whose hooks
  render blocks. `AnyBlockType` (not `BlockType`) because the map holds block types of differing
  attrs shapes — see [Blocks](blocks.md).
- `options` — your own options (plus the engine's), read-only.
- `report` — a sink for non-fatal diagnostics (such as a block hook that threw); whatever you
  pass it appears in the projection result's `diagnostics`.

```ts
engine.registerProjector(htmlProjector); // from @onioneko/boardkit-html
await engine.projection<string>("fin", "html", {
  source,
  options: { theme: "light" }, // your own options, available on the projector's input.options
});
```

## Structure and values are separate

A merged node is **pure structure**: provenance, the owning parsed document and its source, the
byte ranges it projects, the `heading` of a section slice, and its include children — and
nothing else. Resolved live values never live on the tree. That separation is what lets the
engine cache merged trees by content hash while RESOLVE re-runs per projection against the
call-scoped `Source`.

Values reach you on the side instead:

- a custom projector reads `input.values`, keyed by each ref's canonical key;
- a block's `project` hook receives its own `values` record, keyed by source id and holding
  param-less refs only (see [Blocks](blocks.md));
- projection middleware sees the same map, read-only, as `ctx.values`.

See [Sources](sources.md) for where these values come from — the `Source` port, `{{source:…}}`
prose refs versus a block's own `sources` declaration, and canonical keys.

## Reading a document without projecting it

`engine.docInfo(docId)` summarizes one document for a host that lists or labels documents: its
title, frontmatter, headings and blocks, without a projection and without parsing again.

```ts
const info = await engine.docInfo("fin");
info?.title;       // "Family Finance"
info?.sections;    // [{ sectionId: "family-finance", heading: "Family Finance", level: 1 }, …]
info?.blocks;      // [{ blockId: "dec-macbook", type: "status" }, …]
```

- **Title.** The frontmatter `title` when it is a non-blank string (trimmed), otherwise the text
  of the first non-empty level-1 heading, ATX (`#`) or setext (`===`). A heading inside a fence,
  blockquote or list is not a document heading, so it is never the title. Without either, `title`
  is absent.
- **Headings.** `sections` lists the top-level headings in document order. The text has its
  `{#anchor}` removed, and the anchor, when there is one, is the `sectionId` (otherwise the slug),
  so `## Now {#now}` is `{ sectionId: "now", heading: "Now", level: 2 }`. Content before the first
  heading is not listed. See [Heading anchors](#heading-anchors) for exactly what counts as one.
- **Plain text.** `title` and `heading` are the heading's plain text, not rendered markdown:
  emphasis and link markup are dropped, an image contributes nothing, and a `{{source:…}}` ref
  stays as its raw, unresolved token.
- **Ids are not unique.** Two headings can carry the same explicit anchor, or an anchor equal to
  another heading's slug, and an empty heading has an empty id. Key a list by position rather than
  by `sectionId`; an `{{include:doc#id}}` addresses the first section with that id.
- **Diagnostics.** `diagnostics` holds the parse's own, such as invalid frontmatter YAML.
- **Cost.** The summary comes from the engine's parse cache, like `getBlock`: a document the engine
  wrote or has already projected costs no parse, and any other is parsed once and cached.
- **Absent.** `docInfo` returns `undefined` for a missing document, an invalid id, a document over
  `maxDocumentBytes` or a complexity limit, and one whose parse (or the copy of it) threw, the
  same as `getBlock`.
  `getDoc` still returns the raw source of all but the first two.
- **A copy.** The result is a fresh copy, so changing it changes nothing the engine holds.

## Heading anchors

A heading that ends in `{#id}` takes `id` as its section id, which `{{include:doc#id}}` addresses;
any other heading's id is its slug. The anchor is part of the markup, not the text: the section's
heading text, `docInfo`, and the html projection all leave it out, and the html projector renders
it as the heading's `id` attribute (prefixed by the sanitizer, so `## Risk limits {#risk-limits}`
becomes `<h2 id="user-content-risk-limits">Risk limits</h2>`).

An id is `[A-Za-z0-9_-]+`, and it counts only when it is written literally at the very end of the
heading, in plain text:

- **Code is literal.** ``## Syntax `{#id}` `` has no anchor: its id is the slug `syntax-id`, and
  the code span renders as written. A code span is the way to end a heading with a literal
  `{#word}`.
- **Formatting splits it.** `## A {#_x_}` has no anchor, because `_x_` is emphasis. An id that
  begins and ends with `_` (or `*`) cannot be written; `_` inside an id, as in `{#a_b}`, is fine.
- **Escapes and character references are literal.** `## Esc \{#esc}` and `## Esc &#123;#esc}`
  have no anchor. An escaped backslash before it (`\\{#esc}`) leaves the anchor intact.
- An anchor inside emphasis (`## *Now {#now}*`) or after a link still counts.

`splitHeadingAnchor(text)`, exported from `@onioneko/boardkit-core`, is the string half of the
rule: it splits a trailing `{#id}` off a heading's plain text, in time linear in the text's length.
A projector that renders headings from its own markdown parse applies it to the heading's last
run of plain text, as the parser does.

## Projection middleware

Projection middleware wraps the PROJECT stage's projector call. It may amend the projector's
`options` before `next()`, or transform the `output` after `next()`. A middleware that throws
degrades the output the same way a throwing projector does (below): a `WriteRejection` attaches
its own diagnostics, and any other error attaches an `E_MIDDLEWARE_ERROR` diagnostic carrying
its message (fail-soft — the projection never throws because of a middleware). Per-reader redaction over the merged tree lives in projection middleware — see
[Middleware](middleware.md).

## Projector exceptions

A projector that throws degrades rather than propagating the error, so one bad projector never
breaks a whole projection pipeline. The result carries an `E_PROJECTOR_ERROR` diagnostic, and
its output is the projector's `degrade(src, diagnostics)` return value — or, for a projector
that declares no `degrade`, the raw source text.

Content never makes `projection()` throw: a throwing projector, projection middleware or block
hook degrades, and a document that cannot be parsed comes back `ok: false`. An error from the
storage port when reading the projected document itself (a file that is a directory, or a
symlink loop) is not content, and still rejects the call. The same error on an included document
leaves that include verbatim with an `E_INCLUDE_UNREADABLE` diagnostic, and on a document with a
scoped subscriber it never fails a write.

Raw source is the right fallback for `text`, whose output *is* markdown. It is the wrong one for
any projector whose output a host renders: raw markdown handed to an HTML sink is unsanitized
markup. Such a projector implements `degrade` to return something inert, as `htmlProjector`
does (the escaped source in a `<pre>`). `degrade` must not throw; if it does, the output is the
empty string `""` — whatever the projector's output type, even one that never returns strings —
and a second `E_PROJECTOR_ERROR` is reported.

A block hook that throws is narrower: the walk catches it and the block renders as its
verbatim source (the built-in projectors: raw markdown in `text`, escaped `<pre><code>` in
`html`) while the rest of the document renders normally. The walk hands the failure to the
projector as `hookError` on the block; the built-in projectors pass it to `input.report`, and
it appears in the result as `E_BLOCK_HOOK_ERROR`. A custom projector built on the walk does
the same to surface it.

Diagnostic messages can contain text from the document — a block hook's error message, for
example, often quotes the attrs it choked on — so a host that renders diagnostics as HTML must
escape them first.

## Write a custom projector

A projector that rewrites spans the way `text` and `html` do is built on
`walkProjectionParts` — the single traversal both built-ins run, and the supported way to reach
block hooks and include provenance without reimplementing the splice. The walk decides *what*
each byte of the document is — a run of prose, a resolved `{{source:…}}` reference, a typed
block with its hook already dispatched, or an expanded `{{include:…}}` — and your handlers
decide what each piece *becomes*.

```ts
import {
  createProjectionWalkCache,
  documentNode,
  walkProjectionParts,
  type ProjectionWalkHandlers,
} from "@onioneko/boardkit-core";
```

`walkProjectionParts<T>(walk, handlers): T[]` returns the pieces in document order, typed as
your projector's own piece type `T` — a react element, an mdast node, a JSON record, whatever
your output is built from. `walkProjection(walk, handlers): string` is the `T = string`
specialization that joins the pieces for you; it is what `text` (and `@onioneko/boardkit-html`) use.

Start from the node to walk — the merged tree's root when the engine's MERGE stage supplied one,
or a standalone document when it did not:

```ts
const node = input.merged?.root ?? documentNode(input.doc, input.src);
```

`MergedNode` already satisfies `ProjectionNode`, so the merged tree's root and its include
children are walked directly; `documentNode(doc, src)` builds the same shape for a document
projected on its own.

When you walk include children too, create one cache per projection call with
`createProjectionWalkCache()` and pass it as `cache` to every walk of that call. Work that covers
the whole document, such as the values record block hooks receive, is then done once per
document instead of once per included copy. Do not keep a cache across projection calls: it
assumes `values` and the block types do not change while it is in use.

```ts
const cache = createProjectionWalkCache();
const out = walkProjection({ node, values: input.values, projectorId: "md", cache }, handlers);
```

The four handlers below are required — there is no default for `onProse`, because there is no
generic identity from `string` to an arbitrary `T`; a projector says explicitly what an untouched
run of source becomes. A fifth, `onUnresolvedSource`, is optional (see
[Stale and unresolved references](#stale-and-unresolved-references)):

```ts
const handlers: ProjectionWalkHandlers<string> = {
  onProse: (prose) => prose,
  onSource: (value) => value,
  onBlock: ({ hooked, output, raw }) => (hooked && output !== undefined ? String(output) : raw),
  onInclude: (include) => `> ${include.node.heading ?? ""}`,
};
```

`onBlock` receives a `ProjectionWalkBlock` whose `hooked` and `output` fields together say what
happened to that block, in three distinguishable cases:

| `hooked` | `output` | meaning |
|---|---|---|
| `false` | `undefined` | the type is unregistered, or declares no hook for this projector id |
| `true` | the hook's return | the hook rendered something |
| `true` | `undefined` | the hook ran and returned nothing |

Both built-in projectors treat the first and third case the same way — render the block's
verbatim `raw` — but a projector that needs to tell "nobody rendered this" from "the hook opted
out" reads `hooked` directly instead of just checking whether `output` is `undefined`.

A ref that carries params (`{{source:spend period=month}}`) never reaches a block hook's own
`values` record — hooks look values up by source id alone, and a param-bearing ref has no
unambiguous id key. A custom projector reads it from `input.values` (or, inside a handler,
`ctx.values`) keyed by `canonicalKey(ref)`, exported alongside the walk toolkit:

```ts
import { canonicalKey } from "@onioneko/boardkit-core";

onSource: (value, ref, ctx) => ctx.values.get(canonicalKey(ref))?.value ?? value,
```

### Stale and unresolved references

By default a `{{source:…}}` reference whose value is stale, or that did not resolve at all, never
reaches `onSource`: its span stays verbatim, inside the surrounding `onProse` run, so a projector
cannot render fabricated data by accident. That is the right fallback for a projector that emits
a string. A projector that builds a live, structured view needs a keyed piece for every reference
instead, so that a later value update can fill it, and it must tell a stale reference from prose
that happens to read `{{source:x}}`. It supplies the optional fifth handler:

```ts
onUnresolvedSource: (ref, state, raw, ctx) =>
  ({ kind: "pending", source: ref.source, stale: state.stale, raw }),
```

- `state` is `{ stale: true, value }` when the resolution degraded, where `value` is the source's
  degradation marker (not real data), and `{ stale: false }` with no `value` when the projection
  holds no value for the reference.
- `raw` is the reference's verbatim source, `{{` to `}}`. Returning it reproduces what a walk
  without the handler emits.
- Param-bearing references reach it too, with `ref.params` set.
- The handler changes only what the span becomes. `ctx.hookValues`, the record block hooks
  receive, still leaves stale and missing values out, so a block hook renders its own fallback
  and never sees a placeholder.

### End to end: a `json` projector

[`examples/05-custom-projector.ts`](../../examples/05-custom-projector.ts) registers a `json`
projector: one record per block, reading each type's own `json` hook when it has one and falling
back to the block's attrs when it does not, plus one record per `{{source:…}}` reference, including
one with no value, through `onUnresolvedSource`. Prose and includes contribute nothing to the
assembled array, so those handlers return `undefined`. Run it with
`pnpm example 05-custom-projector.ts` (see [`examples/README.md`](../../examples/README.md)).

It also demonstrates why `textProjector` is exported from `@onioneko/boardkit-core`: passing `projectors`
to `createEngine` *replaces* the default set rather than adding to it, so a host that constructs
an engine with `projectors: [jsonProjector]` loses `text` entirely unless it lists
`textProjector` alongside it. `engine.registerProjector`, used here, has no such trap — it
appends to whatever is already registered (still just `text`, the engine's own default), which
is exactly why the example calls it instead of passing `projectors` at construction.

### Structured output from the html pipeline

A projector whose output is a component tree or a JSON view, but which wants the html projector's
markdown handling and sanitize policy, builds on `@onioneko/boardkit-html`'s two halves instead of
the walk alone. `projectHast(walk, handlers)` runs the walk and the markdown pipeline for one node
and returns unsanitized hast in which every reference, block and include is a hole the handlers
fill, so a paragraph that holds a reference stays one paragraph. `sanitizePanelHast(tree)` then
applies exactly the html projector's policy.
[`examples/06-structured-projector.ts`](../../examples/06-structured-projector.ts) builds a JSON
view this way. The html package's README lists the hole kinds and the handler contract.

## Next

- [Blocks](blocks.md) — how block `project` hooks render.
- [Intents](intents.md) — how the html projector turns affordances into `data-intent` payloads.
- [Middleware](middleware.md) — amend and transform projections.
- [Sources](sources.md) — how `{{source:…}}` and block-declared refs resolve to `input.values`.
