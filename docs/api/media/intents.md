# Intents

An **intent** is a consumer-produced request naming a document, a block, an affordance, and
its parameters, plus optional compare-and-set guards. It is the shape an html projection's
`data-intent` attributes encode, so a browser can post a button click back to the engine
unchanged.

```ts
import type { Intent } from "@onioneko/boardkit-core";

const intent: Intent = {
  docId: "fin",
  blockId: "dec-macbook",
  affordance: "transition",
  params: { to: "approved" },
  expectedVersion: "…", // optional, document version the projection was rendered against
  expected: { value: "pending" }, // optional, attribute values rendered against
  strictExpected: false, // optional, opt out of strict value-CAS for this intent
};
```

## The `data-intent` payload

When a block's `project.html` hook annotates an element with `data-intent`, the html projector
enriches it into the full payload:

```json
{
  "docId": "fin",
  "blockId": "dec-macbook",
  "affordance": "transition",
  "params": { "to": "approved" },
  "expectedVersion": "sha256-of-source",
  "expected": { "value": "pending" }
}
```

The hook writes only `affordance` and `params`; the projector adds `docId`, `blockId`,
`expectedVersion` (the version of the document the block came from), and `expected` (the
current values of the attributes the affordance's patch touches, in the delta's key order).
Unknown affordances, unparseable payloads, and throwing patches leave the attribute unchanged.

A projector or client that builds intents itself computes the same `expected` with
`intentExpected`:

```ts
import { intentExpected } from "@onioneko/boardkit-core";

const block = await engine.getBlock("fin", "dec-macbook");
if (block !== undefined) {
  const expected = intentExpected(statusType, "transition", block.attrs, { to: "approved" });
  // { value: "pending" }, or undefined for an unknown affordance or a patch that throws
}
```

## Applying an intent

`engine.applyIntent(intent, { writer })` decodes the affordance through the block type and
hands the resulting attribute delta to the patch pipeline:

```ts
const result = await engine.applyIntent(
  {
    docId: "fin",
    blockId: "dec-macbook",
    affordance: "transition",
    params: { to: "approved" },
  },
  { writer },
);
console.log(result.ok); // true on success; result.events holds the emitted events
```

Along the way it validates the params against the affordance's declared schema and runs the
same commit pipeline as a full-text write or a patch, so every route emits the same events.
The default route is thin by design: writer identity, authentication, and write policy are the
host's job before calling it.

## Decoding happens inside the write lock

The route does not precompute a delta. It hands the patch pipeline the affordance's `patch`
function, which the pipeline calls **inside the write lock** against the block's
freshly-committed attrs (and the params as the write middleware chain left them). Two intents
that touch different parts of the same block therefore commute: each decodes against what the
other already committed, so neither loses the other's change.

That in-lock decode is also what write middleware sees — an intent-originated patch proposal
carries `affordance` and `params`, both amendable and re-validated before the delta is decoded.
See [Middleware](middleware.md).

## Compare-and-set and value-CAS rebase

The intent's `expectedVersion` and `expected` carry through as patch guards:

0. `expected` is given and disagrees with the block's current values → reject with
   `expected-mismatch`, whatever `expectedVersion` says (**strict value-CAS**, see below).
1. No `expectedVersion` → apply.
2. `expectedVersion` matches the current document version → apply.
3. The version moved (a concurrent edit), but every `expected` attribute still matches the
   block's current values → **rebased**: apply and mark `result.rebased` as `true`.
4. Otherwise → reject (`stale-version` when no `expected` was given, `expected-mismatch` when
   it was).

Rebasing means a button clicked against a slightly-stale projection still succeeds when the
fields the affordance actually touches are unchanged.

The comparison is scoped to the decoded delta, not to the whole block. Because the delta is
recomputed inside the lock, only the parts it actually rewrites need to match the client's
`expected`: an array attribute is compared **per element, at the indices the delta changes**,
and every other attribute is compared as a whole value. Ticking checklist item `c` while someone
else ticked item `a` rebases and applies; two writers ticking item `c` reject with
`expected-mismatch`. An `expected` that is missing a key the delta changes counts as a mismatch
— the client's view of that key cannot be verified.

### Strict value-CAS

Rule 0 is on by default. A client can hold a version and values from different snapshots: a
view that applies value deltas without a re-render, or a payload a client forged. Without rule
0, a current `expectedVersion` would apply the write without looking at `expected`, so the
client would overwrite values it never saw. With it, the engine refuses the write, inside the
write lock, and returns the current attrs as `rejection.current`.

To get the 0.1 behaviour back, where `expected` is only consulted once the version has moved,
set `strictExpected: false`:

- on one intent (`Intent.strictExpected`) or one patch (`engine.patch(…, { strictExpected })`);
- for the whole engine (`createEngine({ strictExpected: false })`); a call's own value wins.

`engine.patch` with a concrete `attrs` delta uses the same rules, comparing every key of
`expected` whole.

## Next

- [Blocks](blocks.md) — how `affordances` are declared.
- [Projections](projections.md) — how `data-intent` attributes are produced.
- [Events](events.md) — the event stream intents emit.
