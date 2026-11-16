import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runSourceProbe } from "../probe-reference.test.js";
import { createSourceDefinition, getRepoMockDataRoot } from "../test-helpers.js";
import { extractAntigravitySqliteSeeds } from "./antigravity/sqlite.js";

const fixtureRoot = path.join(getRepoMockDataRoot(), "fixtures/antigravity-sqlite");
const cases = JSON.parse(await readFile(path.join(fixtureRoot, "cases.json"), "utf8")) as {
  parent_id: string; child_id: string; assistant_only_id: string; parent_tokens: number; child_tokens: number;
  first_usage: Record<string, number>;
  unanchored_generation_hex: string;
};
const source = (root: string) => createSourceDefinition("src-antigravity-sqlite", "antigravity", root);
const database = (root: string) => path.join(root, "conversations", `${cases.parent_id}.db`);

async function scratch(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-sqlite-"));
  try { await cp(fixtureRoot, root, { recursive: true }); await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("Antigravity SQLite retains literal repeated prompts and counts each generation once", async () => {
  const [payload] = (await runSourceProbe({ safe_mode: true }, [source(fixtureRoot)])).sources;
  assert.ok(payload);
  assert.deepEqual(payload.loss_audits, []);
  assert.equal(payload.sessions.length, 3);
  const turns = payload.turns.filter(turn => turn.session_id === `sess:antigravity:${cases.parent_id}`);
  assert.deepEqual(turns.map(turn => turn.canonical_text), ["Plan the fixture deployment.", "Continue the rollout.", "Continue the rollout.", "Inspect tool-only deployment."]);
  assert.equal(turns.reduce((total, turn) => total + (turn.context_summary.total_tokens ?? 0), 0), cases.parent_tokens);
  const usage = turns[0]!.context_summary.token_usage;
  for (const [key, expected] of Object.entries(cases.first_usage)) assert.equal((usage as unknown as Record<string, number>)[key], expected, key);
  assert.ok(payload.atoms.some(atom => atom.actor_kind === "assistant" && atom.payload.text === "Rollout finished."));
  assert.equal(payload.contexts.flatMap(context => context.tool_calls).length, 2);
  assert.equal(turns[3]?.context_summary.assistant_reply_count, 0);
  assert.equal(turns[3]?.context_summary.total_tokens, 15);
  const orphan = payload.sessions.find(session => session.id.endsWith(cases.assistant_only_id));
  assert.equal(orphan?.turn_count, 0);
});

test("Antigravity SQLite probing leaves source bytes and directory entries unchanged", async () => {
  await scratch(async root => {
    const files = (await readdir(path.join(root, "conversations"))).map(name => path.join(root, "conversations", name));
    files.push(path.join(root, "conversation_summaries.db"));
    const before = await Promise.all(files.map(file => readFile(file)));
    await runSourceProbe({ safe_mode: true }, [source(root)]);
    for (const [index, file] of files.entries()) assert.deepEqual(await readFile(file), before[index]);
    assert.equal((await readdir(path.join(root, "conversations"))).length, 3);
  });
});

test("Antigravity malformed generation evidence remains visible while step usage recovers", async () => {
  await scratch(async root => {
    const db = new DatabaseSync(database(root));
    try { db.exec("UPDATE gen_metadata SET data = x'ff' WHERE idx = 40"); } finally { db.close(); }
    const [payload] = (await runSourceProbe({ safe_mode: true }, [source(root)])).sources;
    assert.ok(payload);
    assert.ok(payload.loss_audits.some(audit => audit.diagnostic_code === "antigravity_invalid_generation"));
    assert.ok(payload.records.some(record => record.raw_json.includes('"data":"/w=="')));
    assert.equal(payload.turns.filter(turn => turn.session_id.endsWith(cases.parent_id))
      .reduce((total, turn) => total + (turn.context_summary.total_tokens ?? 0), 0), cases.parent_tokens);
  });
});

test("Antigravity malformed steps and future step formats retain opaque source evidence", async () => {
  await scratch(async root => {
    const db = new DatabaseSync(database(root));
    try { db.exec("UPDATE steps SET metadata = x'ff' WHERE idx = 1; UPDATE steps SET step_format = 99 WHERE idx = 5"); }
    finally { db.close(); }
    const [payload] = (await runSourceProbe({ safe_mode: true }, [source(root)])).sources;
    assert.ok(payload);
    assert.equal(payload.turns.filter(turn => turn.session_id.endsWith(cases.parent_id)).length, 4);
    assert.ok(payload.loss_audits.some(audit => audit.diagnostic_code === "antigravity_invalid_step"));
    assert.ok(payload.records.some(record => record.record_path_or_offset === "sqlite:steps[1]:opaque"));
  });
});

test("Antigravity missing, empty and corrupt SQLite inputs degrade with explicit diagnostics", async () => {
  await scratch(async root => {
    const db = new DatabaseSync(database(root));
    try { db.exec("DELETE FROM steps; DELETE FROM gen_metadata"); } finally { db.close(); }
    assert.deepEqual(extractAntigravitySqliteSeeds(database(root)), []);
    await writeFile(database(root), "corrupt fixture database");
    const [payload] = (await runSourceProbe({ safe_mode: true }, [source(root)])).sources;
    assert.ok(payload?.loss_audits.length);
    assert.ok(payload.sessions.some(session => session.id.endsWith(cases.child_id)));
    const [missing] = (await runSourceProbe({ safe_mode: true }, [source(path.join(root, "missing"))])).sources;
    assert.equal(missing?.source.sync_status, "error");
  });
});

test("Antigravity admits native SQLite values before reading payloads", () => {
  let admitted = 0;
  assert.throws(() => extractAntigravitySqliteSeeds(database(fixtureRoot), { admit(bytes) {
    admitted += bytes; throw new Error("fixture admission refused");
  } }), /fixture admission refused/u);
  assert.ok(admitted > 0);
});

test("Antigravity unanchored usage and future step kinds remain inspectable", async () => {
  await scratch(async root => {
    const db = new DatabaseSync(database(root));
    try {
      db.prepare("UPDATE gen_metadata SET data = ? WHERE idx = 40").run(Buffer.from(cases.unanchored_generation_hex, "hex"));
      db.exec("UPDATE steps SET step_type = 999 WHERE idx = 2");
    } finally { db.close(); }
    const [payload] = (await runSourceProbe({ safe_mode: true }, [source(root)])).sources;
    assert.ok(payload?.loss_audits.some(audit => audit.diagnostic_code === "antigravity_unanchored_generation"));
    // The explicit tool call remains interpretable even with a future step enum.
    assert.equal(payload?.contexts.flatMap(context => context.tool_calls).length, 2);
    assert.equal(payload?.turns.filter(turn => turn.session_id.endsWith(cases.parent_id))
      .reduce((total, turn) => total + (turn.context_summary.total_tokens ?? 0), 0), cases.parent_tokens);
  });
});

test("Antigravity malformed workspace metadata retains the remaining history", async () => {
  await scratch(async root => {
    const db = new DatabaseSync(path.join(root, "conversation_summaries.db"));
    try { db.exec("ALTER TABLE conversation_summaries ADD COLUMN workspace_uris TEXT; UPDATE conversation_summaries SET workspace_uris = '{bad'"); }
    finally { db.close(); }
    const [payload] = (await runSourceProbe({ safe_mode: true }, [source(root)])).sources;
    assert.equal(payload?.sessions.length, 3);
    assert.equal(payload?.turns.length, 5);
    assert.ok(payload?.loss_audits.some(audit => audit.diagnostic_code === "antigravity_invalid_summary_workspace"));
  });
});
