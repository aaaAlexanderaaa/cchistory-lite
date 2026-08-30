#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildLiteArtifact } from './build-lite-artifact.mjs';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keepTemp = process.argv.includes('--keep-temp');
const skipBuild = process.argv.includes('--skip-build');

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cchistory-lite-artifact-verify-'));
  try {
    const manifest = await buildLiteArtifact({
      repoRoot,
      outputRoot: path.join(tempRoot, 'release'),
      skipBuild,
      createTarball: true,
      versionOverride: '0.0.0-verify',
    });
    const extractRoot = path.join(tempRoot, 'installed');
    await mkdir(extractRoot, { recursive: true });
    await execFile('tar', ['-xzf', manifest.tarball_path, '-C', extractRoot]);
    const installedRoot = path.join(extractRoot, path.basename(manifest.artifact_dir));
    if (path.basename(manifest.artifact_dir) !== `cchistory-lite-${manifest.version}`) {
      throw new Error(`Artifact directory stem is ${path.basename(manifest.artifact_dir)}, expected cchistory-lite-${manifest.version}`);
    }

    await assertNoWorkspaceSpecs(installedRoot);
    const cli = path.join(installedRoot, 'bin', 'cchistory-lite');
    const tui = path.join(installedRoot, 'bin', 'cchistory-lite-tui');
    const expectedVersion = JSON.parse(
      await readFile(path.join(repoRoot, 'apps', 'lite-cli', 'package.json'), 'utf8'),
    ).version;
    const version = await execFile(cli, ['--version'], { cwd: extractRoot });
    if (version.stdout.trim() !== expectedVersion) {
      throw new Error(`Unexpected installed Lite version: ${version.stdout.trim()} (expected ${expectedVersion})`);
    }
    const tuiHelp = await execFile(tui, ['--help'], { cwd: extractRoot });
    if (!/CC History Lite TUI/u.test(tuiHelp.stdout)) throw new Error('Installed Lite TUI help was unavailable.');
    // Both binaries bake their version as a literal. Catch the two drifting apart
    // here rather than shipping an artifact whose halves disagree.
    const tuiReportedVersion = tuiHelp.stdout.match(/CC History Lite TUI\s+(\S+)/u)?.[1];
    if (tuiReportedVersion !== expectedVersion) {
      throw new Error(`Installed Lite TUI reports version ${tuiReportedVersion} but the CLI reports ${expectedVersion}.`);
    }

    const fixtureRoot = path.join(repoRoot, 'mock_data', '.codex', 'sessions');
    const launchedTui = await execFile(
      cli,
      ['tui', '--source-root', `codex=${fixtureRoot}`, '--source', 'codex', '--safe', '--limit-files', '1'],
      { cwd: extractRoot, maxBuffer: 8 * 1024 * 1024 },
    );
    if (!/CC History Lite TUI/u.test(launchedTui.stdout) || !/Ephemeral live snapshot/u.test(launchedTui.stdout)) {
      throw new Error(`Installed Lite CLI could not launch the sibling TUI: ${launchedTui.stdout}`);
    }
    const search = await execFile(
      cli,
      ['search', 'mock', '--source-root', `codex=${fixtureRoot}`, '--source', 'codex', '--safe', '--json', '--no-dir'],
      { cwd: extractRoot, maxBuffer: 8 * 1024 * 1024 },
    );
    const payload = JSON.parse(search.stdout);
    if (
      payload.schema !== 'cchistory-lite/v2'
      || payload.kind !== 'search'
      || payload.unit !== 'session'
      || payload.total < 1
      || payload.shown !== payload.results.length
      || payload.shown > payload.total
    ) {
      throw new Error(`Installed Lite CLI fixture search failed: ${search.stdout}`);
    }
    const schemaNames = [
      'cchistory-lite-v2.schema.json',
      'cchistory-lite-canonical-v1.schema.json',
      'cchistory-lite-query-v2.schema.json',
      'cchistory-lite-query-result-v2.schema.json',
      'cchistory-lite-error-v1.schema.json',
      'cchistory-lite-agent-v1.schema.json',
    ];
    for (const schemaName of schemaNames) {
      JSON.parse(await readFile(path.join(installedRoot, 'schemas', schemaName), 'utf8'));
    }
    const requestPath = path.join(tempRoot, 'query.json');
    await writeFile(requestPath, `${JSON.stringify({
      schema: 'cchistory-lite-query/v2',
      operations: [{ id: 'find', kind: 'search', query: 'mock', limit: 1 }],
    })}\n`, 'utf8');
    const query = await execFile(
      cli,
      ['query', '--request', requestPath, '--source-root', `codex=${fixtureRoot}`, '--source', 'codex', '--safe', '--no-dir'],
      { cwd: extractRoot, maxBuffer: 8 * 1024 * 1024 },
    );
    const queryPayload = JSON.parse(query.stdout);
    if (
      queryPayload.schema !== 'cchistory-lite-query-result/v2'
      || queryPayload.kind !== 'query_result'
      || queryPayload.operations?.[0]?.status !== 'ok'
      || queryPayload.operations[0].result?.total < 1
    ) {
      throw new Error(`Installed Lite CLI fixture query failed: ${query.stdout}`);
    }
    await assertPublishableNpmPackage(installedRoot, tempRoot, expectedVersion);
    console.log('[cchistory] standalone Lite artifact verification passed');
    console.log(`[cchistory] verified binaries: ${cli}, ${tui}`);
  } finally {
    if (keepTemp) console.log(`[cchistory] kept verification directory: ${tempRoot}`);
    else await rm(tempRoot, { recursive: true, force: true });
  }
}

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
  const requiredDocFiles = [
    'package/docs/guide/for-agents.md',
    'package/docs/guide/lite.md',
    'package/skills/using-cchistory-lite/SKILL.md',
  ];
  for (const required of requiredDocFiles) {
    if (!names.includes(required)) {
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

  const agent = await execFile(npmCli, ['agent']);
  const agentContract = JSON.parse(agent.stdout);
  if (agentContract.schema !== 'cchistory-lite-agent/v1') {
    throw new Error(`Prefix-installed cchistory-lite agent schema is ${agentContract.schema}, expected cchistory-lite-agent/v1`);
  }
  const agentSkill = await execFile(npmCli, ['agent', 'skill']);
  if (!agentSkill.stdout.includes('CC History Lite')) {
    throw new Error('Prefix-installed cchistory-lite agent skill did not print the shipped skill doc');
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

async function assertNoWorkspaceSpecs(root) {
  for (const packageJsonPath of await listPackageJsonFiles(root)) {
    const source = await readFile(packageJsonPath, 'utf8');
    if (source.includes('workspace:*')) {
      throw new Error(`Standalone artifact retained a workspace dependency: ${packageJsonPath}`);
    }
  }
}

async function listPackageJsonFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listPackageJsonFiles(target));
    else if (entry.name === 'package.json') result.push(target);
  }
  return result;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
