import type { SessionProjection, SessionRelatedWorkProjection } from "@cchistory/domain";

/**
 * Omit a session from collection and project-browser trees when its inbound
 * delegated-session parent resolves to a different session in this snapshot.
 * Message-level parentUuid ancestry and orphan children stay visible.
 */
export function filterTopLevelSessions(
  sessions: readonly SessionProjection[],
  relatedWork: readonly SessionRelatedWorkProjection[],
): SessionProjection[] {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const delegatedChildIds = new Set(
    relatedWork
      .filter((entry) => {
        const parentSessionRef = entry.parent_session_ref;
        return (
          entry.relation_kind === "delegated_session" &&
          entry.direction === "inbound" &&
          entry.child_session_ref === entry.query_session_ref &&
          parentSessionRef !== undefined &&
          parentSessionRef !== entry.child_session_ref &&
          sessionIds.has(parentSessionRef)
        );
      })
      .map((entry) => entry.query_session_ref),
  );
  return sessions.filter((session) => !delegatedChildIds.has(session.id));
}
