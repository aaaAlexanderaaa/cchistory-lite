import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listSourceFiles } from "../index.js";
import { extractOpenCodeSqliteSeeds } from "./opencode/sqlite.js";
import { getRepoMockDataRoot, createSourceDefinition, assertFragmentKinds } from "../test-helpers.js";
import { runSourceProbe } from "../probe-reference.test.js";

const sqliteFixtures = path.join(getRepoMockDataRoot(), "fixtures/opencode-sqlite");

async function withSqlite(
  fixtureName: "v1.sql" | "v2.sql" | "v2-presplit.sql",
  body: (root: string, dbPath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), `cchistory-opencode-${fixtureName}-`));
  try {
    const dbPath = path.join(root, "opencode.db");
    const sql = await readFile(path.join(sqliteFixtures, fixtureName), "utf8");
    execSql(dbPath, sql);
    await body(root, dbPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function execSql(dbPath: string, sql: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

function opencodeSource(baseDir: string) {
  return createSourceDefinition("src-opencode-sqlite", "opencode", baseDir);
}

test("[opencode] SQLite v1 message/part rows project turns, usage, tools, files, and a delegated child", async () => {
  await withSqlite("v1.sql", async (root) => {
    const source = opencodeSource(root);
    const files = await listSourceFiles("opencode", root);
    assert.deepEqual(files, [path.join(root, "opencode.db")]);

    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    const parent = payload.sessions.find((session) => session.id === "sess:opencode:ses_fixture_v1_main");
    assert.ok(parent);
    assert.equal(parent.title, "Retry helper review");
    assert.equal(parent.working_directory, "/Users/mock_user/workspace/opencode-lab");
    assert.equal(parent.turn_count, 1);
    const child = payload.sessions.find((session) => session.id === "sess:opencode:ses_fixture_v1_child");
    assert.ok(child);
    assert.equal(child.turn_count, 1);

    const parentTurns = payload.turns.filter((turn) => turn.session_id === parent.id);
    assert.equal(parentTurns.length, 1);
    assert.ok(parentTurns[0]?.canonical_text.includes("Find the retry helper and explain its backoff."));
    assert.ok(parentTurns[0]?.canonical_text.includes("[file] diagram.png"));
    assert.equal(parentTurns[0]?.canonical_text.includes("base64"), false);
    assert.equal(parentTurns[0]?.context_summary?.token_usage?.total_tokens, 1_175);

    assertFragmentKinds(payload, ["title_signal", "workspace_signal", "model_signal", "text", "tool_call", "tool_result"]);
    const toolResults = payload.fragments.filter((fragment) => fragment.fragment_kind === "tool_result");
    assert.equal(toolResults.length, 2);
    assert.equal(toolResults.some((fragment) => fragment.payload.is_error === true), true);
    assert.ok(toolResults.some((fragment) => String(fragment.payload.output).includes("ripgrep")));

    const relation = payload.fragments.find((fragment) => fragment.fragment_kind === "session_relation");
    assert.ok(relation);
    assert.equal(relation.session_ref, "sess:opencode:ses_fixture_v1_child");
    assert.equal(relation.payload.parent_uuid, "ses_fixture_v1_main");
  });
});

test("[opencode] SQLite v2 keeps assistant usage apart from compaction and projects system/shell evidence", async () => {
  await withSqlite("v2.sql", async (root) => {
    const source = opencodeSource(root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    const session = payload.sessions.find((candidate) => candidate.id === "sess:opencode:ses_fixture_v2_main");
    assert.ok(session);
    assert.equal(session.title, "Compare storage generations");
    assert.equal(session.model, "mock-opencode-v2");
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.turns[0]?.canonical_text, "Compare the two OpenCode storage generations.");
    assert.equal(payload.turns[0]?.context_summary?.token_usage?.total_tokens, 1_778);

    // The generic runtime applies assistant usage to its reply text rather than
    // emitting a standalone signal; the turn total proves compaction tokens
    // stayed out of reply accounting.
    assert.equal(payload.turns[0]?.context_summary?.token_usage?.total_tokens, 1_778);

    const toolResults = payload.fragments.filter((fragment) => fragment.fragment_kind === "tool_result");
    assert.equal(toolResults.length, 2);
    assert.equal(toolResults.some((fragment) => fragment.payload.is_error === true), true);
    assert.ok(toolResults.some((fragment) => String(fragment.payload.output).includes("SessionTable = ...")));

    const syntheticText = payload.fragments
      .filter((fragment) => fragment.fragment_kind === "text")
      .map((fragment) => String(fragment.payload.text ?? ""));
    assert.ok(syntheticText.some((text) => text.includes("Compact rules apply.")));
    assert.ok(syntheticText.some((text) => text.includes("Compacted summary text.")));
    assert.ok(syntheticText.some((text) => text.includes("$ npm test")));
    assert.ok(syntheticText.some((text) => text.includes("ok")));

    const compactionAudit = payload.loss_audits.find((audit) => audit.diagnostic_code === "opencode_compaction_usage_not_attributed");
    assert.ok(compactionAudit);
    assert.equal(compactionAudit.severity, "info");
  });
});

test("[opencode] pre-split v2 stores (session + session_message without seq) still project history", async () => {
  await withSqlite("v2-presplit.sql", async (root) => {
    const source = opencodeSource(root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.sessions.length, 1);
    const session = payload.sessions[0]!;
    assert.equal(session.id, "sess:opencode:ses_fixture_presplit");
    assert.equal(session.title, "Pre-split storage review");
    assert.equal(session.model, "mock-opencode-presplit");
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.turns[0]?.canonical_text, "Review the pre-split v2 store.");
    assert.equal(payload.turns[0]?.context_summary?.token_usage?.total_tokens, 840);
    assert.ok(
      payload.fragments.some(
        (fragment) => fragment.fragment_kind === "tool_result"
          && String(fragment.payload.output).includes("export const schema"),
      ),
    );
    assert.equal(payload.loss_audits.some((audit) => audit.severity === "warning"), false);
  });
});

test("[opencode] targeted SQLite reads filter native rows and keep delegated children with their parent", async () => {
  await withSqlite("v1.sql", async (root) => {
    const source = opencodeSource(root);
    const units: string[] = [];
    const budget = {
      admit(_bytes: number, unit: string): void {
        units.push(unit);
      },
      maximumUnitBytes(): number {
        return 64 * 1024 * 1024;
      },
    };

    const [childPayload] = (
      await runSourceProbe(
        { source_ids: [source.id], target_session_refs: ["sess:opencode:ses_fixture_v1_child"], read_budget: budget },
        [source],
      )
    ).sources;
    assert.ok(childPayload);
    assert.deepEqual(childPayload.sessions.map((session) => session.id), ["sess:opencode:ses_fixture_v1_child"]);
    assert.equal(units.filter((unit) => unit === "message rows").length, 1, "child target reads only its own messages");
    assert.equal(units.filter((unit) => unit === "part rows").length, 1, "child target reads only its own parts");

    units.length = 0;
    const [parentPayload] = (
      await runSourceProbe(
        { source_ids: [source.id], target_session_refs: ["sess:opencode:ses_fixture_v1_main"], read_budget: budget },
        [source],
      )
    ).sources;
    assert.ok(parentPayload);
    assert.deepEqual(
      parentPayload.sessions.map((session) => session.id).sort(),
      ["sess:opencode:ses_fixture_v1_child", "sess:opencode:ses_fixture_v1_main"],
      "a parent target includes its delegated child so family/related work stays resolvable",
    );
    assert.equal(units.filter((unit) => unit === "message rows").length, 2);

    await assert.rejects(
      runSourceProbe({ source_ids: [source.id], target_session_refs: ["ses_missing"] }, [source]),
      /requested session/u,
    );
  });
});

test("[opencode] the SQLite store suppresses only the legacy JSON sessions it actually covers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-opencode-mixed-"));
  try {
    execSql(path.join(root, "opencode.db"), await readFile(path.join(sqliteFixtures, "v2.sql"), "utf8"));
    const legacyDir = path.join(root, "storage", "session", "global");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "ses_fixture_v2_main.json"),
      JSON.stringify({ id: "ses_fixture_v2_main", title: "Legacy duplicate", time: { created: 1_770_001_000_000 } }),
      "utf8",
    );
    await writeFile(
      path.join(legacyDir, "ses_legacy_only.json"),
      JSON.stringify({ id: "ses_legacy_only", title: "Legacy only", time: { created: 1_770_002_000_000 } }),
      "utf8",
    );

    const source = opencodeSource(root);
    const files = await listSourceFiles("opencode", root);
    assert.deepEqual(files, [path.join(root, "opencode.db"), path.join(legacyDir, "ses_fixture_v2_main.json"), path.join(legacyDir, "ses_legacy_only.json")]);

    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.deepEqual(
      payload.sessions.map((session) => session.id).sort(),
      ["sess:opencode:ses_fixture_v2_main", "sess:opencode:ses_legacy_only"],
    );
    const sqliteSession = payload.sessions.find((session) => session.id === "sess:opencode:ses_fixture_v2_main");
    assert.equal(sqliteSession?.title, "Compare storage generations");
    assert.ok(
      payload.loss_audits.some((audit) => audit.diagnostic_code === "opencode_sqlite_supersedes_legacy_json"),
    );
    assert.equal(payload.loss_audits.some((audit) => audit.severity === "warning"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[opencode] an empty or unreadable SQLite store leaves the legacy JSON history readable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-opencode-empty-"));
  try {
    const dbPath = path.join(root, "opencode.db");
    execSql(dbPath, await readFile(path.join(sqliteFixtures, "v2.sql"), "utf8"));
    execSql(dbPath, "DELETE FROM session_part; DELETE FROM session_message; DELETE FROM session_v2;");
    const legacyDir = path.join(root, "storage", "session", "global");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "ses_legacy_fallback.json"),
      JSON.stringify({ id: "ses_legacy_fallback", title: "Fallback session", time: { created: 1_770_003_000_000 } }),
      "utf8",
    );

    const source = opencodeSource(root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.deepEqual(payload.sessions.map((session) => session.id), ["sess:opencode:ses_legacy_fallback"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[opencode] an unrecognized SQLite schema is reported instead of guessed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-opencode-unknown-"));
  try {
    const dbPath = path.join(root, "opencode.db");
    execSql(dbPath, "CREATE TABLE unrelated (id TEXT PRIMARY KEY);");
    assert.throws(() => extractOpenCodeSqliteSeeds(dbPath), /Unrecognized OpenCode SQLite schema/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[opencode] a metadata-only migrated store does not hide the complete legacy JSON session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-opencode-partial-"));
  try {
    const dbPath = path.join(root, "opencode.db");
    execSql(dbPath, await readFile(path.join(sqliteFixtures, "v2.sql"), "utf8"));
    // Interrupted migration: sessions exist, conversation rows do not.
    execSql(dbPath, "DELETE FROM session_part; DELETE FROM session_message;");

    const storage = path.join(root, "storage");
    const sessionDir = path.join(storage, "session", "global");
    const messageDir = path.join(storage, "message", "ses_fixture_v2_main");
    const userPartDir = path.join(storage, "part", "msg_partial_user");
    const assistantPartDir = path.join(storage, "part", "msg_partial_assistant");
    for (const dir of [sessionDir, messageDir, userPartDir, assistantPartDir]) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(
      path.join(sessionDir, "ses_fixture_v2_main.json"),
      JSON.stringify({ id: "ses_fixture_v2_main", title: "Legacy partial recovery", time: { created: 1_770_000_000_000 } }),
      "utf8",
    );
    await writeFile(
      path.join(messageDir, "msg_partial_user.json"),
      JSON.stringify({ id: "msg_partial_user", sessionID: "ses_fixture_v2_main", role: "user", time: { created: 1_770_000_001_000 } }),
      "utf8",
    );
    await writeFile(
      path.join(userPartDir, "prt_partial_user.json"),
      JSON.stringify({ id: "prt_partial_user", type: "text", text: "Recovered prompt from JSON." }),
      "utf8",
    );
    await writeFile(
      path.join(messageDir, "msg_partial_assistant.json"),
      JSON.stringify({ id: "msg_partial_assistant", sessionID: "ses_fixture_v2_main", role: "assistant", time: { created: 1_770_000_002_000 } }),
      "utf8",
    );
    await writeFile(
      path.join(assistantPartDir, "prt_partial_assistant.json"),
      JSON.stringify({ id: "prt_partial_assistant", type: "text", text: "Recovered reply from JSON." }),
      "utf8",
    );

    const source = opencodeSource(root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.turns.length, 1, "the JSON copy stays readable when the SQLite store has no message rows");
    assert.equal(payload.turns[0]?.canonical_text, "Recovered prompt from JSON.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
