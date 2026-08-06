import type { ProjectIdentity, SessionProjection, UserTurnProjection } from "@cchistory/domain";

export function buildProjectDisplayList(projects: readonly ProjectIdentity[]): ProjectIdentity[] {
  return projects
    .filter((project) => project.committed_turn_count + project.candidate_turn_count > 0)
    .sort((left, right) => {
      const leftTurns = left.committed_turn_count + left.candidate_turn_count;
      const rightTurns = right.committed_turn_count + right.candidate_turn_count;
      if (leftTurns !== rightTurns) {
        return rightTurns - leftTurns;
      }
      if (left.session_count !== right.session_count) {
        return right.session_count - left.session_count;
      }
      const activityCompare = (right.project_last_activity_at ?? right.updated_at).localeCompare(
        left.project_last_activity_at ?? left.updated_at,
      );
      if (activityCompare !== 0) {
        return activityCompare;
      }
      return left.display_name.localeCompare(right.display_name) || left.project_id.localeCompare(right.project_id);
    });
}

export function compareSessionsByRecency(left: SessionProjection, right: SessionProjection): number {
  return (
    right.updated_at.localeCompare(left.updated_at) ||
    right.created_at.localeCompare(left.created_at) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Index the latest observed conversation activity for each session. Unlike a
 * session's native `updated_at`, a turn's context activity is backed by an
 * actual user, assistant, or tool message and cannot be advanced by a scan or
 * file metadata update.
 */
export function buildSessionLastMessageIndex(
  turns: readonly UserTurnProjection[],
): Map<string, string> {
  const latestBySessionId = new Map<string, string>();
  for (const turn of turns) {
    const activityAt = turn.last_context_activity_at;
    const previous = latestBySessionId.get(turn.session_id);
    if (!previous || activityAt > previous) latestBySessionId.set(turn.session_id, activityAt);
  }
  return latestBySessionId;
}

/**
 * Sessions with conversation evidence sort by their last real message. A
 * turn-less session remains visible, but follows every session with message
 * evidence so source metadata cannot displace actual recent work.
 */
export function orderSessionsByLastMessage(
  sessions: readonly SessionProjection[],
  turns: readonly UserTurnProjection[],
): SessionProjection[] {
  const lastMessageBySessionId = buildSessionLastMessageIndex(turns);
  return [...sessions].sort((left, right) => {
    const leftActivity = lastMessageBySessionId.get(left.id);
    const rightActivity = lastMessageBySessionId.get(right.id);
    if (leftActivity && rightActivity) {
      return (
        rightActivity.localeCompare(leftActivity) ||
        right.created_at.localeCompare(left.created_at) ||
        left.id.localeCompare(right.id)
      );
    }
    if (leftActivity) return -1;
    if (rightActivity) return 1;
    return compareSessionsByRecency(left, right);
  });
}

export function compareTurnsByRecency(left: UserTurnProjection, right: UserTurnProjection): number {
  return (
    right.submission_started_at.localeCompare(left.submission_started_at) ||
    right.created_at.localeCompare(left.created_at) ||
    left.id.localeCompare(right.id)
  );
}

export function compareTurnsByChronology(left: UserTurnProjection, right: UserTurnProjection): number {
  return (
    left.submission_started_at.localeCompare(right.submission_started_at) ||
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id)
  );
}
