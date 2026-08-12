import type { SessionProjection, SessionRelatedWorkProjection } from "@cchistory/domain";

/**
 * Keep delegated child transcripts addressable without presenting them as
 * top-level user sessions in collection and project-browser projections.
 */
export function filterTopLevelSessions(
  sessions: readonly SessionProjection[],
  relatedWork: readonly SessionRelatedWorkProjection[],
): SessionProjection[] {
  const delegatedChildIds = new Set(
    relatedWork
      .filter((entry) =>
        entry.source_platform === "codex" &&
        entry.relation_kind === "delegated_session" &&
        entry.direction === "inbound" &&
        entry.child_session_ref === entry.query_session_ref
      )
      .map((entry) => entry.query_session_ref),
  );
  return sessions.filter((session) => !delegatedChildIds.has(session.id));
}
