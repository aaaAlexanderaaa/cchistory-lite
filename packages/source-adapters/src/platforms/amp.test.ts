import { runSourceProbe } from "../probe-reference.test.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { 
  seedSupportedSourceFixtures, 
  createSourceDefinition,
  getRepoMockDataRoot 
} from "../test-helpers.js";

test("[amp] borrowed decoded records preserve complete projections and exact byte ownership", async () => {
  const source = createSourceDefinition("src-amp-borrowed", "amp", path.join(getRepoMockDataRoot(), ".local/share/amp/threads"));
  const full = (await runSourceProbe({ safe_mode: true }, [source])).sources[0]!;
  const borrowed = (await runSourceProbe({ safe_mode: true, retain_raw_records: false }, [source])).sources[0]!;
  for (const key of ["sessions", "turns", "contexts", "atoms", "fragments"] as const) assert.deepEqual(borrowed[key], full[key]);
  assert.deepEqual(borrowed.loss_audits.map(loss => [loss.diagnostic_code, loss.detail]), full.loss_audits.map(loss => [loss.diagnostic_code, loss.detail]));
  assert.deepEqual(borrowed.records.map(record => record.raw_size_bytes), full.records.map(record => Buffer.byteLength(record.raw_json, "utf8")));
  assert.ok(borrowed.records.every(record => record.raw_text_retained === false && !("parsed_value" in record)));
});

test("[amp] shared root decoding retains native identity and malformed-root evidence", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-04-12T10:00:00Z") });
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-amp-root-"));
  try {
    const fixtureText = await readFile(path.join(getRepoMockDataRoot(), ".local/share/amp/threads/T-019d19fb-1a2b-7345-8cde-0f1a2b3c4d5e.json"), "utf8");
    const fixture = JSON.parse(fixtureText);
    const withoutId = { ...fixture }; delete withoutId.id;
    const cases = [
      { name: "native-id", text: fixtureText, id: fixture.id },
      { name: "missing-id", text: JSON.stringify(withoutId), id: "thread" },
      { name: "primitive", text: JSON.stringify(fixture.title), id: "thread" },
      { name: "malformed", text: fixtureText.slice(0, -20), id: "thread" },
    ];
    for (const item of cases) {
      const sourceRoot = path.join(root, item.name); await mkdir(sourceRoot);
      const file = path.join(sourceRoot, "thread.json"); await writeFile(file, item.text);
      const mtime = new Date("2026-04-12T10:00:00Z"); await utimes(file, mtime, mtime);
      const source = createSourceDefinition(`src-amp-${item.name}`, "amp", sourceRoot);
      const full = (await runSourceProbe({ safe_mode: true }, [source])).sources[0]!;
      const borrowed = (await runSourceProbe({ safe_mode: true, retain_raw_records: false }, [source])).sources[0]!;
      assert.ok(borrowed.records.length > 0);
      assert.ok(borrowed.records.every(record => record.session_ref === `sess:amp:${item.id}`));
      for (const key of ["sessions", "turns", "contexts", "atoms", "fragments"] as const) assert.deepEqual(borrowed[key], full[key]);
      assert.deepEqual(borrowed.loss_audits.map(loss => [loss.diagnostic_code, loss.detail]), full.loss_audits.map(loss => [loss.diagnostic_code, loss.detail]));
      assert.deepEqual(borrowed.records.map(record => record.raw_size_bytes), full.records.map(record => Buffer.byteLength(record.raw_json, "utf8")));
      if (item.name === "malformed" || item.name === "primitive") assert.ok(borrowed.loss_audits.length > 0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("[amp] root history jsonl stays out of default capture when scanning the source root", async () => {
  const mockDataRoot = getRepoMockDataRoot();
  const baseDir = path.join(mockDataRoot, ".local", "share", "amp");
  const source = createSourceDefinition("src-amp-root-mock-data", "amp", baseDir);

  const result = await runSourceProbe({ source_ids: [source.id] }, [source]);
  const payload = result.sources[0];
  assert.ok(payload);
  assert.equal(payload.source.sync_status, "healthy");
  assert.equal(payload.blobs.some((blob) => path.basename(blob.origin_path) === "history.jsonl"), false);
  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.turns.length, 1);
});

test("runSourceProbe uses file mtime as session end when amp messages share one timestamp", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-source-adapters-"));

  try {
    const ampDir = path.join(tempRoot, "amp");
    await mkdir(ampDir, { recursive: true });

    const sharedTimestamp = "2026-03-09T06:00:00.000Z";
    const sharedEpoch = new Date(sharedTimestamp).getTime();
    await writeFile(
      path.join(ampDir, "thread.json"),
      JSON.stringify({
        id: "amp-flat-1",
        created: sharedEpoch,
        title: "Flat AMP thread",
        env: { initial: { trees: [{ uri: "file:///workspace/amp-flat", displayName: "amp-flat" }] } },
        messages: [
          { meta: { sentAt: sharedEpoch }, role: "user", content: [{ type: "text", text: "Summarize." }] },
          { meta: { sentAt: sharedEpoch }, role: "assistant", content: [{ type: "text", text: "Here is the summary." }] },
        ],
      }),
      "utf8",
    );

    const fileMtime = new Date("2026-03-09T06:05:00.000Z");
    await utimes(path.join(ampDir, "thread.json"), fileMtime, fileMtime);

    const [payload] = (
      await runSourceProbe({ limit_files_per_source: 1 }, [
        createSourceDefinition("src-amp-flat", "amp", ampDir),
      ])
    ).sources;

    assert.ok(payload);
    assert.equal(payload.sessions.length, 1);
    const session = payload.sessions[0]!;
    assert.equal(session.created_at, sharedTimestamp);
    assert.equal(session.updated_at, fileMtime.toISOString());
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe uses AMP content activity times instead of scan time or a copied file mtime", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-source-adapters-amp-time-"));
  try {
    const ampDir = path.join(tempRoot, "amp");
    await mkdir(ampDir, { recursive: true });
    const created = Date.parse("2026-03-29T13:58:34.458Z");
    const finalTime = Date.parse("2026-03-29T14:02:04.185Z");
    const filePath = path.join(ampDir, "thread.json");
    await writeFile(filePath, JSON.stringify({
      id: "amp-content-time",
      created,
      messages: [
        { role: "user", meta: { sentAt: created + 1_000 }, content: [{ type: "text", text: "Review this." }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "Reviewed.", startTime: finalTime - 500, finalTime }],
        },
      ],
    }), "utf8");
    const copiedAt = new Date("2026-06-29T05:57:47.000Z");
    await utimes(filePath, copiedAt, copiedAt);

    const [payload] = (await runSourceProbe({}, [createSourceDefinition("src-amp-time", "amp", ampDir)])).sources;
    assert.ok(payload);
    assert.equal(payload.sessions[0]?.created_at, new Date(created).toISOString());
    assert.equal(payload.sessions[0]?.updated_at, new Date(finalTime).toISOString());
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runSourceProbe keeps an empty AMP thread at its root creation time", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-source-adapters-amp-empty-"));
  try {
    const ampDir = path.join(tempRoot, "amp");
    await mkdir(ampDir, { recursive: true });
    const createdAt = "2026-03-20T02:00:00.000Z";
    const filePath = path.join(ampDir, "empty.json");
    await writeFile(filePath, JSON.stringify({
      id: "amp-empty-time",
      created: Date.parse(createdAt),
      messages: [],
    }), "utf8");
    const copiedAt = new Date("2026-06-29T05:57:47.000Z");
    await utimes(filePath, copiedAt, copiedAt);

    const [payload] = (await runSourceProbe({}, [createSourceDefinition("src-amp-empty", "amp", ampDir)])).sources;
    assert.ok(payload);
    assert.equal(payload.sessions[0]?.created_at, createdAt);
    assert.equal(payload.sessions[0]?.updated_at, createdAt);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
