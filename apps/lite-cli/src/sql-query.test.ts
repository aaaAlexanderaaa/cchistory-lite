import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as immediate } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LiveHistorySnapshot, scanLiteHistory, SQL_REQUEST_SCHEMA } from "@cchistory/live-runtime";
import type { LogicalQuery } from "@cchistory/domain";
import { runLiteCli, type LiteCliIo } from "./index.js";
import { runLiteShell, type ShellClock } from "./shell.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../../../mock_data/.codex/sessions", import.meta.url));
const snapshotPromise = scanLiteHistory({ homeDir: repoRoot, hostname: "query-fixture", sourceRoots: [{ sourceRef: "codex", baseDir: sourceRoot }], sourceRefs: ["codex"], contextMode: "none" });
function capture(overrides: Partial<LiteCliIo> = {}) {
  const stdout: string[] = [], stderr: string[] = [];
  const io: LiteCliIo = { cwd: repoRoot, stdout: v => { stdout.push(v); }, stderr: v => { stderr.push(v); }, isTTY: false, ...overrides };
  return { io, stdout, stderr };
}
const sql = 'SELECT id FROM sessions WHERE is_top_level = TRUE AND turn_count > 0 ORDER BY last_message_at DESC NULLS LAST LIMIT $1';

test("M3: one-shot template selects early, complete and batch requests preserve reference rows and totals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-cli-selective-"));
  try {
    for (const name of ['newest', 'tie-a', 'tie-b', 'oldest', 'empty']) {
      await copyFile(path.join(repoRoot, 'mock_data/fixtures/selective-latest', `${name}.jsonl`), path.join(root, `${name}.jsonl`));
    }
    const sql = 'SELECT id, title, last_message_at FROM sessions WHERE is_top_level = TRUE AND turn_count > 0 ORDER BY last_message_at DESC NULLS LAST LIMIT $1';
    const sourceArgs = ['--source', 'codex', '--source-root', `codex=${root}`, '--no-dir'];
    const run = async (args: string[], request?: string) => {
      const output = capture({ homeDir: root, hostname: 'selective-fixture', readStdin: async () => request! });
      assert.equal(await runLiteCli([...args, ...sourceArgs], output.io), 0, output.stderr.join(''));
      return JSON.parse(output.stdout.join(''));
    };
    const selected = await run(['query', '--sql', sql, '--params', '[2]']);
    const complete = await run(['query', '--sql', sql, '--params', '[2]', '--complete']);
    const command = await run(['latest', '2', '--json']);
    const operation = { id: 'first', kind: 'sql', sql, params: [2], complete: false };
    const batch = await run(['query', '--request', '-'], JSON.stringify({ schema: SQL_REQUEST_SCHEMA,
      operations: [operation, { ...operation, id: 'second', complete: true }] }));
    const result = selected.operations[0].result;
    assert.deepEqual(result.rows, complete.operations[0].result.rows);
    assert.deepEqual(result.rows.map((r: { id: string }) => r.id), command.sessions.map((s: { id: string }) => s.id));
    assert.equal(result.coverage.execution, 'selective');
    assert.equal(result.coverage.diagnostics, 'observed');
    assert.equal(result.total, null);
    assert.equal(complete.operations[0].result.total, command.total);
    assert.equal(command.total, 4);
    assert.deepEqual(selected.projection_issues, []);
    for (const op of batch.operations) {
      assert.deepEqual(op.result.rows, result.rows);
      assert.equal(op.result.coverage.execution, 'complete');
    }
    assert.equal('work' in selected, false);
    assert.equal('ids' in result, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Q5: CLI, v2, SQL, and human shell all enter one executor and retain command output", async () => {
  const snapshot = await snapshotPromise;
  const original = snapshot.executeCollectionQuery;
  const calls: LogicalQuery[] = [];
  snapshot.executeCollectionQuery = function(query, options) { calls.push(query); return original.call(this, query, options); };
  try {
    const command = capture({ scan: async () => snapshot });
    assert.equal(await runLiteCli(['latest', '2', '--json', '--no-dir'], command.io), 0);
    const expected = JSON.parse(command.stdout.join('')).sessions.map((s: { id: string }) => s.id);
    const legacy = capture({ scan: async () => snapshot, readStdin: async () => JSON.stringify({ schema: 'cchistory-lite-query/v2', operations: [{ id: 'q', kind: 'latest', limit: 2 }] }) });
    assert.equal(await runLiteCli(['query', '--request', '-', '--no-dir'], legacy.io), 0);
    assert.deepEqual(JSON.parse(legacy.stdout.join('')).operations[0].result.sessions.map((s: { id: string }) => s.id), expected);
    const query = capture({ scan: async () => snapshot });
    assert.equal(await runLiteCli(['query', '--sql', sql, '--params', '[2]', '--complete', '--no-dir'], query.io), 0, query.stderr.join(''));
    const payload = JSON.parse(query.stdout.join(''));
    assert.deepEqual(payload.operations[0].result.rows.map((s: { id: string }) => s.id), expected);
    assert.equal(payload.operations[0].result.total, JSON.parse(command.stdout.join('')).total);
    assert.equal(payload.operations[0].result.coverage.execution, 'complete');
    assert.deepEqual(payload.projection_issues, snapshot.projectionIssues);
    const lines = ['latest 2', sql.replace('$1', '2'), 'exit'];
    const shell = capture({ readLine: async () => lines.shift() ?? null, scan: async () => snapshot });
    assert.equal(await runLiteCli(['shell', '--no-dir'], shell.io), 0, shell.stderr.join(''));
    for (const id of expected) assert.ok(shell.stdout.join('').includes(id));
    assert.equal(calls.length, 5, 'all five requests must use executeCollectionQuery');
    for (const query of calls) {
      assert.equal(query.collection, 'sessions'); assert.equal(query.limit, 2);
      assert.deepEqual(query.predicate, calls[0]!.predicate);
    }
    const listed = capture({ scan: async () => snapshot });
    assert.equal(await runLiteCli(['ls', 'sessions', '--all', '--json', '--no-dir'], listed.io), 0);
    assert.equal(calls.at(-1)?.limit, Infinity, 'old --all remains a trusted template page');
  } finally { snapshot.executeCollectionQuery = original; }
});

test("Q6: invalid SQL batches, fields, values, and budgets fail before the first scan", async () => {
  let scans = 0;
  const fixture = JSON.parse(await readFile(new URL('../../../mock_data/fixtures/query-contract/review.json', import.meta.url), 'utf8'));
  for (const rejected of fixture.rejections) {
    const bad = capture({ scan: async () => { scans++; return snapshotPromise; } });
    assert.equal(await runLiteCli(['query', '--sql', rejected.sql, '--params', JSON.stringify(rejected.params), '--no-dir'], bad.io), 2, rejected.id);
    assert.equal(JSON.parse(bad.stderr.join('')).error.reason, rejected.expected_rejection, rejected.id);
  }
  const mixed = capture({ scan: async () => { scans++; return snapshotPromise; }, readStdin: async () => JSON.stringify({ schema: SQL_REQUEST_SCHEMA, operations: [{ id: 'valid', kind: 'sql', sql: sql, params: [2] }, { id: 'invalid', kind: 'sql', sql: 'DELETE FROM sessions' }] }) });
  assert.equal(await runLiteCli(['query', '--request', '-', '--no-dir'], mixed.io), 2);
  assert.equal(JSON.parse(mixed.stderr.join('')).error.operation_id, 'invalid');
  assert.equal(scans, 0);
});

test("SQL file/stdin, selected fields, and complete totals follow the public projection", async () => {
  const snapshot = await snapshotPromise;
  const query = capture({ scan: async () => snapshot, readStdin: async () => 'SELECT * FROM turns LIMIT 1' });
  assert.equal(await runLiteCli(['query', '--sql-file', '-', '--no-dir'], query.io), 0, query.stderr.join(''));
  const result = JSON.parse(query.stdout.join('')).operations[0].result;
  const turn = snapshot.getTurn(result.rows[0].id)!;
  assert.equal(result.total, null);
  assert.equal(result.rows[0].text, turn.canonical_text);
  assert.equal(result.rows[0].total_tokens, snapshot.getTurnUsage(turn.id)?.total_tokens ?? null);
  assert.equal(result.rows[0].source_platform, snapshot.getSession(turn.session_id)?.source_platform);
  assert.deepEqual(Object.keys(result.rows[0]), result.columns.map((c: { name: string }) => c.name));
  assert.equal('raw_text' in result.rows[0], false);
});

test("Q7: warm SQL shares read identity; successful refresh replaces it and failed refresh retains it", async () => {
  const first = await snapshotPromise, second = new LiveHistorySnapshot(first.data);
  let scans = 0;
  const op = JSON.stringify({ kind: 'sql', sql, params: [1] });
  const lines = [op, op, '{"kind":"refresh"}', op, '{"kind":"refresh"}', op, '{"kind":"exit"}'];
  const out = capture({ readLine: async () => lines.shift() ?? null });
  assert.equal(await runLiteShell({ io: out.io, jsonLines: true, scan: async () => { scans++; if (scans === 3) throw new Error('fixture refresh failure'); return scans === 1 ? first : second; } }), 1);
  const results = out.stdout.join('').trim().split('\n').map(line => JSON.parse(line));
  const reads = results.filter(r => r.kind === 'query_result').map(r => r.read.id);
  assert.deepEqual(reads, [first.readIdentity.id, first.readIdentity.id, second.readIdentity.id, second.readIdentity.id]);
  assert.equal(scans, 3);
  assert.equal(results[4].error.code, 'scan_failed');
});

class FakeClock implements ShellClock {
  now = 0; next = 0; timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number) => { const id = ++this.next; this.timers.set(id, { at: this.now + ms, fn }); return id; };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  advance(ms: number) { this.now += ms; for (const [id, timer] of this.timers) if (timer.at <= this.now) { this.timers.delete(id); timer.fn(); } }
}

test("Q8: deterministic idle expiry, active work, explicit exit/EOF, and disabled expiry", async () => {
  const snapshot = await snapshotPromise;
  for (const active of [false, true]) {
    const clock = new FakeClock(); let accept: (line: string | null) => void = () => {}; let closed = false;
    const out = capture({ readLine: () => new Promise(resolve => { accept = resolve; }) });
    if (active) out.io.stdout = v => { out.stdout.push(v); clock.advance(302000); };
    const running = runLiteShell({ io: out.io, jsonLines: true, clock, scan: async () => snapshot }).then(code => { closed = true; return code; });
    await immediate(); clock.advance(299000); await immediate(); assert.equal(closed, false);
    if (active) {
      accept(JSON.stringify({ kind: 'latest', limit: 1 })); await immediate();
      assert.equal(clock.now, 601000); assert.equal(closed, false);
      clock.advance(299000); await immediate(); assert.equal(closed, false);
    }
    clock.advance(1000); assert.equal(await running, 0); assert.equal(clock.timers.size, 0);
  }
  for (const line of [null, '{"kind":"exit"}']) {
    const clock = new FakeClock(); const out = capture({ readLine: async () => line });
    assert.equal(await runLiteShell({ io: out.io, jsonLines: true, clock, idleTimeoutSeconds: 0, scan: async () => snapshot }), 0);
    assert.equal(clock.timers.size, 0);
  }
});

test("Q8: partial input resets idle time, queued EOF drains, and input listeners are released", async () => {
  const snapshot = await snapshotPromise, clock = new FakeClock(), stdin = new PassThrough();
  const out = capture({ stdin }); let closed = false;
  const running = runLiteShell({ io: out.io, jsonLines: true, clock, scan: async () => snapshot }).then(code => { closed = true; return code; });
  await immediate(); clock.advance(299000); stdin.write('{"kind":');
  clock.advance(299000); await immediate(); assert.equal(closed, false);
  stdin.end('"latest","limit":1}\n{"kind":"list","collection":"sessions","limit":1}\n');
  assert.equal(await running, 0);
  assert.equal(out.stdout.join('').trim().split('\n').length, 2);
  assert.equal(clock.timers.size, 0); assert.equal(stdin.listenerCount('data'), 0);
});

test("Q8: pending output suspends expiry until it is flushed", async () => {
  const snapshot = await snapshotPromise, clock = new FakeClock();
  let release: () => void = () => {}, closed = false, line = 0;
  const drained = new Promise<void>(resolve => { release = resolve; });
  const out = capture({ readLine: () => ++line === 1 ? Promise.resolve('{"kind":"latest","limit":1}') : new Promise(() => {}) });
  const running = runLiteShell({ io: { ...out.io, flush: () => drained }, jsonLines: true, clock, scan: async () => snapshot }).then(code => { closed = true; return code; });
  await immediate(); clock.advance(600000); await immediate();
  assert.equal(closed, false); assert.equal(clock.timers.size, 0);
  release(); await immediate(); clock.advance(299000); await immediate(); assert.equal(closed, false);
  clock.advance(1000); assert.equal(await running, 0); assert.equal(clock.timers.size, 0);
});

test("cold shell validates before reading and help/exit never scan", async () => {
  for (const jsonLines of [false, true]) {
    const lines = jsonLines ? ['{"kind":"sql","sql":"DELETE FROM sessions"}', '{"kind":"exit"}']
      : ['help', 'latest broken', 'SELECT invalid FROM sessions LIMIT 1', 'unknown', 'exit'];
    let scans = 0;
    const out = capture({ readLine: async () => lines.shift() ?? null });
    await runLiteShell({ io: out.io, jsonLines, scan: async () => { scans++; throw new Error('must not scan'); } });
    assert.equal(scans, 0);
  }
});

test("scoped empty rows retain scope and report observed unknown directory attribution", async () => {
  const base = await snapshotPromise;
  const snapshot = new LiveHistorySnapshot({ ...base.data, sessions: base.data.sessions.map(s => ({ ...s, working_directory: undefined })) });
  for (const argv of [['latest', 'sessions', '10', '--json'], ['query', '--sql', 'SELECT id FROM sessions LIMIT 10']]) {
    const out = capture({ scan: async () => snapshot });
    assert.equal(await runLiteCli([...argv, '--dir', '/fixture/project'], out.io), 0, out.stderr.join(''));
    const payload = JSON.parse(out.stdout.join(''));
    const scope = payload.diagnostics.directory_scope;
    assert.equal(scope.directory, '/fixture/project');
    assert.equal(scope.unknown_directory_sessions, base.data.sessions.length);
    assert.equal(scope.matching_sessions, 0);
    assert.equal(payload.operations ? payload.operations[0].result.rows.length : payload.sessions.length, 0);
  }
});

test("source discovery never prepares history; counted status is explicit", async () => {
  const snapshot = await snapshotPromise;
  let scans = 0;
  for (const argv of [['sources'], ['ls', 'sources']]) {
    const out = capture({ homeDir: repoRoot, scan: async () => { scans++; return snapshot; } });
    assert.equal(await runLiteCli([...argv, '--json', '--source', 'codex', '--source-root', `codex=${sourceRoot}`], out.io), 0);
    const inventory = JSON.parse(out.stdout.join(''));
    assert.equal(inventory.kind, 'source_inventory');
    assert.equal(inventory.sources[0].history_read, false);
    assert.equal(inventory.sources[0].total_sessions, null);
    assert.equal(scans, 0);
  }
  const counted = capture({ scan: async () => { scans++; return snapshot; } });
  assert.equal(await runLiteCli(['sources', '--complete', '--json'], counted.io), 0);
  assert.equal(JSON.parse(counted.stdout.join('')).kind, 'sources');
  assert.equal(scans, 1);
});

test("native budget failure remains a resource error in one-shot and cold shell", async () => {
  const { SourceReadBudgetExceededError } = await import('@cchistory/live-runtime');
  let scans = 0;
  const scan = async () => { scans++; throw new SourceReadBudgetExceededError('fixture.db:blobs', 4096, 1024); };
  const out = capture({ scan });
  assert.equal(await runLiteCli(['latest', '--dir', '/fixture/project', '--json'], out.io), 1);
  assert.equal(out.stdout.join(''), '');
  const error = JSON.parse(out.stderr.join('')).error;
  assert.equal(error.code, 'read_budget_exceeded');
  assert.equal(error.resource.complete, false);
  const lines = ['{"kind":"latest","limit":1}', '{"kind":"exit"}'];
  const shell = capture({ readLine: async () => lines.shift() ?? null });
  assert.equal(await runLiteShell({ io: shell.io, jsonLines: true, directoryScope: '/fixture/project', scan }), 1);
  assert.equal(shell.stderr.join(''), '');
  assert.deepEqual(JSON.parse(shell.stdout.join('')).error.resource, error.resource);
  assert.equal(scans, 2); // No fallback to broader scope or repeated automatic scans.
});

test("sample caps rendered sessions even when a selected container projects many sessions", async () => {
  const snapshot = await snapshotPromise;
  assert.ok(snapshot.listTopLevelSessions().filter(s => s.turn_count > 0).length > 1);
  const out = capture({ scan: async () => snapshot });
  assert.equal(await runLiteCli(['sample', '1', '--no-dir', '--json'], out.io), 0);
  const result = JSON.parse(out.stdout.join(''));
  assert.equal(result.sampled, true);
  assert.equal(result.sample_per_source, 1);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, snapshot.selectCollectionTemplate('latest-sessions', 1).ids[0]);
});
