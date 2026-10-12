---
"@onioneko/boardkit-core": minor
---

A patch refusal that leaves the document and the event log untouched:

- `engine.applyIntent` now refuses an intent whose decoded delta changes no value (the affordance's `patch` returned `{}`, or only values the block already has) with the new reason `no-change` and diagnostic `E_INTENT_NO_CHANGE`, with the block's current attrs as `rejection.current`. Before, such an intent committed, emitted `doc.updated` and returned `ok: true`. The rule runs after params validation and the compare-and-set check, so invalid params are still refused as `validation` and a lost compare-and-set is still `expected-mismatch`. Hosts that treat any refusal as an error should handle `no-change` as "nothing to do". `engine.patch` is unchanged: a direct patch that changes nothing still commits.
- An affordance `patch` that mutates the attrs it is given no longer loses its change: the function now gets its own copy of the current attrs.
