import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileSql, scanLiteHistory, type LiveHistorySnapshot, type ScanLiteHistoryOptions } from "./index.js";
import { LiveHistoryReader } from "./history-reader.js";

const fixtureRoot = fileURLToPath(new URL("../../../mock_data/fixtures/grok-bot/", import.meta.url));
const cases = JSON.parse(await readFile(path.join(fixtureRoot, "review-cases.json"), "utf8")) as {
  agent_id: string;
  masking: { token_prefix: string; token_character: string; token_length: number; cut_padding_character: string;
    cut_padding_length: number; prompt: string; reply: string; timestamp_ms: number };
  source_isolation: { literal_prompts: string[]; mixed_prompts: string[] };
  fallback_cases: Array<{ name: string; entries?: unknown[]; raw_entry?: string; database_text?: string;
    missing_table?: boolean; diagnostic?: string }>;
};

async function copyAgentFixture(root: string): Promise<string> {
  for (const directory of ["agents", "agent-transcripts"]) {
    await mkdir(path.join(root, directory), { recursive: true });
    await cp(path.join(fixtureRoot, directory, cases.agent_id), path.join(root, directory, cases.agent_id), { recursive: true });
  }
  return path.join(root, "agents", cases.agent_id, "store.db");
}

function options(root: string): ScanLiteHistoryOptions {
  return { homeDir: root, sourceRefs: ["grok_bot"], sourceRoots: [{ sourceRef: "grok_bot", baseDir: root }],
    safeMode: true, contextMode: "full", retainConversationEvidence: true,
    scanGuard: { profile: "light" }, scanGuardDeps: { readAvailableBytes: () => 1024 ** 3,
      readHeapBytes: () => 1024 ** 3, lock: { lockPath: path.join(root, "scan.lock") } } };
}

function assertConversation(snapshot: LiveHistorySnapshot, prompt: string): void {
  assert.deepEqual(snapshot.projectionIssues, []);
  assert.equal(snapshot.listResolvedSessions().length, 1);
  assert.deepEqual(snapshot.listResolvedTurns().map(turn => turn.canonical_text), [prompt]);
  assert.equal(snapshot.data.conversation_evidence?.length, 2);
  assert.ok(snapshot.data.conversation_evidence?.every(message => message.session_id === `sess:grok_bot:${cases.agent_id}`));
}

test("Grok Bot reader refresh follows WAL inserts and deletes with unchanged main-file mtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-grok-bot-wal-"));
  let writer: DatabaseSync | undefined;
  const reader = new LiveHistoryReader(overrides => scanLiteHistory({ ...options(root), ...overrides }));
  try {
    const storePath = await copyAgentFixture(root);
    writer = new DatabaseSync(storePath);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)");
    const initialMtime = (await stat(storePath)).mtimeMs;
    assertConversation(await reader.collection(true), "Fallback jsonl after empty store.");

    const fixture = cases.masking;
    const insert = writer.prepare("INSERT INTO transcript_entries (seq, id, entry) VALUES (?, ?, ?)");
    for (const [index, role] of ["user", "assistant"].entries()) {
      insert.run(index + 1, `fixture-${role}`, JSON.stringify({ kind: "message", role,
        content: role === "user" ? fixture.prompt : fixture.reply, timestampMs: fixture.timestamp_ms + index * 1000 }));
    }
    assert.equal((await stat(storePath)).mtimeMs, initialMtime);
    const store = await reader.refresh();
    assertConversation(store, fixture.prompt);
    assert.deepEqual(store.data.loss_audits, []);

    writer.exec("DELETE FROM transcript_entries");
    assert.equal((await stat(storePath)).mtimeMs, initialMtime);
    const fallback = await reader.refresh();
    assertConversation(fallback, "Fallback jsonl after empty store.");
    assert.deepEqual(fallback.data.loss_audits, []);
  } finally { reader.close(); writer?.close(); await rm(root, { recursive: true, force: true }); }
});

test("Grok Bot fallback and retained parse losses preserve the runtime projection contract", async () => {
  for (const fixture of cases.fallback_cases) {
    const root = await mkdtemp(path.join(os.tmpdir(), "lite-grok-bot-fallback-"));
    try {
      const storePath = await copyAgentFixture(root);
      if (fixture.database_text) {
        await writeFile(storePath, fixture.database_text, "utf8");
      } else {
        const db = new DatabaseSync(storePath);
        try {
          if (fixture.missing_table) {
            db.exec("DROP TABLE transcript_entries");
          } else {
            const entries = fixture.raw_entry ? [fixture.raw_entry] : fixture.entries!.map(entry => JSON.stringify(entry));
            const insert = db.prepare("INSERT INTO transcript_entries (seq, id, entry) VALUES (?, ?, ?)");
            entries.forEach((entry, index) => insert.run(index + 1, `fixture-${index}`, entry));
          }
        } finally { db.close(); }
      }
      const snapshot = await scanLiteHistory(options(root));
      assertConversation(snapshot, "Fallback jsonl after empty store.");
      if (fixture.diagnostic) assert.ok(snapshot.data.loss_audits.some(audit => audit.diagnostic_code === fixture.diagnostic), fixture.name);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("Grok Bot assistant-only stores keep unbound evidence and supersede duplicate JSONL", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-grok-bot-assistant-"));
  try {
    const storePath = await copyAgentFixture(root);
    const db = new DatabaseSync(storePath);
    try {
      db.prepare("INSERT INTO transcript_entries (seq, id, entry) VALUES (?, ?, ?)").run(1, "fixture-assistant", JSON.stringify({
        kind: "message", role: "assistant", content: cases.masking.reply, timestampMs: cases.masking.timestamp_ms,
      }));
    } finally { db.close(); }
    const snapshot = await scanLiteHistory(options(root));
    assert.deepEqual(snapshot.projectionIssues, []);
    assert.equal(snapshot.listResolvedSessions().length, 1);
    assert.deepEqual(snapshot.listResolvedTurns(), []);
    assert.deepEqual(snapshot.data.loss_audits, []);
    assert.equal(snapshot.data.conversation_evidence?.length, 1);
    const evidence = snapshot.data.conversation_evidence?.[0];
    assert.equal(evidence?.role, "assistant");
    assert.equal(evidence?.turn_id, null);
    assert.equal(evidence?.session_id, `sess:grok_bot:${cases.agent_id}`);
    assert.equal(evidence?.text, cases.masking.reply);
    assert.equal(snapshot.search({ query: "Fallback" }).total, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Grok Bot retains the real query beside a hidden prompt in either envelope order", async () => {
  for (const text of cases.source_isolation.mixed_prompts) {
    const root = await mkdtemp(path.join(os.tmpdir(), "lite-grok-bot-mixed-query-"));
    try {
      await copyAgentFixture(root);
      await writeFile(path.join(root, "agent-transcripts", cases.agent_id, `${cases.agent_id}.jsonl`), [
        { role: "user", content: text }, { role: "assistant", content: cases.masking.reply },
      ].map(entry => JSON.stringify(entry)).join("\n"));
      const snapshot = await scanLiteHistory(options(root));
      assertConversation(snapshot, cases.masking.prompt);
      assert.deepEqual(snapshot.data.loss_audits, []);
      assert.equal(snapshot.data.conversation_evidence?.some(message => message.text.includes("SAND_HIDDEN_PROMPT")), false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});


test("Grok Bot sessions without cwd remain visible under directory scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-grok-bot-dir-scope-"));
  try {
    await copyAgentFixture(root);
    const snapshot = await scanLiteHistory(options(root));
    const sessions = snapshot.listResolvedSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.working_directory, undefined);
    assert.equal(snapshot.listResolvedSessions({ directoryScope: "/tmp" }).length, 1);
    assert.equal(snapshot.listResolvedSessions({ directoryScope: "/workspace" }).length, 1);
    const scope = snapshot.getDirectoryScopeDiagnostics("/tmp");
    assert.equal(scope?.matching_sessions, 1);
    assert.equal(scope?.unknown_directory_sessions, 0);
    assert.equal(scope?.directory_agnostic_sessions, 1);
    assert.equal(snapshot.search({ query: "Fallback", directoryScope: "/tmp" }).total, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex and Claude preserve literal Grok markers in turns, search, titles and evidence", async () => {
  const titles = await compileSql("SELECT title FROM sessions LIMIT 1");
  for (const platform of ["codex", "claude_code"] as const) {
    const fixturePath = path.join(fixtureRoot, "../source-shapes", platform === "codex"
      ? "codex/ordinary-fork.jsonl" : "claude/ordinary-parent-uuid.jsonl");
    const lines = (await readFile(fixturePath, "utf8")).trim().split("\n");
    for (const prompt of cases.source_isolation.literal_prompts) {
      const root = await mkdtemp(path.join(os.tmpdir(), "lite-grok-source-isolation-"));
      try {
        const records = lines.map(line => JSON.parse(line));
        const user = platform === "codex" ? records[1].payload : records[0].message;
        user.content[0].text = prompt;
        await writeFile(path.join(root, "fixture.jsonl"), records.map(record => JSON.stringify(record)).join("\n"));
        const snapshot = await scanLiteHistory({ ...options(root), sourceRefs: [platform],
          sourceRoots: [{ sourceRef: platform, baseDir: root }] });
        assert.deepEqual(snapshot.projectionIssues, []);
        assert.deepEqual(snapshot.data.loss_audits, []);
        assert.deepEqual(snapshot.listResolvedTurns().map(turn => turn.canonical_text), [prompt]);
        assert.equal(snapshot.search({ query: "credential" }).total, 1);
        assert.deepEqual(snapshot.executeCollectionQuery(titles).rows, [{ title: prompt }]);
        const evidence = snapshot.data.conversation_evidence?.filter(message => message.role === "user");
        assert.equal(evidence?.length, 1);
        assert.equal(evidence?.[0]?.text, prompt);
        assert.equal(evidence?.[0]?.turn_id, snapshot.listResolvedTurns()[0]?.id);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }
});

test("Grok Bot SQL titles use canonical masking while preserving the raw session title", async () => {
  for (const padding of ["", cases.masking.cut_padding_character.repeat(cases.masking.cut_padding_length) + " "]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "lite-grok-bot-sql-title-"));
    try {
      const storePath = await copyAgentFixture(root);
      const fixture = cases.masking;
      const token = fixture.token_prefix + fixture.token_character.repeat(fixture.token_length);
      await rm(path.join(path.dirname(storePath), "profile.json"));
      await writeFile(path.join(root, "agent-transcripts", cases.agent_id, `${cases.agent_id}.jsonl`), [
        { role: "user", content: `${padding}${token} ${fixture.prompt}` }, { role: "assistant", content: fixture.reply },
      ].map(entry => JSON.stringify(entry)).join("\n"));
      const snapshot = await scanLiteHistory(options(root));
      assertConversation(snapshot, padding ? `${padding} ${fixture.prompt}` : fixture.prompt);
      assert.ok(snapshot.listResolvedSessions()[0]?.title?.includes(fixture.token_prefix));
      const result = snapshot.executeCollectionQuery(await compileSql("SELECT title FROM sessions LIMIT 1"));
      if (padding) {
        const title = result.rows[0]?.title;
        assert.equal(typeof title, "string");
        assert.ok((title as string).startsWith(padding.trim()));
        assert.ok((title as string).includes("Rotate"));
        assert.equal((title as string).includes(fixture.token_prefix), false);
        await writeFile(path.join(path.dirname(storePath), "profile.json"), JSON.stringify({ name: token }));
        const masked = await scanLiteHistory(options(root));
        assert.deepEqual(masked.executeCollectionQuery(await compileSql("SELECT title FROM sessions LIMIT 1")).rows, [{ title: "" }]);
      } else {
        assert.deepEqual(result.rows, [{ title: fixture.prompt }]);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
