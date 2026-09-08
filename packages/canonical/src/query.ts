import type {
  CanonicalQueryResult, LogicalQuery, QueryCollection, QueryColumn, QueryPredicate, QueryValue,
  SessionProjection, UserTurnProjection, SessionRelatedWorkProjection,
} from "@cchistory/domain";
import { buildSessionLastMessageIndex } from "./read-order.js";
import { filterSessionsByDirectoryScope, filterTurnsByDirectoryScope } from "./directory-scope.js";
import { filterTopLevelSessions } from "./session-collections.js";
import { resolveTurnUsage, summarizeSessionUsage } from "./usage.js";

const column = (name: string, type: QueryColumn["type"] = "string", nullable = false): QueryColumn => ({ name, type, nullable });
export const QUERY_COLUMNS: Readonly<Record<QueryCollection, readonly QueryColumn[]>> = {
  sessions: [column("id"), column("source_id"), column("source_platform"), column("title", "string", true),
    column("created_at", "timestamp"), column("last_message_at", "timestamp", true), column("turn_count", "number"),
    column("is_top_level", "boolean"), column("primary_project_id", "string", true), column("working_directory", "string", true),
    column("model", "string", true), column("total_tokens", "number", true)],
  turns: [column("id"), column("session_id"), column("source_id"), column("source_platform"), column("project_id", "string", true),
    column("submitted_at", "timestamp"), column("last_message_at", "timestamp"), column("text"), column("model", "string", true),
    column("total_tokens", "number", true), column("has_errors", "boolean"), column("link_state")],
};

/** Command frontends only choose a template and page. These are also the SQL selection semantics. */
export function collectionQueryTemplate(kind: "latest-sessions" | "latest-turns" | "list-sessions", limit = 20, offset = 0): LogicalQuery {
  if (!(Number.isSafeInteger(limit) && limit > 0 || limit === Infinity) || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Invalid collection page.");
  }
  const sessions = kind !== "latest-turns";
  const top: QueryPredicate = { kind: "compare", field: "is_top_level", op: "=", value: true };
  return {
    collection: sessions ? "sessions" : "turns", columns: ["id"],
    predicate: !sessions ? undefined : kind === "latest-sessions"
      ? { kind: "and", left: top, right: { kind: "compare", field: "turn_count", op: ">", value: 0 } } : top,
    order: [{ field: sessions ? "last_message_at" : "submitted_at", direction: "DESC", nulls: "LAST" }],
    limit, offset, complete: true,
  };
}

export interface QuerySnapshotData {
  sessions: readonly SessionProjection[];
  turns: readonly UserTurnProjection[];
  related_work: readonly SessionRelatedWorkProjection[];
}

export function executeCanonicalQuery(data: QuerySnapshotData, query: LogicalQuery, directoryScope?: string): CanonicalQueryResult {
  const needed = new Set([...query.columns, ...query.order.map(x => x.field), "id"]);
  const collect = (p?: QueryPredicate): void => {
    if (!p) return;
    if (p.kind === "and" || p.kind === "or") { collect(p.left); collect(p.right); }
    else if (p.kind === "not") collect(p.operand);
    else needed.add(p.field);
  };
  collect(query.predicate);
  const last = needed.has("last_message_at") && query.collection === "sessions" ? buildSessionLastMessageIndex(data.turns) : undefined;
  const top = needed.has("is_top_level") ? new Set(filterTopLevelSessions(data.sessions, data.related_work).map(s => s.id)) : undefined;
  const sessions = new Map(data.sessions.map(s => [s.id, s]));
  const ownTurns = new Map<string, UserTurnProjection[]>();
  if (needed.has("total_tokens") && query.collection === "sessions") {
    for (const turn of data.turns) {
      const list = ownTurns.get(turn.session_id) ?? []; list.push(turn); ownTurns.set(turn.session_id, list);
    }
  }
  const project = (entity: SessionProjection | UserTurnProjection): Record<string, QueryValue> => {
    const get = (field: string): QueryValue => {
      if (query.collection === "sessions") {
        const s = entity as SessionProjection;
        if (field === "title") return s.canonical_title ?? null;
        if (field === "last_message_at") return last?.get(s.id) ?? null;
        if (field === "is_top_level") return top?.has(s.id) ?? false;
        if (field === "total_tokens") return summarizeSessionUsage(ownTurns.get(s.id) ?? []).total_tokens ?? null;
      } else {
        const t = entity as UserTurnProjection;
        if (field === "source_platform") return sessions.get(t.session_id)?.source_platform ?? null;
        if (field === "submitted_at") return t.submission_started_at;
        if (field === "last_message_at") return t.last_context_activity_at;
        if (field === "text") return t.canonical_text;
        if (field === "model") return t.context_summary.primary_model ?? null;
        if (field === "total_tokens") return resolveTurnUsage(t).total_tokens ?? null;
        if (field === "has_errors") return t.context_summary.has_errors;
      }
      return (entity as unknown as Record<string, QueryValue>)[field] ?? null;
    };
    return Object.fromEntries([...needed].map(field => [field, get(field)]));
  };
  // Snapshot collections already retain canonical order. It is also the stable tie order.
  const entities = query.collection === "sessions"
    ? filterSessionsByDirectoryScope(data.sessions, directoryScope)
    : filterTurnsByDirectoryScope(data.turns, data.sessions, directoryScope);
  return executeQueryRows(entities.map(project), query);
}

type Truth = boolean | null;
const negate = (v: Truth): Truth => v === null ? null : !v;
function compare(a: QueryValue, b: QueryValue): number {
  if (typeof a === "string" && typeof b === "string") {
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      const x = a.codePointAt(i)!, y = b.codePointAt(j)!;
      if (x !== y) return x - y;
      i += x > 0xffff ? 2 : 1; j += y > 0xffff ? 2 : 1;
    }
    return (a.length - i) - (b.length - j);
  }
  return a === b ? 0 : a! < b! ? -1 : 1;
}

/** Linear-space wildcard matching; never compile a user's pattern to a backtracking regexp. */
function like(text: string, pattern: string): boolean {
  const input = Array.from(text), chars = Array.from(pattern);
  const tokens: { kind: "many" | "one" | "text"; text?: string }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "\\") tokens.push({ kind: "text", text: chars[++i] });
    else tokens.push(c === "%" ? { kind: "many" } : c === "_" ? { kind: "one" } : { kind: "text", text: c });
  }
  let previous = new Uint8Array(input.length + 1); previous[0] = 1;
  for (const t of tokens) {
    const next = new Uint8Array(input.length + 1);
    if (t.kind === "many") next[0] = previous[0]!;
    for (let i = 1; i <= input.length; i++) {
      next[i] = t.kind === "many" ? Number(Boolean(previous[i] || next[i - 1]))
        : Number(Boolean(previous[i - 1]) && (t.kind === "one" || t.text === input[i - 1]));
    }
    previous = next;
  }
  return previous[input.length] === 1;
}

function matches(row: Record<string, QueryValue>, p: QueryPredicate, compareField: (field: string, a: QueryValue, b: QueryValue) => number): Truth {
  if (p.kind === "and" || p.kind === "or") {
    const a = matches(row, p.left, compareField), b = matches(row, p.right, compareField);
    return p.kind === "and" ? a === false || b === false ? false : a === null || b === null ? null : true
      : a === true || b === true ? true : a === null || b === null ? null : false;
  }
  if (p.kind === "not") return negate(matches(row, p.operand, compareField));
  const value = row[p.field] ?? null;
  if (p.kind === "null") return p.negate ? value !== null : value === null;
  if (p.kind === "in") {
    const found = value !== null && p.values.some(v => v !== null && compareField(p.field, value, v) === 0);
    const result = found ? true : value === null || p.values.includes(null) ? null : false;
    return p.negate ? negate(result) : result;
  }
  if (p.kind === "like") {
    const result = value === null || p.pattern === null ? null : like(String(value), p.pattern);
    return p.negate ? negate(result) : result;
  }
  if (value === null || p.value === null) return null;
  const c = compareField(p.field, value, p.value);
  return p.op === "=" ? c === 0 : p.op === "!=" ? c !== 0 : p.op === "<" ? c < 0 : p.op === "<=" ? c <= 0 : p.op === ">" ? c > 0 : c >= 0;
}

/** Shared evaluation for every frontend; rows arrive in canonical tie order. */
export function executeQueryRows(rows: readonly Record<string, QueryValue>[], query: LogicalQuery): CanonicalQueryResult {
  const types = new Map(QUERY_COLUMNS[query.collection].map(c => [c.name, c]));
  const compareField = (field: string, a: QueryValue, b: QueryValue) => types.get(field)?.type === "timestamp"
    ? Date.parse(String(a)) - Date.parse(String(b)) : compare(a, b);
  const normalized = rows.map(row => {
    const result = { ...row };
    for (const [key, value] of Object.entries(result)) {
      if (value !== null && types.get(key)?.type === "timestamp") result[key] = new Date(String(value)).toISOString();
    }
    return result;
  });
  const selected = query.predicate ? normalized.filter(row => matches(row, query.predicate!, compareField) === true) : normalized;
  selected.sort((a, b) => {
    for (const key of query.order) {
      const x = a[key.field] ?? null, y = b[key.field] ?? null;
      if (x === y) continue;
      if (x === null || y === null) return (x === null ? -1 : 1) * (key.nulls === "FIRST" ? 1 : -1);
      const c = compareField(key.field, x, y);
      if (c) return key.direction === "ASC" ? c : -c;
    }
    return 0;
  });
  const page = selected.slice(query.offset, query.offset + query.limit);
  return {
    ids: page.map(row => String(row.id)), columns: query.columns.map(name => ({ ...types.get(name)! })),
    rows: page.map(row => Object.fromEntries(query.columns.map(name => [name, row[name] ?? null]))),
    total: query.complete ? selected.length : null, shown: page.length, limit: query.limit, offset: query.offset,
    coverage: { execution: "complete", rows: "exact", diagnostics: "complete" },
  };
}

/** A sample's physical file selection can contain many sessions in one container. */
export function selectSampleSessions(data: QuerySnapshotData, perSource: number, directoryScope?: string): CanonicalQueryResult {
  const admitted: string[] = [];
  for (const sourceId of new Set(data.sessions.map(session => session.source_id))) {
    const query = collectionQueryTemplate("latest-sessions", perSource);
    query.predicate = { kind: "and", left: query.predicate!, right: { kind: "compare", field: "source_id", op: "=", value: sourceId } };
    admitted.push(...executeCanonicalQuery(data, query, directoryScope).ids);
  }
  const query = collectionQueryTemplate("latest-sessions", Infinity);
  query.predicate = { kind: "in", field: "id", values: admitted, negate: false };
  return executeCanonicalQuery(data, query, directoryScope);
}
