import type {
  ProjectIdentity,
  SessionProjection,
  SourceStatus,
  TurnContextProjection,
  UserTurnProjection,
} from "@cchistory/domain";
import { compareTurnsByRecency, orderSessionsByLastMessage } from "./read-order.js";
import { resolveStructuredTokenTotal } from "./usage.js";

export interface ProjectionAuditInput {
  sources: readonly SourceStatus[];
  projects: readonly ProjectIdentity[];
  sessions: readonly SessionProjection[];
  turns: readonly UserTurnProjection[];
  contexts?: readonly TurnContextProjection[];
}

export interface ProjectionAuditIssue {
  code:
  | "duplicate-id"
  | "missing-source"
  | "missing-session"
  | "missing-project"
  | "missing-context-turn"
  | "session-turn-count"
  | "session-primary-project"
  | "project-turn-count"
  | "project-session-count"
  | "sessions-not-recency-ordered"
  | "turns-not-recency-ordered"
  | "projected-unlinked-turn"
  | "turn-usage-total-mismatch";
  entity: "source" | "project" | "session" | "turn" | "context" | "snapshot";
  id: string;
  detail: string;
}

/**
 * Check the cross-entity contracts that a live snapshot promises to its
 * consumers. This is intentionally a pure audit rather than a constructor
 * guard: malformed source data must remain inspectable, while tests and
 * diagnostic tooling still get a precise failure instead of a plausible but
 * wrong browser view.
 */
export function auditProjectionConsistency(input: ProjectionAuditInput): ProjectionAuditIssue[] {
  const issues: ProjectionAuditIssue[] = [];
  const sourceIds = indexIds(input.sources, "source", issues, (source) => source.id);
  const projectIds = indexIds(input.projects, "project", issues, (project) => project.project_id);
  const sessionIds = indexIds(input.sessions, "session", issues, (session) => session.id);
  const turnIds = new Set<string>();
  const contextTurnIds = new Set<string>();
  const turnsBySessionId = new Map<string, UserTurnProjection[]>();
  const turnsByProjectId = new Map<string, UserTurnProjection[]>();

  const expectedSessionOrder = orderSessionsByLastMessage(input.sessions, input.turns);
  for (const [index, session] of input.sessions.entries()) {
    if (!sourceIds.has(session.source_id)) {
      issues.push({
        code: "missing-source",
        entity: "session",
        id: session.id,
        detail: `source ${session.source_id} is not present`,
      });
    }
    if (session.primary_project_id && !projectIds.has(session.primary_project_id)) {
      issues.push({
        code: "session-primary-project",
        entity: "session",
        id: session.id,
        detail: `primary project ${session.primary_project_id} is not present`,
      });
    }
    const expected = expectedSessionOrder[index];
    if (expected && expected.id !== session.id) {
      issues.push({
        code: "sessions-not-recency-ordered",
        entity: "snapshot",
        id: session.id,
        detail: `expected session ${expected.id} at position ${index + 1}`,
      });
    }
  }

  for (const [index, turn] of input.turns.entries()) {
    if (turnIds.has(turn.id)) {
      issues.push({
        code: "duplicate-id",
        entity: "turn",
        id: turn.id,
        detail: "turn id appears more than once",
      });
    }
    turnIds.add(turn.id);
    if (!sourceIds.has(turn.source_id)) {
      issues.push({
        code: "missing-source",
        entity: "turn",
        id: turn.id,
        detail: `source ${turn.source_id} is not present`,
      });
    }
    if (!sessionIds.has(turn.session_id)) {
      issues.push({
        code: "missing-session",
        entity: "turn",
        id: turn.id,
        detail: `session ${turn.session_id} is not present`,
      });
    }
    if (turn.project_id && !projectIds.has(turn.project_id)) {
      issues.push({
        code: "missing-project",
        entity: "turn",
        id: turn.id,
        detail: `project ${turn.project_id} is not present`,
      });
    }
    if (turn.project_id && turn.link_state === "unlinked") {
      issues.push({
        code: "projected-unlinked-turn",
        entity: "turn",
        id: turn.id,
        detail: `turn points at project ${turn.project_id} but is marked unlinked`,
      });
    }
    const structuredTotal = resolveStructuredTokenTotal(turn.context_summary.token_usage);
    const summaryTotal = turn.context_summary.total_tokens;
    if (structuredTotal !== undefined && summaryTotal !== undefined && structuredTotal !== summaryTotal) {
      issues.push({
        code: "turn-usage-total-mismatch",
        entity: "turn",
        id: turn.id,
        detail: `structured token usage totals ${structuredTotal} but context summary declares ${summaryTotal}`,
      });
    }
    const sessionTurns = turnsBySessionId.get(turn.session_id);
    if (sessionTurns) sessionTurns.push(turn);
    else turnsBySessionId.set(turn.session_id, [turn]);
    if (turn.project_id) {
      const projectTurns = turnsByProjectId.get(turn.project_id);
      if (projectTurns) projectTurns.push(turn);
      else turnsByProjectId.set(turn.project_id, [turn]);
    }
    const previous = input.turns[index - 1];
    if (previous && compareTurnsByRecency(previous, turn) > 0) {
      issues.push({
        code: "turns-not-recency-ordered",
        entity: "snapshot",
        id: turn.id,
        detail: `turn follows a newer turn ${previous.id}`,
      });
    }
  }

  for (const session of input.sessions) {
    const actualTurnCount = turnsBySessionId.get(session.id)?.length ?? 0;
    if (session.turn_count !== actualTurnCount) {
      issues.push({
        code: "session-turn-count",
        entity: "session",
        id: session.id,
        detail: `declares ${session.turn_count} turns but projects ${actualTurnCount}`,
      });
    }
  }

  for (const project of input.projects) {
    const projectTurns = turnsByProjectId.get(project.project_id) ?? [];
    const committedTurnCount = projectTurns.filter((turn) => turn.link_state === "committed").length;
    const candidateTurnCount = projectTurns.filter((turn) => turn.link_state === "candidate").length;
    const sessionCount = new Set(projectTurns.map((turn) => turn.session_id)).size;
    if (
      project.committed_turn_count !== committedTurnCount ||
      project.candidate_turn_count !== candidateTurnCount
    ) {
      issues.push({
        code: "project-turn-count",
        entity: "project",
        id: project.project_id,
        detail: `declares ${project.committed_turn_count} committed and ${project.candidate_turn_count} candidate turns but projects ${committedTurnCount} and ${candidateTurnCount}`,
      });
    }
    if (project.session_count !== sessionCount) {
      issues.push({
        code: "project-session-count",
        entity: "project",
        id: project.project_id,
        detail: `declares ${project.session_count} sessions but projects ${sessionCount}`,
      });
    }
  }

  for (const context of input.contexts ?? []) {
    if (contextTurnIds.has(context.turn_id)) {
      issues.push({
        code: "duplicate-id",
        entity: "context",
        id: context.turn_id,
        detail: "context turn id appears more than once",
      });
    }
    contextTurnIds.add(context.turn_id);
    if (!turnIds.has(context.turn_id)) {
      issues.push({
        code: "missing-context-turn",
        entity: "context",
        id: context.turn_id,
        detail: "context points at a turn that is not present",
      });
    }
  }

  return issues;
}

function indexIds<T>(
  values: readonly T[],
  entity: "source" | "project" | "session",
  issues: ProjectionAuditIssue[],
  getId: (value: T) => string,
): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    const id = getId(value);
    if (ids.has(id)) {
      issues.push({
        code: "duplicate-id",
        entity,
        id,
        detail: `${entity} id appears more than once`,
      });
    }
    ids.add(id);
  }
  return ids;
}
