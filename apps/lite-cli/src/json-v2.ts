import type {
  AssistantReplyProjection,
  LossAuditRecord,
  ProjectIdentity,
  SessionProjection,
  SessionRelatedWorkProjection,
  SourceStatus,
  TurnContextProjection,
  UserTurnProjection,
} from "@cchistory/domain";
import type { LiveHistorySnapshot } from "@cchistory/live-runtime";

export const COMPACT_JSON_SCHEMA = "cchistory-lite/v2";
export const CANONICAL_JSON_SCHEMA = "cchistory-lite-canonical/v1";
export const ERROR_JSON_SCHEMA = "cchistory-lite-error/v1";
export const CONTENT_TRUST = "untrusted_history";

export type JsonOutputMode = "none" | "compact" | "canonical";

export function compactPayload(
  payload: Record<string, unknown>,
  snapshot: LiveHistorySnapshot,
): Record<string, unknown> {
  const kind = String(payload.kind ?? "unknown");
  const base = {
    schema: COMPACT_JSON_SCHEMA,
    kind,
    content_trust: CONTENT_TRUST,
  };

  switch (kind) {
    case "sources":
      return { ...base, ...counts(payload), sources: records(payload.sources).map(sourceSummary) };
    case "projects":
      return { ...base, ...counts(payload), projects: records(payload.projects).map(projectSummary) };
    case "sessions":
      return {
        ...base,
        ...counts(payload),
        sessions: records(payload.sessions).map((value) => sessionSummary(value as unknown as SessionProjection, snapshot)),
      };
    case "turns":
      return {
        ...base,
        ...counts(payload),
        turns: records(payload.turns).map((value) => turnSummary(value as unknown as UserTurnProjection, snapshot)),
      };
    case "search":
      return {
        ...base,
        query: payload.query,
        total: payload.total,
        results: records(payload.results).map((result) => searchResultSummary(result, snapshot)),
      };
    case "project_tree":
      return compactProjectTree(base, payload, snapshot);
    case "session_tree":
      return { ...base, session: sessionNodeSummary(record(payload.session), snapshot) };
    case "project_detail":
      return {
        ...base,
        project: projectSummary(record(payload.project) as unknown as ProjectIdentity),
        sessions: records(payload.sessions).map((node) => sessionNodeSummary(node, snapshot)),
        turns: records(payload.turns).map((turn) => turnSummary(turn as unknown as UserTurnProjection, snapshot)),
      };
    case "session_detail":
      return {
        ...base,
        session: sessionSummary(record(payload.session) as unknown as SessionProjection, snapshot),
        related_work: records(payload.related_work).map(relatedWorkSummary),
        turns: records(payload.turns).map((entry) => {
          const turn = record(entry.turn) as unknown as UserTurnProjection;
          return {
            ...turnSummary(turn, snapshot),
            context: contextSummary(entry.context as TurnContextProjection | undefined, false),
          };
        }),
      };
    case "turn_detail": {
      const turn = record(payload.turn) as unknown as UserTurnProjection;
      const session = optionalRecord(payload.session) as unknown as SessionProjection | undefined;
      const project = optionalRecord(payload.project) as unknown as ProjectIdentity | undefined;
      return {
        ...base,
        turn: turnSummary(turn, snapshot),
        session: session ? sessionSummary(session, snapshot) : null,
        project: project ? projectSummary(project) : null,
        context: contextSummary(payload.context as TurnContextProjection | undefined, true),
      };
    }
    case "source_detail":
      return {
        ...base,
        source: sourceSummary(record(payload.source) as unknown as SourceStatus),
        sessions: records(payload.sessions).map((session) => sessionSummary(session as unknown as SessionProjection, snapshot)),
        loss_audits: records(payload.loss_audits).map(lossAuditSummary),
      };
    case "stats":
      return { ...base, overview: payload.overview, rollup: payload.rollup ?? null };
    default:
      return { ...base };
  }
}

export function sourceSummary(source: SourceStatus | Record<string, unknown>): Record<string, unknown> {
  const value = source as SourceStatus;
  return {
    id: value.id,
    slot_id: value.slot_id,
    platform: value.platform,
    display_name: value.display_name,
    base_dir: value.base_dir,
    sync_status: value.sync_status,
    error_message: value.error_message ?? null,
    last_sync: value.last_sync,
    total_sessions: value.total_sessions,
    total_turns: value.total_turns,
  };
}

export function projectSummary(project: ProjectIdentity | Record<string, unknown>): Record<string, unknown> {
  const value = project as ProjectIdentity;
  return {
    project_id: value.project_id,
    display_name: value.display_name,
    slug: value.slug,
    linkage_state: value.linkage_state,
    confidence: value.confidence,
    link_reason: value.link_reason,
    primary_workspace_path: value.primary_workspace_path ?? null,
    repo_root: value.repo_root ?? null,
    repo_remote: value.repo_remote ?? null,
    source_platforms: value.source_platforms ?? [],
    session_count: value.session_count,
    turn_count: value.committed_turn_count + value.candidate_turn_count,
    last_activity_at: value.project_last_activity_at ?? value.updated_at,
  };
}

export function sessionSummary(session: SessionProjection, snapshot: LiveHistorySnapshot): Record<string, unknown> {
  const turns = snapshot.listSessionTurns(session.id);
  const models = new Set<string>();
  if (session.model?.trim()) models.add(session.model.trim());
  for (const turn of turns) {
    const model = turn.context_summary.primary_model?.trim();
    if (model) models.add(model);
  }
  const usage = snapshot.getSessionUsage(session.id);
  return {
    id: session.id,
    source_id: session.source_id,
    source_platform: session.source_platform,
    title: session.canonical_title ?? null,
    created_at: session.created_at,
    updated_at: session.updated_at,
    activity_at: snapshot.getSessionActivityAt(session.id) ?? session.updated_at,
    turn_count: session.turn_count,
    model_summary: models.size > 0 ? [...models].join(", ") : null,
    total_tokens: usage?.total_tokens ?? null,
    working_directory: session.working_directory ?? null,
    source_session_id: session.source_session_id ?? null,
    resume_command: session.resume_command ?? null,
    primary_project_id: session.primary_project_id ?? null,
  };
}

export function turnSummary(turn: UserTurnProjection, snapshot: LiveHistorySnapshot): Record<string, unknown> {
  const session = snapshot.getSession(turn.session_id);
  const usage = snapshot.getTurnUsage(turn.id);
  return {
    id: turn.id,
    session_id: turn.session_id,
    source_id: turn.source_id,
    source_platform: session?.source_platform ?? null,
    project_id: turn.project_id ?? null,
    submission_started_at: turn.submission_started_at,
    last_context_activity_at: turn.last_context_activity_at,
    authored_text: turn.canonical_text,
    link_state: turn.link_state,
    model: turn.context_summary.primary_model ?? session?.model ?? null,
    total_tokens: usage?.total_tokens ?? null,
    assistant_reply_count: turn.context_summary.assistant_reply_count,
    tool_call_count: turn.context_summary.tool_call_count,
  };
}

export function assistantReplySummary(reply: AssistantReplyProjection): Record<string, unknown> {
  return {
    id: reply.id,
    created_at: reply.created_at,
    model: reply.model,
    stop_reason: reply.stop_reason ?? null,
    canonical_text: reply.canonical_text,
    token_usage: reply.token_usage ?? null,
  };
}

function compactProjectTree(
  base: Record<string, unknown>,
  payload: Record<string, unknown>,
  snapshot: LiveHistorySnapshot,
): Record<string, unknown> {
  if (payload.project) return { ...base, project: projectNodeSummary(record(payload.project), snapshot) };
  return {
    ...base,
    projects: records(payload.projects).map((node) => projectNodeSummary(node, snapshot)),
    unlinked: records(payload.unlinked).map((node) => sessionNodeSummary(node, snapshot)),
  };
}

function projectNodeSummary(node: Record<string, unknown>, snapshot: LiveHistorySnapshot): Record<string, unknown> {
  return {
    project: projectSummary(record(node.project) as unknown as ProjectIdentity),
    sessions: records(node.sessions).map((session) => sessionNodeSummary(session, snapshot)),
    turns: records(node.turns).map((turn) => turnSummary(turn as unknown as UserTurnProjection, snapshot)),
  };
}

function sessionNodeSummary(node: Record<string, unknown>, snapshot: LiveHistorySnapshot): Record<string, unknown> {
  return {
    session: sessionSummary(record(node.session) as unknown as SessionProjection, snapshot),
    turns: records(node.turns).map((turn) => turnSummary(turn as unknown as UserTurnProjection, snapshot)),
    related_work: records(node.related_work).map(relatedWorkSummary),
  };
}

export function searchResultSummary(result: Record<string, unknown>, snapshot: LiveHistorySnapshot): Record<string, unknown> {
  const turn = record(result.turn) as unknown as UserTurnProjection;
  const session = optionalRecord(result.session) as unknown as SessionProjection | undefined;
  const project = optionalRecord(result.project) as unknown as ProjectIdentity | undefined;
  return {
    turn: turnSummary(turn, snapshot),
    session: session ? sessionSummary(session, snapshot) : null,
    project: project ? projectSummary(project) : null,
    highlights: Array.isArray(result.highlights) ? result.highlights : [],
    relevance_score: result.relevance_score,
  };
}

function contextSummary(context: TurnContextProjection | undefined, includeReplies: boolean): Record<string, unknown> | null {
  if (!context) return null;
  return {
    assistant_reply_count: context.assistant_replies.length,
    tool_call_count: context.tool_calls.length,
    assistant_replies: includeReplies ? context.assistant_replies.map(assistantReplySummary) : [],
  };
}

export function relatedWorkSummary(value: Record<string, unknown>): Record<string, unknown> {
  const related = value as unknown as SessionRelatedWorkProjection;
  return {
    id: related.id,
    relation_kind: related.relation_kind,
    target_kind: related.target_kind,
    direction: related.direction ?? null,
    target_session_ref: related.target_session_ref ?? null,
    target_run_ref: related.target_run_ref ?? null,
    title: related.canonical_title ?? null,
    status: related.status ?? null,
    created_at: related.created_at,
    updated_at: related.updated_at,
    evidence_confidence: related.evidence_confidence,
  };
}

function lossAuditSummary(value: Record<string, unknown>): Record<string, unknown> {
  const audit = value as unknown as LossAuditRecord;
  return {
    id: audit.id,
    severity: audit.severity,
    diagnostic_code: audit.diagnostic_code,
    stage_kind: audit.stage_kind,
    scope_ref: audit.scope_ref,
    detail: audit.detail,
    created_at: audit.created_at,
  };
}

function counts(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    total: payload.total,
    ...(payload.shown === undefined ? {} : { shown: payload.shown }),
  };
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
