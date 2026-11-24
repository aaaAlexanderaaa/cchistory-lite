import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDefaultSourcesForHost, listSourceFiles } from "../index.js";
import { getPlatformAdapter, listPlatformAdapters, listPlatformAdaptersBySupportTier } from "../platforms/registry.js";
import { extractHermesSqliteSeeds } from "../platforms/hermes/sqlite.js";
import { getRepoMockDataRoot, createSourceDefinition, assertFragmentKinds } from "../test-helpers.js";
import { runSourceProbe } from "../probe-reference.test.js";

const hermesFixture = path.join(getRepoMockDataRoot(), "fixtures/hermes/state.sql");

async function withHermesRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-hermes-"));
  try {
    const sql = await readFile(hermesFixture, "utf8");
    const db = new DatabaseSync(path.join(root, "state.db"));
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function hermesSource(baseDir: string) {
  return createSourceDefinition("src-hermes", "hermes", baseDir);
}

test("[hermes] registers as an experimental SQLite-container source", () => {
  const adapter = getPlatformAdapter("hermes");
  assert.ok(adapter);
  assert.equal(adapter.supportTier, "experimental");
  assert.equal(adapter.sessionTargeting, "container");
  assert.equal(adapter.projectionBoundary, "source");
  assert.ok(listPlatformAdapters().some((entry) => entry.platform === "hermes"));
  assert.deepEqual(
    listPlatformAdaptersBySupportTier("experimental").map((entry) => entry.platform).includes("hermes"),
    true,
  );
  assert.ok(adapter.matchesSourceFile("/tmp/hermes/state.db"));
  assert.equal(adapter.matchesSourceFile("/tmp/hermes/state.db-wal"), false);
  assert.deepEqual(adapter.getDefaultBaseDirCandidates({ homeDir: "/Users/tester", env: {} }), [
    "/Users/tester/.hermes",
  ]);
  assert.deepEqual(
    adapter.getDefaultBaseDirCandidates({ homeDir: "/Users/tester", env: { HERMES_HOME: "/opt/hermes-home" } })[0],
    "/opt/hermes-home",
  );

  const sources = getDefaultSourcesForHost({
    homeDir: "/Users/tester",
    hostname: "hermes-test-host",
    platform: "darwin",
    env: {},
    pathExists: (targetPath) => targetPath === path.join("/Users/tester", ".hermes"),
  });
  const resolved = sources.find((source) => source.platform === "hermes");
  assert.ok(resolved);
  assert.equal(resolved.display_name, "Hermes Agent");
  assert.equal(resolved.family, "local_coding_agent");
});

test("[hermes] named profile stores are discovered beside the default profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-hermes-profiles-"));
  try {
    await mkdir(path.join(root, "profiles", "coder"), { recursive: true });
    await mkdir(path.join(root, "profiles", "work"), { recursive: true });
    for (const target of [
      path.join(root, "state.db"),
      path.join(root, "profiles", "coder", "state.db"),
      path.join(root, "profiles", "work", "state.db"),
    ]) {
      const db = new DatabaseSync(target);
      try {
        db.exec("CREATE TABLE sessions (id TEXT); CREATE TABLE messages (id INTEGER);");
      } finally {
        db.close();
      }
    }
    const files = await listSourceFiles("hermes", root);
    assert.deepEqual(files, [
      path.join(root, "state.db"),
      path.join(root, "profiles", "coder", "state.db"),
      path.join(root, "profiles", "work", "state.db"),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[hermes] fixture sessions project turns, collapsed reasoning, tools, lineage, and session usage", async () => {
  await withHermesRoot(async (root) => {
    const source = hermesSource(root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.sessions.length, 3);

    const main = payload.sessions.find((session) => session.id === "sess:hermes:sess_fixture_hermes_main");
    assert.ok(main);
    assert.equal(main.title, "Retry review in Hermes");
    assert.equal(main.model, "mock-hermes-1");
    assert.equal(main.working_directory, "/Users/mock_user/workspace/hermes-lab");
    assert.equal(main.turn_count, 3);
    const mainTurns = payload.turns.filter((turn) => turn.session_id === main.id);
    assert.deepEqual(mainTurns.map((turn) => turn.canonical_text), [
      "Find the retry helper and explain the backoff.",
      "Now compare providers.",
      "Please fix the flaky retry test.",
    ]);

    const child = payload.sessions.find((session) => session.id === "sess:hermes:sess_fixture_hermes_child");
    assert.ok(child);
    assert.equal(child.turn_count, 1);
    const reset = payload.sessions.find((session) => session.id === "sess:hermes:sess_fixture_hermes_reset");
    assert.ok(reset);
    assert.equal(reset.turn_count, 1);

    assertFragmentKinds(payload, ["title_signal", "workspace_signal", "model_signal", "text", "tool_call", "tool_result", "token_usage_signal"]);

    const reasoning = payload.fragments.filter(
      (fragment) => fragment.fragment_kind === "text" && fragment.payload.source_content_type === "reasoning",
    );
    assert.equal(reasoning.length >= 2, true);
    assert.equal(reasoning.every((fragment) => fragment.payload.display_policy === "collapse"), true);
    assert.ok(reasoning.some((fragment) => String(fragment.payload.text).includes("retry helper")));

    const toolCalls = payload.fragments.filter((fragment) => fragment.fragment_kind === "tool_call");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0]?.payload.tool_name, "read");
    assert.deepEqual(toolCalls[0]?.payload.input, { path: "src/retry.ts" });
    const toolResults = payload.fragments.filter((fragment) => fragment.fragment_kind === "tool_result");
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0]?.payload.call_id, "call_h1");
    assert.ok(String(toolResults[0]?.payload.output).includes("Math.min"));

    const relation = payload.fragments.find((fragment) => fragment.fragment_kind === "session_relation");
    assert.ok(relation);
    assert.equal(relation.session_ref, "sess:hermes:sess_fixture_hermes_child");
    assert.equal(relation.payload.parent_uuid, "sess_fixture_hermes_main");
    assert.equal(relation.payload.relation_source, "hermes_model_config_delegate");
    assert.equal(
      payload.fragments.filter((fragment) => fragment.fragment_kind === "session_relation").length,
      1,
      "branch/reset lineage must not create a delegated relation",
    );
    assert.ok(payload.loss_audits.some((audit) => audit.diagnostic_code === "hermes_lineage_continuation"));

    const usage = payload.fragments.filter((fragment) => fragment.fragment_kind === "token_usage_signal");
    assert.equal(usage.length, 4);
    assert.equal(usage.every((fragment) => fragment.payload.scope === "session"), true);
    assert.equal(
      usage.every((fragment) => typeof fragment.payload.independent_usage_event_id === "string"),
      true,
      "session/model usage survives a last turn without a text reply",
    );
    const mainUsage = usage
      .filter((fragment) => fragment.session_ref === "sess:hermes:sess_fixture_hermes_main")
      .map((fragment) => fragment.payload.token_usage as Record<string, number>);
    assert.equal(mainUsage.length, 2);
    const mainTokens = mainUsage.reduce((sum, item) => sum + (item.total_tokens ?? 0), 0);
    assert.equal(mainTokens, 2_960, "reasoning is a subset of output and must not be added twice");
    assert.equal(mainUsage.reduce((sum, item) => sum + (item.input_tokens ?? 0), 0), 300);
    assert.equal(mainUsage.reduce((sum, item) => sum + (item.cache_read_input_tokens ?? 0), 0), 2_500);
    assert.equal(mainUsage.reduce((sum, item) => sum + (item.reasoning_output_tokens ?? 0), 0), 40);

    assert.ok(payload.loss_audits.some((audit) => audit.diagnostic_code === "hermes_image_content_not_projected"));
    const hidden = payload.fragments.filter((fragment) => String(fragment.payload.text ?? "").includes("hidden audit note"));
    assert.deepEqual(hidden, []);
    const rewound = payload.turns.filter((turn) => turn.canonical_text.includes("rewound prompt"));
    assert.deepEqual(rewound, []);
    assert.equal(
      payload.turns.some((turn) => turn.canonical_text.includes("CONTEXT COMPACTION")),
      false,
      "compression summaries must not become user turns",
    );
    assert.ok(
      syntheticTextOf(payload).some((text) => text.includes("[CONTEXT COMPACTION — REFERENCE ONLY]")),
      "standalone and merged compression summaries remain collapsed system evidence",
    );
    assert.ok(
      syntheticTextOf(payload).some((text) => text.includes("Older summary of the retry work.")),
      "the merged carrier's summary suffix is collapsed, not a user turn",
    );
    assert.ok(
      syntheticTextOf(payload).some((text) => text.includes("Turn failed: provider timeout.")),
      "display-only failed-turn rows remain evidence, not assistant replies",
    );
  });
});

test("[hermes] targeted reads resolve one session and reject unknown refs", async () => {
  await withHermesRoot(async (root) => {
    const source = hermesSource(root);
    const [payload] = (
      await runSourceProbe({ source_ids: [source.id], target_session_refs: ["sess:hermes:sess_fixture_hermes_reset"] }, [source])
    ).sources;
    assert.ok(payload);
    assert.deepEqual(payload.sessions.map((session) => session.id), ["sess:hermes:sess_fixture_hermes_reset"]);
    assert.deepEqual(payload.turns.map((turn) => turn.canonical_text), ["Continue after compression."]);

    await assert.rejects(
      runSourceProbe({ source_ids: [source.id], target_session_refs: ["sess_missing"] }, [source]),
      /requested session/u,
    );
  });
});

test("[hermes] older stores without optional columns still project the transcript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-hermes-old-"));
  try {
    const dbPath = path.join(root, "state.db");
    const db = new DatabaseSync(dbPath);
    try {
      // Pre-title/pre-model_config schema: only the columns AppendMessage always wrote.
      db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT,
          parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL,
          input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0);
        CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
          role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL, active INTEGER DEFAULT 1);
        INSERT INTO sessions VALUES ('sess_old', 'cli', 'mock-hermes-old', NULL, 1760000000.0, NULL, 10, 2);
        INSERT INTO messages (session_id, role, content, timestamp) VALUES
          ('sess_old', 'user', 'Old schema prompt.', 1760000001.0),
          ('sess_old', 'assistant', 'Old schema reply.', 1760000002.0);
      `);
    } finally {
      db.close();
    }
    const seeds = extractHermesSqliteSeeds(dbPath);
    assert.equal(seeds.length, 1);
    const source = hermesSource(root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.deepEqual(payload.turns.map((turn) => turn.canonical_text), ["Old schema prompt."]);
    assert.ok(payload.fragments.some((fragment) =>
      fragment.fragment_kind === "token_usage_signal"
      && typeof fragment.payload.independent_usage_event_id === "string"
      && (fragment.payload.token_usage as Record<string, number>).total_tokens === 12,
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[hermes] an unrecognized SQLite schema is reported instead of guessed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-hermes-unknown-"));
  try {
    const dbPath = path.join(root, "state.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY);");
    } finally {
      db.close();
    }
    assert.throws(() => extractHermesSqliteSeeds(dbPath), /Unrecognized Hermes Agent SQLite schema/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function syntheticTextOf(payload: { fragments: Array<{ fragment_kind: string; payload: Record<string, unknown> }> }): string[] {
  return payload.fragments
    .filter(
      (fragment) =>
        fragment.fragment_kind === "text"
        && fragment.payload.display_policy === "collapse"
        && fragment.payload.source_content_type !== "reasoning",
    )
    .map((fragment) => String(fragment.payload.text ?? ""));
}

test("[hermes] a parent target includes its delegated child and Windows uses LOCALAPPDATA", async () => {
  await withHermesRoot(async (root) => {
    const source = hermesSource(root);
    const [payload] = (
      await runSourceProbe(
        { source_ids: [source.id], target_session_refs: ["sess:hermes:sess_fixture_hermes_main"] },
        [source],
      )
    ).sources;
    assert.ok(payload);
    assert.deepEqual(
      payload.sessions.map((session) => session.id).sort(),
      [
        "sess:hermes:sess_fixture_hermes_child",
        "sess:hermes:sess_fixture_hermes_main",
        "sess:hermes:sess_fixture_hermes_reset",
      ],
      "a parent target keeps delegated children and compression continuations resolvable",
    );
    assert.ok(payload.fragments.some((fragment) => fragment.fragment_kind === "session_relation"));
  });

  const localAppData = "C:/Users/tester/AppData/Local";
  const localRoot = `${localAppData}/hermes`;
  const sources = getDefaultSourcesForHost({
    homeDir: "C:/Users/tester",
    hostname: "hermes-win32-host",
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    pathExists: (targetPath) => targetPath === localRoot,
  });
  const resolved = sources.find((entry) => entry.platform === "hermes");
  assert.ok(resolved);
  assert.equal(resolved.base_dir, localRoot);
});
