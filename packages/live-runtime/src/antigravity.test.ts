import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { UNASSIGNED_PROJECT_KEY, compileSql, scanLiteHistory, type ScanLiteHistoryOptions } from "./index.js";
import { LiveHistoryReader } from "./history-reader.js";

const fixtureRoot = fileURLToPath(new URL("../../../mock_data/fixtures/antigravity-sqlite/", import.meta.url));
const cases = JSON.parse(await readFile(path.join(fixtureRoot, "cases.json"), "utf8")) as {
  parent_id: string; child_id: string; assistant_only_id: string; parent_tokens: number; child_tokens: number;
  mixed_model_generation: { index: number; data_hex: string; model: string; total_tokens: number };
};
const parent = `sess:antigravity:${cases.parent_id}`;
const child = `sess:antigravity:${cases.child_id}`;

function options(root: string): ScanLiteHistoryOptions {
  return { homeDir: root, sourceRefs: ["antigravity"], sourceRoots: [{ sourceRef: "antigravity", baseDir: root }],
    safeMode: true, retainConversationEvidence: true, contextMode: "none",
    scanGuardDeps: { readAvailableBytes: () => 1024 ** 3, readHeapBytes: () => 1024 ** 3,
      lock: { lockPath: path.join(os.tmpdir(), "cchistory-antigravity-fixture.lock") } } };
}

test("Antigravity SQLite history, usage, delegated search and orphan messages preserve projection identity", async () => {
  const snapshot = await scanLiteHistory(options(fixtureRoot));
  assert.deepEqual(snapshot.projectionIssues, []);
  assert.deepEqual(snapshot.data.loss_audits, []);
  assert.equal(snapshot.listResolvedSessions().length, 3);
  assert.equal(snapshot.listTopLevelSessions().length, 2);
  assert.equal(snapshot.listSessionTurns(parent).length, 4);
  assert.equal(snapshot.listSessionTurns(child).length, 1);
  assert.ok(snapshot.listSessionRelatedWork(parent).some(work => work.child_session_ref === child));
  const match = snapshot.searchConversation({ query: "Child inspected", group_by: "message" }).results[0];
  assert.equal(match?.session_id, parent);
  assert.equal(match?.matched_session_id, child);
  assert.ok(snapshot.data.conversation_evidence?.some(message => message.session_id.endsWith(cases.assistant_only_id) && message.turn_id === null));
  const result = snapshot.executeCollectionQuery(await compileSql("SELECT id, total_tokens FROM sessions LIMIT 10"));
  assert.equal(result.rows.find(row => row.id === parent)?.total_tokens, cases.parent_tokens);
  assert.equal(result.rows.find(row => row.id === child)?.total_tokens, cases.child_tokens);
  assert.equal(result.rows.find(row => row.id === `sess:antigravity:${cases.assistant_only_id}`)?.total_tokens, 6);
  assert.equal(snapshot.getUsageOverview().total_tokens, cases.parent_tokens + cases.child_tokens + 6);
  assert.equal(snapshot.getUsageOverview({ include_known_zero_token: true }).total_turns, 5);
  const full = await scanLiteHistory({ ...options(fixtureRoot), contextMode: "full" });
  assert.deepEqual(full.projectionIssues, []);
  assert.deepEqual(full.executeCollectionQuery(await compileSql("SELECT id, total_tokens FROM sessions LIMIT 10")).rows, result.rows);
});

test("Antigravity collection refresh observes WAL changes with unchanged main-file mtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-runtime-wal-"));
  let writer: DatabaseSync | undefined;
  const reader = new LiveHistoryReader(overrides => scanLiteHistory({ ...options(root), ...overrides }));
  try {
    await cp(fixtureRoot, root, { recursive: true });
    const file = path.join(root, "conversations", `${cases.parent_id}.db`);
    writer = new DatabaseSync(file);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)");
    const mtime = (await stat(file)).mtimeMs;
    const sql = await compileSql("SELECT id, total_tokens FROM sessions LIMIT 10");
    const initial = await reader.collection(true);
    assert.equal(initial.executeCollectionQuery(sql).rows.find(row => row.id === parent)?.total_tokens, cases.parent_tokens);
    // Remove the later generation and its mirrored step usage in the same WAL.
    writer.exec("DELETE FROM gen_metadata WHERE idx = 90; DELETE FROM steps WHERE idx = 5");
    assert.equal((await stat(file)).mtimeMs, mtime);
    const refreshed = await reader.refresh();
    assert.deepEqual(refreshed.projectionIssues, []);
    assert.deepEqual(refreshed.data.loss_audits, []);
    assert.equal(refreshed.executeCollectionQuery(sql).rows.find(row => row.id === parent)?.total_tokens, 1165);
  } finally { reader.close(); writer?.close(); await rm(root, { recursive: true, force: true }); }
});

test("Antigravity model rollups attribute each call and count mixed-model turns once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-runtime-models-"));
  try {
    await cp(fixtureRoot, root, { recursive: true });
    const db = new DatabaseSync(path.join(root, "conversations", `${cases.parent_id}.db`));
    try {
      const generation = cases.mixed_model_generation;
      const data = Buffer.from(generation.data_hex, "hex");
      db.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)").run(generation.index, data, data.length);
    } finally { db.close(); }
    const snapshot = await scanLiteHistory(options(root));
    assert.deepEqual(snapshot.projectionIssues, []);
    assert.deepEqual(snapshot.data.loss_audits, []);
    const baselineTokens = cases.parent_tokens + cases.child_tokens + 6;
    const rollup = snapshot.getUsageRollup("model");
    assert.equal(rollup.rows.find(row => row.key === "gemini-fixture")?.total_tokens, baselineTokens);
    assert.equal(rollup.rows.find(row => row.key === cases.mixed_model_generation.model)?.total_tokens, cases.mixed_model_generation.total_tokens);
    const overview = snapshot.getUsageOverview();
    assert.equal(overview.total_tokens, baselineTokens + cases.mixed_model_generation.total_tokens);
    assert.equal(overview.total_turns, 4);
    assert.equal(snapshot.getUsageRollup("source").rows[0]?.turn_count, overview.total_turns);
    assert.equal(snapshot.getUsageRollup("day").rows[0]?.turn_count, overview.total_turns);
    assert.equal(rollup.rows.find(row => row.key === cases.mixed_model_generation.model)?.turn_count, 1);
    const project = snapshot.listSessionTurns(parent)[0]!.project_id!;
    assert.equal(snapshot.getUsageRollup("model", { project_id: project }).rows
      .find(row => row.key === cases.mixed_model_generation.model)?.total_tokens, cases.mixed_model_generation.total_tokens);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Antigravity turn-less assistant and delegated sessions link to their project when workspace metadata exists", async () => {
  const snapshot = await scanLiteHistory(options(fixtureRoot));
  assert.deepEqual(snapshot.projectionIssues, []);
  const parentSession = snapshot.getSession(parent);
  const childSession = snapshot.getSession(child);
  const assistantOnlySession = snapshot.getSession(`sess:antigravity:${cases.assistant_only_id}`);
  assert.ok(parentSession?.primary_project_id);
  assert.equal(childSession?.primary_project_id, parentSession.primary_project_id);
  assert.equal(assistantOnlySession?.turn_count, 0);
  if (assistantOnlySession?.working_directory) {
    assert.ok(assistantOnlySession.primary_project_id, "turn-less session with cwd should resolve primary_project_id");
    assert.equal(
      snapshot.getUsageRollup("project").rows.find((row) => row.key === UNASSIGNED_PROJECT_KEY),
      undefined,
    );
  }
});
