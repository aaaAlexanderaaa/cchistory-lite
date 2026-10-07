import { runSourceProbe } from "../probe-reference.test.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  getDefaultSourcesForHost,
  listSourceFiles,
} from "../index.js";
import { createSourceDefinition, getRepoMockDataRoot } from "../test-helpers.js";
import {
  grokBotAdapter,
  isGrokBotStorePath,
  isGrokBotTranscriptPath,
  parseGrokBotAgentIdFromPath,
  shouldMatchGrokBotTranscript,
} from "./grok-bot.js";

const STORE_AGENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01";
const EMPTY_AGENT = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const JSONL_ONLY = "cccccccc-dddd-4eee-8fff-111111111111";
const fixtureRoot = path.join(getRepoMockDataRoot(), "fixtures/grok-bot");

function seedStore(dbPath: string, messages: Array<Record<string, unknown>>): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE transcript_entries (
      seq INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      entry TEXT NOT NULL
    );
  `);
  const insert = db.prepare("INSERT INTO transcript_entries (seq, id, entry) VALUES (?, ?, ?)");
  let seq = 1;
  for (const message of messages) {
    insert.run(seq++, String(message.id ?? seq), JSON.stringify(message));
  }
  db.close();
}

test("[grok_bot] default candidates include agent-data and sand-data", () => {
  const candidates = grokBotAdapter.getDefaultBaseDirCandidates({ homeDir: "/home/fixture" });
  assert.deepEqual(candidates, [
    "/home/fixture/agent-data",
    "/home/fixture/sand-data",
    "/home/fixture/.agent-data",
    "/home/fixture/.sand-data",
  ]);
  assert.equal(grokBotAdapter.platform, "grok_bot");
  assert.equal(grokBotAdapter.supportTier, "experimental");
});

test("[grok_bot] path helpers recognize store and transcript layouts", () => {
  const storePath = `/data/agents/${STORE_AGENT}/store.db`;
  const transcriptPath = `/data/agent-transcripts/${STORE_AGENT}/${STORE_AGENT}.jsonl`;
  assert.equal(isGrokBotStorePath(storePath), true);
  assert.equal(isGrokBotTranscriptPath(transcriptPath), true);
  assert.equal(parseGrokBotAgentIdFromPath(storePath), STORE_AGENT);
  assert.equal(parseGrokBotAgentIdFromPath(transcriptPath), STORE_AGENT);
});

test("[grok_bot] fixture corpus: store preferred, jsonl-only retained, empty store skipped", async () => {
  const source = createSourceDefinition("src-grok-bot-fixture", "grok_bot", fixtureRoot);
  const files = await listSourceFiles("grok_bot", fixtureRoot);
  assert.ok(files.some((file) => file.endsWith(`${STORE_AGENT}/store.db`)));
  assert.ok(files.some((file) => file.endsWith(`${JSONL_ONLY}.jsonl`)));
  // Overlapping transcript for the store agent must not be matched when store has rows.
  assert.equal(
    files.some((file) => file.includes(STORE_AGENT) && file.endsWith(".jsonl")),
    false,
  );
  assert.equal(shouldMatchGrokBotTranscript(path.join(fixtureRoot, "agent-transcripts", STORE_AGENT, `${STORE_AGENT}.jsonl`)), false);

  const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
  assert.ok(payload);
  assert.equal(payload.source.sync_status, "healthy");

  const sessionIds = payload.sessions.map((session) => session.source_session_id).sort();
  assert.deepEqual(sessionIds, [JSONL_ONLY, STORE_AGENT].sort());
  assert.equal(payload.sessions.some((session) => session.source_session_id === EMPTY_AGENT), false);

  const storeSession = payload.sessions.find((session) => session.source_session_id === STORE_AGENT);
  assert.ok(storeSession);
  assert.equal(storeSession.title, "Fixture Bot");
  const storeTurn = payload.turns.find((turn) => turn.session_id === storeSession.id);
  assert.ok(storeTurn);
  assert.match(storeTurn.canonical_text, /workspace map/u);
  assert.equal(
    payload.turns.some((turn) => turn.canonical_text.includes("should not win over store")),
    false,
  );

  const jsonlSession = payload.sessions.find((session) => session.source_session_id === JSONL_ONLY);
  assert.ok(jsonlSession);
  const jsonlTurn = payload.turns.find((turn) => turn.session_id === jsonlSession.id);
  assert.ok(jsonlTurn);
  assert.match(jsonlTurn.canonical_text, /Jsonl-only session/u);
});

test("[grok_bot] missing root degrades safely", async () => {
  const missing = path.join(os.tmpdir(), `cchistory-grok-bot-missing-${process.pid}`);
  const source = createSourceDefinition("src-grok-bot-missing", "grok_bot", missing);
  const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
  assert.ok(payload);
  assert.equal(payload.sessions.length, 0);
  assert.equal(payload.turns.length, 0);
});

test("[grok_bot] empty root degrades safely", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-grok-bot-empty-"));
  try {
    await mkdir(path.join(tempRoot, "agents"), { recursive: true });
    await mkdir(path.join(tempRoot, "agent-transcripts"), { recursive: true });
    const source = createSourceDefinition("src-grok-bot-empty", "grok_bot", tempRoot);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.sessions.length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("[grok_bot] malformed store.db degrades without inventing sessions", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-grok-bot-malformed-"));
  try {
    const agentId = "dddddddd-eeee-4fff-8111-222222222222";
    const agentDir = path.join(tempRoot, "agents", agentId);
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "store.db"), "not-a-sqlite-database", "utf8");
    const source = createSourceDefinition("src-grok-bot-malformed", "grok_bot", tempRoot);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.sessions.length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("[grok_bot] store-only and jsonl-only temp trees both project", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-grok-bot-shapes-"));
  try {
    const storeId = "11111111-2222-4333-8444-555555555555";
    const jsonlId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    const storeDir = path.join(tempRoot, "agents", storeId);
    await mkdir(storeDir, { recursive: true });
    seedStore(path.join(storeDir, "store.db"), [
      {
        kind: "message",
        id: "t0u",
        role: "user",
        content: "Store-only prompt",
        timestampMs: Date.parse("2026-10-07T11:00:00.000Z"),
      },
      {
        kind: "message",
        id: "t0a0",
        role: "assistant",
        content: "Store-only reply",
        timestampMs: Date.parse("2026-10-07T11:00:01.000Z"),
      },
    ]);
    await writeFile(path.join(storeDir, "profile.json"), JSON.stringify({ name: "Store Only" }), "utf8");

    const transcriptDir = path.join(tempRoot, "agent-transcripts", jsonlId);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${jsonlId}.jsonl`),
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "Jsonl-only prompt" }] },
      })}\n${JSON.stringify({
        role: "assistant",
        message: { content: [{ type: "text", text: "Jsonl-only reply" }] },
      })}\n`,
      "utf8",
    );

    const source = createSourceDefinition("src-grok-bot-shapes", "grok_bot", tempRoot);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.sessions.length, 2);
    assert.ok(payload.turns.some((turn) => turn.canonical_text === "Store-only prompt"));
    assert.ok(payload.turns.some((turn) => turn.canonical_text === "Jsonl-only prompt"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("[grok_bot] when both shapes exist for one agent, store wins", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-grok-bot-both-"));
  try {
    const agentId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
    const storeDir = path.join(tempRoot, "agents", agentId);
    await mkdir(storeDir, { recursive: true });
    seedStore(path.join(storeDir, "store.db"), [
      {
        kind: "message",
        id: "t0u",
        role: "user",
        content: "Preferred store text",
        timestampMs: Date.parse("2026-10-07T12:00:00.000Z"),
      },
      {
        kind: "message",
        id: "t0a0",
        role: "assistant",
        content: "Preferred store reply",
        timestampMs: Date.parse("2026-10-07T12:00:01.000Z"),
      },
    ]);
    const transcriptDir = path.join(tempRoot, "agent-transcripts", agentId);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${agentId}.jsonl`),
      `${JSON.stringify({
        role: "user",
        message: { content: [{ type: "text", text: "Duplicate jsonl text" }] },
      })}\n`,
      "utf8",
    );

    const files = await listSourceFiles("grok_bot", tempRoot);
    assert.ok(files.some((file) => file.endsWith("store.db")));
    assert.equal(files.some((file) => file.endsWith(".jsonl")), false);

    const source = createSourceDefinition("src-grok-bot-both", "grok_bot", tempRoot);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns[0]?.canonical_text, "Preferred store text");
    assert.equal(payload.turns.some((turn) => turn.canonical_text.includes("Duplicate jsonl")), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("[grok_bot] default discovery registers grok_bot slot", () => {
  const sources = getDefaultSourcesForHost({
    homeDir: "/tmp/cchistory-no-such-home",
    includeMissing: true,
  });
  const grokBot = sources.find((source) => source.platform === "grok_bot");
  assert.ok(grokBot);
  assert.equal(grokBot.slot_id, "grok_bot");
  assert.equal(grokBot.display_name, "Grok Bot");
});
