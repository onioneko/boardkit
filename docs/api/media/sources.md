# Sources

A **live value** is data injected at projection time and never persisted: the document's bytes
name what they want (a source id, optionally with params); the `Source` port answers what it
currently is. Two things in a document can want one: ordinary prose, with `{{source:…}}`, and a
block, through its type's `sources` hook. Both resolve through the same port, in the same batched
pass, and both degrade the same way when a value is missing or stale.

## The `Source` port

```ts
import type { Source } from "@onioneko/boardkit-core";

const source: Source = {
  async resolve(ref) {
    if (ref.source === "bank_balance") return "¥23,450";
    return { value: "n/a", stale: true };
  },
};
```

`resolve` is called once per distinct reference (deduplicated by canonical key, see below) and
may return a plain string, or `{ value, stale? }` to degrade explicitly without throwing. A
`Source` is **call-scoped**, not fixed at engine construction: it is passed to
`engine.projection(docId, projectorId, { source })` on every call, so two readers — or the same
reader at two different times — can resolve the same document's refs against different data (a
live balance now, a cached one during an outage, a redacted one for a guest).

## Two ways to declare a reference

**Prose** names a reference inline, for a live value embedded in text a human is reading:

```markdown
Cash on hand: {{source:bank_balance}}
```

**A block** declares the references *it* depends on through `BlockType.sources`, derived from
its own attrs — no `{{source:…}}` appears anywhere in its fence:

````markdown
```metric
id: burn
label: Monthly burn
source: monthly_burn
```
````

This is the distinction to reach for: prose is right when the live value is one detail inside a
sentence or a paragraph; a block's own `sources` is right when the value *is* the block — a
`metric` (or a `chart` whose spec names a `source`) has no other content to attach a
`{{source:…}}` to, and gluing one into the prose beside it would just be a second, easier-to-drift
place to name the same reference. See [Blocks](blocks.md#live-values-sources-and-the-values-record)
for the `sources` hook itself, on the `metric` starter block.

Whichever way a reference is declared, the engine collects prose refs and every registered
block's declared refs together and resolves the whole set once, at RESOLVE, in one
dedup-batched pass — a block renders its value even when no prose ref names the same source, and
a prose ref and a block that happen to want the same source id only resolve it once.

## Canonical keys

A reference's **canonical key** is what every resolved value is stored under, deduplicated
against: the source id, `?`, then any params as `k=v` pairs joined by `&`, in sorted key order.

```ts
import { canonicalKey } from "@onioneko/boardkit-core";

canonicalKey({ kind: "source", source: "bank_balance", params: {} });
// "bank_balance?"
canonicalKey({ kind: "source", source: "spend", params: { period: "month" } });
// "spend?period=month"
```

`ProjectionInput.values` (and, inside a custom projector's walk, `ProjectionWalkContext.values`)
is a `ReadonlyMap<string, SourceValue>` keyed exactly this way — every resolved reference for the
projection, param-bearing ones included. `canonicalKey` is exported from `@onioneko/boardkit-core`
alongside the projection walk toolkit for that reason: it is how a custom projector or a
projection middleware looks one up. See [Projections](projections.md#write-a-custom-projector).

## Param-bearing refs

A reference can carry named parameters: `{{source:spend period=month}}` parses to `{ kind:
"source", source: "spend", params: { period: "month" } }`, and a block's `sources` hook can
return the same shape. Params are resolved exactly like any other reference — but because two
refs sharing a source id and differing only in params (`period=month` vs. `period=year`) have no
single unambiguous "the value for `spend`", a param-bearing ref is **never** placed in a block
hook's `values` record, which is keyed by source id alone. It reaches a projector two other ways
instead: a prose span rewrite still substitutes it directly (the span itself carries the params),
and a custom projector or projection middleware reads it from `input.values` / `ctx.values` by
canonical key.

## Staleness: fail-soft, never fabricated

A resolution is stale when `Source.resolve` says so explicitly (`{ value, stale: true }`) or
throws — a throw is caught and normalized to `{ value: "", stale: true }`, never propagated. A
stale (or entirely unresolved — the id wasn't recognized, `resolve` returned nothing usable)
value is never substituted:

- in prose, the `{{source:…}}` span stays verbatim rather than showing a placeholder or an empty
  string — see [Source-faithful span rewriting](projections.md#source-faithful-span-rewriting);
- in a block hook's `values` record, the source id's key is simply absent, which is exactly what
  lets the hook render its own fallback (the `metric` block, for one, falls back to printing the
  source id itself: `values[attrs.source] ?? attrs.source`).

Either way, a bad or slow live-value lookup degrades one reference locally — it never fails the
whole projection.

## Next

- [Blocks](blocks.md) — the `sources` hook and the `values` record a `project` hook receives.
- [Projections](projections.md) — `input.values`, canonical keys, and writing a custom projector.
- [Storage and watch](storage-and-watch.md) — durable workspaces, separate from live values.
