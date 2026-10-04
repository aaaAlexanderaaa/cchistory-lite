import type { LossAuditRecord, ReadStatus, SourceStatus } from "@cchistory/domain";

/** This summarizes observed evidence; no_known_gaps is never proof of a native transaction. */
export function summarizeReadStatus(input: {
  sources: readonly SourceStatus[];
  lossAudits: readonly LossAuditRecord[];
  projectionIssueCount: number;
  unknownDirectorySessions?: number;
  limitedScan?: boolean;
  observedDiagnostics?: boolean;
}): ReadStatus {
  const sources = input.sources.filter(s => s.sync_status === "error" || s.error_message).length;
  const losses = input.lossAudits.filter(a => a.severity !== "info").length;
  const unknown = input.unknownDirectorySessions ?? 0;
  const reasons = [sources ? "source_error" : "", losses ? "read_loss" : "", unknown ? "unknown_directory" : "",
    input.projectionIssueCount ? "projection_issue" : "", input.limitedScan ? "limited_scan" : "",
    input.observedDiagnostics ? "observed_diagnostics" : ""].filter(Boolean);
  return { status: sources || losses || unknown || input.projectionIssueCount ? "partial"
    : input.limitedScan || input.observedDiagnostics ? "unverified" : "no_known_gaps",
    reasons, source_error_count: sources, loss_warning_count: losses, unknown_directory_sessions: unknown,
    projection_issue_count: input.projectionIssueCount };
}
