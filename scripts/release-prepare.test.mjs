import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  bakedVersionRelativePaths,
  prepareRelease,
  replaceBakedVersion,
  versionedPackageRelativePaths,
} from "./release-prepare.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function bakedSource(version, { exported = true } = {}) {
  const prefix = exported ? "export " : "";
  return `/** comment */\n${prefix}const VERSION = "${version}";\n`;
}

async function writePackage(repo, relativePath, version) {
  const target = path.join(repo, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ name: relativePath, version }, null, 2)}\n`, "utf8");
}

async function createReleaseFixture(t, { version = "0.4.2", bakedVersion = version } = {}) {
  const scratchRoot = path.join(repositoryRoot, "tmp");
  await mkdir(scratchRoot, { recursive: true });
  const repo = await mkdtemp(path.join(scratchRoot, "release-prepare-"));
  t.after(async () => rm(repo, { recursive: true, force: true }));
  for (const relativePath of versionedPackageRelativePaths) {
    await writePackage(repo, relativePath, version);
  }
  await mkdir(path.join(repo, "apps", "lite-cli", "src"), { recursive: true });
  await mkdir(path.join(repo, "apps", "lite-tui", "src"), { recursive: true });
  await writeFile(path.join(repo, bakedVersionRelativePaths[0]), bakedSource(bakedVersion), "utf8");
  await writeFile(path.join(repo, bakedVersionRelativePaths[1]), bakedSource(bakedVersion), "utf8");
  await writeFile(
    path.join(repo, "CHANGELOG.md"),
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "### Added",
      "",
      "- next release notes",
      "",
      `## [${version}] - 2026-08-30`,
      "",
      "### Fixed",
      "",
      "- previous",
      "",
    ].join("\n"),
    "utf8",
  );
  return repo;
}

function captureLogs() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    log: (line) => stdout.push(line),
    error: (line) => stderr.push(line),
  };
}

async function runPrepare(repo, { version = "0.4.3", checkOnly = false, date = "2026-08-30" } = {}) {
  const logs = captureLogs();
  const result = await prepareRelease({
    version,
    repo,
    checkOnly,
    date,
    assertTag: async () => {},
    log: logs.log,
    error: logs.error,
  });
  return { ...result, stdout: logs.stdout.join("\n"), stderr: logs.stderr.join("\n") };
}

test("replaceBakedVersion rewrites the single VERSION assignment", () => {
  const source = bakedSource("0.4.2");
  const { currentVersion, updated } = replaceBakedVersion(source, "version.ts", "0.4.3");
  assert.equal(currentVersion, "0.4.2");
  assert.equal(updated, bakedSource("0.4.3"));
});

test("replaceBakedVersion accepts a non-exported VERSION assignment", () => {
  const source = bakedSource("0.4.2", { exported: false });
  const { updated } = replaceBakedVersion(source, "index.ts", "0.5.0");
  assert.equal(updated, bakedSource("0.5.0", { exported: false }));
});

test("replaceBakedVersion refuses zero or multiple VERSION assignments", () => {
  assert.throws(
    () => replaceBakedVersion("export const OTHER = \"0.4.2\";\n", "missing.ts", "0.4.3"),
    /expected exactly one/,
  );
  assert.throws(
    () => replaceBakedVersion(`${bakedSource("0.4.2")}${bakedSource("0.4.2")}`, "dup.ts", "0.4.3"),
    /expected exactly one/,
  );
});

test("workspace baked VERSION files match the rewriter contract and the CLI manifest", async () => {
  const current = JSON.parse(
    await readFile(path.join(repositoryRoot, "apps", "lite-cli", "package.json"), "utf8"),
  ).version;
  for (const relativePath of bakedVersionRelativePaths) {
    const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
    const { currentVersion, updated } = replaceBakedVersion(source, relativePath, "0.0.0-test");
    assert.equal(currentVersion, current, relativePath);
    assert.match(updated, /const VERSION = "0\.0\.0-test";/);
    assert.equal([...updated.matchAll(/^((?:export )?const VERSION = )"([^"]+)"(;)$/gm)].length, 1);
  }
});

test("release-prepare check-only does not write and a real run updates manifests, baked versions, and the changelog", async (t) => {
  const repo = await createReleaseFixture(t);
  const beforeCli = await readFile(path.join(repo, bakedVersionRelativePaths[0]), "utf8");
  const check = await runPrepare(repo, { checkOnly: true });
  assert.equal(check.ok, true, check.stderr);
  assert.ok(check.stdout.includes(`would rewrite ${bakedVersionRelativePaths[0]}`));
  assert.equal(await readFile(path.join(repo, bakedVersionRelativePaths[0]), "utf8"), beforeCli);
  assert.equal(JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")).version, "0.4.2");

  const applied = await runPrepare(repo);
  assert.equal(applied.ok, true, applied.stderr);
  assert.equal(applied.updatedCount, 10);
  assert.equal(JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")).version, "0.4.3");
  assert.equal(JSON.parse(await readFile(path.join(repo, "apps", "lite-tui", "package.json"), "utf8")).version, "0.4.3");
  assert.match(await readFile(path.join(repo, bakedVersionRelativePaths[0]), "utf8"), /const VERSION = "0\.4\.3";/);
  assert.match(await readFile(path.join(repo, bakedVersionRelativePaths[1]), "utf8"), /const VERSION = "0\.4\.3";/);
  const changelog = await readFile(path.join(repo, "CHANGELOG.md"), "utf8");
  assert.match(changelog, /## \[Unreleased\]/);
  assert.match(changelog, /## \[0\.4\.3\] - 2026-08-30/);
  assert.match(changelog, /next release notes/);
});

test("release-prepare refuses when a baked VERSION disagrees with the package versions", async (t) => {
  const repo = await createReleaseFixture(t, { bakedVersion: "0.4.1" });
  const result = await runPrepare(repo, { checkOnly: true });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /baked VERSION literals must agree/);
  assert.equal(JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")).version, "0.4.2");
});

test("release-prepare refuses when a baked VERSION assignment is missing", async (t) => {
  const repo = await createReleaseFixture(t);
  await writeFile(path.join(repo, bakedVersionRelativePaths[0]), "export const OTHER = \"0.4.2\";\n", "utf8");
  const result = await runPrepare(repo, { checkOnly: true });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /expected exactly one/);
});
