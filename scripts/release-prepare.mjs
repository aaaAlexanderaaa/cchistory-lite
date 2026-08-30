#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, '..');
const changelogRelativePath = 'CHANGELOG.md';
const currentVersionRelativePath = path.join('apps', 'lite-cli', 'package.json');
export const versionedPackageRelativePaths = [
  'package.json',
  path.join('apps', 'lite-cli', 'package.json'),
  path.join('apps', 'lite-tui', 'package.json'),
  path.join('packages', 'domain', 'package.json'),
  path.join('packages', 'canonical', 'package.json'),
  path.join('packages', 'source-adapters', 'package.json'),
  path.join('packages', 'live-runtime', 'package.json'),
];
export const bakedVersionRelativePaths = [
  path.join('apps', 'lite-cli', 'src', 'version.ts'),
  path.join('apps', 'lite-tui', 'src', 'version.ts'),
];

const usage = `usage: node scripts/release-prepare.mjs <version> [--repo <path>] [--check-only] [--date <YYYY-MM-DD>]

Validates and prepares a Lite release:
  1. rewrites the top-level "version" field in all 7 workspace package.json files
  2. rewrites the baked VERSION literals in the CLI and TUI entry sources
  3. folds CHANGELOG.md: the [Unreleased] content becomes [<version>] - <date>
     and a fresh empty [Unreleased] section is inserted above it

options:
  --repo <path>        repository root (default: the repository containing this script)
  --check-only         validate and print the plan without writing anything
  --date <YYYY-MM-DD>  release date for the new changelog section (default: today, UTC)
  -h, --help           show this message

exits 0 when the plan is valid (or was applied), 1 with a clear message otherwise.
`;

const semverPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const versionLinePattern = /^([ \t]*)"version":\s*"([^"]*)"(,?)[ \t]*$/m;
const bakedVersionPattern = /^((?:export )?const VERSION = )"([^"]+)"(;)$/m;

function parseSemver(version) {
  const match = semverPattern.exec(version);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareSemver(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  const leftPre = left.prerelease;
  const rightPre = right.prerelease;
  if (leftPre.length === 0 && rightPre.length === 0) return 0;
  if (leftPre.length === 0) return 1;
  if (rightPre.length === 0) return -1;
  const shared = Math.min(leftPre.length, rightPre.length);
  for (let index = 0; index < shared; index += 1) {
    const leftPart = leftPre[index];
    const rightPart = rightPre[index];
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  if (leftPre.length === rightPre.length) return 0;
  return leftPre.length < rightPre.length ? -1 : 1;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function findBakedVersionAssignments(source) {
  return [...source.matchAll(new RegExp(bakedVersionPattern.source, 'gm'))];
}

export function replaceBakedVersion(source, relativePath, nextVersion) {
  const assignments = findBakedVersionAssignments(source);
  if (assignments.length !== 1) {
    throw new Error(
      `${relativePath}: expected exactly one \`const VERSION = "..."\` assignment, found ${assignments.length}.`,
    );
  }
  const updated = source.replace(bakedVersionPattern, `$1"${nextVersion}"$3`);
  const after = findBakedVersionAssignments(updated);
  if (after.length !== 1 || after[0][2] !== nextVersion) {
    throw new Error(`${relativePath}: VERSION rewrite did not produce the expected assignment.`);
  }
  return { currentVersion: assignments[0][2], updated };
}

function replaceTopLevelVersion(source, relativePath, nextVersion) {
  const match = versionLinePattern.exec(source);
  if (!match) {
    throw new Error(`${relativePath}: no top-level "version" line found.`);
  }
  const parsed = JSON.parse(source);
  if (parsed.version !== match[2]) {
    throw new Error(
      `${relativePath}: the first "version" line (${match[2]}) is not the top-level field (${parsed.version}); refusing to edit.`,
    );
  }
  const updated = source.replace(
    versionLinePattern,
    `${match[1]}"version": "${nextVersion}"${match[3]}`,
  );
  if (JSON.parse(updated).version !== nextVersion) {
    throw new Error(`${relativePath}: version rewrite did not produce the expected top-level version.`);
  }
  return { currentVersion: match[2], updated };
}

function findUnreleasedSection(lines) {
  const start = lines.findIndex((line) => /^## \[Unreleased\][ \t]*$/.test(line));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^## \[/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function unreleasedHasContent(lines, section) {
  return lines
    .slice(section.start + 1, section.end)
    .some((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
}

function foldChangelog(source, version, date) {
  const lines = source.split('\n');
  const section = findUnreleasedSection(lines);
  const folded = [
    ...lines.slice(0, section.start),
    '## [Unreleased]',
    '',
    `## [${version}] - ${date}`,
    ...lines.slice(section.start + 1),
  ];
  return folded.join('\n');
}

async function readPackageVersion(repoRoot, relativePath) {
  const source = await readFile(path.join(repoRoot, relativePath), 'utf8');
  return JSON.parse(source).version;
}

async function readBakedVersion(repoRoot, relativePath) {
  let source;
  try {
    source = await readFile(path.join(repoRoot, relativePath), 'utf8');
  } catch (error) {
    throw new Error(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const assignments = findBakedVersionAssignments(source);
  if (assignments.length !== 1) {
    throw new Error(
      `${relativePath}: expected exactly one \`const VERSION = "..."\` assignment, found ${assignments.length}.`,
    );
  }
  return assignments[0][2];
}

async function assertTagAbsent(repoRoot, tag) {
  let stdout;
  try {
    ({ stdout } = await execFile('git', ['tag', '-l', tag], { cwd: repoRoot }));
  } catch (error) {
    throw new Error(
      `could not run "git tag -l ${tag}" in ${repoRoot} (${error.message}); the tag check is mandatory.`,
    );
  }
  if (stdout.trim() !== '') {
    throw new Error(`git tag ${tag} already exists; a version can only be released once.`);
  }
}

function parseArgs(argv) {
  const parsed = { version: undefined, repo: undefined, checkOnly: false, date: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--repo' && argv[index + 1]) parsed.repo = argv[++index];
    else if (argument.startsWith('--repo=')) parsed.repo = argument.slice('--repo='.length);
    else if (argument === '--check-only') parsed.checkOnly = true;
    else if (argument === '--date' && argv[index + 1]) parsed.date = argv[++index];
    else if (argument.startsWith('--date=')) parsed.date = argument.slice('--date='.length);
    else if (argument === '--help' || argument === '-h') parsed.help = true;
    else if (!argument.startsWith('-') && parsed.version === undefined) parsed.version = argument;
    else throw new Error(`unknown or duplicate argument: ${argument}`);
  }
  return parsed;
}

export async function prepareRelease({
  version,
  repo = defaultRepoRoot,
  checkOnly = false,
  date,
  assertTag = assertTagAbsent,
  log = console.log,
  error = console.error,
} = {}) {
  if (!version) {
    throw new Error('missing required <version> argument.');
  }

  const repoRoot = path.resolve(repo);
  const nextVersion = parseSemver(version);
  if (!nextVersion) {
    throw new Error(
      `version "${version}" is not strict semver; expected X.Y.Z with an optional -prerelease.N suffix.`,
    );
  }
  const releaseDate = date ?? todayUtc();
  if (!datePattern.test(releaseDate)) {
    throw new Error(`date "${releaseDate}" is not YYYY-MM-DD.`);
  }

  const currentVersion = await readPackageVersion(repoRoot, currentVersionRelativePath);
  const currentParsed = parseSemver(currentVersion);
  if (!currentParsed) {
    throw new Error(`${currentVersionRelativePath}: current version "${currentVersion}" is not parseable semver.`);
  }

  const problems = [];
  if (compareSemver(nextVersion, currentParsed) <= 0) {
    problems.push(`version ${version} is not strictly greater than the current version ${currentVersion}.`);
  }

  for (const relativePath of versionedPackageRelativePaths) {
    const packageVersion = await readPackageVersion(repoRoot, relativePath);
    if (packageVersion !== currentVersion) {
      problems.push(
        `${relativePath} is at ${packageVersion} while ${currentVersionRelativePath} is at ${currentVersion}; all 7 package versions must agree before a release.`,
      );
    }
  }

  for (const relativePath of bakedVersionRelativePaths) {
    try {
      const bakedVersion = await readBakedVersion(repoRoot, relativePath);
      if (bakedVersion !== currentVersion) {
        problems.push(
          `${relativePath} is at ${bakedVersion} while ${currentVersionRelativePath} is at ${currentVersion}; baked VERSION literals must agree with the package versions before a release.`,
        );
      }
    } catch (caught) {
      problems.push(caught instanceof Error ? caught.message : String(caught));
    }
  }

  try {
    await assertTag(repoRoot, `v${version}`);
  } catch (caught) {
    problems.push(caught instanceof Error ? caught.message : String(caught));
  }

  const changelogPath = path.join(repoRoot, changelogRelativePath);
  const changelogSource = await readFile(changelogPath, 'utf8');
  const changelogLines = changelogSource.split('\n');
  const unreleased = findUnreleasedSection(changelogLines);
  if (!unreleased) {
    problems.push(`${changelogRelativePath}: no "## [Unreleased]" section found.`);
  } else if (!unreleasedHasContent(changelogLines, unreleased)) {
    problems.push(
      `${changelogRelativePath}: the [Unreleased] section has no content; accumulate release notes there before cutting a release.`,
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) error(`error: ${problem}`);
    return { ok: false, problems };
  }

  const mode = checkOnly ? 'check-only plan' : 'release preparation';
  log(`[cchistory] ${mode} for ${version} (current ${currentVersion}, date ${releaseDate})`);
  for (const relativePath of versionedPackageRelativePaths) {
    log(`[cchistory] ${checkOnly ? 'would bump' : 'bumped'} ${relativePath}: ${currentVersion} -> ${version}`);
  }
  for (const relativePath of bakedVersionRelativePaths) {
    log(`[cchistory] ${checkOnly ? 'would rewrite' : 'rewrote'} ${relativePath}: ${currentVersion} -> ${version}`);
  }
  log(
    `[cchistory] ${checkOnly ? 'would fold' : 'folded'} ${changelogRelativePath}: [Unreleased] -> [${version}] - ${releaseDate}, fresh empty [Unreleased] inserted`,
  );

  if (checkOnly) {
    log('[cchistory] check-only: no files written.');
    return { ok: true, checkOnly, version, currentVersion, date: releaseDate };
  }

  for (const relativePath of versionedPackageRelativePaths) {
    const targetPath = path.join(repoRoot, relativePath);
    const source = await readFile(targetPath, 'utf8');
    const { updated } = replaceTopLevelVersion(source, relativePath, version);
    await writeFile(targetPath, updated, 'utf8');
  }
  for (const relativePath of bakedVersionRelativePaths) {
    const targetPath = path.join(repoRoot, relativePath);
    const source = await readFile(targetPath, 'utf8');
    const { updated } = replaceBakedVersion(source, relativePath, version);
    await writeFile(targetPath, updated, 'utf8');
  }
  await writeFile(changelogPath, foldChangelog(changelogSource, version, releaseDate), 'utf8');
  const updatedCount = versionedPackageRelativePaths.length + bakedVersionRelativePaths.length + 1;
  log(`[cchistory] release preparation complete: ${updatedCount} files updated.`);
  return { ok: true, checkOnly, version, currentVersion, date: releaseDate, updatedCount };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
    return;
  }
  if (!args.version) {
    console.error('error: missing required <version> argument.\n');
    console.error(usage);
    process.exitCode = 1;
    return;
  }

  const result = await prepareRelease({
    version: args.version,
    repo: args.repo,
    checkOnly: args.checkOnly,
    date: args.date,
  });
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
