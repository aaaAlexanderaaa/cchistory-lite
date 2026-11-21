import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { QueryValue, QueryCollection } from "@cchistory/domain";
import { executeQueryRows, collectionQueryTemplate } from "@cchistory/canonical";
import { compileSql, compileSqlRequest, parseSqlRequest, SQL_REQUEST_SCHEMA, QueryValidationError } from "./sql-query.js";

const fixture = JSON.parse(await readFile(new URL("../../../mock_data/fixtures/query-contract/review.json", import.meta.url), "utf8")) as {
  sessions: Record<string, QueryValue>[]; turns: Record<string, QueryValue>[];
  canonical_session_order: string[]; canonical_turn_order: string[];
  queries: { id: string; sql: string; params: QueryValue[]; expected_ids: string[]; expected_rows?: Record<string, QueryValue>[] }[];
  rejections: { id: string; sql: string; params: QueryValue[]; expected_rejection: string }[];
};
const rows = (collection: QueryCollection) => {
  if (collection === "calls") return [];
  return (collection === "sessions" ? fixture.canonical_session_order : fixture.canonical_turn_order)
    .map(id => fixture[collection].find(row => row.id === id)!);
};

test("Q1–Q5: the reviewed SQL corpus executes with fixed IDs, values, and canonical ties", async () => {
  const request = await compileSqlRequest({ schema: SQL_REQUEST_SCHEMA, operations: fixture.queries.map(({ id, sql, params }) => ({ id, kind: "sql" as const, sql, params, complete: false })) });
  for (const [index, op] of request.operations.entries()) {
    const expected = fixture.queries[index]!;
    const result = executeQueryRows(rows(op.query.collection), op.query);
    assert.deepEqual(result.ids, expected.expected_ids, expected.id);
    assert.equal(result.total, null);
    if (expected.expected_rows) assert.deepEqual(result.rows, expected.expected_rows);
  }
  for (const [id, template] of [["latest_sessions", "latest-sessions"], ["latest_turns", "latest-turns"], ["list_sessions", "list-sessions"]] as const) {
    const sql = request.operations.find(op => op.id === id)!.query;
    const command = collectionQueryTemplate(template, sql.limit, sql.offset);
    const fromSql = executeQueryRows(rows(sql.collection), { ...sql, complete: true });
    const fromCommand = executeQueryRows(rows(command.collection), command);
    assert.deepEqual(fromCommand.ids, fromSql.ids);
    assert.equal(fromCommand.total, fromSql.total);
  }
});

test("Q6: concrete and generated rejected queries never lower into executable plans", async () => {
  for (const q of fixture.rejections) {
    await assert.rejects(compileSql(q.sql, q.params), e => e instanceof QueryValidationError && e.reason === q.expected_rejection, q.id);
  }
  const rejected = [
    'SELECT id FROM sessions LIMIT 1; /*' + 'x'.repeat(16385) + '*/',
    'SELECT id FROM sessions WHERE ' + 'NOT '.repeat(9) + '(turn_count = 1) LIMIT 1',
    'SELECT id FROM sessions WHERE ' + Array(65).fill('turn_count = 1').join(' OR ') + ' LIMIT 1',
    'SELECT id FROM sessions WHERE id IN (' + Array(33).fill("'s1'").join(',') + ') LIMIT 1',
  ];
  for (const sql of rejected) await assert.rejects(compileSql(sql), e => e instanceof QueryValidationError && e.reason === "budget");
  for (const sql of [
    'SELECT id AS x FROM sessions LIMIT 1', 'SELECT id FROM sessions AS x LIMIT 1',
    'SELECT DISTINCT id FROM sessions LIMIT 1', 'SELECT sessions.id FROM sessions LIMIT 1',
    'SELECT * FROM sessions LIMIT 1 OFFSET -1', 'SELECT id, id FROM sessions LIMIT 1',
    'SELECT id FROM sessions WHERE turn_count = turn_count LIMIT 1',
  ]) await assert.rejects(compileSql(sql), QueryValidationError);
  await assert.rejects(compileSql('SELECT id FROM sessions LIMIT $2', [1, 2]), QueryValidationError);
  await assert.rejects(compileSql('SELECT id FROM sessions LIMIT 1', [1]), QueryValidationError);
  await assert.rejects(compileSql('SELECT id FROM sessions WHERE title = $1 AND turn_count = $1 LIMIT 1', [1]), QueryValidationError);
  assert.throws(() => parseSqlRequest(JSON.stringify({ schema: SQL_REQUEST_SCHEMA, operations: Array(17).fill({}) })), QueryValidationError);
  assert.throws(() => parseSqlRequest(JSON.stringify({ schema: SQL_REQUEST_SCHEMA, operations: [{ id: "q", kind: "sql", sql: "SELECT id FROM sessions LIMIT 1", params: null }] })), QueryValidationError);
});

test("Scalar semantics: timezone normalization, null order, Unicode patterns, and typed values", async () => {
  const run = async (sql: string, params: QueryValue[] = []) => {
    const query = await compileSql(sql, params, true);
    return executeQueryRows(rows(query.collection), query);
  };
  assert.deepEqual((await run('SELECT id FROM sessions WHERE last_message_at = $1 LIMIT 10', ['2026-04-15T20:00:00+08:00'])).ids, ['s2', 's1']);
  assert.deepEqual((await run('SELECT id FROM sessions ORDER BY last_message_at DESC LIMIT 1')).ids, ['s5']);
  assert.deepEqual((await run('SELECT id FROM sessions WHERE total_tokens IS NULL OR total_tokens NOT BETWEEN 0 AND 20 LIMIT 10')).ids, ['s1', 's6', 's5']);
  const query = await compileSql('SELECT id FROM sessions WHERE title LIKE $1 LIMIT 10', ['_\\_%']);
  assert.deepEqual(executeQueryRows([{ id: 'unicode', title: '😀_text' }, { id: 'wrong', title: '😀text' }], query).ids, ['unicode']);
  await assert.rejects(compileSql('SELECT id FROM sessions WHERE title LIKE $1 LIMIT 10', ['x\\']), QueryValidationError);
  await assert.rejects(compileSql('SELECT id FROM sessions WHERE created_at = $1 LIMIT 10', ['2026-04-15']), QueryValidationError);
  await assert.rejects(compileSql('SELECT id FROM sessions WHERE turn_count > $1 LIMIT 10', ['1']), QueryValidationError);
});

test("SQL calls collection compiles typed predicates and evaluates call-level telemetry rows", async () => {
  const query = await compileSql(
    "SELECT id, session_id, role, cache_hit_ratio, miss_cause, primary_tool, anomaly_kinds, adjusted_cost_usd FROM calls WHERE cache_status = $1 AND context_input_tokens >= $2 ORDER BY adjusted_cost_usd DESC LIMIT $3",
    ["miss", 20000, 5],
    true,
  );
  assert.equal(query.collection, "calls");
  const sampleCalls: Record<string, QueryValue>[] = [
    {
      id: "call-1", session_id: "s1", parent_session_id: null, turn_id: "t1", source_id: "src-1",
      source_platform: "claude_code", project_id: "p1", role: "main", subagent_key: null, granularity: "call",
      seq: 1, created_at: "2026-11-20T14:00:01.000Z", gap_ms: null, model: "claude-sonnet-4-5",
      input_tokens: 100, cache_read_tokens: 49000, cache_write_tokens: 0, output_tokens: 100, reasoning_tokens: 0,
      total_tokens: 49200, context_input_tokens: 49100, context_delta_tokens: 0, cache_hit_ratio: 0.998,
      cache_status: "hit", miss_cause: null, adjusted_cost_usd: 0.02, high_context_tier: false,
      tool_count: 1, tool_error_count: 0, primary_tool: "Bash:kubectl get pod api-<id>", anomaly_kinds: "polling_loop",
    },
    {
      id: "call-2", session_id: "s1", parent_session_id: null, turn_id: "t1", source_id: "src-1",
      source_platform: "claude_code", project_id: "p1", role: "main", subagent_key: null, granularity: "call",
      seq: 2, created_at: "2026-11-20T14:06:17.000Z", gap_ms: 372000, model: "claude-sonnet-4-5",
      input_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 49000, output_tokens: 200, reasoning_tokens: 0,
      total_tokens: 49300, context_input_tokens: 49100, context_delta_tokens: 1000, cache_hit_ratio: 0,
      cache_status: "miss", miss_cause: "idle_ttl_gap", adjusted_cost_usd: 0.19, high_context_tier: false,
      tool_count: 1, tool_error_count: 1, primary_tool: "Bash:npm test", anomaly_kinds: "cache_miss_cliff",
    },
    {
      id: "call-3", session_id: "s1", parent_session_id: "s1", turn_id: "t1", source_id: "src-1",
      source_platform: "claude_code", project_id: "p1", role: "subagent", subagent_key: "agent-explore-1", granularity: "call",
      seq: 3, created_at: "2026-11-20T14:01:00.000Z", gap_ms: null, model: "claude-sonnet-4-5",
      input_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 16000, output_tokens: 300, reasoning_tokens: 0,
      total_tokens: 16400, context_input_tokens: 16100, context_delta_tokens: null, cache_hit_ratio: 0,
      cache_status: "miss", miss_cause: "cold_start", adjusted_cost_usd: 0.06, high_context_tier: false,
      tool_count: 0, tool_error_count: 0, primary_tool: null, anomaly_kinds: null,
    },
  ];
  const res = executeQueryRows(sampleCalls, query);
  assert.deepEqual(res.ids, ["call-2"]);
  assert.equal(res.total, 1);
  assert.equal(res.rows[0]?.miss_cause, "idle_ttl_gap");
  assert.equal(res.rows[0]?.primary_tool, "Bash:npm test");

  await assert.rejects(compileSql("SELECT unknown_col FROM calls LIMIT 1"), QueryValidationError);
  await assert.rejects(compileSql("SELECT id FROM calls WHERE high_context_tier = 'yes' LIMIT 1"), QueryValidationError);
});
