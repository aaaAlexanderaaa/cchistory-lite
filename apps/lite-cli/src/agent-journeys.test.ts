import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LiveHistoryReader, LiveHistorySnapshot, scanLiteHistory, type ScanLiteHistoryOptions } from "@cchistory/live-runtime";
import { runLiteCli, type LiteCliIo } from "./index.js";
import { executeQuery, parseQueryRequest, prepareQuerySnapshot, QUERY_REQUEST_SCHEMA } from "./query.js";
import { runLiteShell } from "./shell.js";

const fixture = fileURLToPath(new URL("../../../mock_data/fixtures/agent-evidence", import.meta.url));
const directory = "/fixture/agent-project";
const parent = "sess:codex:evidence-parent";
const child = "sess:codex:evidence-child";
function options(baseDir = fixture): ScanLiteHistoryOptions {
  return { homeDir: baseDir, hostname: "agent-evidence-fixture", sourceRefs: ["codex"], sourceRoots: [{ sourceRef: "codex", baseDir }],
    directoryScope: directory, safeMode: true, scanGuard: { profile: "light" } };
}
function capture(overrides: Partial<LiteCliIo> = {}) {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { cwd: directory, homeDir: fixture, isTTY: false, stdout: (v: string) => { out.push(v); },
    stderr: (v: string) => { err.push(v); }, ...overrides } as LiteCliIo };
}
function request(operations: unknown[]) { return JSON.stringify({ schema: QUERY_REQUEST_SCHEMA, operations }); }

test("agent journey: latest, read and repeated replies use stable IDs and two scans", async () => {
  const scans: Partial<ScanLiteHistoryOptions>[] = [];
  const captured = capture();
  let step = 0;
  const code = await runLiteShell({ jsonLines: true, directoryScope: directory,
    scan: async (overrides = {}) => { scans.push(overrides); return scanLiteHistory({ ...options(), ...overrides }); },
    io: { ...captured.io, readLine: async () => {
      if (step++ === 0) return JSON.stringify({ kind: "latest", limit: 10 });
      if (step === 2) return JSON.stringify({ kind: "read", session_ref: parent, max_chars: 512, limit: 1 });
      const first = JSON.parse(captured.out[1]!);
      const turn = first.operations[0].result.messages[0].turn_id;
      if (step === 3 || step === 4) return JSON.stringify({ kind: "replies", turn_refs: [turn] });
      if (step === 5) return JSON.stringify({ kind: "latest", limit: 10 });
      return null;
    } },
  });
  assert.equal(code, 0, captured.err.join(""));
  assert.equal(scans.length, 2);
  assert.deepEqual(scans[1]!.sessionRefs, [parent]);
  const results = captured.out.map(line => JSON.parse(line));
  assert.equal(results[0].read.id, results[4].read.id);
  assert.equal(results[1].read.id, results[2].read.id);
  assert.equal(results[2].read.id, results[3].read.id);
  const sessions = results[0].operations[0].result.sessions;
  assert.ok(sessions.some((s: { id: string }) => s.id === parent));
  assert.ok(sessions.some((s: { id: string }) => s.id === "sess:codex:evidence-duplicate"));
  assert.ok(!sessions.some((s: { id: string }) => [child, "sess:codex:evidence-empty", "sess:codex:evidence-other"].includes(s.id)));
  assert.match(results[2].operations[0].result.turns[0].assistant_replies[0].canonical_text, /exponential backoff/);
});

test("agent journey: answer search and cited turn reading share one context-light scan", async () => {
  let scans = 0, step = 0;
  const captured = capture();
  const code = await runLiteShell({ jsonLines: true, directoryScope: directory,
    scan: async overrides => { scans++; const snapshot = await scanLiteHistory({ ...options(), ...overrides });
      assert.deepEqual(snapshot.data.contexts, []); assert.deepEqual(snapshot.projectionIssues, []); return snapshot; },
    io: { ...captured.io, readLine: async () => {
      if (step++ === 0) return JSON.stringify({ kind: "search", query: "exponential backoff", content: "conversation" });
      if (step === 2) return JSON.stringify({ kind: "read", turn_ref: JSON.parse(captured.out[0]!).operations[0].result.results[0].turn_id });
      return null;
    } },
  });
  assert.equal(code, 0);
  assert.equal(scans, 1);
  const [found, read] = captured.out.map(line => JSON.parse(line));
  assert.equal(found.operations[0].result.total, 1);
  assert.equal(found.operations[0].result.results[0].role, "assistant");
  assert.equal(found.read.id, read.read.id);
  assert.deepEqual(read.operations[0].result.messages.map((m: { role: string }) => m.role), ["user", "assistant"]);
  assert.match(read.operations[0].result.messages[1].text, /rejected fixed delay/);
});

test("delegated hits stay under their parent and cite the child; scope and empty sessions remain explicit", async () => {
  const snapshot = await scanLiteHistory({ ...options(), directoryScope: undefined, contextMode: "none", retainConversationEvidence: true });
  const found = snapshot.searchConversation({ query: "checksum", directoryScope: directory });
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0]!.session_id, parent);
  assert.equal(found.results[0]!.matched_session_id, child);
  assert.equal(found.results[0]!.turn_id, null);
  assert.equal(snapshot.getSession(child)!.turn_count, 0);
  const read = snapshot.readEvidence({ kind: "session", ref: found.results[0]!.matched_session_id }, {}, directory)!;
  assert.ok(read.messages.every(m => m.session_id === child));
  assert.equal(snapshot.readEvidence({ kind: "session", ref: "sess:codex:evidence-other" }, {}, directory), undefined);
  assert.deepEqual(snapshot.readEvidence({ kind: "session", ref: "sess:codex:evidence-empty" }, {}, directory)!.messages, []);
  assert.equal(snapshot.searchConversation({ query: "unrelated", directoryScope: directory }).total, 0);
  assert.deepEqual(snapshot.projectionIssues, []);
});

test("long fixture evidence is searchable after 16 KiB and bounded pages reconstruct the source", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "lite-agent-long-"));
  try {
    await cp(fixture, scratch, { recursive: true });
    const file = path.join(scratch, "parent.jsonl"), before = await stat(file);
    const records = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const user = records.find(r => r.payload.role === "user");
    user.payload.content[0].text = records.find(r => r.payload.role === "user" && r.payload.content[0].text.includes("emoji")).payload.content[0].text.repeat(400) + " tail-evidence-marker";
    await writeFile(file, records.map(r => JSON.stringify(r)).join("\n") + "\n");
    await utimes(file, before.atime, new Date(before.mtimeMs + 2000));
    const snapshot = await scanLiteHistory({ ...options(scratch), contextMode: "none", retainConversationEvidence: true });
    const hit = snapshot.searchConversation({ query: "tail-evidence-marker", directoryScope: directory }).results[0]!;
    assert.equal(hit.session_id, parent);
    assert.ok(hit.start > 16 * 1024);
    let cursor: string | undefined, reconstructed = "", pages = 0;
    do {
      const page = snapshot.readEvidence({ kind: "turn", ref: hit.turn_id! }, { max_chars: 511, limit: 1, cursor }, directory)!;
      assert.ok(page.returned_chars <= 511);
      for (const message of page.messages) if (message.role === "user") reconstructed += message.text;
      cursor = page.next_cursor ?? undefined;
      assert.ok(++pages < 100);
    } while (cursor);
    assert.equal(reconstructed, snapshot.getTurn(hit.turn_id!)!.canonical_text);
    const op = { id: "read", kind: "read", turn_ref: hit.turn_id, max_chars: 511 };
    const result = executeQuery(parseQueryRequest(request([op])), snapshot, directory);
    assert.ok(Buffer.byteLength(JSON.stringify(result.payload)) < 8000);
    assert.deepEqual(snapshot.projectionIssues, []);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("successful refresh invalidates detail and cursor; failed refresh preserves usable reads", async () => {
  const original = await scanLiteHistory({ ...options(), contextMode: "full" });
  const changed = new LiveHistorySnapshot({ ...original.data, turns: original.data.turns.map(t => ({ ...t, canonical_text: t.canonical_text + " Updated fixture." })) });
  let current = original, fail = false, scans = 0;
  const reader = new LiveHistoryReader(async () => { scans++; if (fail) throw new Error("fixture refresh failed"); return current; });
  try {
    const detail = await reader.detail([{ kind: "session", ref: parent }]);
    const cursor = detail.readEvidence({ kind: "session", ref: parent }, { limit: 1 }, directory)!.next_cursor!;
    fail = true;
    await assert.rejects(reader.refresh(), /fixture refresh failed/);
    assert.equal(await reader.detail([{ kind: "session", ref: parent }]), detail);
    assert.equal(scans, 2);
    fail = false; current = changed;
    await reader.refresh();
    const next = await reader.detail([{ kind: "session", ref: parent }]);
    assert.notEqual(next.readIdentity.id, detail.readIdentity.id);
    assert.throws(() => next.readEvidence({ kind: "session", ref: parent }, { cursor }, directory), /changed/);
  } finally { reader.close(); }
});

test("detail cache respects entry and retained-data limits and releases on close", async () => {
  const snapshot = await scanLiteHistory({ ...options(), contextMode: "full" });
  let scans = 0;
  const scan = async () => { scans++; return snapshot; };
  const reader = new LiveHistoryReader(scan, 0);
  await reader.detail([{ kind: "session", ref: parent }]);
  await reader.detail([{ kind: "session", ref: parent }]);
  assert.equal(scans, 2);
  reader.close();
  const cached = new LiveHistoryReader(scan);
  await cached.detail([{ kind: "session", ref: parent }]);
  await cached.detail([{ kind: "session", ref: parent }]);
  assert.equal(scans, 3);
  cached.close();
  await cached.detail([{ kind: "session", ref: parent }]);
  assert.equal(scans, 4);
  cached.close();

  let targetedScans = 0;
  const bounded = new LiveHistoryReader(async overrides => {
    targetedScans++;
    return scanLiteHistory({ ...options(), ...overrides });
  }, 16 * 1024 * 1024, 1);
  try {
    await bounded.detail([{ kind: "session", ref: parent }]);
    await bounded.detail([{ kind: "session", ref: "sess:codex:evidence-duplicate" }]);
    await bounded.detail([{ kind: "session", ref: parent }]);
    assert.equal(targetedScans, 3, "the oldest detail was evicted at the entry limit");
  } finally { bounded.close(); }
});

test("partial detail caches and warm collections preserve ambiguous session candidates", async () => {
  for (const warmCollection of [false, true]) {
    const reader = new LiveHistoryReader(overrides => scanLiteHistory({ ...options(), ...overrides }));
    try {
      if (warmCollection) await reader.collection();
      await reader.detail([{ kind: "session", ref: parent }], { evidenceOnly: true });
      const operations = [{ id: "ambiguous", kind: "read", session_ref: "Review the fixture decision." },
        { id: "valid", kind: "read", session_ref: parent }];
      const snapshot = await reader.detail(operations.map(op => ({ kind: "session", ref: op.session_ref })), { evidenceOnly: true });
      const result = executeQuery(parseQueryRequest(request(operations)), snapshot, directory);
      const payload = JSON.parse(JSON.stringify(result.payload));
      assert.equal(payload.operations[0].error.code, "ambiguous_reference");
      assert.deepEqual(payload.operations[0].error.candidates.map((candidate: { id: string }) => candidate.id).sort(),
        [parent, "sess:codex:evidence-duplicate"].sort());
      assert.equal(payload.operations[1].status, "ok");
      assert.ok(payload.operations[1].result.messages.every((message: { session_id: string }) => message.session_id === parent));
    } finally { reader.close(); }
  }
});

test("one-shot missing session references preserve valid batch results", async () => {
  for (const missing of ["sess:codex:missing", "sess:claude_code:missing"]) {
    const captured = capture({ readStdin: async () => request([
      { id: "valid", kind: "read", session_ref: parent },
      { id: "missing", kind: "read", session_ref: missing },
    ]) });
    const code = await runLiteCli(["query", "--request", "-", "--dir", directory,
      "--source", "codex", "--source-root", `codex=${fixture}`, "--safe"], captured.io);
    assert.equal(code, 1);
    assert.equal(captured.err.join(""), "");
    const payload = JSON.parse(captured.out.join(""));
    assert.equal(payload.operations[0].status, "ok");
    assert.ok(payload.operations[0].result.messages.some((message: { text: string }) => message.text.includes("exponential backoff")));
    assert.equal(payload.operations[1].status, "error");
    assert.equal(payload.operations[1].error.code, "reference_not_found");
    assert.deepEqual(payload.projection_issues, []);
  }
});

test("cold and warm shells keep missing session references at the operation level", async () => {
  for (const warmCollection of [false, true]) {
    const captured = capture();
    const lines = [
      ...(warmCollection ? [JSON.stringify({ kind: "latest", limit: 10 })] : []),
      request([{ id: "valid", kind: "read", session_ref: parent },
        { id: "missing", kind: "read", session_ref: "sess:codex:missing" }]),
      JSON.stringify({ kind: "read", session_ref: "sess:claude_code:missing" }),
      JSON.stringify({ kind: "read", session_ref: parent }),
    ];
    const code = await runLiteShell({ jsonLines: true, directoryScope: directory,
      scan: overrides => scanLiteHistory({ ...options(), ...overrides }),
      io: { ...captured.io, readLine: async () => lines.shift() ?? null },
    });
    assert.equal(code, 1);
    const payloads = captured.out.map(line => JSON.parse(line)).slice(warmCollection ? 1 : 0);
    assert.equal(payloads[0].kind, "query_result");
    assert.equal(payloads[0].operations[0].status, "ok");
    assert.equal(payloads[0].operations[1].error.code, "reference_not_found");
    assert.equal(payloads[1].kind, "query_result");
    assert.equal(payloads[1].operations[0].error.code, "reference_not_found");
    assert.equal(payloads[2].operations[0].status, "ok");
    assert.deepEqual(payloads[0].projection_issues, []);
  }
});

test("targeted scan failures propagate without a matching-scan retry", async () => {
  const failure = new Error("fixture scan failed");
  let scans = 0;
  const reader = new LiveHistoryReader(async () => { scans++; throw failure; });
  try {
    await assert.rejects(reader.detail([{ kind: "session", ref: parent }]), error => error === failure);
    assert.equal(scans, 1);
  } finally { reader.close(); }
});

test("mixed legacy replies and evidence reads retain unanchored delegated answers", async () => {
  const reader = new LiveHistoryReader(overrides => scanLiteHistory({ ...options(), ...overrides }));
  try {
    const legacy = await reader.detail([{ kind: "session", ref: parent }]);
    assert.equal(legacy.data.conversation_evidence, undefined);
    const turnId = legacy.listSessionTurns(parent)[0]!.id;
    const query = parseQueryRequest(request([{ id: "reply", kind: "replies", turn_refs: [turnId] },
      { id: "child", kind: "read", session_ref: child }]));
    const prepared = await prepareQuerySnapshot(query, reader);
    const result = executeQuery(query, prepared, directory);
    const payload = JSON.parse(JSON.stringify(result.payload));
    assert.equal(result.hasOperationErrors, false);
    assert.ok(payload.operations[1].result.messages.some((message: { turn_id: string | null; text: string }) =>
      message.turn_id === null && message.text.includes("checksum")));
  } finally { reader.close(); }
});

test("invalid evidence requests fail before scanning", async () => {
  const invalid = [
    { kind: "read", session_ref: parent, turn_ref: "turn" }, { kind: "read" },
    { kind: "read", session_ref: parent, max_chars: 1 }, { kind: "read", session_ref: parent, limit: 101 },
    { kind: "read", session_ref: parent, cursor: "bad-cursor" },
    { kind: "search", query: "fixture", content: "conversation", max_chars: 64001 },
    { kind: "search", query: "fixture", content: "all" },
    { kind: "search", query: "fixture", group_by: "message" },
    { kind: "search", query: "fixture", content: "conversation", group_by: "turn" },
  ];
  let scans = 0;
  for (const operation of invalid) {
    const captured = capture({ readStdin: async () => request([{ id: "bad", ...operation }]), scan: async () => { scans++; throw new Error("unexpected scan"); } });
    assert.equal(await runLiteCli(["query", "--request", "-", "--dir", directory], captured.io), 2, captured.err.join(""));
  }
  assert.equal(scans, 0);
});

test("older decision, later mention and reversal remain individually addressable in one shell scan", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "lite-old-decisions-"));
  try {
    await cp(fixture, scratch, { recursive: true });
    const file = path.join(scratch, "parent.jsonl"), before = await stat(file);
    const rows = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const original = rows[2].payload.content[0].text;
    rows[4].payload.content[0].text = "Mention exponential backoff with jitter in the migration notes.";
    rows.push({ ...rows[1], timestamp: "2026-04-12T10:07:00Z", payload: { ...rows[1].payload,
      content: [{ type: "input_text", text: "Record the revised retry decision." }] } });
    rows.push({ ...rows[2], timestamp: "2026-04-12T10:08:00Z", payload: { ...rows[2].payload,
      content: [{ type: "output_text", text: "Reversal: replace exponential backoff with jitter with the server retry-after schedule." }] } });
    await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    await utimes(file, before.atime, new Date(before.mtimeMs + 2000));
    const captured = capture(); let step = 0, scans = 0;
    const code = await runLiteShell({ jsonLines: true, directoryScope: directory,
      scan: async overrides => { scans++; return scanLiteHistory({ ...options(scratch), ...overrides }); },
      io: { ...captured.io, readLine: async () => {
        if (step++ === 0) return JSON.stringify({ kind: "search", query: "exponential backoff", content: "conversation", group_by: "message", limit: 1 });
        if (step <= 3) return JSON.stringify({ kind: "search", query: "exponential backoff", content: "conversation", group_by: "message", limit: 1,
          offset: JSON.parse(captured.out[step - 2]!).operations[0].result.next_offset });
        if (step === 4) return JSON.stringify({ kind: "read", turn_ref: JSON.parse(captured.out[2]!).operations[0].result.results[0].turn_id });
        return null;
      } } });
    assert.equal(code, 0, captured.err.join("")); assert.equal(scans, 1);
    const responses = captured.out.map(line => JSON.parse(line));
    const hits = responses.slice(0, 3).map(response => response.operations[0].result.results[0]);
    assert.equal(new Set(hits.map(hit => hit.message_id)).size, 3);
    assert.match(hits[0].text, /Reversal/); assert.match(hits[1].text, /Mention/);
    assert.equal(hits[2].text, original);
    assert.ok(hits.every(hit => hit.session_id === parent && hit.matched_session_id === parent && hit.turn_id));
    assert.equal(new Set(responses.map(response => response.read.id)).size, 1);
    assert.ok(responses[3].operations[0].result.messages.some((message: { message_id: string; text: string }) => message.message_id === hits[2].message_id && message.text === original));
    const snapshot = await scanLiteHistory({ ...options(scratch), contextMode: "none", retainConversationEvidence: true });
    assert.equal(snapshot.searchConversation({ query: "exponential backoff" }).total, 1, "default grouping stays compatible");
    const childHit = snapshot.searchConversation({ query: "checksum", group_by: "message" }).results[0]!;
    assert.equal(childHit.matched_session_id, child); assert.equal(childHit.turn_id, null);
    assert.deepEqual(snapshot.projectionIssues, []);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("opt-in diagnostics emit metadata JSONL, preserve stdout results and explain SQL work and shell reuse", async () => {
  const args = ["query", "--sql", "SELECT id FROM sessions LIMIT 2", "--complete", "--source", "codex", "--source-root", `codex=${fixture}`, "--dir", directory];
  const ordinary = capture(), diagnosed = capture();
  assert.equal(await runLiteCli(args, ordinary.io), 0, ordinary.err.join(""));
  assert.equal(await runLiteCli([...args, "--diagnostics"], diagnosed.io), 0, diagnosed.err.join(""));
  assert.deepEqual(JSON.parse(diagnosed.out.join("")).operations, JSON.parse(ordinary.out.join("")).operations);
  assert.equal(ordinary.err.length, 0);
  const events = diagnosed.err.flatMap(chunk => chunk.trim().split("\n").map(line => JSON.parse(line)));
  assert.ok(events.every(event => event.schema === "cchistory-lite-diagnostic/v1"));
  for (const kind of ["read_start", "progress", "budget", "query_work", "read_done"]) assert.ok(events.some(event => event.kind === kind), kind);
  assert.ok(events.some(event => event.kind === "progress" && event.count_unit === "sessions"));
  assert.ok(events.filter(event => event.attempt_id).every(event => Number.isFinite(event.rss_bytes) && Number.isFinite(event.heap_used_bytes)));
  assert.doesNotMatch(diagnosed.err.join(""), /exponential backoff|checksum|rejected fixed delay/);
  const snapshot = await scanLiteHistory({ ...options(), contextMode: "none", retainConversationEvidence: true });
  const cacheEvents: { kind: string; decision?: unknown }[] = [];
  const reader = new LiveHistoryReader(async () => snapshot, undefined, undefined, event => cacheEvents.push(event));
  await reader.collection(true);
  await reader.detail([{ kind: "session", ref: parent }], { evidenceOnly: true });
  await reader.refresh(); reader.close();
  assert.deepEqual(cacheEvents.map(event => event.decision), ["miss", "hit", "refresh", "closed"]);
  const failures: { kind: string; error_class?: unknown }[] = [];
  await assert.rejects(scanLiteHistory({ ...options(), contextMode: "matching", onDiagnostic: event => failures.push(event) }), /requires/);
  assert.equal(failures.at(-1)?.kind, "read_error");
});

test("agent journey: SQL success with a lost file reports partial history at the top level", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "lite-agent-loss-"));
  try {
    await cp(fixture, scratch, { recursive: true });
    let removed = false;
    const captured = capture({ scan: async overrides => scanLiteHistory({ ...options(scratch), ...overrides,
      sourceRefs: ["codex"], sourceRoots: [{ sourceRef: "codex", baseDir: scratch }],
      onProgress: e => { if (!removed && e.stage === "file_start") { removed = true; unlinkSync(path.join(scratch, "duplicate-title.jsonl")); } },
    }) });
    assert.equal(await runLiteCli(["query", "--sql", "SELECT id FROM sessions LIMIT 10", "--complete", "--dir", directory], captured.io), 0, captured.err.join(""));
    const result = JSON.parse(captured.out.join(""));
    assert.equal(result.operations[0].result.coverage.execution, "complete");
    assert.equal(result.read_status.status, "partial");
    assert.ok(result.read_status.reasons.includes("read_loss"));
    assert.ok(result.diagnostics.loss_audits.length > 0);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
