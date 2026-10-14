/** Optional metadata-only events. No transcript, tool body, query text or credentials. */
export interface ReadDiagnostic {
  kind: "read_start" | "read_done" | "read_error" | "progress" | "budget" | "query_work" | "cache";
  [field: string]: unknown;
}
export type ReadDiagnosticSink = (event: ReadDiagnostic) => void;
