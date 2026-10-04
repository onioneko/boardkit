## What and why

<!-- What changed, why, and the issue it closes (for example "Closes #123"). List anything you could not verify. -->

## Checklist

- [ ] The gate passes: `pnpm build && pnpm typecheck && pnpm test`
- [ ] `pnpm lint` (biome) reports nothing in the changed files
- [ ] New behavior has tests, written test-first
- [ ] Public API changes carry JSDoc, and the guides in `docs/` are updated where they describe the change
- [ ] A changeset is added if a published package changed (`pnpm changeset`)
