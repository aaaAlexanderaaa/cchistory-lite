import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { scanLiteHistory } from "./index.js";

const fixture = new URL("../../../mock_data/fixtures/source-shapes/codex/ordinary-fork.jsonl", import.meta.url);
const gib = 1024 ** 3;

test("active ZCode WAL commits remain readable with the guard enabled or disabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-active-wal-"));
  let writer: DatabaseSync | undefined;
  try {
    const base = path.join(root, "zcode");
    await mkdir(path.join(base, "cli/db"), { recursive: true });
    const file = path.join(base, "cli/db/db.sqlite");
    writer = new DatabaseSync(file);
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    writer.exec(await readFile(new URL("../../../mock_data/fixtures/context-boundary/zcode/fixture.sql", import.meta.url), "utf8"));
    for (const guarded of [true, false]) {
      let commits = 0;
      const snapshot = await scanLiteHistory({ homeDir: root, sourceRefs: ["zcode"],
        sourceRoots: [{ sourceRef: "zcode", baseDir: base }],
        scanGuard: guarded ? { profile: "light" } : undefined,
        scanGuardDeps: { readAvailableBytes: () => gib, lock: { lockPath: path.join(root, "scan.lock") } },
        onProgress: event => {
          if (event.stage === "file_start" || event.stage === "file_capture_done" || event.stage === "file_parse_done") {
            writer!.exec("UPDATE session SET time_updated = time_updated + 1");
            commits++;
          }
        },
      });
      assert.equal(commits, 3);
      assert.ok(snapshot.listResolvedSessions().length > 0);
      assert.deepEqual(snapshot.projectionIssues, []);
      assert.deepEqual(snapshot.data.loss_audits, []);
    }
  } finally { writer?.close(); await rm(root, { recursive: true, force: true }); }
});

test("a vanished file leaves diagnostics while readable sessions survive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-vanished-file-"));
  try {
    const missing = path.join(root, "gone.jsonl");
    await cp(fixture, missing);
    await cp(fixture, path.join(root, "kept.jsonl"));
    let removed = false;
    const snapshot = await scanLiteHistory({ homeDir: root, sourceRefs: ["codex"],
      sourceRoots: [{ sourceRef: "codex", baseDir: root }], safeMode: true,
      scanGuard: { profile: "light" }, scanGuardDeps: { readAvailableBytes: () => gib, lock: { lockPath: path.join(root, "scan.lock") } },
      onProgress: event => {
        if (!removed && event.stage === "file_start") { unlinkSync(missing); removed = true; }
      },
    });
    assert.ok(removed);
    assert.equal(snapshot.listResolvedSessions().length, 1);
    assert.ok(snapshot.data.loss_audits.some(a => a.detail.includes("gone.jsonl")));
    assert.deepEqual(snapshot.projectionIssues, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("temporary input bytes do not permanently consume the scan's read headroom", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-reusable-budget-"));
  try {
    for (let i = 0; i < 12; i++) await cp(fixture, path.join(root, `${i}.jsonl`));
    const bytes = (await stat(path.join(root, "0.jsonl"))).size;
    const snapshot = await scanLiteHistory({ homeDir: root, sourceRefs: ["codex"],
      sourceRoots: [{ sourceRef: "codex", baseDir: root }], safeMode: true,
      scanGuard: { profile: "light" }, scanGuardDeps: {
        readAvailableBytes: () => bytes * 8, readHeapBytes: () => gib,
        lock: { lockPath: path.join(root, "scan.lock") },
      },
    });
    assert.equal(snapshot.listResolvedSessions().length, 1);
    assert.deepEqual(snapshot.data.loss_audits, []);
    assert.deepEqual(snapshot.projectionIssues, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
