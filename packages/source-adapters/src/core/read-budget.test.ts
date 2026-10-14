import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readBudgetedSqliteRows, SourceReadBudgetExceededError, type SourceReadBudget } from "./read-budget.js";
import { runSourceProbe } from "../probe-reference.test.js";
import { getDefaultSourcesForHost } from "../index.js";

function budget(bytes: number): SourceReadBudget {
  return { admit(requested, unit) {
    if (requested > bytes) throw new SourceReadBudgetExceededError(unit, requested, bytes);
    bytes -= requested;
  } };
}

test("SQLite admission counts selected bytes and empty-row overhead before retrieving values", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "lite-read-budget-"));
  try {
    const file = path.join(scratch, "fixture.db");
    const create = new DatabaseSync(file);
    try { create.exec(await readFile(new URL("../../../../mock_data/fixtures/read-budget/sqlite.sql", import.meta.url), "utf8")); }
    finally { create.close(); }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec("BEGIN");
      const select = "SELECT id, data FROM payloads WHERE id = ?";
      const shared = budget(160);
      const rows = readBudgetedSqliteRows(db, select, ["id", "data"], ["small"], shared);
      assert.equal(rows[0]?.id, "small");
      assert.throws(() => readBudgetedSqliteRows(db, select, ["id", "data"], ["empty"], shared), SourceReadBudgetExceededError);
      assert.throws(() => readBudgetedSqliteRows(db, select, ["id", "data"], ["large"], budget(1024)), error =>
        error instanceof SourceReadBudgetExceededError && error.requestedBytes === 4096 + 128 + 5);
      assert.equal(readBudgetedSqliteRows(db, select, ["id", "data"], ["missing"], budget(0)).length, 0);
    } finally { db.close(); }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("ZCode and both Cursor container paths retain budget failures as per-file diagnostics", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "lite-container-budget-"));
  try {
    for (const kind of ["zcode", "cursor-store", "cursor-state"] as const) {
      const base = path.join(scratch, kind); await mkdir(base);
      const file = path.join(base, kind === "zcode" ? "db.sqlite" : kind === "cursor-store" ? "store.db" : "state.vscdb");
      const db = new DatabaseSync(file);
      try {
        if (kind === "zcode") db.exec(await readFile(new URL("../../../../mock_data/fixtures/context-boundary/zcode/fixture.sql", import.meta.url), "utf8"));
        else db.exec(await readFile(new URL(`../../../../mock_data/fixtures/read-budget/${kind}.sql`, import.meta.url), "utf8"));
      } finally { db.close(); }
      const source = getDefaultSourcesForHost({ homeDir: scratch, includeMissing: true }).find(s => s.platform === (kind === "zcode" ? "zcode" : "cursor"))!;
      const selected = { ...source, base_dir: base };
      const before = await readFile(file);
      const result = await runSourceProbe({ safe_mode: true, source_file_paths: { [source.id]: [file] }, read_budget: budget(0) }, [selected]);
      assert.ok(result.sources[0]?.loss_audits.some(a => a.detail.includes("Read budget exceeded")), kind);
      assert.deepEqual(await readFile(file), before);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("ZCode admits message parts independently and metadata retention preserves canonical evidence", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "lite-zcode-units-"));
  try {
    const file = path.join(scratch, "db.sqlite");
    const db = new DatabaseSync(file);
    try {
      db.exec(await readFile(new URL("../../../../mock_data/fixtures/context-boundary/zcode/fixture.sql", import.meta.url), "utf8"));
      const template = db.prepare("SELECT data FROM part WHERE id = 'parent-tool'").get()!.data as string;
      const insert = db.prepare("INSERT INTO part VALUES (?, 'parent-assistant', 'zcode-parent', 1775955603000, 1775955603000, ?)");
      for (let index = 0; index < 80; index++) {
        const part = JSON.parse(template);
        part.callID = `fixture-call-${index}`;
        part.state.output = part.state.output.repeat(1024);
        insert.run(`fixture-part-${index}`, JSON.stringify(part));
      }
    } finally { db.close(); }
    const source = getDefaultSourcesForHost({ homeDir: scratch, includeMissing: true }).find(s => s.platform === "zcode")!;
    const selected = { ...source, base_dir: scratch };
    const source_file_paths = { [source.id]: [file] };
    const complete = (await runSourceProbe({ safe_mode: true, source_file_paths }, [selected])).sources[0]!;
    const largest = 64 * 1024;
    const metadata = (await runSourceProbe({ safe_mode: true, source_file_paths, retain_raw_records: false,
      read_budget: { admit(bytes, unit) { if (bytes > largest) throw new SourceReadBudgetExceededError(unit, bytes, largest); } },
    }, [selected])).sources[0]!;
    assert.deepEqual(metadata.sessions, complete.sessions);
    assert.deepEqual(metadata.turns, complete.turns);
    assert.deepEqual(metadata.contexts, complete.contexts);
    assert.deepEqual(metadata.loss_audits, []);
    assert.ok(metadata.records.every(record => record.raw_text_retained === false && record.raw_json === "" && record.raw_size_bytes! > 0));
    assert.ok(metadata.records.every(record => !("parsed_value" in record)), "borrowed decoder objects stop at the parser boundary");
    assert.deepEqual(metadata.records.map(record => record.raw_size_bytes), complete.records.map(record => Buffer.byteLength(record.raw_json, "utf8")));
    assert.equal(metadata.source.total_records, complete.source.total_records);
    const convert = new DatabaseSync(file);
    try {
      convert.exec(`ALTER TABLE part RENAME TO old_part;
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT) WITHOUT ROWID;
        INSERT INTO part SELECT * FROM old_part; DROP TABLE old_part;`);
    } finally { convert.close(); }
    const convertedComplete = (await runSourceProbe({ safe_mode: true, source_file_paths }, [selected])).sources[0]!;
    const withoutRowid = (await runSourceProbe({ safe_mode: true, source_file_paths, retain_raw_records: false }, [selected])).sources[0]!;
    assert.deepEqual(withoutRowid.sessions, convertedComplete.sessions);
    assert.deepEqual(withoutRowid.turns, convertedComplete.turns);
    assert.deepEqual(withoutRowid.contexts, convertedComplete.contexts);
    assert.deepEqual(withoutRowid.turns.map(turn => turn.canonical_text), complete.turns.map(turn => turn.canonical_text));
    assert.equal(withoutRowid.contexts.reduce((count, context) => count + context.tool_calls.length, 0),
      complete.contexts.reduce((count, context) => count + context.tool_calls.length, 0));
    assert.deepEqual(withoutRowid.loss_audits, []);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
