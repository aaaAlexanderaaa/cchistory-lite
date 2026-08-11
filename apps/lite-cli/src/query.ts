import {
  AmbiguousReferenceError,
  type LiteContextTarget,
  type LiveHistorySnapshot,
} from "@cchistory/live-runtime";
import {
  CONTENT_TRUST,
  assistantReplySummary,
  projectSummary,
  relatedWorkSummary,
  searchResultSummary,
  sessionSummary,
  turnSummary,
} from "./json-v2.js";

export const QUERY_REQUEST_SCHEMA = "cchistory-lite-query/v1";
export const QUERY_RESULT_SCHEMA = "cchistory-lite-query-result/v1";

export type QueryOperation = SearchOperation | SessionOperation | RepliesOperation;

export interface QueryRequest {
  schema: typeof QUERY_REQUEST_SCHEMA;
  operations: QueryOperation[];
}

interface QueryOperationBase {
  id: string;
  kind: "search" | "session" | "replies";
}

interface SearchOperation extends QueryOperationBase {
  kind: "search";
  query: string;
  project_ref?: string;
  limit?: number;
  offset?: number;
}

interface SessionOperation extends QueryOperationBase {
  kind: "session";
  refs: string[];
}

interface RepliesOperation extends QueryOperationBase {
  kind: "replies";
  turn_refs: string[];
}

export interface QueryExecutionResult {
  payload: Record<string, unknown>;
  hasOperationErrors: boolean;
}

export class QueryRequestError extends Error {
  readonly code = "invalid_query_request";
}

class QueryReferenceError extends Error {
  readonly code = "reference_not_found";
}

export function parseQueryRequest(raw: string): QueryRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new QueryRequestError(`Query request is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = requireRecord(parsed, "query request");
  assertOnlyKeys(root, new Set(["schema", "operations"]), "query request");
  if (root.schema !== QUERY_REQUEST_SCHEMA) {
    throw new QueryRequestError(`Query request schema must be ${QUERY_REQUEST_SCHEMA}.`);
  }
  if (!Array.isArray(root.operations) || root.operations.length === 0) {
    throw new QueryRequestError("Query request operations must be a non-empty array.");
  }
  const operations = root.operations.map((value, index) => parseOperation(value, index));
  const ids = new Set<string>();
  for (const operation of operations) {
    if (ids.has(operation.id)) throw new QueryRequestError(`Duplicate query operation id: ${operation.id}.`);
    ids.add(operation.id);
  }
  return { schema: QUERY_REQUEST_SCHEMA, operations };
}

export function queryContextTargets(request: QueryRequest): LiteContextTarget[] {
  return request.operations.flatMap((operation) => operation.kind === "replies"
    ? operation.turn_refs.map((ref) => ({ kind: "turn" as const, ref }))
    : []);
}

export function executeQuery(
  request: QueryRequest,
  snapshot: LiveHistorySnapshot,
  directoryScope?: string,
): QueryExecutionResult {
  let hasOperationErrors = false;
  const operations = request.operations.map((operation) => {
    try {
      return {
        id: operation.id,
        kind: operation.kind,
        status: "ok",
        result: executeOperation(operation, snapshot, directoryScope),
      };
    } catch (error) {
      hasOperationErrors = true;
      return {
        id: operation.id,
        kind: operation.kind,
        status: "error",
        error: queryErrorPayload(error),
      };
    }
  });
  return {
    payload: {
      schema: QUERY_RESULT_SCHEMA,
      kind: "query_result",
      content_trust: CONTENT_TRUST,
      operations,
      projection_issues: snapshot.projectionIssues,
    },
    hasOperationErrors,
  };
}

function executeOperation(
  operation: QueryOperation,
  snapshot: LiveHistorySnapshot,
  directoryScope?: string,
): Record<string, unknown> {
  if (operation.kind === "search") {
    const project = operation.project_ref ? snapshot.getProject(operation.project_ref) : undefined;
    if (operation.project_ref && !project) throw new QueryReferenceError(`Project not found: ${operation.project_ref}.`);
    const result = snapshot.search({
      query: operation.query,
      projectId: project?.project_id,
      limit: operation.limit ?? 50,
      offset: operation.offset ?? 0,
      directoryScope,
    });
    return {
      query: operation.query,
      total: result.total,
      results: result.results.map((entry) => searchResultSummary(entry as unknown as Record<string, unknown>, snapshot)),
    };
  }

  if (operation.kind === "session") {
    const allowed = directoryScope
      ? new Set(snapshot.listResolvedSessions({ directoryScope }).map((session) => session.id))
      : undefined;
    const sessions = operation.refs.map((ref) => {
      const session = snapshot.getSession(ref);
      if (!session || (allowed && !allowed.has(session.id))) throw new QueryReferenceError(`Session not found: ${ref}.`);
      return {
        session: sessionSummary(session, snapshot),
        turns: snapshot.listSessionTurns(session.id).map((turn) => turnSummary(turn, snapshot)),
        related_work: snapshot.listSessionRelatedWork(session.id).map((entry) => relatedWorkSummary(entry as unknown as Record<string, unknown>)),
      };
    });
    return { sessions };
  }

  const allowed = directoryScope
    ? new Set(snapshot.listResolvedTurns({ directoryScope }).map((turn) => turn.id))
    : undefined;
  const turns = operation.turn_refs.map((ref) => {
    const turn = snapshot.getTurn(ref);
    if (!turn || (allowed && !allowed.has(turn.id))) throw new QueryReferenceError(`UserTurn not found: ${ref}.`);
    const session = snapshot.getSession(turn.session_id);
    const project = turn.project_id ? snapshot.getProject(turn.project_id) : undefined;
    const context = snapshot.getTurnContext(turn.id);
    return {
      turn: turnSummary(turn, snapshot),
      session: session ? sessionSummary(session, snapshot) : null,
      project: project ? projectSummary(project) : null,
      assistant_replies: context?.assistant_replies.map(assistantReplySummary) ?? [],
    };
  });
  return { turns };
}

function parseOperation(value: unknown, index: number): QueryOperation {
  const operation = requireRecord(value, `operation ${index + 1}`);
  const id = requireNonEmptyString(operation.id, `operation ${index + 1} id`);
  const kind = requireNonEmptyString(operation.kind, `operation ${id} kind`);
  if (kind === "search") {
    assertOnlyKeys(operation, new Set(["id", "kind", "query", "project_ref", "limit", "offset"]), `operation ${id}`);
    const parsed: SearchOperation = {
      id,
      kind,
      query: requireNonEmptyString(operation.query, `operation ${id} query`),
    };
    if (operation.project_ref !== undefined) parsed.project_ref = requireNonEmptyString(operation.project_ref, `operation ${id} project_ref`);
    if (operation.limit !== undefined) parsed.limit = requireInteger(operation.limit, `operation ${id} limit`, 1);
    if (operation.offset !== undefined) parsed.offset = requireInteger(operation.offset, `operation ${id} offset`, 0);
    return parsed;
  }
  if (kind === "session") {
    assertOnlyKeys(operation, new Set(["id", "kind", "refs"]), `operation ${id}`);
    return { id, kind, refs: requireStringArray(operation.refs, `operation ${id} refs`) };
  }
  if (kind === "replies") {
    assertOnlyKeys(operation, new Set(["id", "kind", "turn_refs"]), `operation ${id}`);
    return { id, kind, turn_refs: requireStringArray(operation.turn_refs, `operation ${id} turn_refs`) };
  }
  throw new QueryRequestError(`Unsupported query operation kind: ${JSON.stringify(kind)}.`);
}

function queryErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof AmbiguousReferenceError) {
    return {
      code: "ambiguous_reference",
      message: error.message,
      candidates: error.candidateIds.map((id) => ({ id })),
    };
  }
  if (error instanceof QueryReferenceError) return { code: error.code, message: error.message, candidates: [] };
  return { code: "query_operation_failed", message: error instanceof Error ? error.message : String(error), candidates: [] };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QueryRequestError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new QueryRequestError(`${label} must be a non-empty string.`);
  return value.trim();
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new QueryRequestError(`${label} must be a non-empty string array.`);
  return value.map((entry, index) => requireNonEmptyString(entry, `${label}[${index}]`));
}

function requireInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new QueryRequestError(`${label} must be an integer >= ${minimum}.`);
  }
  return value as number;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new QueryRequestError(`${label} contains unknown field ${JSON.stringify(unknown[0])}.`);
}
