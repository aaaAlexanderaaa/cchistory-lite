import { runSourceProbe } from "../probe-reference.test.js";
import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp, rm, stat, truncate, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDefaultSourcesForHost} from "../index.js";
import { getRepoMockDataRoot } from "../test-helpers.js";
import {
  assertSourceFileReadPlanCurrent,
  createSourceFileReadPlan,
  SourceFileReadPlanChangedError,
} from "./file-read-plan.js";

const fixture = path.join(getRepoMockDataRoot(), "fixtures/source-shapes/codex/ordinary-fork.jsonl");

test("read plans deduplicate primary files and shared companions, respecting safe mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-read-plan-"));
  try {
    const source = getDefaultSourcesForHost({ homeDir: root, includeMissing: true }).find((entry) => entry.platform === "gemini")!;
    const chats = path.join(source.base_dir, "tmp/project/chats");
    await mkdir(chats, { recursive: true });
    const files = [path.join(chats, "a.json"), path.join(chats, "b.json")];
    for (const file of files) await cp(fixture, file);
    const companion = path.join(source.base_dir, "projects.json");
    await cp(path.join(getRepoMockDataRoot(), ".gemini/projects.json"), companion);
    const primaryBytes = (await stat(files[0]!)).size * 2;
    const full = await createSourceFileReadPlan(source, [...files, files[0]!], false);
    assert.deepEqual(full.files, files);
    assert.equal(full.bytes, primaryBytes + (await stat(companion)).size);
    assert.ok(full.companions[files[0]!]!.includes(companion));
    assert.ok(full.companions[files[1]!]!.includes(companion));
    assert.equal(full.versions[path.join(source.base_dir, "tmp/project/.project_root")], null);
    const safe = await createSourceFileReadPlan(source, files, true);
    assert.equal(safe.bytes, primaryBytes);
    assert.deepEqual(safe.companions[files[0]!], []);
    await assertSourceFileReadPlanCurrent(full);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite WAL and SHM count once even when companion capture is disabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-read-plan-"));
  try {
    const source = getDefaultSourcesForHost({ homeDir: root, includeMissing: true }).find((entry) => entry.platform === "zcode")!;
    const file = path.join(root, "db.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) await cp(fixture, `${file}${suffix}`);
    const expectedBytes = (await stat(file)).size * 3;
    for (const safeMode of [false, true]) {
      const plan = await createSourceFileReadPlan(source, [file], safeMode);
      assert.equal(plan.bytes, expectedBytes);
      assert.equal(Object.keys(plan.versions).length, 3);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read plans reject appended, removed, replaced, and newly appearing evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-read-plan-"));
  try {
    const source = getDefaultSourcesForHost({ homeDir: root, includeMissing: true }).find((entry) => entry.platform === "zcode")!;
    const file = path.join(root, "db.sqlite");
    await cp(fixture, file);
    let plan = await createSourceFileReadPlan(source, [file], true);
    await appendFile(file, "\n");
    const modified = new Date("2030-01-01T00:00:00.000Z");
    await utimes(file, modified, modified);
    await assert.rejects(assertSourceFileReadPlanCurrent(plan), SourceFileReadPlanChangedError);
    plan = await createSourceFileReadPlan(source, [file], true);
    await rm(file);
    await assert.rejects(assertSourceFileReadPlanCurrent(plan), SourceFileReadPlanChangedError);
    await cp(fixture, file);
    await assert.rejects(assertSourceFileReadPlanCurrent(plan), SourceFileReadPlanChangedError);
    plan = await createSourceFileReadPlan(source, [file], true);
    await cp(fixture, `${file}-wal`);
    await assert.rejects(assertSourceFileReadPlanCurrent(plan), SourceFileReadPlanChangedError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a probe consumes its plan without discovering newly added primary files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-read-plan-"));
  try {
    const defaultSource = getDefaultSourcesForHost({ homeDir: root, includeMissing: true }).find((entry) => entry.platform === "codex")!;
    const source = { ...defaultSource, base_dir: root };
    const file = path.join(root, "first.jsonl");
    await cp(fixture, file);
    const plan = await createSourceFileReadPlan(source, [file], true);
    await cp(fixture, path.join(root, "second.jsonl"));
    const readFiles: string[] = [];
    await runSourceProbe({
      safe_mode: true,
      source_file_plans: { [source.id]: plan },
      on_progress: (event) => {
        if (event.stage === "file_start" && event.file_path) readFiles.push(event.file_path);
      },
    }, [source]);
    assert.deepEqual(readFiles, [file]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("companion planning bounds Grok summary reads and retains uncertain parent evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-read-plan-grok-"));
  try {
    const sessions = path.join(root, "sessions");
    await cp(path.join(getRepoMockDataRoot(), "fixtures/grok-cli/sessions"), sessions, { recursive: true });
    const cwd = path.join(sessions, "%2Fworkspace%2Fgrok-fixture");
    const child = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const file = path.join(cwd, child, "chat_history.jsonl");
    await truncate(path.join(cwd, child, "summary.json"), 256 * 1024 ** 3);
    const defaultSource = getDefaultSourcesForHost({ homeDir: root, includeMissing: true }).find((entry) => entry.platform === "grok")!;
    const plan = await createSourceFileReadPlan({ ...defaultSource, base_dir: sessions }, [file], false);
    assert.ok(plan.bytes >= 256 * 1024 ** 3);
    assert.ok(plan.companions[file]!.includes(path.join(cwd, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "subagents", child, "meta.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
