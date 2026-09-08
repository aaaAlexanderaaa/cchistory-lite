import assert from "node:assert/strict";
import { appendFileSync, utimesSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SourceFileReadPlanChangedError } from "@cchistory/source-adapters";
import { scanLiteHistory, scanLiteQuery, type ScanLiteHistoryOptions } from "./index.js";
import { compileSql } from "./sql-query.js";
import { isSelectiveLatestQuery } from "./selective-query.js";

const fixture = new URL("../../../mock_data/fixtures/selective-latest/", import.meta.url);
const variants = JSON.parse(await readFile(new URL("variants.json", fixture), "utf8"));
const names = ["newest", "tie-a", "tie-b", "oldest", "empty"];
const sql = "SELECT id, title, last_message_at FROM sessions WHERE is_top_level = TRUE AND turn_count > 0 ORDER BY last_message_at DESC NULLS LAST LIMIT $1";
const query = await compileSql(sql, [2]);

async function withCorpus(run: (root: string, options: ScanLiteHistoryOptions) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-selective-"));
  try {
    for (const name of names) {
      const file = path.join(root, `${name}.jsonl`);
      await copyFile(new URL(`${name}.jsonl`, fixture), file);
      // Deliberately contradict conversation order; never depend on copy speed or clock ticks.
      const mtime = new Date(name === "oldest" ? "2026-08-01T00:00:00Z" : "2026-02-01T00:00:00Z");
      await utimes(file, mtime, mtime);
    }
    await run(root, { homeDir: root, hostname: "selective-fixture", sourceRoots: [{ sourceRef: "codex", baseDir: root }], sourceRefs: ["codex"], contextMode: "none" });
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function writeRecords(root: string, file: string, records: unknown[]) {
  await writeFile(path.join(root, file), records.map(r => JSON.stringify(r)).join("\n") + "\n");
  await utimes(path.join(root, file), new Date("2026-03-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z"));
}

test("M3: exact latest ignores mtime, interprets tied candidates and skips only strictly older groups", async () => {
  assert.ok(isSelectiveLatestQuery(query));
  await withCorpus(async (_root, options) => {
    const read = await scanLiteQuery(query, options);
    const full = await scanLiteHistory(options);
    assert.deepEqual(read.result.rows, full.executeCollectionQuery(query).rows);
    assert.deepEqual(read.result.ids, ["sess:codex:newest", "sess:codex:tie-a"]);
    assert.deepEqual(read.result.coverage, { execution: "selective", rows: "exact", diagnostics: "observed" });
    assert.equal(read.result.total, null);
    assert.deepEqual(read.projectionIssues, []);
    assert.deepEqual(full.projectionIssues, []);
    assert.equal(read.work.discoveredPrimaryFiles, 5);
    assert.equal(read.work.metadataEvidenceFiles, 5);
    assert.equal(read.work.inventoryFiles, 5);
    assert.equal(read.work.inventoryRecordsDecoded, 13);
    assert.ok(read.work.inventoryBytesRead > 0);
    assert.equal(read.work.payloadFilesProcessed, 4, "empty and both tied groups must be read");
    assert.equal(read.work.canonicalInterpretations, 4);
    assert.equal(read.work.skippedPrimaryFiles, 1);
    assert.equal(read.work.retainedSessions, 4);
    assert.equal(read.work.retainedTurns, 3);
    assert.equal("data" in read, false, "a partial read is not exposed as a reusable full snapshot");
  });
});

test("M3: split native files are interpreted as one complete logical session", async () => {
  await withCorpus(async (root, options) => {
    await writeRecords(root, "split.jsonl", variants.split);
    const read = await scanLiteQuery(query, options);
    const full = await scanLiteHistory(options);
    assert.deepEqual(read.result.rows, full.executeCollectionQuery(query).rows);
    assert.equal(read.result.ids[0], "sess:codex:oldest");
    assert.equal(read.result.coverage.execution, "selective");
    assert.equal(read.work.payloadFilesProcessed, 4);
    assert.equal(read.work.canonicalInterpretations, 3);
    assert.equal(read.work.skippedPrimaryFiles, 2);
    assert.deepEqual(read.projectionIssues, []);
  });
});

test("M3: uncertain timestamps, identity, syntax and family evidence use the complete reader", async () => {
  for (const variant of ["timestamp", "identity", "unknown", "family_tool", "family_tool_whitespace", "child", "malformed", "oversized"] as const) {
    await withCorpus(async (root, options) => {
      const file = path.join(root, "oldest.jsonl");
      const records = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      if (variant === "timestamp") delete records[0].timestamp;
      else if (variant === "identity") records.shift();
      else if (variant === "child") await writeRecords(root, "child.jsonl", variants.child);
      else if (variant === "unknown" || variant === "family_tool") records.push(variants[variant]);
      else if (variant === "family_tool_whitespace") {
        const call = structuredClone(variants.family_tool); call.payload.name = ` ${call.payload.name} `; records.push(call);
      }
      else if (variant === "oversized") records[1].payload.content[0].text = "x".repeat(1024 * 1024 + 1);
      await writeRecords(root, "oldest.jsonl", records);
      if (variant === "malformed") appendFileSync(file, "{invalid\n");
      const read = await scanLiteQuery(query, options);
      const full = await scanLiteHistory(options);
      assert.deepEqual(read.result.rows, full.executeCollectionQuery(query).rows, variant);
      assert.equal(read.result.coverage.execution, "complete", variant);
      assert.equal(read.result.coverage.diagnostics, "complete", variant);
      assert.equal(read.work.skippedPrimaryFiles, 0, variant);
      assert.ok(read.work.fallbackReason, variant);
      assert.deepEqual(read.projectionIssues, full.projectionIssues, variant);
      assert.equal(read.lossAudits.length, full.data.loss_audits.length, variant);
      if (variant === "child") assert.ok(!read.result.ids.includes("sess:codex:child"));
    });
  }
});

test("M3: complete totals and other query shapes bypass the inventory; insufficient rows do not claim pruning", async () => {
  await withCorpus(async (_root, options) => {
    for (const q of [{ ...query, complete: true }, { ...query, offset: 1 }, { ...query, columns: ["id"] }]) {
      const read = await scanLiteQuery(q, options);
      const full = await scanLiteHistory(options);
      assert.deepEqual(read.result, full.executeCollectionQuery(q));
      assert.equal(read.work.inventoryFiles, 0);
      assert.equal(read.work.canonicalInterpretations, 5);
      assert.equal(read.work.payloadRecordsProcessed, 13);
      assert.equal(read.work.retainedSessions, 5);
      if (q.complete) assert.equal(read.result.total, 4);
    }
    const read = await scanLiteQuery({ ...query, limit: 10 }, options);
    assert.equal(read.result.coverage.execution, "complete");
    assert.equal(read.work.skippedPrimaryFiles, 0);
  });
});

test("M3: a skipped file changing after inventory aborts the attempt", async () => {
  await withCorpus(async (root, options) => {
    let changed = false;
    options.onProgress = event => {
      if (event.stage !== "file_start" || changed) return;
      changed = true;
      const file = path.join(root, "oldest.jsonl");
      appendFileSync(file, JSON.stringify(variants.changed) + "\n");
      utimesSync(file, new Date("2026-08-02T00:00:00Z"), new Date("2026-08-02T00:00:00Z"));
    };
    await assert.rejects(scanLiteQuery(query, options), SourceFileReadPlanChangedError);
    assert.ok(changed);
  });
});

test("M3: bounds inspect all timestamps and scope or multiple sources retain complete-reference behavior", async () => {
  await withCorpus(async (root, options) => {
    const records = (await readFile(path.join(root, "oldest.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    // The last line is old metadata; a tail timestamp would wrongly hide the newest real message.
    await writeRecords(root, "oldest.jsonl", [...records, variants.changed, records[0]]);
    const read = await scanLiteQuery(query, options);
    const full = await scanLiteHistory(options);
    assert.deepEqual(read.result.rows, full.executeCollectionQuery(query).rows);
    assert.equal(read.result.ids[0], "sess:codex:oldest");
    assert.equal(read.result.coverage.execution, "selective");
    for (const directoryScope of ["/fixture/query-project", "/fixture/other-project"]) {
      const scoped = await scanLiteQuery(query, { ...options, directoryScope });
      const reference = await scanLiteHistory({ ...options, directoryScope });
      assert.deepEqual(scoped.result.rows, reference.executeCollectionQuery(query, { directoryScope }).rows);
    }
    const mixedOptions = { ...options, sourceRefs: ["codex", "claude_code"], sourceRoots: [...options.sourceRoots!, { sourceRef: "claude_code", baseDir: path.join(root, "missing-claude") }] };
    const mixed = await scanLiteQuery(query, mixedOptions);
    assert.equal(mixed.work.inventoryFiles, 0);
    assert.equal(mixed.result.coverage.execution, "complete");
    assert.deepEqual(mixed.result.rows, (await scanLiteHistory(mixedOptions)).executeCollectionQuery(query).rows);
  });
});
