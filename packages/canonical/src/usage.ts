import type {
  ProjectIdentity,
  SessionProjection,
  SessionUsageEvent,
  SourceStatus,
  TokenUsageSummary,
  UsageStatsDimension,
  UsageStatsOverview,
  UsageStatsRollup,
  UsageStatsRollupRow,
  UserTurnProjection,
} from "@cchistory/domain";
import { nowIso, mergeTokenUsageMetrics } from "@cchistory/domain";
import { sessionMatchesDirectoryScope } from "./directory-scope.js";

export interface UsageFilters {
  project_id?: string;
  project_ids?: string[];
  source_ids?: string[];
  host_ids?: string[];
  after_date?: string; // YYYY-MM-DD — only include turns on or after this date
  include_known_zero_token?: boolean;
  directory_scope?: string;
}

export interface UsageAggregationRow {
  turn_id: string | null;
  session_id: string;
  source_id: string;
  source_label: string;
  host_id: string;
  project_id?: string;
  project_label: string;
  model: string;
  day: string;
  month: string;
  has_token_usage: boolean;
  zero_token_reason?: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

export interface TurnUsageProjection {
  has_token_usage: boolean;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface SessionUsageProjection {
  turns_with_token_usage: number;
  total_tokens?: number;
}

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
    cached_input_tokens: cachedInputTokens,
    output_tokens: usage?.output_tokens,
    reasoning_output_tokens: usage?.reasoning_output_tokens,
    total_tokens: structuredTotal ?? turn.context_summary.total_tokens,
  };
}

export function resolveSessionUsageMetrics(session: SessionProjection | undefined): TokenUsageSummary | undefined {
  return session?.usage_events?.reduce<TokenUsageSummary | undefined>((sum, event) => mergeTokenUsageMetrics(sum, event.token_usage), undefined);
}

export function summarizeSessionUsage(turns: readonly UserTurnProjection[], session?: SessionProjection): SessionUsageProjection {
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
  rows: UsageAggregationRow[],
  key: keyof Pick<
    UsageAggregationRow,
    "input_tokens" | "cached_input_tokens" | "output_tokens" | "reasoning_output_tokens" | "total_tokens"
  >,
): number {
  return rows.reduce((total, row) => total + row[key], 0);
}

export function usageDimensionKey(row: UsageAggregationRow, dimension: UsageStatsDimension): string {
  switch (dimension) {
    case "model":
      return row.model;
    case "project":
      return row.project_id ?? "unassigned";
    case "source":
      return row.source_id;
    case "host":
      return row.host_id;
    case "day":
      return row.day;
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
    case "day":
      return row.day;
    case "month":
      return row.month;
  }
}

export function compareUsageRollupRows(
  dimension: UsageStatsDimension,
  left: UsageStatsRollupRow,
  right: UsageStatsRollupRow,
): number {
  if (dimension === "day" || dimension === "month") {
    return left.key.localeCompare(right.key);
  }
  if (left.total_tokens !== right.total_tokens) {
    return right.total_tokens - left.total_tokens;
  }
  if (left.turn_count !== right.turn_count) {
    return right.turn_count - left.turn_count;
  }
  return left.label.localeCompare(right.label);
}

export function buildUsageRows(params: {
  filters: UsageFilters;
  listResolvedTurns: () => UserTurnProjection[];
  listResolvedSessions: () => SessionProjection[];
  listSources: () => SourceStatus[];
  listProjects: () => ProjectIdentity[];
}): UsageAggregationRow[] {
  const { filters, listResolvedTurns, listResolvedSessions, listSources, listProjects } = params;
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

  const rows: UsageAggregationRow[] = turns
    .filter((turn) =>
      filters.directory_scope
        ? sessionMatchesDirectoryScope(sessionsById.get(turn.session_id), filters.directory_scope)
        : true,
    )
    .filter((turn) => (filters.project_id ? turn.project_id === filters.project_id : true))
    .filter((turn) =>
      filters.project_ids && filters.project_ids.length > 0
        ? turn.project_id
          ? filters.project_ids.includes(turn.project_id)
          : false
        : true,
    )
    .filter((turn) =>
      filters.source_ids && filters.source_ids.length > 0 ? filters.source_ids.includes(turn.source_id) : true,
    )
    .flatMap((turn): UsageAggregationRow[] => {
      const session = sessionsById.get(turn.session_id);
      const source = sourcesById.get(turn.source_id);
      const project = turn.project_id ? projectsById.get(turn.project_id) : undefined;
      const usage = resolveTurnUsage(turn);
      const hasTokUsage = usage.has_token_usage;
      const zeroTokenReason =
        turn.context_summary.zero_token_reason ??
        (turn.context_summary.assistant_reply_count === 0 && !hasTokUsage ? "no_assistant_reply" : undefined);
      const row: UsageAggregationRow = {
        turn_id: turn.id,
        session_id: turn.session_id,
        source_id: turn.source_id,
        source_label: source ? `${source.display_name} (${source.slot_id})` : turn.source_id,
        host_id: session?.host_id ?? source?.host_id ?? "unknown",
        project_id: turn.project_id,
        project_label: project?.display_name ?? "Unassigned",
        model: turn.context_summary.primary_model ?? session?.model ?? "unknown",
        day: turn.submission_started_at.slice(0, 10),
        month: turn.submission_started_at.slice(0, 7),
        has_token_usage: hasTokUsage,
        zero_token_reason: zeroTokenReason,
        input_tokens: usage.input_tokens ?? 0,
        cached_input_tokens: usage.cached_input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        reasoning_output_tokens: usage.reasoning_output_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      };
      const events = eventsByTurn.get(turn.id);
      if (!events?.length) return [row];
      const modelUsage = new Map<string, TokenUsageSummary>();
      for (const event of events) {
        const model = event.model ?? "unknown";
        modelUsage.set(model, mergeTokenUsageMetrics(modelUsage.get(model), event.token_usage)!);
      }
      return [...modelUsage].map(([model, usage]) => ({ ...row, model, ...usageAmounts(usage) }));
    });
  for (const session of sessionsById.values()) {
    if (filters.directory_scope && !sessionMatchesDirectoryScope(session, filters.directory_scope)) continue;
    if (filters.project_id && session.primary_project_id !== filters.project_id) continue;
    if (filters.project_ids?.length && (!session.primary_project_id || !filters.project_ids.includes(session.primary_project_id))) continue;
    if (filters.source_ids?.length && !filters.source_ids.includes(session.source_id)) continue;
    const source = sourcesById.get(session.source_id);
    const project = session.primary_project_id ? projectsById.get(session.primary_project_id) : undefined;
    for (const event of session.usage_events ?? []) {
      if (event.turn_id !== null) continue;
      const usage = event.token_usage;
      rows.push({ turn_id: null, session_id: session.id, source_id: session.source_id,
        source_label: source ? `${source.display_name} (${source.slot_id})` : session.source_id,
        host_id: session.host_id, project_id: session.primary_project_id, project_label: project?.display_name ?? "Unassigned",
        model: event.model ?? "unknown", day: event.created_at.slice(0, 10), month: event.created_at.slice(0, 7),
        has_token_usage: true, ...usageAmounts(usage) });
    }
  }
  return rows.filter((row) => (filters.host_ids && filters.host_ids.length > 0 ? filters.host_ids.includes(row.host_id) : true))
    .filter((row) => (filters.after_date ? row.day >= filters.after_date : true))
    .filter((row) => (filters.include_known_zero_token ? true : !row.zero_token_reason || row.has_token_usage));
}

function usageAmounts(usage: TokenUsageSummary) {
  return { input_tokens: usage.input_tokens ?? 0,
    cached_input_tokens: usage.cached_input_tokens ?? (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    output_tokens: usage.output_tokens ?? 0, reasoning_output_tokens: usage.reasoning_output_tokens ?? 0,
    total_tokens: resolveStructuredTokenTotal(usage) ?? 0 };
}

function countUsageTurns(rows: readonly UsageAggregationRow[], predicate: (row: UsageAggregationRow) => boolean = () => true): number {
  const ids = new Set<string>();
  for (const row of rows) if (row.turn_id !== null && predicate(row)) ids.add(row.turn_id);
  return ids.size;
}

export function countExcludedZeroTokenTurns(params: {
  filters: UsageFilters;
  listResolvedTurns: () => UserTurnProjection[];
  listResolvedSessions: () => SessionProjection[];
  listSources: () => SourceStatus[];
  listProjects: () => ProjectIdentity[];
}): number {
  const allRows = buildUsageRows({ ...params, filters: { ...params.filters, include_known_zero_token: true } });
  return allRows.filter((row) => row.zero_token_reason && !row.has_token_usage).length;
}

export function computeUsageOverview(params: {
  filters: UsageFilters;
  listResolvedTurns: () => UserTurnProjection[];
  listResolvedSessions: () => SessionProjection[];
  listSources: () => SourceStatus[];
  listProjects: () => ProjectIdentity[];
}): UsageStatsOverview {
  const rows = buildUsageRows(params);
  const turnCount = countUsageTurns(rows);
  const turnsWithTokenUsage = countUsageTurns(rows, row => row.has_token_usage);
  const turnsWithPrimaryModel = countUsageTurns(rows, row => row.model !== "unknown");

  const excludedCount = params.filters.include_known_zero_token ? 0 : countExcludedZeroTokenTurns(params);

  return {
    generated_at: nowIso(),
    total_turns: turnCount,
    turns_with_token_usage: turnsWithTokenUsage,
    turn_coverage_ratio: turnCount === 0 ? 0 : turnsWithTokenUsage / turnCount,
    turns_with_primary_model: turnsWithPrimaryModel,
    total_input_tokens: sumUsageRows(rows, "input_tokens"),
    total_cached_input_tokens: sumUsageRows(rows, "cached_input_tokens"),
    total_output_tokens: sumUsageRows(rows, "output_tokens"),
    total_reasoning_output_tokens: sumUsageRows(rows, "reasoning_output_tokens"),
    total_tokens: sumUsageRows(rows, "total_tokens"),
    excluded_zero_token_turns: excludedCount > 0 ? excludedCount : undefined,
  };
}

export function computeUsageRollup(params: {
  dimension: UsageStatsDimension;
  filters: UsageFilters;
  listResolvedTurns: () => UserTurnProjection[];
  listResolvedSessions: () => SessionProjection[];
  listSources: () => SourceStatus[];
  listProjects: () => ProjectIdentity[];
}): UsageStatsRollup {
  const { dimension, filters } = params;
  const rows = buildUsageRows(params);
  const groups = new Map<string, UsageStatsRollupRow>();
  const groupRows = new Map<string, UsageAggregationRow[]>();

  for (const row of rows) {
    const key = usageDimensionKey(row, dimension);
    const label = usageDimensionLabel(row, dimension);
    const current = groups.get(key) ?? {
      key,
      label,
      dimension,
      turn_count: 0,
      turns_with_token_usage: 0,
      turn_coverage_ratio: 0,
      turns_with_primary_model: 0,
      total_input_tokens: 0,
      total_cached_input_tokens: 0,
      total_output_tokens: 0,
      total_reasoning_output_tokens: 0,
      total_tokens: 0,
    };
    const members = groupRows.get(key) ?? [];
    members.push(row);
    groupRows.set(key, members);
    current.total_input_tokens += row.input_tokens;
    current.total_cached_input_tokens += row.cached_input_tokens;
    current.total_output_tokens += row.output_tokens;
    current.total_reasoning_output_tokens += row.reasoning_output_tokens;
    current.total_tokens += row.total_tokens;
    groups.set(key, current);
  }

  const rollupRows = [...groups.values()]
    .map((row) => {
      const members = groupRows.get(row.key)!;
      const turnCount = countUsageTurns(members);
      const withUsage = countUsageTurns(members, member => member.has_token_usage);
      return { ...row, turn_count: turnCount, turns_with_token_usage: withUsage,
        turns_with_primary_model: countUsageTurns(members, member => member.model !== "unknown"),
        turn_coverage_ratio: turnCount === 0 ? 0 : withUsage / turnCount };
    })
    .sort((left, right) => compareUsageRollupRows(dimension, left, right));

  const excludedCount = filters.include_known_zero_token ? 0 : countExcludedZeroTokenTurns(params);

  return {
    generated_at: nowIso(),
    dimension,
    rows: rollupRows,
    excluded_zero_token_turns: excludedCount > 0 ? excludedCount : undefined,
  };
}
