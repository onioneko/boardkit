# @onioneko/boardkit-blocks

BoardKit's reference block pack: six stateful document
components you register yourself, like any block type — pass `starterBlocks`
via `createEngine({ blocks })`, or add individual types with
`engine.registerBlock`. Nothing registers by default; hosts may trim or
replace this pack wholesale — it is not part of the core API.

```ts
import { createEngine } from "@onioneko/boardkit-core";
import { starterBlocks } from "@onioneko/boardkit-blocks";

const engine = createEngine({
  storage,
  blocks: starterBlocks,
});
```

## Blocks

| Block | State (attrs) | Transition events | Affordances | text projection | html projection |
|---|---|---|---|---|---|
| `checklist` | `items[{id,label,done}]` | `checklist.item.done` / `.undone` | `toggle(itemId)` | `- [ ]` / `- [x]` list | interactive checkboxes (`data-intent`) |
| `status` | `states[]` (ordered), `value`, `note` | `status.changed` | `transition(to)` | `**STATUS**: pending` | badge + transition buttons (`data-intent`); current value in `data-state` |
| `metric` | `label`, `source`, `view`, `thresholds?` | — | — | `label: value` (live via source id) | labeled value |
| `chart` | `type`, `source`, `spec` (opaque chart-source DSL) | — | — | spec verbatim (machine-readable) | `<pre>` fallback |
| `form` | `fields[{id,label,type,options?}]`, `status`, `answer?` | `form.answered` | `answer(values)` | question text + options | form fields |
| `rule` | `when`, `do` (opaque strings), `enabled` | `rule.enabled` | `toggle()` | rule text with state | switch (`data-intent`) |

## Notes and deviations

1. **The `checklist` item transition is directional.** `items[].done` emits
   `checklist.item.done` on `false→true` and `checklist.item.undone` on
   `true→false`; both events also carry the `from`/`to` booleans.
2. **`chart` renders as `<pre>` in html.** The library does not know chart
   libraries; hosts register their own block type (or renderer) to replace the
   fallback. The text projection always emits the spec verbatim.
3. **Schemas are plain JSON Schema literals** (no @sinclair/typebox in this
   package) — one artifact, zero codegen, contributor-friendly.
4. Interactive html hooks annotate elements with `data-intent` payloads; the
   html projection's sanitize schema allows `className`, `id`, `data-intent`,
   `data-source` and `data-state`. View adapters translate those annotations
   into Intents. The blocks in this pack never put attr values into
   `className`: the `status` block renders `<div class="status" data-state="…">`,
   so style a state with `.status[data-state="approved"]`.

## License

[MIT](https://github.com/onioneko/boardkit/blob/main/packages/blocks/LICENSE)
