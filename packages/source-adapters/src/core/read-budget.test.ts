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

test("ZCode and both Cursor container paths propagate budget refusal past per-file recovery", async () => {
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
      await assert.rejects(runSourceProbe({ safe_mode: true, source_file_paths: { [source.id]: [file] }, read_budget: budget(0) }, [selected]), SourceReadBudgetExceededError, kind);
      assert.deepEqual(await readFile(file), before);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
