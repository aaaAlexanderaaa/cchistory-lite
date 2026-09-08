export type QueryCollection = "sessions" | "turns";
export type QueryValue = string | number | boolean | null;
export type QueryValueType = "string" | "number" | "boolean" | "timestamp";
export interface QueryColumn { name: string; type: QueryValueType; nullable: boolean }
export type QueryPredicate =
  | { kind: "and"; left: QueryPredicate; right: QueryPredicate }
  | { kind: "or"; left: QueryPredicate; right: QueryPredicate }
  | { kind: "not"; operand: QueryPredicate }
  | { kind: "null"; field: string; negate: boolean }
  | { kind: "compare"; field: string; op: "=" | "!=" | "<" | "<=" | ">" | ">="; value: QueryValue }
  | { kind: "in"; field: string; values: QueryValue[]; negate: boolean }
  | { kind: "like"; field: string; pattern: string | null; negate: boolean };
export interface LogicalQuery {
  collection: QueryCollection;
  columns: string[];
  predicate?: QueryPredicate;
  order: { field: string; direction: "ASC" | "DESC"; nulls: "FIRST" | "LAST" }[];
  limit: number;
  offset: number;
  complete: boolean;
}
export interface CanonicalQueryResult {
  ids: string[];
  columns: QueryColumn[];
  rows: Record<string, QueryValue>[];
  total: number | null;
  shown: number;
  limit: number;
  offset: number;
  coverage: { execution: "complete" | "selective"; rows: "exact"; diagnostics: "complete" | "observed" };
}
