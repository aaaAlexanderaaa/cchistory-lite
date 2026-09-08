import { interpretSessionEvidence } from "@cchistory/canonical";
import assert from "node:assert/strict";
import fs from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, utimes } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertSourceFileReadPlanCurrent,
  getDefaultSourcesForHost,
  inspectSourceFilesLogicalSessionMetadata,
  runSourceProbe,
  SourceFileReadPlanChangedError,
} from "@cchistory/source-adapters";
import { buildLiveSnapshot, resolveLiteSources, scanLiteHistory } from "./index.js";
import { PreparationMetadata } from "./preparation-metadata.js";

const mockData = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../mock_data");
const codexFixture = path.join(mockData, "fixtures/source-shapes/codex/ordinary-fork.jsonl");
const parentFixture = path.join(mockData, ".codex/sessions/2026/04/12/rollout-2026-04-12T09-00-00-codex-delegation-parent.jsonl");
const later = new Date("2030-01-01T00:00:00.000Z");

async function seed() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-preparation-metadata-"));
  const source = getDefaultSourcesForHost({ homeDir: root, includeMissing: true }).find((entry) => entry.platform === "codex")!;
  return { root, source: { ...source, base_dir: root } };
}

test("preparation reuses unchanged metadata by source and path, preserving requested order", async () => {
  const { root, source } = await seed();
  try {
    const files = [path.join(root, "fork.jsonl"), path.join(root, "parent.jsonl")];
    await cp(codexFixture, files[0]!);
    await cp(parentFixture, files[1]!);
    const reads: string[][] = [];
    const preparation = new PreparationMetadata(async (platform, paths, options) => {
      reads.push([...paths]);
      return inspectSourceFilesLogicalSessionMetadata(platform, paths, options);
    });
    const options = { includeWorkspaceMetadata: true, workspaceScan: "first" as const };
    const first = await preparation.inspect(source, files, options);
    first.metadata[0]!.sessionKey = "caller-mutated";
    const reversed = await preparation.inspect(source, [files[1]!, files[0]!, files[1]!], options);
    assert.deepEqual(reads, [files]);
    assert.deepEqual(reversed.metadata.map((entry) => entry.sessionKey), [
      "sess:codex:codex-delegation-parent", "sess:codex:codex-ordinary-fork", "sess:codex:codex-delegation-parent",
    ]);
    assert.equal(reversed.evidence[0], first.evidence[0]);
    await preparation.inspect({ ...source, id: `${source.id}-other` }, [files[0]!], options);
    assert.equal(reads.length, 2, "different sources must not share an entry");

    // Excluded files still support earlier selection decisions even when only a subset is reused.
    await appendFile(files[0]!, "\n");
    await utimes(files[0]!, later, later);
    const subset = await preparation.inspect(source, [files[1]!], options);
    await assert.rejects(assertSourceFileReadPlanCurrent(subset.evidence[0]!), SourceFileReadPlanChangedError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("identity, first cwd, and full cwd remain separate metadata contracts", async () => {
  const { root, source } = await seed();
  try {
    const file = path.join(root, "changing-cwd.jsonl");
    await cp(codexFixture, file);
    // A later fixture record changes cwd: the first-line optimization must not answer a full scan.
    const laterRecord = (await readFile(parentFixture, "utf8")).split("\n")[0]!
      .replace("01:00:00", "02:00:00");
    await appendFile(file, `${laterRecord}\n`);
    await utimes(file, later, later);
    let reads = 0;
    const preparation = new PreparationMetadata(async (...args) => {
      reads += 1;
      return inspectSourceFilesLogicalSessionMetadata(...args);
    });
    const first = await preparation.inspect(source, [file], { workspaceScan: "first" });
    const full = await preparation.inspect(source, [file], {});
    const identity = await preparation.inspect(source, [file], { includeWorkspaceMetadata: false });
    assert.equal(first.metadata[0]?.workingDirectory, "/workspace/codex-ordinary-fork");
    assert.equal(full.metadata[0]?.workingDirectory, "/workspace/codex-delegated");
    assert.equal(identity.metadata[0]?.workingDirectoryState, "absent");
    assert.equal(identity.metadata[0]?.sessionKey, first.metadata[0]?.sessionKey);
    assert.deepEqual(await preparation.inspect(source, [file], { includeWorkspaceMetadata: true, workspaceScan: "full" }), full);
    assert.equal(reads, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata reuse rejects changed or removed evidence; a new attempt reads afresh", async () => {
  const { root, source } = await seed();
  try {
    const file = path.join(root, "fork.jsonl");
    await cp(codexFixture, file);
    let reads = 0;
    const inspect: ConstructorParameters<typeof PreparationMetadata>[0] = async (...args) => {
      reads += 1;
      return inspectSourceFilesLogicalSessionMetadata(...args);
    };
    const preparation = new PreparationMetadata(inspect);
    await preparation.inspect(source, [file], {});
    await appendFile(file, "\n");
    await utimes(file, later, later);
    await assert.rejects(preparation.inspect(source, [file], {}), SourceFileReadPlanChangedError);
    assert.equal(reads, 1);
    const fresh = new PreparationMetadata(inspect);
    await fresh.inspect(source, [file], {});
    assert.equal(reads, 2);
    await rm(file);
    await assert.rejects(fresh.inspect(source, [file], {}), SourceFileReadPlanChangedError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata changed during inspection is never admitted for reuse", async () => {
  const { root, source } = await seed();
  try {
    const file = path.join(root, "fork.jsonl");
    await cp(codexFixture, file);
    let reads = 0;
    const preparation = new PreparationMetadata(async (...args) => {
      reads += 1;
      const result = await inspectSourceFilesLogicalSessionMetadata(...args);
      if (reads === 1) {
        await appendFile(file, "\n");
        await utimes(file, later, later);
      }
      return result;
    });
    await assert.rejects(preparation.inspect(source, [file], {}), SourceFileReadPlanChangedError);
    await preparation.inspect(source, [file], {});
    assert.equal(reads, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reused uncertain metadata stays uncertain and newly appearing evidence invalidates it", async () => {
  const { root, source } = await seed();
  try {
    const missing = path.join(root, "missing.jsonl");
    let reads = 0;
    const preparation = new PreparationMetadata(async (...args) => {
      reads += 1;
      return inspectSourceFilesLogicalSessionMetadata(...args);
    });
    const first = await preparation.inspect(source, [missing], {});
    assert.equal(first.metadata[0]?.sessionKeyState, "uncertain");
    assert.equal(first.metadata[0]?.workingDirectoryState, "uncertain");
    assert.deepEqual(await preparation.inspect(source, [missing], {}), first);
    assert.equal(reads, 1);
    await cp(codexFixture, missing);
    await assert.rejects(preparation.inspect(source, [missing], {}), SourceFileReadPlanChangedError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sample --dir reuses Claude metadata while preserving projection and refresh isolation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-preparation-sample-"));
  const originalCreateReadStream = fs.createReadStream;
  const file = path.join(root, "projects/-workspace-claude-resume/ordinary.jsonl");
  let reads = 0;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await cp(path.join(mockData, "fixtures/source-shapes/claude/ordinary-parent-uuid.jsonl"), file);
    const baseDir = path.join(root, "projects");
    const options = {
      homeDir: root,
      sourceRefs: ["claude_code"],
      sourceRoots: [{ sourceRef: "claude_code", baseDir }],
      directoryScope: "/workspace/claude-resume",
      sample: { perSource: 1 },
      safeMode: true,
      contextMode: "none" as const,
    };
    const expected = buildLiveSnapshot(await runSourceProbe(interpretSessionEvidence, { safe_mode: true }, await resolveLiteSources(options)));
    t.mock.method(fs, "createReadStream", ((target, streamOptions) => {
      if (target === file) reads += 1;
      return originalCreateReadStream(target, streamOptions);
    }) as typeof fs.createReadStream);
    syncBuiltinESMExports();
    const actual = await scanLiteHistory(options);
    assert.equal(reads, 1, "the sample and logical grouping must share one full metadata read");
    assert.deepEqual(actual.listResolvedSessions(), expected.listResolvedSessions());
    assert.deepEqual(actual.listResolvedTurns(), expected.listResolvedTurns());
    assert.deepEqual(actual.projectionIssues, []);
    await scanLiteHistory(options);
    assert.equal(reads, 2, "refresh must own a fresh preparation");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
