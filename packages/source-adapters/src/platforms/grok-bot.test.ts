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
import { splitUserText } from "../core/user-text.js";
import { createSourceDefinition, getRepoMockDataRoot } from "../test-helpers.js";
import {
  grokBotAdapter,
  isGrokBotStorePath,
  isGrokBotTranscriptPath,
  listGrokBotCompanionEvidencePaths,
  parseGrokBotAgentIdFromPath,
  shouldMatchGrokBotTranscript,
} from "./grok-bot.js";
import {
  cleanGrokBotUserTitleText,
  extractGrokBotProfileUpdateName,
  isGrokBotHiddenPromptText,
  resolveGrokBotSessionTitle,
  shortGrokBotAgentLabel,
} from "./grok-bot/title.js";

const STORE_AGENT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01";
const EMPTY_AGENT = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const JSONL_ONLY = "cccccccc-dddd-4eee-8fff-111111111111";
const EMPTY_STORE_JSONL = "dddddddd-eeee-4fff-8111-222222222222";
const DELETED_AGENT = "eeeeeeee-ffff-4111-8222-333333333333";
const MISSING_PROFILE = "ffffffff-1111-4222-8333-444444444444";
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

test("[grok_bot] companions omit opaque conversation-blobs.db", () => {
  const storePath = `/data/agents/${STORE_AGENT}/store.db`;
  const companions = listGrokBotCompanionEvidencePaths("/data", storePath);
  assert.ok(companions.some((entry) => entry.endsWith("profile.json")));
  assert.equal(companions.some((entry) => entry.endsWith("conversation-blobs.db")), false);
});

test("[grok_bot] title helpers strip hidden prompts and prefer profile update names", () => {
  assert.equal(isGrokBotHiddenPromptText("[SAND_HIDDEN_PROMPT][first run] hi"), true);
  assert.equal(isGrokBotHiddenPromptText("normal user text"), false);
  assert.equal(cleanGrokBotUserTitleText("[t0u]\nMap the workspace"), "Map the workspace");
  assert.equal(cleanGrokBotUserTitleText("[SAND_HIDDEN_PROMPT]nope"), undefined);

  const token = Buffer.from(JSON.stringify({ name: "Recovered Name" }), "utf8").toString("base64url");
  assert.equal(
    extractGrokBotProfileUpdateName(`[SAND_HIDDEN_PROMPT]<<SAND_AGENT_PROFILE_UPDATE:v1:${token}>>`),
    "Recovered Name",
  );

  const title = resolveGrokBotSessionTitle({
    agentId: DELETED_AGENT,
    profileUpdateName: "Recovered Name",
    firstUserText: "[t0u]\nShould not win",
    truncate: (value, length) => value.slice(0, length),
  });
  assert.equal(title, "Recovered Name");
  assert.equal(shortGrokBotAgentLabel(DELETED_AGENT), "eeeeeeee");
});

test("[grok_bot] SAND_HIDDEN_PROMPT user_query chunks are injected, not authored", () => {
  const text = [
    "<timestamp>Wednesday, Oct 7, 2026, 1:00 PM (UTC+8)</timestamp>",
    "<user_query>",
    "[SAND_HIDDEN_PROMPT][first run] This is your very first turn.",
    "</user_query>",
  ].join("\n");
  const chunks = splitUserText(text, { platform: "grok_bot" });
  assert.equal(chunks.some((chunk) => chunk.originKind === "user_authored"), false);
  assert.equal(
    chunks.some((chunk) => chunk.originKind === "injected_user_shaped" && chunk.text.includes("SAND_HIDDEN_PROMPT")),
    true,
  );
});

test("[grok_bot] fixture corpus: store preferred, titles cleaned, empty store skipped", async () => {
  const source = createSourceDefinition("src-grok-bot-fixture", "grok_bot", fixtureRoot);
  const files = await listSourceFiles("grok_bot", fixtureRoot);
  assert.ok(files.some((file) => file.endsWith(`${STORE_AGENT}/store.db`)));
  assert.ok(files.some((file) => file.endsWith(`${JSONL_ONLY}.jsonl`)));
  assert.ok(files.some((file) => file.endsWith(`${EMPTY_STORE_JSONL}.jsonl`)));
  assert.ok(files.some((file) => file.endsWith(`${DELETED_AGENT}.jsonl`)));
  assert.ok(files.some((file) => file.endsWith(`${MISSING_PROFILE}.jsonl`)));
  // Overlapping transcript for the store agent must not be matched when store has rows.
  assert.equal(
    files.some((file) => file.includes(STORE_AGENT) && file.endsWith(".jsonl")),
    false,
  );
  assert.equal(shouldMatchGrokBotTranscript(path.join(fixtureRoot, "agent-transcripts", STORE_AGENT, `${STORE_AGENT}.jsonl`)), false);
  // Empty store allows jsonl match.
  assert.equal(
    shouldMatchGrokBotTranscript(path.join(fixtureRoot, "agent-transcripts", EMPTY_STORE_JSONL, `${EMPTY_STORE_JSONL}.jsonl`)),
    true,
  );

  const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
  assert.ok(payload);
  assert.equal(payload.source.sync_status, "healthy");

  const sessionIds = payload.sessions.map((session) => session.source_session_id).sort();
  assert.deepEqual(
    sessionIds,
    [DELETED_AGENT, EMPTY_STORE_JSONL, JSONL_ONLY, MISSING_PROFILE, STORE_AGENT].sort(),
  );
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

  const emptyStoreSession = payload.sessions.find((session) => session.source_session_id === EMPTY_STORE_JSONL);
  assert.ok(emptyStoreSession);
  assert.equal(emptyStoreSession.title, "Empty Store With Jsonl");
  assert.ok(payload.turns.some((turn) => turn.canonical_text.includes("Fallback jsonl after empty store")));

  const deletedSession = payload.sessions.find((session) => session.source_session_id === DELETED_AGENT);
  assert.ok(deletedSession);
  assert.equal(deletedSession.title, "Deleted Bot From Update");
  assert.doesNotMatch(deletedSession.title ?? "", /SAND_HIDDEN_PROMPT|first run/u);
  assert.ok(payload.turns.some((turn) => turn.session_id === deletedSession.id && /workspace roots/u.test(turn.canonical_text)));
  assert.equal(
    payload.turns.some((turn) => turn.session_id === deletedSession.id && turn.canonical_text.includes("SAND_HIDDEN_PROMPT")),
    false,
  );

  const missingSession = payload.sessions.find((session) => session.source_session_id === MISSING_PROFILE);
  assert.ok(missingSession);
  assert.match(missingSession.title ?? "", /Summarize the feeds layout/u);
  assert.doesNotMatch(missingSession.title ?? "", /SAND_HIDDEN_PROMPT|\[t0u\]/u);
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
    const agentId = "12121212-eeee-4fff-8111-222222222222";
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
    const storeSession = payload.sessions.find((session) => session.source_session_id === storeId);
    assert.equal(storeSession?.title, "Store Only");
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
