#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    await assertNodeHeapOwnership([
      path.join(repoRoot, 'apps', 'lite-cli', 'dist', 'bin.js'),
      path.join(repoRoot, 'apps', 'lite-tui', 'dist', 'bin.js'),
      path.join(repoRoot, 'apps', 'lite-cli', 'dist', 'index.js'),
      path.join(repoRoot, 'apps', 'lite-tui', 'dist', 'index.js'),
      `${cli}.mjs`, `${tui}.mjs`,
    ], [cli, tui], tempRoot);
    await assertShippedAgentSkill(cli, installedRoot);
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
      'cchistory-lite-query-v3.schema.json',
      'cchistory-lite-query-result-v3.schema.json',
      'cchistory-lite-error-v1.schema.json',
      'cchistory-lite-agent-v1.schema.json',
    ];
    for (const schemaName of schemaNames) {
      JSON.parse(await readFile(path.join(installedRoot, 'schemas', schemaName), 'utf8'));
    }
    const sql = await execFile(cli, [
      'query', '--sql', 'SELECT id, title FROM sessions WHERE is_top_level = TRUE AND turn_count > 0 LIMIT $1',
      '--params', '[1]', '--complete', '--source-root', `codex=${fixtureRoot}`, '--source', 'codex', '--safe', '--no-dir',
    ], { cwd: extractRoot, maxBuffer: 8 * 1024 * 1024 });
    const sqlPayload = JSON.parse(sql.stdout);
    if (sqlPayload.schema !== 'cchistory-lite-query-result/v3' || sqlPayload.operations?.[0]?.result?.shown !== 1 || sqlPayload.operations[0].result.total < 1) {
      throw new Error(`Installed SQL parser/executor closure failed: ${sql.stdout}`);
    }
    await assertSelectiveLatest(cli, installedRoot, tempRoot);
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
    'package/node_modules/pgsql-ast-parser/',
    'package/node_modules/nearley/',
    'package/node_modules/moo/',
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
    'package/docs/guide/query.md',
    'package/docs/guide/queries/latest-sessions.sql',
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
  const npmTui = path.join(npmPrefix, 'node_modules', '.bin', 'cchistory-lite-tui');
  await assertNodeHeapOwnership([npmLite, npmCli, npmTui], [npmLite, npmCli, npmTui], tempRoot);
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
  await assertShippedAgentSkill(npmCli, path.join(npmPrefix, 'node_modules', '@cchistory', 'lite'));

  const fixtureRoot = path.join(repoRoot, 'mock_data', '.codex', 'sessions');
  const sql = await execFile(npmCli, ['query', '--sql', 'SELECT id FROM sessions LIMIT 1', '--source-root', `codex=${fixtureRoot}`, '--source', 'codex', '--no-dir'], { cwd: npmPrefix, maxBuffer: 8 * 1024 * 1024 });
  if (JSON.parse(sql.stdout).operations?.[0]?.result?.shown !== 1) throw new Error('Prefix-installed SQL execution failed.');
  await assertSelectiveLatest(npmCli, path.join(npmPrefix, 'node_modules', '@cchistory', 'lite'), tempRoot);

  const launchedTui = await execFile(
    npmCli,
    ['tui', '--source-root', `codex=${fixtureRoot}`, '--source', 'codex', '--safe', '--limit-files', '1'],
    { cwd: npmPrefix, maxBuffer: 8 * 1024 * 1024 },
  );
  if (!/CC History Lite TUI/u.test(launchedTui.stdout) || !/Ephemeral live snapshot/u.test(launchedTui.stdout)) {
    throw new Error(`Prefix-installed CLI could not launch the sibling TUI: ${launchedTui.stdout}`);
  }
}

// Compare actual launchers against bare Node in the same environment. An exit
// preload records every Node process, so an adaptive child cannot go unnoticed.
async function assertNodeHeapOwnership(modules, executables, tempRoot) {
  const traceRoot = await mkdtemp(path.join(tempRoot, 'heap-ownership-'));
  try {
    const preload = path.join(repoRoot, 'mock_data', 'fixtures', 'system-memory', 'launcher-trace.cjs');
    const trace = path.join(traceRoot, 'trace.jsonl');
    const cases = [
      { flags: [], options: '', marker: undefined },
      { flags: [], options: '--max-old-space-size=768', marker: '37' },
      { flags: ['--max-old-space-size=384'], options: '--max-old-space-size=768', marker: undefined },
    ];
    for (const scenario of cases) {
      const env = { ...process.env, TEST_LITE_LAUNCHER_TRACE: trace,
        NODE_OPTIONS: `${scenario.options} --require ${JSON.stringify(preload)}`.trim() };
      delete env.CCHISTORY_ADAPTIVE_NODE_MEMORY_MB;
      if (scenario.marker !== undefined) env.CCHISTORY_ADAPTIVE_NODE_MEMORY_MB = scenario.marker;
      const run = async (command, args) => {
        await writeFile(trace, '');
        await execFile(command, args, { cwd: traceRoot, env, timeout: 30_000 });
        const rows = (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        if (rows.length !== 1) throw new Error(`Launcher ${command} created ${rows.length} Node processes; expected one.`);
        return rows[0];
      };
      const baseline = await run(process.execPath, [...scenario.flags, '-e', 'void 0']);
      const check = async (command, args) => {
        const launched = await run(command, args);
        if (launched.heapLimit !== baseline.heapLimit || launched.adaptiveMarker !== baseline.adaptiveMarker) {
          throw new Error(`Launcher changed Node memory settings: ${JSON.stringify({ command, baseline, launched })}`);
        }
      };
      for (const entry of modules) await check(process.execPath, [...scenario.flags, entry, '--help']);
      if (scenario.flags.length === 0) for (const entry of executables) await check(entry, ['--help']);
    }
    console.log('[cchistory] actual launchers preserve Node default/explicit heap and use one process');
  } finally {
    await rm(traceRoot, { recursive: true, force: true });
  }
}

async function assertShippedAgentSkill(cli, installedRoot) {
  const skillPath = path.join('skills', 'using-cchistory-lite', 'SKILL.md');
  const expected = await readFile(path.join(repoRoot, skillPath), 'utf8');
  const installed = await readFile(path.join(installedRoot, skillPath), 'utf8');
  const printed = (await execFile(cli, ['agent', 'skill'], { cwd: installedRoot })).stdout;
  if (installed !== expected || printed !== expected) {
    throw new Error('Installed agent skill differs from the repository skill or its CLI output.');
  }
  const inventory = JSON.parse((await execFile(cli, ['sources', '--json', '--source', 'codex',
    '--source-root', `codex=${path.join(repoRoot, 'mock_data', '.codex', 'sessions')}`], { cwd: installedRoot })).stdout);
  if (inventory.schema !== 'cchistory-lite-source-inventory/v1' || inventory.kind !== 'source_inventory'
      || inventory.sources.length !== 1 || inventory.sources[0].history_read !== false
      || inventory.sources[0].total_sessions !== null) throw new Error('Installed source discovery violated its metadata-only contract.');
  await readFile(path.join(installedRoot, 'schemas', 'cchistory-lite-source-inventory-v1.schema.json'), 'utf8');
}

async function assertSelectiveLatest(cli, installedRoot, tempRoot) {
  const root = await mkdtemp(path.join(tempRoot, 'selective-fixture-'));
  for (const name of ['newest', 'tie-a', 'tie-b', 'oldest', 'empty']) {
    await copyFile(path.join(repoRoot, 'mock_data', 'fixtures', 'selective-latest', `${name}.jsonl`), path.join(root, `${name}.jsonl`));
  }
  const args = ['query', '--sql-file', path.join(installedRoot, 'docs', 'guide', 'queries', 'latest-sessions.sql'),
    '--params', '[2]', '--source', 'codex', '--source-root', `codex=${root}`, '--no-dir'];
  const selected = JSON.parse((await execFile(cli, args, { cwd: tempRoot })).stdout);
  const complete = JSON.parse((await execFile(cli, [...args, '--complete'], { cwd: tempRoot })).stdout);
  const result = selected.operations[0].result, reference = complete.operations[0].result;
  if (result.coverage.execution !== 'selective' || result.coverage.diagnostics !== 'observed'
    || result.total !== null || reference.total !== 4 || reference.coverage.execution !== 'complete'
    || JSON.stringify(result.rows) !== JSON.stringify(reference.rows) || selected.projection_issues.length) {
    throw new Error('Installed latest template selective/complete parity failed.');
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
