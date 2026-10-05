# Releasing

This file is for maintainers. Contributors do not publish anything: see [Releasing in CONTRIBUTING.md](CONTRIBUTING.md#releasing) for how a change reaches npm.

Releases are published by the release workflow (`.github/workflows/release.yml`) through npm trusted publishing: the workflow authenticates to npm with a short-lived GitHub OIDC token, and npm attaches a provenance attestation to every version published by the workflow. No npm token is stored in the repository.

The three packages are versioned in lockstep: `.changeset/config.json` puts them in one `fixed` group, so every release gives all three the same version. Two more settings keep a core minor from pushing html and blocks to `1.0.0`: the upper bound `<1.0.0` of the html and blocks peer range on core, and `.changeset/config.json` sets `onlyUpdatePeerDependentsWhenOutOfRange` under `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH`. That option is experimental and may change even in a Changesets patch release. After any upgrade of `@changesets/cli` or `changesets/action`, check the result in a scratch copy of the repository before merging the upgrade. Add a changeset `"@onioneko/boardkit-core": minor`, run `pnpm exec changeset version`, and confirm that all three packages move to the same next minor version and none to `1.0.0`. Then discard the copy.

The lower bound of each peer range tracks the oldest core whose API that package imports: html's is `>=0.3.0` (it imports `splitHeadingAnchor`), blocks' is `>=0.1.0` (it imports only types that 0.1.0 has). Raise it in the same change that starts using a newer core export. When the lower bound is above the core version in the repository, which happens between merging such a change and merging the version pull request, every Changesets run warns that `@onioneko/boardkit-html` "must depend on the current version of `@onioneko/boardkit-core`". That warning is expected and harmless: `changeset version` still moves all three packages to the same next version.

The steps below are a one-time bootstrap. After them, every release goes through the version pull request.

## 1. Publish each package once by hand

A trusted publisher is configured in a package's settings on npmjs.com, so each package must exist before the workflow can publish it.

The release workflow runs on the first push to `main` and fails at publishing until steps 1 to 3 are done. That is expected. Re-run it afterwards: it should report no unpublished packages.

1. Sign in to an npm account that can publish to the `@onioneko` scope, with two-factor authentication enabled.
2. Start from a clean checkout of `main` and run the full gate:

   ```bash
   git clone https://github.com/onioneko/boardkit.git
   cd boardkit
   corepack enable
   pnpm install --frozen-lockfile
   pnpm build
   pnpm typecheck
   pnpm test
   ```

3. Log in to npm:

   ```bash
   npm login
   ```

4. Publish the packages one at a time, core first:

   ```bash
   (cd packages/core && pnpm publish --access public)
   (cd packages/html && pnpm publish --access public)
   (cd packages/blocks && pnpm publish --access public)
   ```

   - Use `pnpm publish`, not `npm publish`: pnpm replaces the `workspace:` and `catalog:` ranges with real version ranges, which `npm publish` would ship unchanged.
   - npm asks for a one-time password for each package.
   - Provenance can only be generated on a CI provider, so these first versions have none. Every later version, published by the workflow through trusted publishing, has a provenance attestation automatically.

5. Tag the published versions, as the workflow would have done:

   ```bash
   pnpm exec changeset tag
   git push --follow-tags
   ```

   `changeset tag` creates an annotated `@onioneko/boardkit-<name>@<version>` tag for each package. Optionally, create a GitHub release for each tag by hand.

## 2. Configure the trusted publisher

For each of `@onioneko/boardkit-core`, `@onioneko/boardkit-html` and `@onioneko/boardkit-blocks`:

1. On npmjs.com, open the package's **Settings**.
2. In **Trusted Publisher**, choose **GitHub Actions** and enter:
   - **Organization or user:** `onioneko`
   - **Repository:** `boardkit`
   - **Workflow filename:** `release.yml` (the file name only, not its path)
   - **Environment name:** leave empty
   - **Allowed actions:** tick **Allow npm publish**. The release workflow publishes directly with `npm publish` (through `changeset publish`); a configuration that only allows `npm stage publish`, the default for new configurations, would refuse it. Leave **Allow npm dist-tag** unticked.
3. Save.

The same configuration can be created from the command line with npm 11.15.0 or later, once the package exists and with two-factor authentication enabled on the account:

```bash
npm trust github @onioneko/boardkit-core --repo onioneko/boardkit --file release.yml --allow-publish
npm trust github @onioneko/boardkit-html --repo onioneko/boardkit --file release.yml --allow-publish
npm trust github @onioneko/boardkit-blocks --repo onioneko/boardkit --file release.yml --allow-publish
```

## 3. Restrict publishing to the trusted publisher

For each package:

1. In the package's **Settings**, open **Publishing access**.
2. Select **Require two-factor authentication and disallow tokens** and click **Update Package Settings**.

Publishing with an npm token is then refused, whatever the token's settings. The trusted publisher keeps working, and a maintainer with two-factor authentication can still publish interactively from their own machine if ever needed. Revoke any npm token created for this repository, and do not add an `NPM_TOKEN` secret.

## 4. Configure the GitHub repository

All of these are under the repository's **Settings**.

1. **Let the workflow open the version pull request.** In **Actions > General**, under **Workflow permissions**, enable **Allow GitHub Actions to create and approve pull requests**. Without it, the release workflow cannot open the version pull request.
2. **Private vulnerability reporting.** In **Advanced Security** (under **Security and quality** in the sidebar), enable **Private vulnerability reporting**. [SECURITY.md](SECURITY.md) and the issue template configuration send reporters there.
3. **Secret scanning and push protection.** On the same page, enable **Secret Protection**, then enable **Push protection** inside it.
4. **A ruleset on `main`.** In **Rules > Rulesets**, choose **New ruleset > New branch ruleset** and set:
   - **Enforcement status:** Active
   - **Target branches:** include the default branch
   - **Restrict deletions** and **Block force pushes**
   - **Require a pull request before merging**
   - **Require status checks to pass**, with both CI checks: `lint + typecheck + build + test (node 22)` and `lint + typecheck + build + test (node 24)`

## Every release after that

1. Merged pull requests carry changesets. On each push to `main`, the release workflow runs the checks and opens or updates the **Version Packages** pull request.
2. That pull request is opened and updated with the workflow's own token, so GitHub creates its CI runs in an approval-required state: open the pull request's checks, choose **Approve workflows to run**, and wait for CI to pass. Passing a GitHub App installation token to the changesets action as `github-token` would start CI automatically, at the cost of storing the app's credentials in the repository; this setup does not do that.
3. Review the version pull request: all three packages should move to the same new version, and none should jump to `1.0.0` unless a changeset asked for a major bump.
4. Merge the pull request. The workflow runs the checks again, publishes every package whose version is not on npm yet, and creates the git tags and GitHub releases.
5. Check the run's log for `No NPM_TOKEN found, but OIDC is available - using npm trusted publishing`, and check that each new version shows a provenance attestation on npmjs.com.
