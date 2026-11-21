/**
 * Role: Canonical usage row extraction, multi-dimension filtering, and single-dimension
 * overview/rollup aggregation with separated cache read/write and cost totals.
 * Excludes multi-dimension matrix breakdowns (usage-breakdown.ts) and pricing lookup (usage-pricing.ts).
 */

import type {
  AssistantStopReason,
  ProjectIdentity,
  SessionContributionProjection,
  SessionFamilyProjection,
  SessionProjection,
  SessionRelatedWorkProjection,
  SessionUsageEvent,
  SourceStatus,
  TokenUsageSummary,
  UsagePricingConfig,
  UsageStatsDimension,
  UsageStatsRollupRow,
  UsageTimeBucket,
  UsageTimePreset,
  UsageToolSummary,
  UsageWeekMode,
  UserTurnProjection,
} from "@cchistory/domain";
import { mergeTokenUsageMetrics } from "@cchistory/domain";
import { sessionMatchesDirectoryScope } from "./directory-scope.js";
import { extractLocalTimeParts, resolveUsageTimezone, resolveWeekBucket } from "./usage-time.js";

export interface UsageFilters {
  project_id?: string;
  project_ids?: string[];
  session_ids?: string[];
  source_ids?: string[];
  host_ids?: string[];
  models?: string[];
  model_queries?: string[];
  time_keys?: string[];
  time_dimension?: UsageTimeBucket;
  after_date?: string; // YYYY-MM-DD (inclusive in selected timezone)
  before_date?: string; // YYYY-MM-DD (inclusive in selected timezone)
  after_ts?: number; // epoch ms inclusive
  before_ts?: number; // epoch ms inclusive
  include_known_zero_token?: boolean;
  directory_scope?: string;
  timezone?: string;
  week_mode?: UsageWeekMode;
  week_start_day?: number;
  week_reset_hour?: number;
  now_ms?: number;
  pricing?: UsagePricingConfig;
  quota_limit_usd?: number;
  time_preset?: UsageTimePreset;
}

export interface UsageAggregationRow {
  context_input_tokens?: number;
  event_id?: string;
  seq?: number;
  created_at?: string;
  subagent_key?: string;
  stop_reason?: AssistantStopReason;
  compaction_before?: boolean;
  preceding_tool_results?: readonly UsageToolSummary[];
  emitted_tool_calls?: readonly UsageToolSummary[];
  is_call_event?: boolean;
  turn_id: string | null;
  session_id: string;
  session_label: string;
  source_id: string;
  source_label: string;
  host_id: string;
  project_id?: string;
  project_label: string;
  model: string;
  timestamp_ms: number;
  local_hour: number;
  hour: string;
  hour_of_day: string;
  day: string;
  week: string;
  week_label: string;
  month: string;
  has_token_usage: boolean;
  zero_token_reason?: string;
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  non_reasoning_output_tokens: number;
  reasoning_for_billing_tokens: number;
  billable_output_tokens: number;
  total_tokens: number;
}

export interface TurnUsageProjection {
  has_token_usage: boolean;
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface SessionUsageProjection {
  turns_with_token_usage: number;
  total_tokens?: number;
}

export interface UsageSourceData {
  listResolvedTurns: () => readonly UserTurnProjection[];
  listResolvedSessions: () => readonly SessionProjection[];
  listSources: () => readonly SourceStatus[];
  listProjects: () => readonly ProjectIdentity[];
  listSessionContributions?: () => readonly SessionContributionProjection[];
  listSessionFamilies?: () => readonly SessionFamilyProjection[];
  listRelatedWork?: () => readonly SessionRelatedWorkProjection[];
}

export const UNASSIGNED_PROJECT_KEY = "unassigned";

/** Resolve the approved option-B total from structured usage when possible. */
export function resolveStructuredTokenTotal(usage: TokenUsageSummary | undefined): number | undefined {
  if (!usage) return undefined;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;

  const cacheTokens =
    usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined
      ? (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      : usage.cached_input_tokens;
  const components = [usage.input_tokens, cacheTokens, usage.output_tokens];
  return components.some((value) => typeof value === "number")
    ? components.reduce<number>((total, value) => total + (value ?? 0), 0)
    : undefined;
}

export function resolveTurnUsage(turn: UserTurnProjection): TurnUsageProjection {
  const usage = turn.context_summary.token_usage;
  const cachedInputTokens = usage
    ? usage.cached_input_tokens ??
      (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined
        ? (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        : undefined)
    : undefined;
  const structuredTotal = resolveStructuredTokenTotal(usage);
  const values = usage
    ? [
        usage.input_tokens,
        usage.cache_read_input_tokens,
        usage.cache_creation_input_tokens,
        usage.cached_input_tokens,
        usage.output_tokens,
        usage.reasoning_output_tokens,
        usage.total_tokens,
      ]
    : [];
  return {
    has_token_usage:
      values.some((value) => typeof value === "number") ||
      typeof turn.context_summary.total_tokens === "number",
    input_tokens: usage?.input_tokens,
    cache_read_input_tokens: usage?.cache_read_input_tokens,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: usage?.output_tokens,
    reasoning_output_tokens: usage?.reasoning_output_tokens,
    total_tokens: structuredTotal ?? turn.context_summary.total_tokens,
  };
}

export function resolveSessionUsageMetrics(session: SessionProjection | undefined): TokenUsageSummary | undefined {
  return session?.usage_events?.reduce<TokenUsageSummary | undefined>(
    (sum, event) => mergeTokenUsageMetrics(sum, event.token_usage),
    undefined,
  );
}

export function summarizeSessionUsage(
  turns: readonly UserTurnProjection[],
  session?: SessionProjection,
): SessionUsageProjection {
  let turnsWithTokenUsage = 0;
  let totalTokens = 0;
  let hasTotal = false;
  for (const turn of turns) {
    const usage = resolveTurnUsage(turn);
    if (usage.has_token_usage) turnsWithTokenUsage += 1;
    if (usage.total_tokens === undefined) continue;
    hasTotal = true;
    totalTokens += usage.total_tokens;
  }
  return {
    turns_with_token_usage: turnsWithTokenUsage,
    total_tokens: resolveStructuredTokenTotal(resolveSessionUsageMetrics(session)) ?? (hasTotal ? totalTokens : undefined),
  };
}

export function hasAnyTokenUsage(turn: UserTurnProjection): boolean {
  return resolveTurnUsage(turn).has_token_usage;
}

export function sumUsageRows(
  rows: readonly UsageAggregationRow[],
  key: keyof Pick<
    UsageAggregationRow,
    | "input_tokens"
    | "cache_read_input_tokens"
    | "cache_creation_input_tokens"
    | "cached_input_tokens"
    | "output_tokens"
    | "reasoning_output_tokens"
    | "billable_output_tokens"
    | "total_tokens"
  >,
): number {
  return rows.reduce((total, row) => total + row[key], 0);
}

export function usageDimensionKey(row: UsageAggregationRow, dimension: UsageStatsDimension): string {
  switch (dimension) {
    case "model":
      return row.model;
    case "project":
      return row.project_id ?? UNASSIGNED_PROJECT_KEY;
    case "source":
      return row.source_id;
    case "host":
      return row.host_id;
    case "session":
      return row.session_id;
    case "hour":
      return row.hour;
    case "hour_of_day":
      return row.hour_of_day;
    case "day":
      return row.day;
    case "week":
      return row.week;
    case "month":
      return row.month;
  }
}

export function usageDimensionLabel(row: UsageAggregationRow, dimension: UsageStatsDimension): string {
  switch (dimension) {
    case "model":
      return row.model;
    case "project":
      return row.project_label;
    case "source":
      return row.source_label;
    case "host":
      return row.host_id;
    case "session":
      return row.session_label;
    case "hour":
      return row.hour;
    case "hour_of_day":
      return row.hour_of_day;
    case "day":
      return row.day;
    case "week":
      return row.week_label;
    case "month":
      return row.month;
  }
}

export function compareUsageRollupRows(
  dimension: UsageStatsDimension,
  left: UsageStatsRollupRow,
  right: UsageStatsRollupRow,
): number {
  if (
    dimension === "hour" ||
    dimension === "hour_of_day" ||
    dimension === "day" ||
    dimension === "week" ||
    dimension === "month"
  ) {
    return left.key.localeCompare(right.key);
  }
  if (dimension === "session") {
    const costDiff = (right.cost?.adjusted_cost_usd ?? 0) - (left.cost?.adjusted_cost_usd ?? 0);
    if (Math.abs(costDiff) > 1e-9) return costDiff;
  }
  if (left.total_tokens !== right.total_tokens) {
    return right.total_tokens - left.total_tokens;
  }
  if (left.turn_count !== right.turn_count) {
    return right.turn_count - left.turn_count;
  }
  return left.label.localeCompare(right.label);
}

export function buildUsageRows(params: UsageSourceData & { filters: UsageFilters }): UsageAggregationRow[] {
  const sessionsById = new Map(params.listResolvedSessions().map((session) => [session.id, session]));
  const baseRows = extractUnfilteredUsageRows(params, params.filters);
  return filterUsageRows(baseRows, params.filters, sessionsById);
}

export function extractUnfilteredUsageRows(
  params: UsageSourceData,
  timeOptions: Pick<UsageFilters, "timezone" | "week_mode" | "week_start_day" | "week_reset_hour" | "now_ms" | "pricing"> = {},
): UsageAggregationRow[] {
  const { listResolvedTurns, listResolvedSessions, listSources, listProjects } = params;
  const timeZone = resolveUsageTimezone(timeOptions.timezone ?? timeOptions.pricing?.timezone);
  const weekMode = timeOptions.week_mode ?? timeOptions.pricing?.quota?.week_mode ?? "rolling_7d";
  const weekStartDay = timeOptions.week_start_day ?? timeOptions.pricing?.quota?.week_start_day;
  const weekResetHour = timeOptions.week_reset_hour ?? timeOptions.pricing?.quota?.week_reset_hour;
  const nowMs = timeOptions.now_ms ?? Date.now();

  const turns = listResolvedTurns();
  const sessionsById = new Map(listResolvedSessions().map((session) => [session.id, session]));
  const sourcesById = new Map(listSources().map((source) => [source.id, source]));
  const projectsById = new Map(listProjects().map((project) => [project.project_id, project]));
  const eventsByTurn = new Map<string, SessionUsageEvent[]>();
  for (const session of sessionsById.values()) {
    for (const event of session.usage_events ?? []) {
      if (event.turn_id === null) continue;
      const events = eventsByTurn.get(event.turn_id) ?? [];
      events.push(event);
      eventsByTurn.set(event.turn_id, events);
    }
  }

  const resolveSessionLabel = (session: SessionProjection | undefined, sessionId: string): string => {
    const raw = session?.title?.trim() || session?.canonical_title?.trim() || session?.source_session_id?.trim() || sessionId;
    return raw.replace(/\s+/gu, " ");
  };

  const bucketTime = (isoTimestamp: string) => {
    const parsedMs = Date.parse(isoTimestamp);
    if (!Number.isFinite(parsedMs)) {
      const fallbackDay = isoTimestamp.slice(0, 10) || "1970-01-01";
      const fallbackMonth = isoTimestamp.slice(0, 7) || "1970-01";
      return {
        timestamp_ms: Number.NaN,
        local_hour: 0,
        hour: `${fallbackDay} 00:00`,
        hour_of_day: "00:00",
        day: fallbackDay,
        week: fallbackDay,
        week_label: fallbackDay,
        month: fallbackMonth,
      };
    }
    const local = extractLocalTimeParts(parsedMs, timeZone);
    const week = resolveWeekBucket(parsedMs, { timeZone, weekMode, weekStartDay, weekResetHour, nowMs });
    return {
      timestamp_ms: parsedMs,
      local_hour: local.hour,
      hour: local.hourKey,
      hour_of_day: `${String(local.hour).padStart(2, "0")}:00`,
      day: local.dayKey,
      week: week.key,
      week_label: week.label,
      month: local.monthKey,
    };
  };

  const rows: UsageAggregationRow[] = turns.flatMap((turn): UsageAggregationRow[] => {
    const session = sessionsById.get(turn.session_id);
    const source = sourcesById.get(turn.source_id);
    const project = turn.project_id ? projectsById.get(turn.project_id) : undefined;
    const turnUsage = resolveTurnUsage(turn);
    const hasTokUsage = turnUsage.has_token_usage;
    const zeroTokenReason =
      turn.context_summary.zero_token_reason ??
      (turn.context_summary.assistant_reply_count === 0 && !hasTokUsage ? "no_assistant_reply" : undefined);
    const time = bucketTime(turn.submission_started_at);
    const fallbackSummary: TokenUsageSummary = turn.context_summary.token_usage ?? {
      input_tokens: turnUsage.input_tokens,
      cache_read_input_tokens: turnUsage.cache_read_input_tokens,
      cache_creation_input_tokens: turnUsage.cache_creation_input_tokens,
      cached_input_tokens: turnUsage.cached_input_tokens,
      output_tokens: turnUsage.output_tokens,
      reasoning_output_tokens: turnUsage.reasoning_output_tokens,
      total_tokens: turnUsage.total_tokens,
    };

    const baseRow: UsageAggregationRow = {
      created_at: turn.submission_started_at,
      is_call_event: false,
      turn_id: turn.id,
      session_id: turn.session_id,
      session_label: resolveSessionLabel(session, turn.session_id),
      source_id: turn.source_id,
      source_label: source ? `${source.display_name} (${source.slot_id})` : turn.source_id,
      host_id: session?.host_id ?? source?.host_id ?? "unknown",
      project_id: turn.project_id,
      project_label: project?.display_name ?? "Unassigned",
      model: turn.context_summary.primary_model ?? session?.model ?? "unknown",
      ...time,
      has_token_usage: hasTokUsage,
      zero_token_reason: zeroTokenReason,
      ...usageAmounts(fallbackSummary),
    };

    const events = eventsByTurn.get(turn.id);
    if (!events?.length) return [baseRow];
    return events.map((event) => ({
      ...baseRow,
      event_id: event.id,
      seq: event.seq,
      created_at: event.created_at,
      subagent_key: event.subagent_key,
      stop_reason: event.stop_reason,
      compaction_before: event.compaction_before,
      preceding_tool_results: event.preceding_tool_results,
      emitted_tool_calls: event.emitted_tool_calls,
      is_call_event: true,
      model: event.model ?? "unknown",
      ...bucketTime(event.created_at),
      ...usageAmounts(event.token_usage, true),
    }));
  });

  for (const session of sessionsById.values()) {
    const source = sourcesById.get(session.source_id);
    const project = session.primary_project_id ? projectsById.get(session.primary_project_id) : undefined;
    for (const event of session.usage_events ?? []) {
      if (event.turn_id !== null) continue;
      const time = bucketTime(event.created_at);
      rows.push({
        event_id: event.id,
        seq: event.seq,
        created_at: event.created_at,
        subagent_key: event.subagent_key,
        stop_reason: event.stop_reason,
        compaction_before: event.compaction_before,
        preceding_tool_results: event.preceding_tool_results,
        emitted_tool_calls: event.emitted_tool_calls,
        is_call_event: true,
        turn_id: null,
        session_id: session.id,
        session_label: resolveSessionLabel(session, session.id),
        source_id: session.source_id,
        source_label: source ? `${source.display_name} (${source.slot_id})` : session.source_id,
        host_id: session.host_id,
        project_id: session.primary_project_id,
        project_label: project?.display_name ?? "Unassigned",
        model: event.model ?? "unknown",
        ...time,
        has_token_usage: true,
        ...usageAmounts(event.token_usage, true),
      });
    }
  }

  return rows;
}

export function filterUsageRows(
  rows: readonly UsageAggregationRow[],
  filters: UsageFilters,
  sessionsById?: ReadonlyMap<string, SessionProjection>,
): UsageAggregationRow[] {
  const projectFilterSet = buildProjectFilterSet(filters);
  const sessionFilterSet = filters.session_ids?.length ? new Set(filters.session_ids) : undefined;
  const modelExactSet = filters.models?.length
    ? new Set(filters.models.map((entry) => entry.trim().toLowerCase()).filter(Boolean))
    : undefined;
  const modelQueries = filters.model_queries?.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const timeKeySet = filters.time_keys?.length ? new Set(filters.time_keys) : undefined;
  const timeDimension = filters.time_dimension ?? "day";

  return rows.filter((row) => {
    if (sessionFilterSet && !sessionFilterSet.has(row.session_id)) return false;
    if (filters.directory_scope && sessionsById && !sessionMatchesDirectoryScope(sessionsById.get(row.session_id), filters.directory_scope)) {
      return false;
    }
    if (projectFilterSet) {
      const rowKey = row.project_id ?? UNASSIGNED_PROJECT_KEY;
      if (!projectFilterSet.has(rowKey) && !(rowKey === UNASSIGNED_PROJECT_KEY && projectFilterSet.has("__unassigned__"))) {
        return false;
      }
    }
    if (filters.source_ids?.length && !filters.source_ids.includes(row.source_id)) return false;
    if (filters.host_ids?.length && !filters.host_ids.includes(row.host_id)) return false;
    if (modelExactSet && modelExactSet.size > 0 && !modelExactSet.has(row.model.toLowerCase())) return false;
    if (modelQueries && modelQueries.length > 0 && !matchesModelQueries(row.model, modelQueries)) return false;
    if (timeKeySet && timeKeySet.size > 0 && !timeKeySet.has(usageDimensionKey(row, timeDimension))) return false;
    if (filters.after_date && row.day < filters.after_date) return false;
    if (filters.before_date && row.day > filters.before_date) return false;
    if (filters.after_ts !== undefined && Number.isFinite(row.timestamp_ms) && row.timestamp_ms < filters.after_ts) return false;
    if (filters.before_ts !== undefined && Number.isFinite(row.timestamp_ms) && row.timestamp_ms > filters.before_ts) return false;
    if (!filters.include_known_zero_token && row.zero_token_reason && !row.has_token_usage) return false;
    return true;
  });
}

function buildProjectFilterSet(filters: UsageFilters): Set<string> | undefined {
  const keys: string[] = [];
  if (filters.project_id) keys.push(filters.project_id);
  if (filters.project_ids?.length) keys.push(...filters.project_ids);
  return keys.length === 0 ? undefined : new Set(keys);
}

function matchesModelQueries(model: string, queries: readonly string[]): boolean {
  const lower = model.toLowerCase();
  return queries.some((query) => {
    if (query.includes("*")) {
      const escaped = query.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*");
      return new RegExp(`^${escaped}$`, "iu").test(lower);
    }
    return lower === query || lower.includes(query);
  });
}

function usageAmounts(usage: TokenUsageSummary, nativeCall = false) {
  const input_tokens = usage.input_tokens ?? 0;
  const cache_creation_input_tokens = usage.cache_creation_input_tokens ?? 0;
  const cache_read_input_tokens =
    usage.cache_read_input_tokens ??
    (usage.cache_creation_input_tokens === undefined
      ? (usage.cached_input_tokens ?? 0)
      : Math.max(0, (usage.cached_input_tokens ?? 0) - cache_creation_input_tokens));
  const cached_input_tokens = usage.cached_input_tokens ?? cache_read_input_tokens + cache_creation_input_tokens;
  const output_tokens = usage.output_tokens ?? 0;
  const reasoning_output_tokens = usage.reasoning_output_tokens ?? 0;
  const total_tokens = resolveStructuredTokenTotal(usage) ?? 0;

  const cacheForSum = Math.max(cached_input_tokens, cache_read_input_tokens + cache_creation_input_tokens);
  const baseSum = input_tokens + cacheForSum + output_tokens;
  const separateReasoning =
    reasoning_output_tokens > 0 && total_tokens > baseSum && total_tokens === baseSum + reasoning_output_tokens;
  const billable_output_tokens = separateReasoning ? output_tokens + reasoning_output_tokens : output_tokens;
  const reasoning_for_billing_tokens = Math.min(billable_output_tokens, reasoning_output_tokens);
  const non_reasoning_output_tokens = Math.max(0, billable_output_tokens - reasoning_for_billing_tokens);

  return {
    context_input_tokens: nativeCall ? input_tokens + cacheForSum : undefined,
    input_tokens,
    cache_read_input_tokens,
    cache_creation_input_tokens,
    cached_input_tokens,
    output_tokens,
    reasoning_output_tokens,
    non_reasoning_output_tokens,
    reasoning_for_billing_tokens,
    billable_output_tokens,
    total_tokens,
  };
}
