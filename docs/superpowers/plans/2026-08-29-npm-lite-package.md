# @cchistory/lite npm package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Lite release closure into one public npm package `@cchistory/lite` so `npx @cchistory/lite` and `npm install -g @cchistory/lite` work, then ship it as 0.4.2.

**Architecture:** Keep `scripts/build-lite-artifact.mjs` as the only packer. It already copies CLI/TUI `dist/` and vendors `@cchistory/{domain,canonical,source-adapters,live-runtime}` into `node_modules`. Change that directory's `package.json` so `npm pack` / `npm publish` keep the vendored tree via `bundleDependencies`, expose a `lite` bin for `npx @cchistory/lite`, and use a filesystem-safe stem `cchistory-lite-<version>`. Workspace packages stay `private` and unpublished.

**Tech Stack:** Node.js >= 22, pnpm workspace, existing `node:test` package tests, `scripts/verify-lite-artifact.mjs` as the release-closure gate, npm for pack/install/publish.

## Global Constraints

- Public package name is `@cchistory/lite`; `publishConfig.access` is `public`.
- Product version of this change is `0.4.2`. Do not retag `0.4.1`.
- Do not publish `@cchistory/domain`, `@cchistory/canonical`, `@cchistory/source-adapters`, `@cchistory/live-runtime`, `@cchistory/lite-cli`, or `@cchistory/lite-tui`.
- Do not change CLI or TUI history semantics, commands, JSON contracts, or adapter behavior.
- Do not add `sample` to the TUI, `query`, or `shell`.
- Do not add a persistent store or any mutation command.
- Do not `npm publish` from the repository root (`private: true` stays).
- Do not add CI-triggered npm publish.
- `bundleDependencies` is required; do not hard-code `0.4.2` into the builder's dependency versions — copy each vendored package's workspace version.
- After `npm install --prefix <tmp> <packed.tgz>`, `<tmp>/node_modules/.bin/lite --help` runs the CLI and `cchistory-lite --version` prints the CLI manifest version.
- On-disk tarball stem is `cchistory-lite-<version>` (no `standalone`, no `/`).

## File map

| File | Responsibility |
| --- | --- |
| `scripts/verify-lite-artifact.mjs` | Extract-and-run checks plus `npm pack` → prefix-install checks |
| `scripts/build-lite-artifact.mjs` | Writes the publishable closure (`package.json`, bins, README, LICENSE, stem) |
| `package.json` and `apps/*/package.json` and `packages/*/package.json` | Version `0.4.2`; apps marked `private: true` |
| `apps/lite-cli/src/index.ts` | Baked CLI `VERSION` |
| `apps/lite-tui/src/version.ts` | Baked TUI `VERSION` |
| `apps/lite-tui/src/render.test.ts` | Banner string must match TUI version |
| `README.md`, `docs/guide/lite.md`, `skills/using-cchistory-lite/SKILL.md`, `CHANGELOG.md` | npx / global install as the default path |

---

### Task 1: Fail the artifact verifier on the missing npm shape

**Files:**
- Modify: `scripts/verify-lite-artifact.mjs`
- Test: `pnpm run verify:lite-artifact -- --skip-build` (requires a prior `pnpm run build:lite` if `dist/` is stale)

**Interfaces:**
- Consumes: `buildLiteArtifact()` return value `{ artifact_dir, tarball_path }` and the extracted directory at `path.join(extractRoot, path.basename(manifest.artifact_dir))`
- Produces: `assertPublishableNpmPackage(installedRoot, tempRoot, expectedVersion)` — throws if the extracted closure cannot be `npm pack`ed and prefix-installed as `@cchistory/lite`

- [ ] **Step 1: Add the failing publish-shape assertions**

Insert this helper above `assertNoWorkspaceSpecs` in `scripts/verify-lite-artifact.mjs`:

```javascript
const PUBLISHED_PACKAGE_NAME = '@cchistory/lite';
const BUNDLED_PACKAGES = [
  '@cchistory/domain',
  '@cchistory/canonical',
  '@cchistory/source-adapters',
  '@cchistory/live-runtime',
];

async function assertPublishableNpmPackage(installedRoot, tempRoot, expectedVersion) {
  const artifactPackage = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'));
  if (artifactPackage.name !== PUBLISHED_PACKAGE_NAME) {
    throw new Error(`Artifact package name is ${artifactPackage.name}, expected ${PUBLISHED_PACKAGE_NAME}`);
  }
  if (artifactPackage.bin?.lite !== './bin/cchistory-lite.mjs') {
    throw new Error(`Artifact is missing the lite bin alias: ${JSON.stringify(artifactPackage.bin)}`);
  }
  if (artifactPackage.bin?.['cchistory-lite'] !== './bin/cchistory-lite.mjs') {
    throw new Error(`Artifact is missing the cchistory-lite bin: ${JSON.stringify(artifactPackage.bin)}`);
  }
  if (artifactPackage.bin?.['cchistory-lite-tui'] !== './bin/cchistory-lite-tui.mjs') {
    throw new Error(`Artifact is missing the cchistory-lite-tui bin: ${JSON.stringify(artifactPackage.bin)}`);
  }
  if (artifactPackage.publishConfig?.access !== 'public') {
    throw new Error(`Artifact publishConfig.access is ${artifactPackage.publishConfig?.access}, expected public`);
  }
  const bundled = artifactPackage.bundleDependencies ?? artifactPackage.bundledDependencies;
  for (const packageName of BUNDLED_PACKAGES) {
    if (!Array.isArray(bundled) || !bundled.includes(packageName)) {
      throw new Error(`Artifact bundleDependencies missing ${packageName}: ${JSON.stringify(bundled)}`);
    }
    if (artifactPackage.dependencies?.[packageName] !== expectedVersion && artifactPackage.dependencies?.[packageName] !== artifactPackage.version) {
      // During verify, artifact version is 0.0.0-verify while baked CLI version is the workspace version.
      // Dependency versions must copy the vendored workspace package versions, not a hard-coded 0.4.2.
      if (typeof artifactPackage.dependencies?.[packageName] !== 'string' || artifactPackage.dependencies[packageName].includes('workspace:')) {
        throw new Error(`Artifact dependency ${packageName} is ${artifactPackage.dependencies?.[packageName]}`);
      }
    }
  }

  const packDir = path.join(tempRoot, 'npm-pack');
  await mkdir(packDir, { recursive: true });
  const packed = await execFile('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: installedRoot });
  const packedListing = JSON.parse(packed.stdout);
  const packedFileName = packedListing[0]?.filename ?? packedListing[0]?.id;
  if (!packedFileName) {
    throw new Error(`npm pack did not report a filename: ${packed.stdout}`);
  }
  const packedTarball = path.join(packDir, path.basename(packedFileName));
  const listing = await execFile('tar', ['-tzf', packedTarball]);
  const names = listing.stdout.split('\n');
  const requiredPrefixes = [
    'package/bin/cchistory-lite.mjs',
    'package/apps/lite-cli/dist/',
    'package/apps/lite-tui/dist/',
    'package/schemas/',
    'package/node_modules/@cchistory/domain/',
    'package/node_modules/@cchistory/canonical/',
    'package/node_modules/@cchistory/source-adapters/',
    'package/node_modules/@cchistory/live-runtime/',
    'package/README.md',
    'package/LICENSE',
  ];
  for (const required of requiredPrefixes) {
    if (!names.some((entry) => entry === required || entry.startsWith(required))) {
      throw new Error(`npm pack tarball missing ${required}`);
    }
  }

  const npmPrefix = path.join(tempRoot, 'npm-prefix');
  await mkdir(npmPrefix, { recursive: true });
  await execFile('npm', ['install', '--prefix', npmPrefix, packedTarball]);
  const npmLite = path.join(npmPrefix, 'node_modules', '.bin', 'lite');
  const npmCli = path.join(npmPrefix, 'node_modules', '.bin', 'cchistory-lite');
  const help = await execFile(npmLite, ['--help']);
  if (!/cchistory-lite/u.test(help.stdout)) {
    throw new Error(`Prefix-installed lite --help failed: ${help.stdout}`);
  }
  const npmVersion = await execFile(npmCli, ['--version']);
  if (npmVersion.stdout.trim() !== expectedVersion) {
    throw new Error(`Prefix-installed cchistory-lite --version is ${npmVersion.stdout.trim()} (expected ${expectedVersion})`);
  }

  const fixtureRoot = path.join(repoRoot, 'mock_data', '.codex', 'sessions');
  const launchedTui = await execFile(
    npmCli,
    ['tui', '--source-root', `codex=${fixtureRoot}`, '--source', 'codex', '--safe', '--limit-files', '1'],
    { cwd: npmPrefix, maxBuffer: 8 * 1024 * 1024 },
  );
  if (!/CC History Lite TUI/u.test(launchedTui.stdout) || !/Ephemeral live snapshot/u.test(launchedTui.stdout)) {
    throw new Error(`Prefix-installed CLI could not launch the sibling TUI: ${launchedTui.stdout}`);
  }
}
```

Call it after the existing extract-and-run checks succeed, immediately before the final `console.log` success lines, with:

```javascript
    await assertPublishableNpmPackage(installedRoot, tempRoot, expectedVersion);
```

Also assert the extract-and-run tarball stem. After `installedRoot` is computed, add:

```javascript
    if (path.basename(manifest.artifact_dir) !== `cchistory-lite-${manifest.version}`) {
      throw new Error(`Artifact directory stem is ${path.basename(manifest.artifact_dir)}, expected cchistory-lite-${manifest.version}`);
    }
```

During this verifier run `manifest.version` is `0.0.0-verify` (existing `versionOverride`). Do not hard-code `0.4.2` in the verifier.

- [ ] **Step 2: Run the verifier and confirm it fails on the current builder**

Run:

```bash
pnpm run build:lite
pnpm run verify:lite-artifact -- --skip-build
```

Expected: FAIL with `Artifact package name is cchistory-lite-standalone, expected @cchistory/lite` (or the stem error `cchistory-lite-standalone-0.0.0-verify`).

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-lite-artifact.mjs
git commit -m "$(cat <<'EOF'
test(lite): require a publishable @cchistory/lite artifact

Fail the release-closure gate until the standalone directory can be
npm-packed and prefix-installed as the public package.
EOF
)"
```

---

### Task 2: Make the artifact builder emit `@cchistory/lite`

**Files:**
- Modify: `scripts/build-lite-artifact.mjs`
- Test: `pnpm run verify:lite-artifact -- --skip-build`

**Interfaces:**
- Consumes: workspace `package.json` versions via existing `copyVendoredPackage` return `{ package_name, version, relative_path }[]`
- Produces: artifact directory `dist/lite-artifacts/cchistory-lite-<version>/` whose `package.json` `name` is `@cchistory/lite`, with bins `lite` / `cchistory-lite` / `cchistory-lite-tui`, `bundleDependencies` listing the four vendored packages, plus `README.md` and `LICENSE`

- [ ] **Step 1: Split published name from on-disk stem**

In `scripts/build-lite-artifact.mjs` replace:

```javascript
const artifactPackageName = 'cchistory-lite-standalone';
```

with:

```javascript
const publishedPackageName = '@cchistory/lite';
const artifactStem = 'cchistory-lite';
```

Replace every use of `artifactPackageName` for the filesystem / tarball name with `artifactStem`:

```javascript
  const artifactName = `${artifactStem}-${version}`;
```

Keep `publishedPackageName` for `package.json` `name` and `manifest.package_name`.

- [ ] **Step 2: Write the publishable package.json after vendoring**

`includedPackages` is already populated before today's `artifactPackage` object. Replace that object with:

```javascript
  const vendoredVersions = Object.fromEntries(
    includedPackages.map((entry) => [entry.package_name, entry.version]),
  );
  const artifactPackage = {
    name: publishedPackageName,
    version,
    type: 'module',
    license: cliPackage.license ?? rootPackage.license ?? 'MIT',
    description: 'Zero-store, read-only CLI and TUI for local AI coding-agent history.',
    bin: {
      lite: './bin/cchistory-lite.mjs',
      'cchistory-lite': './bin/cchistory-lite.mjs',
      'cchistory-lite-tui': './bin/cchistory-lite-tui.mjs',
    },
    files: ['bin', 'apps', 'schemas', 'INSTALL.md', 'README.md', 'LICENSE'],
    dependencies: vendoredVersions,
    bundleDependencies: vendoredPackages.map((entry) => entry.packageName),
    engines: { node: rootPackage.engines?.node ?? '>=22' },
    publishConfig: { access: 'public' },
  };
```

Do not put `0.4.2` in this script. `vendoredVersions` comes from each workspace `package.json` (or from `versionOverride` only for the artifact's own `version` field — leave that as today).

Set `manifest.package_name` to `publishedPackageName`.

- [ ] **Step 3: Copy LICENSE and write the npm README**

After writing `INSTALL.md`, add:

```javascript
  await cp(path.join(repoRoot, 'LICENSE'), path.join(artifactDir, 'LICENSE'));
  await writeFile(
    path.join(artifactDir, 'README.md'),
    [
      '# @cchistory/lite',
      '',
      'Zero-store, read-only CLI and TUI that reads local AI coding-agent history',
      'in place. Requires Node.js >= 22.',
      '',
      '```bash',
      'npx @cchistory/lite --help',
      'npm install -g @cchistory/lite',
      'cchistory-lite sources',
      '```',
      '',
      'This package scans native history on disk and keeps the snapshot in memory.',
      'It does not create `~/.cchistory`.',
      '',
      'The `lite` bin is an alias of `cchistory-lite` so `npx @cchistory/lite` works.',
      'A global install also links `cchistory-lite` and `cchistory-lite-tui`.',
      '',
    ].join('\n'),
    'utf8',
  );
```

Update `INSTALL.md` so extract-and-run still works, and mention npm:

```javascript
      'Install from npm: `npx @cchistory/lite --help` or `npm install -g @cchistory/lite`.',
      '',
      'This directory is a self-contained Lite release closure. It carries both',
      'Lite binaries and every private workspace package required at runtime.',
      'It does not require a CCHistory repository checkout or pnpm workspace links.',
```

Leave the POSIX / Windows extract-and-run bullets in place.

- [ ] **Step 4: Run the verifier and confirm it passes**

Run:

```bash
pnpm run verify:lite-artifact -- --skip-build
```

Expected: `[cchistory] standalone Lite artifact verification passed` and no missing-`lite`-bin / missing-`node_modules/@cchistory` errors.

If `npm pack` omits `node_modules` despite `bundleDependencies`, do not invent a second packer. Confirm the four packages exist under `installedRoot/node_modules/@cchistory/` before `npm pack`, and that each is listed in both `dependencies` and `bundleDependencies`.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-lite-artifact.mjs
git commit -m "$(cat <<'EOF'
feat(lite): emit a publishable @cchistory/lite closure

Shape the existing standalone artifact so npm pack keeps vendored
packages and exposes the lite bin for npx.
EOF
)"
```

---

### Task 3: Bump the product to 0.4.2 and lock apps private

**Files:**
- Modify: `package.json` (root `version` only; keep `"private": true`)
- Modify: `apps/lite-cli/package.json` (`version`, add `"private": true`)
- Modify: `apps/lite-tui/package.json` (`version`, add `"private": true`)
- Modify: `packages/domain/package.json`
- Modify: `packages/canonical/package.json`
- Modify: `packages/source-adapters/package.json`
- Modify: `packages/live-runtime/package.json`
- Modify: `apps/lite-cli/src/index.ts` (`const VERSION = "0.4.1"` → `"0.4.2"`)
- Modify: `apps/lite-tui/src/version.ts` (`export const VERSION = "0.4.1"` → `"0.4.2"`)
- Modify: `apps/lite-tui/src/render.test.ts` (`CC History Lite TUI 0.4.1` → `0.4.2`)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 2 builder copies whatever version is in each workspace `package.json`
- Produces: every workspace manifest and both baked `VERSION` constants equal `0.4.2`; CLI `--version` and TUI banner agree

- [ ] **Step 1: Change the version literals**

Set `"version": "0.4.2"` in all seven `package.json` files listed above.

In `apps/lite-cli/package.json` and `apps/lite-tui/package.json`, add `"private": true` next to `"version"` (the four packages already have it; do not add `private` to the published artifact — that file is generated).

In `apps/lite-cli/src/index.ts`:

```javascript
const VERSION = "0.4.2";
```

In `apps/lite-tui/src/version.ts`:

```javascript
export const VERSION = "0.4.2";
```

In `apps/lite-tui/src/render.test.ts` replace the banner assertion string with `"CC History Lite TUI 0.4.2"`.

- [ ] **Step 2: Add the 0.4.2 changelog section**

Replace the empty Unreleased heading in `CHANGELOG.md` with:

```markdown
## [Unreleased]

## [0.4.2] - 2026-08-29

### Added

- `@cchistory/lite` is the public npm package for this release closure.
  `npx @cchistory/lite` and `npm install -g @cchistory/lite` install the same
  CLI/TUI as the extract-and-run tarball. Workspace packages stay private.
  The `lite` bin is an alias of `cchistory-lite`.

### Changed

- The standalone tarball stem is `cchistory-lite-<version>.tgz` (no
  `standalone` suffix). Extract-and-run launchers are unchanged.
```

Keep the existing `## [0.4.1]` section intact.

- [ ] **Step 3: Rebuild and run package tests plus the artifact verifier**

Run:

```bash
pnpm run build:lite
pnpm --filter @cchistory/lite-cli test
pnpm --filter @cchistory/lite-tui test
pnpm run verify:lite-artifact -- --skip-build
```

Expected: CLI/TUI tests pass; verifier prints the baked version `0.4.2` from `--version`; prefix-installed `cchistory-lite --version` is `0.4.2`.

- [ ] **Step 4: Commit**

```bash
git add package.json apps/lite-cli/package.json apps/lite-tui/package.json packages/domain/package.json packages/canonical/package.json packages/source-adapters/package.json packages/live-runtime/package.json apps/lite-cli/src/index.ts apps/lite-tui/src/version.ts apps/lite-tui/src/render.test.ts CHANGELOG.md
git commit -m "$(cat <<'EOF'
chore: release 0.4.2

Mark the npm distribution channel and keep workspace apps private.
EOF
)"
```

---

### Task 4: Document npx and global install

**Files:**
- Modify: `README.md` (Install section)
- Modify: `docs/guide/lite.md` (Build And Run)
- Modify: `skills/using-cchistory-lite/SKILL.md` (PATH miss)

**Interfaces:**
- Consumes: published name `@cchistory/lite` and tarball stem `cchistory-lite-<version>.tgz` from Tasks 2–3
- Produces: user-facing install instructions that lead with npm/npx

- [ ] **Step 1: Rewrite the README Install section**

Replace the current Install section in `README.md` (from `## Install` through the standalone artifact subsection, before `## Supported sources`) with:

```markdown
## Install

Requires Node.js >= 22.

```bash
npx @cchistory/lite --help
npm install -g @cchistory/lite
cchistory-lite sources
```

`npx @cchistory/lite` runs the `lite` bin (same CLI as `cchistory-lite`).
A global install also links `cchistory-lite-tui`.

Agents looking up local history should follow
[`skills/using-cchistory-lite/SKILL.md`](skills/using-cchistory-lite/SKILL.md)
(copy-paste recipes in [`docs/guide/lite.md`](docs/guide/lite.md)). That skill
is vendor-neutral; copy or symlink it into the host agent’s skill path if the
host auto-loads from there.

### From source

```bash
git clone <this-repo> cchistory-lite
cd cchistory-lite
pnpm install
pnpm run build:lite
```

Link both binaries onto your `PATH`:

```bash
pnpm run lite:link       # cchistory-lite
pnpm run lite:tui:link   # cchistory-lite-tui
```

Or run them straight out of the workspace without linking:

```bash
pnpm lite -- sources
pnpm lite:tui
```

### Standalone release artifact

`pnpm run lite:artifact` produces a self-contained closure under `dist/lite-artifacts/` —
both binaries plus every workspace package they need, with no `workspace:*` specifiers and no
pnpm workspace required at runtime. Extract `cchistory-lite-<version>.tgz` anywhere and run
`bin/cchistory-lite` (or `bin\cchistory-lite.cmd` on Windows). The same directory is what
`npm publish` uploads as `@cchistory/lite`.
```

- [ ] **Step 2: Update the guide and skill**

In `docs/guide/lite.md`, insert this block **above** the existing `pnpm --filter` build snippet in `## Build And Run`:

```markdown
Published install (no repository checkout):

```bash
npx @cchistory/lite --help
npm install -g @cchistory/lite
```

`npx @cchistory/lite` is the `lite` alias of `cchistory-lite`.
```

Replace:

```
Extract `dist/lite-artifacts/cchistory-lite-standalone-<version>.tgz` and run
```

with:

```
Extract `dist/lite-artifacts/cchistory-lite-<version>.tgz` and run
```

In `skills/using-cchistory-lite/SKILL.md`, replace:

```
If `cchistory-lite` is not on `PATH`, stop. Point the operator at `README.md`
(`pnpm run lite:link`). Do not grep adapter roots, invent a store, or write
native history.
```

with:

```
If `cchistory-lite` is not on `PATH`, stop. Point the operator at
`npx @cchistory/lite` or `npm install -g @cchistory/lite` (from-source:
`pnpm run lite:link` in `README.md`). Do not grep adapter roots, invent a
store, or write native history.
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/guide/lite.md skills/using-cchistory-lite/SKILL.md
git commit -m "$(cat <<'EOF'
docs(lite): lead install with npx @cchistory/lite

Keep clone-and-link and the extract-and-run tarball as secondary paths.
EOF
)"
```

---

### Task 5: Close the release locally, then publish by hand

**Files:**
- None beyond what Tasks 1–4 already changed

**Interfaces:**
- Consumes: artifact directory `dist/lite-artifacts/cchistory-lite-0.4.2/` from `pnpm run lite:artifact`
- Produces: npm registry package `@cchistory/lite@0.4.2`

- [ ] **Step 1: Run the repository gates**

```bash
pnpm run build:lite
pnpm test
pnpm run verify:governance
pnpm run verify:lite-artifact
```

Expected: all four succeed. `verify:lite-artifact` must exercise both extract-and-run and the prefix-install path.

- [ ] **Step 2: Build the publish directory**

```bash
pnpm run lite:artifact
```

Expected: `dist/lite-artifacts/cchistory-lite-0.4.2/` exists, its `package.json` `name` is `@cchistory/lite`, and `dist/lite-artifacts/cchistory-lite-0.4.2.tgz` exists.

- [ ] **Step 3: Confirm npm identity can publish `@cchistory`**

```bash
npm whoami
npm access list packages @cchistory
```

Expected: logged-in user is a publisher on the `@cchistory` org. If `npm whoami` fails, run `npm login` in a real terminal (interactive). Do not publish from the repository root.

- [ ] **Step 4: Publish only the artifact directory**

```bash
npm publish --access public --prefix dist/lite-artifacts/cchistory-lite-0.4.2
```

If `--prefix` is rejected by this npm version, `cd` into that directory and run `npm publish --access public` there. Do not run `npm publish` in the repo root.

Expected: `+ @cchistory/lite@0.4.2`.

- [ ] **Step 5: Smoke the published package**

```bash
npx --yes @cchistory/lite@0.4.2 --version
```

Expected: `0.4.2`.

- [ ] **Step 6: Tag the git release after publish succeeds**

```bash
git tag v0.4.2
```

Do not move `v0.4.1`. Push the branch and tag only if the operator asked.

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| Public package `@cchistory/lite` | 2 |
| `lite` / `cchistory-lite` / `cchistory-lite-tui` bins | 2 |
| `bundleDependencies` + copied workspace versions | 2 |
| README + LICENSE in the artifact | 2 |
| Stem `cchistory-lite-<version>.tgz` | 2 |
| `npm pack` then prefix-install checks | 1, 5 |
| Version 0.4.2 everywhere, apps `private` | 3 |
| README / skill / guide / CHANGELOG | 3, 4 |
| Manual publish, no CI publish, no root publish | 5 |
| No workspace-package publish, no semantic CLI changes | Global constraints |
