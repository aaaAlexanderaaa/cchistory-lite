# npm package for CC History Lite

Date: 2026-08-29
Status: approved for planning
Product version of this change: 0.4.2

## Goal

Publish one public npm package, `@cchistory/lite`, so a user with Node.js >= 22 can run:

```bash
npx @cchistory/lite --help
npx @cchistory/lite search "retry backoff" --source codex --limit 3
npm install -g @cchistory/lite
cchistory-lite sources
```

The repository stays a private pnpm workspace. The published unit is the existing standalone release closure, not the six workspace packages.

## Non-goals

- Do not publish `@cchistory/domain`, `@cchistory/canonical`, `@cchistory/source-adapters`, `@cchistory/live-runtime`, `@cchistory/lite-cli`, or `@cchistory/lite-tui`.
- Do not change CLI or TUI history semantics, commands, JSON contracts, or adapter behavior.
- Do not add `sample` to the TUI, `query`, or `shell`.
- Do not add a persistent store or any mutation command.
- Do not `npm publish` from the repository root (`private: true` stays).
- Do not add CI-triggered npm publish in this change. The first publish is manual after the `@cchistory` org exists.

## User-facing contract

| Action | Result |
| --- | --- |
| `npx @cchistory/lite …` | npm runs the `lite` bin, which is the same CLI as `cchistory-lite` |
| `npm install -g @cchistory/lite` | PATH gains `cchistory-lite`, `cchistory-lite-tui`, and `lite` |
| `cchistory-lite tui` | Spawns the sibling TUI from the same package (existing PATH prepend) |

`lite` is a short alias required by `npx @scope/name` (npm looks for a bin named `lite`). After a global install it is also on PATH and may collide with unrelated `lite` tools. That is accepted. Docs lead with `cchistory-lite`.

The extract-and-run tarball produced by `pnpm run lite:artifact` remains. It is the same closure, now named and shaped so `npm publish` of that directory is valid.

## Published package shape

The artifact `package.json` (written by `scripts/build-lite-artifact.mjs`) becomes:

```json
{
  "name": "@cchistory/lite",
  "version": "0.4.2",
  "type": "module",
  "license": "MIT",
  "description": "Zero-store, read-only CLI and TUI for local AI coding-agent history.",
  "bin": {
    "lite": "./bin/cchistory-lite.mjs",
    "cchistory-lite": "./bin/cchistory-lite.mjs",
    "cchistory-lite-tui": "./bin/cchistory-lite-tui.mjs"
  },
  "files": ["bin", "apps", "schemas", "INSTALL.md", "README.md", "LICENSE"],
  "dependencies": {
    "@cchistory/domain": "0.4.2",
    "@cchistory/canonical": "0.4.2",
    "@cchistory/source-adapters": "0.4.2",
    "@cchistory/live-runtime": "0.4.2"
  },
  "bundleDependencies": [
    "@cchistory/domain",
    "@cchistory/canonical",
    "@cchistory/source-adapters",
    "@cchistory/live-runtime"
  ],
  "engines": { "node": ">=22" },
  "publishConfig": { "access": "public" }
}
```

`bundleDependencies` is required. `npm pack` / `npm publish` omit `node_modules` unless those packages are listed there (and also listed under `dependencies`). The builder copies each vendored package's workspace version into those version fields; do not hard-code `0.4.2` in the script. The four packages stay `private: true` in the workspace and are copied into the artifact as they are today; they are not independently published. Installers must use the copies inside the tarball and must not fetch `@cchistory/domain` (etc.) from the registry.

POSIX `.cmd` launchers stay in `bin/` for the extract-and-run path. npm's bin links use the `.mjs` launchers above.

Copy `LICENSE` and a short package `README.md` into the artifact (the current `INSTALL.md` is not enough for the npm listing). The package README documents `npx @cchistory/lite` and `npm install -g @cchistory/lite`, Node >= 22, and that this is a read-only scanner of native history.

`scripts/build-lite-artifact.mjs` currently sets `name` to `cchistory-lite-standalone`. Change that to `@cchistory/lite`. The on-disk stem becomes `cchistory-lite-<version>` (no `standalone`, no `/`), so the tarball is `dist/lite-artifacts/cchistory-lite-0.4.2.tgz`. Update `docs/guide/lite.md` which still names `cchistory-lite-standalone-<version>.tgz`.

## Version

Ship this distribution change as **0.4.2**.

0.4.1 is already a git tag and a product release without an npm channel. Bump every workspace `package.json` that is currently `0.4.1` (repo root, both apps, all four packages) to `0.4.2` in the same change. Mark `apps/lite-cli` and `apps/lite-tui` `"private": true` so they cannot be published by accident (the four packages already are). Changelog: Unreleased → 0.4.2, Added npm install / npx.

Do not retag 0.4.1.

## Build and verify

Keep one builder: `scripts/build-lite-artifact.mjs`.

Extend `scripts/verify-lite-artifact.mjs` so the existing extract-and-run checks still pass, and add:

1. `npm pack` the artifact directory.
2. Install that tarball into a temporary prefix (`npm install --prefix <tmp> <packed.tgz>`).
3. From that prefix: `lite --help` works; `cchistory-lite --version` prints `0.4.2`; fixture `search` and `cchistory-lite tui …` match the current artifact checks.
4. The packed tarball listing includes `bin/`, `apps/lite-cli/dist`, `apps/lite-tui/dist`, `schemas/`, and `node_modules/@cchistory/{domain,canonical,source-adapters,live-runtime}`.
5. No `workspace:*` remains anywhere in the artifact.

`pnpm run verify:lite-artifact` remains the release-closure gate.

## Publish (manual)

Prerequisite (operator, not code): create the public npm organization `@cchistory` and add the publisher account.

```bash
pnpm run lite:artifact
# then, from the artifact directory:
npm publish --access public
```

Do not publish the repo root. First publish is local. CI publish-on-tag is out of scope.

If the org does not exist yet, implementation and `verify:lite-artifact` still complete; `npm publish` waits.

## Docs

- README Install: `npx @cchistory/lite` and `npm install -g @cchistory/lite` as the default install; keep clone / `pnpm run lite:link` as the from-source path; keep the extract-and-run tarball as a no-registry option.
- `skills/using-cchistory-lite/SKILL.md`: if `cchistory-lite` is not on PATH, tell the operator `npx @cchistory/lite` (or `npm install -g @cchistory/lite`) before `pnpm run lite:link`.
- `docs/guide/lite.md`: same install note.
- CHANGELOG 0.4.2.

## Acceptance

- After `npm install --prefix <tmp> <packed.tgz>`, `<tmp>/node_modules/.bin/lite --help` runs the CLI.
- `<tmp>/node_modules/.bin/cchistory-lite --version` prints `0.4.2`.
- Sibling TUI launch from `cchistory-lite tui` still works.
- Repository root `package.json` remains `"private": true`.
- Internal workspace packages remain unpublished and `private: true`.
- README, skill, and CHANGELOG describe the npm/npx install.
