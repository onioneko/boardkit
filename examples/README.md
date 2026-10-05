# BoardKit examples

Runnable, CI-checked versions of the README's Quick start. Most of them open
the same shared document, `fin.md`, sitting beside these scripts.

- `01-hello.ts` — the whole lifecycle: create a document, project it, watch
  its events, write through an affordance intent, and read the changed
  markdown back.
- `02-watch.ts` — edit `fin.md` yourself and watch the projection follow
  (interactive; not run by CI — see below). Its workspace lives in
  `examples/.workspace/`, seeded from `fin.md` on first run; running it again
  reopens that workspace and continues the same event log.
- `03-agent.ts` — an automated writer: `subscribe` to perceive, `applyIntent`
  to act.
- `04-custom-block.ts` — a newcomer defines a block end to end: typed attrs, a
  schema, one affordance, one transition, and a text projection.
- `05-custom-projector.ts` — a custom `json` projector built on the public
  `walkProjectionParts` walk, consulting each block's own hook and falling
  back to its attrs, and keying a ref with no value through
  `onUnresolvedSource`.
- `06-structured-projector.ts` — a projector whose output is a JSON view,
  built on `@onioneko/boardkit-html`'s `projectHast` (hast with holes for refs,
  blocks and includes) and `sanitizePanelHast` (the html projector's exact
  sanitize pass).

## Run

```bash
pnpm install && pnpm build && pnpm example 01-hello.ts
```

(`pnpm build` first — these resolve `@onioneko/boardkit-core`, `@onioneko/boardkit-blocks`
and `@onioneko/boardkit-html` through their built `dist/`, like any real consumer.)

## The `// Output:` convention

CI runs every example with a `// Output:` block and diffs its stdout against
it, byte-for-byte. An example without one — `02-watch.ts`, whose output
depends on what you type and when — is typechecked only. The same rule as
Go's testable examples.
