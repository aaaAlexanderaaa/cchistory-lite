import { Worker } from "node:worker_threads";
import { QUERY_COLUMNS } from "@cchistory/canonical";
import type { LogicalQuery, QueryCollection, QueryPredicate, QueryValue, QueryValueType } from "@cchistory/domain";

export const SQL_REQUEST_SCHEMA = "cchistory-lite-query/v3";
export const SQL_RESULT_SCHEMA = "cchistory-lite-query-result/v3";
export const MAX_SQL_BYTES = 16_384;
export const MAX_QUERY_REQUEST_BYTES = 1_048_576;
export type QueryRejectionReason = "syntax" | "unsupported" | "field" | "parameter" | "type" | "budget";
export class QueryValidationError extends Error {
  readonly code = "invalid_query_request";
  constructor(message: string, readonly reason: QueryRejectionReason, readonly operationId?: string) { super(message); }
}
const fail = (reason: QueryRejectionReason, message: string): never => { throw new QueryValidationError(message, reason); };
type Node = Record<string, unknown>;
function node(value: unknown): Node {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("unsupported", "Expected a supported SQL node.");
  return value as Node;
}
function only(value: Node, keys: string[]): void {
  if (Object.keys(value).some(k => !keys.includes(k))) fail("unsupported", "Unsupported query construct or option.");
}
export interface SqlOperation { id: string; kind: "sql"; sql: string; params: QueryValue[]; complete: boolean }
export interface SqlRequest { schema: typeof SQL_REQUEST_SCHEMA; operations: SqlOperation[] }
export interface CompiledSqlRequest { schema: typeof SQL_REQUEST_SCHEMA; operations: { id: string; kind: "sql"; query: LogicalQuery }[] }

export function parseSqlRequest(raw: string): SqlRequest {
  if (Buffer.byteLength(raw) > MAX_QUERY_REQUEST_BYTES) fail("budget", "Query request exceeds 1 MiB.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail("syntax", "Query request must be JSON."); }
  const root = node(value); only(root, ["schema", "operations"]);
  if (root.schema !== SQL_REQUEST_SCHEMA) fail("unsupported", `Expected ${SQL_REQUEST_SCHEMA}.`);
  if (!Array.isArray(root.operations) || root.operations.length < 1 || root.operations.length > 16) fail("budget", "Expected 1–16 SQL operations.");
  const seen = new Set<string>();
  const operations = (root.operations as unknown[]).map(value => {
    const op = node(value); only(op, ["id", "kind", "sql", "params", "complete"]);
    if (typeof op.id !== "string" || !op.id.trim() || seen.has(op.id)) fail("parameter", "Operation IDs must be nonempty and unique.");
    if (op.kind !== "sql") fail("unsupported", "v3 accepts SQL operations only.");
    if (op.complete !== undefined && typeof op.complete !== "boolean") fail("type", "complete must be a boolean.");
    seen.add(op.id as string);
    try { validateSqlInput(op.sql, op.params === undefined ? [] : op.params); }
    catch (e) { if (e instanceof QueryValidationError) throw new QueryValidationError(e.message, e.reason, op.id as string); throw e; }
    return { id: op.id as string, kind: "sql" as const, sql: op.sql as string, params: (op.params === undefined ? [] : op.params) as QueryValue[], complete: op.complete === true };
  });
  return { schema: SQL_REQUEST_SCHEMA, operations };
}

function validateSqlInput(sql: unknown, params: unknown): void {
  if (typeof sql !== "string" || !sql.trim()) fail("syntax", "SQL must be a nonempty string.");
  if (Buffer.byteLength(sql as string) > MAX_SQL_BYTES) fail("budget", "SQL exceeds 16 KiB.");
  if (!Array.isArray(params) || params.length > 32) fail("parameter", "Bind at most 32 scalar parameters.");
  if (Buffer.byteLength(JSON.stringify(params)) > MAX_SQL_BYTES) fail("budget", "Parameters exceed 16 KiB.");
  if ((params as unknown[]).some(v => v !== null && !["string", "number", "boolean"].includes(typeof v) || typeof v === "number" && !Number.isFinite(v))) {
    fail("parameter", "Parameters must be finite JSON scalars or null.");
  }
}

export async function compileSqlRequest(request: SqlRequest): Promise<CompiledSqlRequest> {
  // Revalidate library callers too, before starting a worker or touching history.
  const checked = parseSqlRequest(JSON.stringify(request));
  const worker = new Worker(new URL("./sql-worker.js", import.meta.url));
  const message = (timeout: number): Promise<Node> => new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); worker.off("message", onMessage); worker.off("error", onError); worker.off("exit", onExit); };
    const onMessage = (value: Node) => { cleanup(); resolve(value); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onExit = () => onError(new QueryValidationError("SQL parser exited before completing the request.", "budget"));
    const timer = setTimeout(() => onError(new QueryValidationError("SQL parser exceeded its execution deadline.", "budget")), timeout);
    worker.once("message", onMessage); worker.once("error", onError); worker.once("exit", onExit);
  });
  try {
    await message(5000);
    const operations: CompiledSqlRequest["operations"] = [];
    for (const op of checked.operations) {
      try {
        const pending = message(1000); worker.postMessage(op.sql);
        const parsed = await pending;
        if (parsed.error) fail("syntax", String(parsed.error));
        operations.push({ id: op.id, kind: "sql", query: lowerSqlAst(parsed.ast, op.params, op.complete) });
      } catch (e) {
        if (e instanceof QueryValidationError) throw new QueryValidationError(e.message, e.reason, op.id);
        throw e;
      }
    }
    return { schema: SQL_REQUEST_SCHEMA, operations };
  } finally { await worker.terminate(); }
}

export async function compileSql(sql: string, params: QueryValue[] = [], complete = false): Promise<LogicalQuery> {
  return (await compileSqlRequest({ schema: SQL_REQUEST_SCHEMA, operations: [{ id: "query", kind: "sql", sql, params, complete }] })).operations[0]!.query;
}

function timestamp(value: string, parameter: boolean): string {
  const reject = (): never => fail(parameter ? "parameter" : "type", "Expected a valid RFC3339 timestamp with a timezone and millisecond precision.");
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!m) return reject();
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour > 23 || minute > 59 || second > 59) return reject();
  if (m[8] !== "Z" && (Number(m[8]!.slice(1, 3)) > 23 || Number(m[8]!.slice(4)) > 59)) return reject();
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return reject();
  return date.toISOString();
}

/** Positive AST allowlist. Parser support does not grant a feature to the product. */
export function lowerSqlAst(ast: unknown, params: QueryValue[], complete: boolean): LogicalQuery {
  if (!Array.isArray(ast) || ast.length !== 1) return fail("unsupported", "Exactly one SELECT statement is required.");
  const select = node(ast[0]); only(select, ["type", "columns", "from", "where", "orderBy", "limit"]);
  if (select.type !== "select") fail("unsupported", "Only SELECT is supported.");
  if (!Array.isArray(select.from) || select.from.length !== 1) fail("unsupported", "Select one collection.");
  const from = node((select.from as unknown[])[0]); only(from, ["type", "name"]);
  if (from.type !== "table") fail("unsupported", "Select one collection.");
  const table = node(from.name); only(table, ["name"]);
  if (table.name !== "sessions" && table.name !== "turns") fail("field", "Collection must be sessions or turns.");
  const collection = table.name as QueryCollection;
  const fields = new Map(QUERY_COLUMNS[collection].map(c => [c.name, c]));
  const ref = (raw: unknown): string => {
    const n = node(raw); only(n, ["type", "name"]);
    if (n.type !== "ref") return fail("unsupported", "Expected a bare public field.");
    if (typeof n.name !== "string" || !fields.has(n.name)) return fail("field", `Unknown ${collection} field: ${String(n.name)}.`);
    return n.name;
  };
  const used = new Set<number>(), expectedTypes = new Map<number, QueryValueType>();
  const value = (raw: unknown, type: QueryValueType): QueryValue => {
    const n = node(raw); let v: QueryValue; const parameter = n.type === "parameter";
    if (parameter) {
      only(n, ["type", "name"]);
      const index = Number(String(n.name).slice(1));
      if (!/^\$[1-9]\d*$/u.test(String(n.name)) || index > params.length) return fail("parameter", "Missing parameter binding.");
      used.add(index);
      if (expectedTypes.has(index) && expectedTypes.get(index) !== type) return fail("type", "Repeated parameter requires incompatible types.");
      expectedTypes.set(index, type); v = params[index - 1]!;
    } else if (n.type === "null") { only(n, ["type"]); v = null; }
    else if (["string", "integer", "numeric", "boolean"].includes(String(n.type))) { only(n, ["type", "value"]); v = n.value as QueryValue; }
    else if (n.type === "unary" && ["-", "+"].includes(String(n.op))) {
      only(n, ["type", "op", "operand"]); const operand = node(n.operand);
      if (!["integer", "numeric"].includes(String(operand.type))) return fail("unsupported", "Only numeric literal signs are supported.");
      const literal = value(operand, "number") as number; v = n.op === "-" ? -literal : literal;
    } else return fail("unsupported", "Expected a scalar literal or bound parameter.");
    if (v === null) return null;
    if (typeof v !== (type === "timestamp" ? "string" : type) || typeof v === "number" && !Number.isFinite(v)) return fail("type", `Expected ${type} operand.`);
    return type === "timestamp" ? timestamp(v as string, parameter) : v;
  };
  let leaves = 0;
  const predicate = (raw: unknown, depth = 0): QueryPredicate => {
    if (depth > 8 || ++leaves > 128) return fail("budget", "Predicate complexity exceeds v1 bounds.");
    const n = node(raw);
    if (n.type === "binary" && (n.op === "AND" || n.op === "OR")) {
      leaves--; only(n, ["type", "op", "left", "right"]);
      return { kind: n.op === "AND" ? "and" : "or", left: predicate(n.left, depth + 1), right: predicate(n.right, depth + 1) };
    }
    if (n.type === "unary" && n.op === "NOT") { leaves--; only(n, ["type", "op", "operand"]); return { kind: "not", operand: predicate(n.operand, depth + 1) }; }
    if (leaves > 64) return fail("budget", "At most 64 predicate leaves are supported.");
    if (n.type === "unary" && (n.op === "IS NULL" || n.op === "IS NOT NULL")) {
      only(n, ["type", "op", "operand"]); return { kind: "null", field: ref(n.operand), negate: n.op === "IS NOT NULL" };
    }
    if (n.type === "ternary" && (n.op === "BETWEEN" || n.op === "NOT BETWEEN")) {
      only(n, ["type", "op", "value", "lo", "hi"]); const field = ref(n.value), type = fields.get(field)!.type;
      if (type !== "number" && type !== "timestamp") return fail("type", "BETWEEN requires a number or timestamp field.");
      const range: QueryPredicate = { kind: "and", left: { kind: "compare", field, op: ">=", value: value(n.lo, type) }, right: { kind: "compare", field, op: "<=", value: value(n.hi, type) } };
      return n.op === "BETWEEN" ? range : { kind: "not", operand: range };
    }
    if (n.type !== "binary") return fail("unsupported", "Unsupported predicate.");
    only(n, ["type", "op", "left", "right"]);
    const field = ref(n.left), type = fields.get(field)!.type, op = String(n.op);
    if (op === "IN" || op === "NOT IN") {
      const list = node(n.right); only(list, ["type", "expressions"]);
      if (list.type !== "list" || !Array.isArray(list.expressions)) return fail("unsupported", "IN requires a value list.");
      if (list.expressions.length < 1 || list.expressions.length > 32) return fail("budget", "IN accepts 1–32 values.");
      return { kind: "in", field, values: list.expressions.map(v => value(v, type)), negate: op === "NOT IN" };
    }
    if (op === "LIKE" || op === "NOT LIKE") {
      if (type !== "string") return fail("type", "LIKE requires a string field.");
      const pattern = value(n.right, "string") as string | null;
      if (pattern !== null && (pattern.match(/\\+$/u)?.[0].length ?? 0) % 2 === 1) return fail(node(n.right).type === "parameter" ? "parameter" : "type", "LIKE pattern has a dangling escape.");
      return { kind: "like", field, pattern, negate: op === "NOT LIKE" };
    }
    if (!["=", "!=", "<", "<=", ">", ">="].includes(op)) return fail("unsupported", `Unsupported operator: ${op}.`);
    if (op !== "=" && op !== "!=" && type !== "number" && type !== "timestamp") return fail("type", "Ordering comparisons require numbers or timestamps.");
    return { kind: "compare", field, op: op as "=", value: value(n.right, type) };
  };
  if (!Array.isArray(select.columns) || !select.columns.length) fail("field", "Select public columns.");
  const projections = (select.columns as unknown[]).map(raw => { const c = node(raw); only(c, ["expr"]); return c.expr; });
  let columns: string[];
  if (projections.length === 1 && node(projections[0]).type === "ref" && node(projections[0]).name === "*") {
    only(node(projections[0]), ["type", "name"]); columns = [...fields.keys()];
  } else columns = projections.map(ref);
  if (new Set(columns).size !== columns.length) fail("field", "Duplicate columns are not supported.");
  const where = select.where === undefined ? undefined : predicate(select.where);
  if (select.orderBy !== undefined && !Array.isArray(select.orderBy)) fail("unsupported", "Unsupported ordering.");
  const order = ((select.orderBy ?? []) as unknown[]).map(raw => {
    const o = node(raw); only(o, ["by", "order", "nulls"]); const field = ref(o.by);
    const direction = o.order ?? "ASC", nulls = o.nulls ?? (direction === "ASC" ? "LAST" : "FIRST");
    if (direction !== "ASC" && direction !== "DESC" || nulls !== "FIRST" && nulls !== "LAST") fail("unsupported", "Unsupported ordering.");
    return { field, direction: direction as "ASC" | "DESC", nulls: nulls as "FIRST" | "LAST" };
  });
  if (order.length > 3 || new Set(order.map(x => x.field)).size !== order.length) fail("budget", "Order by up to three distinct fields.");
  if (select.limit === undefined) return fail("budget", "An explicit LIMIT is required.");
  const page = node(select.limit); only(page, ["limit", "offset"]);
  if (page.limit === undefined) return fail("budget", "An explicit LIMIT is required.");
  const limit = value(page.limit, "number"), offset = page.offset === undefined ? 0 : value(page.offset, "number");
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) return fail("budget", "LIMIT must be 1–1000 and OFFSET 0–100000.");
  if (used.size !== params.length || [...used].some(i => i < 1 || i > used.size)) fail("parameter", "Bindings must exactly match contiguous $1…$N references.");
  return { collection, columns, predicate: where, order, limit, offset, complete };
}
