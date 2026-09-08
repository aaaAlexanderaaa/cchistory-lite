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
const rows = (collection: QueryCollection) => (collection === "sessions" ? fixture.canonical_session_order : fixture.canonical_turn_order)
  .map(id => fixture[collection].find(row => row.id === id)!);

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
