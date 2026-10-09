# Middleware

Middleware adds behavior along the two pipelines without bypassing stages. Both chains use
Koa-style `(ctx, next)` composition: code before `await next()` runs on the way in, code after
on the way out. Middleware may amend, reject, observe, and transform — but it cannot skip
pipeline stages, by design.

## Write middleware

A write middleware wraps the whole commit pipeline (`VALIDATE → LOCK → COMMIT → DIFF →
EMIT`). Its context exposes the write's author, mode, and a mutable `proposed` payload, plus
the `result` once the pipeline has run:

```ts
import { WriteRejection, type WriteMiddleware } from "@onioneko/boardkit-core";

const rejectRobots: WriteMiddleware = async (ctx, next) => {
  if (ctx.writer.id === "robot") {
    throw new WriteRejection("robots are read-only", [
      { code: "E_ROBOT", message: "writer robot is not allowed to write" },
    ]);
  }
  await next();
};
```

- **amend** — mutate `ctx.proposed` before `await next()`. The proposal is discriminated by
  `ctx.mode`: a full-text write is `{ fullText }`, a patch is `{ blockId, delta, affordance?,
  params? }`, a create is `{ content }` (the initial source text), an import is `{ content }`
  (the bytes `engine.importDoc` stores; read it, but an amended import is rejected with
  `import-amended`), and a remove is `{}` (a removal has nothing to amend — the target is
  `ctx.docId`).
- **reject** — throw `WriteRejection` before `await next()`; the write fails with
  `{ ok: false, rejection: { reason, diagnostics } }`.
- **observe** — read `ctx.result` after `await next()`.

There is no hook between LOCK and COMMIT: middleware wraps the whole pipeline, not a stage
inside it.

## Reading the proposed text's structure

A middleware that needs to know what a full-text write or a create would store (which blocks
it has, of which types, under which headings) parses the proposed text with `ctx.parse(src)`
rather than calling a parser itself:

```ts
import { WriteRejection, type WriteMiddleware } from "@onioneko/boardkit-core";

// Refuse a full-text write that would leave a document with more than 50 blocks.
const capBlocks: WriteMiddleware = async (ctx, next) => {
  if (ctx.mode === "full" && "fullText" in ctx.proposed) {
    const r = ctx.parse(ctx.proposed.fullText);
    if (!r.ok) throw new WriteRejection(r.rejection.reason, r.rejection.diagnostics);
    const blocks = r.parsed.nodes.filter((n) => "blockId" in n).length;
    if (blocks > 50) {
      throw new WriteRejection("too many blocks", [
        { code: "E_TOO_MANY_BLOCKS", message: `${blocks} blocks; at most 50 are allowed` },
      ]);
    }
  }
  await next();
};
```

`ctx.parse` returns a `WriteParseResult`:

- `{ ok: true, parsed }`: the `ParsedDoc` the commit pipeline makes of that text. It may be the
  engine's cached parse, shared with every reader: its block attrs are frozen, and it must not
  be modified.
- `{ ok: false, rejection: { reason, diagnostics } }`: the rejection a write of that text would
  get. The size limit (`too-large`) and the complexity limits (`too-complex`) are checked before
  anything is parsed; a parser that throws gives `validation` with `E_PARSE_FAILED`. Throw it
  as a `WriteRejection`, as above, or call `next()` and let the pipeline reject the write the
  same way.

The parse goes through the engine's content-keyed parse cache, and the pipeline reuses a parse
of the exact text it validates. A middleware that parses `proposed.fullText` (or a create's
`proposed.content`) therefore costs the write no second parse, and parsing the same text again,
in the same or another middleware, costs nothing more. If a middleware amends the proposal
after parsing it, the pipeline parses the amended text itself. `ctx.parse` works in every write
mode, but only a full-text write and a create reuse its parse: a patch computes its new text
inside the pipeline.

## What a patch proposal looks like

A patch's `delta` comes in two forms. `engine.patch` hands middleware a **concrete record** —
the attrs delta exactly as the caller wrote it. An intent hands it a **function**
(`PatchDeltaFn`: `(currentAttrs, params?) => Record<string, unknown>`), decoded inside the
write lock against the block's freshly-read attrs, so no writer ever applies a delta computed
from a stale read.

An intent-originated proposal also carries its origin — `affordance` (the name) and `params`
(the intent's params) — so a policy can decide on *what the write means* rather than on an
opaque function. Both fields are mutable, and the pipeline re-checks them inside the lock: it
looks the (possibly amended) affordance up on the block type — an unknown name rejects with
`E_UNKNOWN_AFFORDANCE` — and validates the proposal's params against that affordance's schema,
a mismatch rejecting at stage `validation` with `E_PARAM_SCHEMA`, before decoding the delta
with them.

Amending `params` is the supported amendment: the delta is decoded with the params middleware
left behind. Amending `affordance` only re-targets that validation lookup — the delta function
stays the one the route built from the *original* affordance, so renaming the affordance does
not redirect the write, it only validates the params against a different schema.

A writer's `kind` is `human` (a person acting through an editor, browser, or CLI), `agent`
(an autonomous or LLM-driven agent), or `program` (a script, job, or service) — provenance
labels the pipeline treats identically, which is exactly what makes them useful to branch on
here. The middleware below rejects every non-human kind for that `executed` transition: both
`agent` and `program` writers fail its `ctx.writer.kind !== "human"` test.

```ts
import { WriteRejection, type WriteMiddleware } from "@onioneko/boardkit-core";

// Only a human may push a status block to `executed`.
const humansExecute: WriteMiddleware = async (ctx, next) => {
  const proposed = ctx.proposed;
  if (
    ctx.mode === "patch" &&
    "affordance" in proposed &&
    proposed.affordance === "transition" &&
    (proposed.params as { to?: string } | undefined)?.to === "executed" &&
    ctx.writer.kind !== "human"
  ) {
    throw new WriteRejection("only a human may execute", [
      { code: "E_NOT_HUMAN", message: `writer ${ctx.writer.id} may not transition to executed` },
    ]);
  }
  await next();
};
```

## Projection middleware

A projection middleware wraps the PROJECT stage's projector call. Its context exposes the
read-only `merged` tree and resolved `values`, a mutable `options` (the projector's options)
before the call, and a mutable `output` after it:

```ts
import { type ProjectionMiddleware } from "@onioneko/boardkit-core";

const addStamp: ProjectionMiddleware = async (ctx, next) => {
  ctx.options["stamp"] = "v1"; // amend options before the projector runs
  await next();
  ctx.output = `${String(ctx.output)}\n<!-- rendered -->`; // transform output after
};
```

A projection middleware that throws rejects the projection: the output degrades to the
projector's `degrade` output (the raw source for a projector that declares none; the escaped
source for `html`). A `WriteRejection` attaches its own diagnostics; any other error, thrown
before or after `next()`, attaches an `E_MIDDLEWARE_ERROR` diagnostic carrying its message, so
one broken plugin never takes a whole view down. `projection()` does not reject either way.

Output a middleware writes after `next()` is not checked by anything: for the `html`
projector it replaces sanitized HTML, and the host code that writes it is responsible for its
safety.

## Per-reader redaction

Redaction is a reader concern, not a document concern, so it belongs in projection middleware
over the merged tree. To hide a document's content from one reader, prune its include edges by
provenance before `next()` — the pruned span stays verbatim. To hide even the reference itself,
rewrite `ctx.output` after `next()`.

```ts
import { type DocId, type MergedNode, type ProjectionMiddleware } from "@onioneko/boardkit-core";

const prune = (node: MergedNode, allowed: ReadonlySet<DocId>): MergedNode => ({
  ...node,
  includes: node.includes
    .filter((inc) => allowed.has(inc.node.provenance.docId))
    .map((inc) => ({ span: inc.span, node: prune(inc.node, allowed) })),
});

const redact: ProjectionMiddleware = async (ctx, next) => {
  ctx.options["merged"] = { root: prune(ctx.merged.root, allowedFor(ctx)) };
  await next();
  ctx.output = String(ctx.output).replace(/\{\{include:[^}]*\}\}/g, ""); // hide the reference too
};
```

`allowedFor(ctx)` is your per-reader policy: it returns the set of `DocId`s the reader may see.
Register it with `createEngine({ middleware: { projection: [redact] } })`.

## Registering middleware

Provide chains at construction, or append them at runtime with `engine.use`:

```ts
import { createEngine, createMemStorage } from "@onioneko/boardkit-core";

const engine = createEngine({
  storage: createMemStorage(),
  middleware: {
    write: [rejectRobots],
    projection: [addStamp],
  },
});

// Runtime registration appends to the end of each chain:
engine.use({ write: someOtherMiddleware });
```

## Ordering

Middleware runs in array order, Koa-style: the first registered is the outermost. Middleware
passed to `createEngine` runs before middleware added later with `engine.use`, so
construction-time middleware wraps runtime middleware.

## Next

- [Blocks](blocks.md) — the block model middleware observes and amends.
- [Projections](projections.md) — the read path projection middleware wraps.
- [Events](events.md) — observing writes via their events.
