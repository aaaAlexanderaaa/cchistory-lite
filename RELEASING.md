# Releasing CC History Lite

Releases of [`@cchistory/lite`](https://www.npmjs.com/package/@cchistory/lite) are cut by the
**Release** GitHub Actions workflow, triggered manually (`workflow_dispatch`). Local publishes
are for emergencies only — see the last section.

## Prerequisites (one-time setup)

- **`NPM_TOKEN` repository secret.** Create an npm granular access token with publish rights on
  `@cchistory/lite`, then add it under the repo's Settings → Secrets and variables → Actions.
- **Provenance requires CI.** Publishing uses `npm publish --provenance`, which only works from
  GitHub Actions (the workflow requests `id-token: write`). A local publish cannot produce
  provenance.
- **Branch protection caveat.** The finalize step pushes the release commit and tag to `main`
  using the workflow's `GITHUB_TOKEN`. If `main` is protected, allow pushes from GitHub Actions
  (or add an exception), otherwise the publish succeeds but the commit/tag push fails.

## Cutting a release

1. Land all changes on `main` with green CI.
2. Make sure `CHANGELOG.md`'s `## [Unreleased]` section covers everything shipping. An empty
   `[Unreleased]` fails the release.
3. Go to **Actions → Release → Run workflow**, enter the version (e.g. `0.4.3`).
4. Optionally run once with `dry_run: true` to exercise every gate plus `npm publish --dry-run`
   without publishing, tagging, or pushing.
5. Run for real. Afterwards verify:
   - the [npm package page](https://www.npmjs.com/package/@cchistory/lite) shows the new version
     and the provenance badge;
   - `git fetch --tags` shows `v<version>` and the `chore: release <version>` commit on `main`;
   - the GitHub Release exists with `cchistory-lite-<version>.tgz` attached.

## What the workflow does

1. Prints the plan (version, dry_run) for the run log.
2. Checks out `main` with full history, sets up pnpm and Node 22 with the npm registry
   configured, and runs `pnpm install --frozen-lockfile`.
3. Runs `node scripts/release-prepare.mjs <version>`, which validates the release (strict semver,
   strictly greater than the current version, no existing `v<version>` tag, non-empty
   `[Unreleased]`, package versions and baked CLI/TUI VERSION literals agree), then rewrites the
   `version` field in all 7 package.json files, the baked VERSION literals, and folds the
   changelog.
4. Runs the four gates in order: `pnpm run build:lite`, `pnpm test`,
   `pnpm run verify:governance`, `pnpm run verify:lite-artifact -- --skip-build`.
5. Builds the publishable closure via `pnpm run lite:artifact -- --skip-build`, producing
   `dist/lite-artifacts/cchistory-lite-<version>/` and its `.tgz`.
6. Publishes: `npm publish --provenance --access public` (or `--dry-run` when `dry_run` is set).
7. On a real run only: commits the version bump (package manifests and baked VERSION
   literals) and changelog fold as `chore: release <version>` (as `github-actions[bot]`),
   tags `v<version>`, pushes `main` and the tag, and creates a GitHub Release with the
   tarball attached and generated notes.

## Versioning policy

- All 7 package.json files (root, both apps, all four packages) share one version and move
  together. The CLI and TUI also bake that version as a source literal (the standalone artifact
  has no `package.json` beside the entrypoint). `release-prepare.mjs` refuses to run when any of
  them disagree, and rewrites both the manifests and the literals.
- Strict semver `X.Y.Z` (optional `-prerelease.N` suffix), always strictly greater than the
  current version. A version can only be released once — the tag check enforces it.
- **Patch**: bug fixes, adapter robustness, rendering tweaks, docs. **Minor**: new commands, new
  adapters, new JSON fields, behavior changes that stay backward compatible. Reserve **major**
  for breaking contract changes (e.g. the `cchistory-lite/v1` → `v2` JSON break).

## Changelog discipline

- Accumulate user-visible changes under `## [Unreleased]` as they land (Keep a Changelog
  format).
- The workflow folds `[Unreleased]` into `## [<version>] - <date>` and inserts a fresh empty
  `[Unreleased]` above it. Nothing else in the changelog is touched.
- An `[Unreleased]` section with no content lines fails the release — that is intentional, so a
  release can never ship with an empty changelog entry.

## Local rehearsal

None of these publish, tag, or push:

```bash
pnpm run release:prepare -- 0.4.3 --check-only   # validate the plan against the real repo
pnpm run lite:artifact                            # build the exact publishable closure
```

Then dispatch the workflow with `dry_run: true` for an end-to-end rehearsal in CI.

## Emergency local publish (avoid if at all possible)

If GitHub Actions is unavailable and a fix must ship:

```bash
pnpm run build:lite
pnpm test
pnpm run verify:governance
pnpm run verify:lite-artifact
pnpm run lite:artifact
cd dist/lite-artifacts/cchistory-lite-X.Y.Z
npm publish --access public   # uses a local, untracked .npmrc with an npm token
```

A local `.npmrc` holding the token stays untracked (it is gitignored). This path produces **no
provenance**, and afterwards you must manually do what the workflow would have done:
`pnpm run release:prepare -- X.Y.Z` (version bump + changelog fold), commit, `git tag vX.Y.Z`,
push, and create the GitHub Release. Prefer waiting for Actions.
