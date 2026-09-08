import type { CanonicalQueryResult, LogicalQuery, LossAuditRecord, SourceStatus } from "@cchistory/domain";
import { collectionQueryTemplate, type ProjectionAuditIssue } from "@cchistory/canonical";

export interface QueryReadWork {
  /** Entries returned by source discovery, before scope/group selection. */
  discoveredPrimaryFiles: number;
  plannedPrimaryFiles: number;
  /** Unique files consulted for grouping metadata; not bytes or physical read-call counts. */
  metadataEvidenceFiles: number;
  inventoryFiles: number;
  inventoryBytesRead: number;
  inventoryRecordsDecoded: number;
  payloadFilesProcessed: number;
  /** Collected native records passed through the payload pipeline, not JSON.parse invocations. */
  payloadRecordsProcessed: number;
  canonicalInterpretations: number;
  retainedSessions: number;
  retainedTurns: number;
  skippedPrimaryFiles: number;
  fallbackReason?: string;
}
export interface LiveQueryRead {
  identity: { id: string; prepared_at: string };
  sourceIds: string[];
  directoryScope?: string;
  directoryScopeDiagnostics?: ReturnType<typeof import("@cchistory/canonical").summarizeDirectoryScope>;
  result: CanonicalQueryResult;
  projectionIssues: readonly ProjectionAuditIssue[];
  sources: SourceStatus[];
  lossAudits: LossAuditRecord[];
  /** Work counters are library diagnostics, not a second user query result format. */
  work: QueryReadWork;
}
export interface SelectiveGroupPlan {
  groups: { files: readonly string[]; targetSessionRefs?: readonly string[] }[];
  upperBounds: string[];
  query: LogicalQuery;
  stopped: boolean;
}
export function newQueryReadWork(): QueryReadWork {
  return { discoveredPrimaryFiles: 0, plannedPrimaryFiles: 0, metadataEvidenceFiles: 0, inventoryFiles: 0, inventoryBytesRead: 0,
    inventoryRecordsDecoded: 0, payloadFilesProcessed: 0, payloadRecordsProcessed: 0,
    canonicalInterpretations: 0, retainedSessions: 0, retainedTurns: 0, skippedPrimaryFiles: 0 };
}
export function isSelectiveLatestQuery(query: LogicalQuery): boolean {
  const template = collectionQueryTemplate("latest-sessions", query.limit);
  return query.collection === "sessions" && !query.complete && query.offset === 0
    && query.limit >= 1 && query.limit <= 1000
    && JSON.stringify(query.columns) === JSON.stringify(["id", "title", "last_message_at"])
    && JSON.stringify(query.predicate) === JSON.stringify(template.predicate)
    && JSON.stringify(query.order) === JSON.stringify(template.order);
}
