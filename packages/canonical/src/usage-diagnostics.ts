/**
 * Role: Canonical usage efficiency, quota pace projection, hourly activity profile,
 * and session-level rollup enrichment (subagent & tool error attribution).
 * Excludes raw row extraction (usage.ts), pricing lookups (usage-pricing.ts), and rendering.
 */

import type {
  QuotaPaceProjection,
  QuotaPaceStatus,
  UsageCostBreakdown,
  UsageCostShares,
  UsageEfficiencyMetrics,
  UsageHourlyProfileCell,
  UsageSessionRollupMeta,
  UsageStatsRollup,
  UsageStatsRollupRow,
  UsageTimeBucket,
} from "@cchistory/domain";
import type { UsageAggregationRow, UsageFilters, UsageSourceData } from "./usage.js";
import { createEmptyCostBreakdown } from "./usage-pricing.js";
import {
  extractLocalTimeParts,
  localWallTimeToEpochMs,
  resolveQuotaPeriodWindow,
  resolveUsageTimezone,
} from "./usage-time.js";

const MIN_ELAPSED_FOR_PROJECTION_MS = 60_000;

export function computeUsageEfficiency(
  totals: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    reasoning_output_tokens: number;
    billable_output_tokens: number;
  },
  cost: UsageCostBreakdown | undefined,
): UsageEfficiencyMetrics {
  const totalInput =
    totals.input_tokens + totals.cache_read_input_tokens + totals.cache_creation_input_tokens;
  const cacheHitRatio = totalInput > 0 ? totals.cache_read_input_tokens / totalInput : null;

  const reasoningForBilling = Math.min(totals.billable_output_tokens, totals.reasoning_output_tokens);
  const reasoningShareRatio =
    totals.billable_output_tokens > 0 ? reasoningForBilling / totals.billable_output_tokens : null;

  let costShares: UsageCostShares | null = null;
  if (cost && cost.adjusted_cost_usd > 0) {
    const denom = cost.adjusted_cost_usd;
    costShares = {
      input: cost.input_adjusted_cost_usd / denom,
      cache_read: cost.cache_read_adjusted_cost_usd / denom,
      cache_write: cost.cache_write_adjusted_cost_usd / denom,
      output: cost.output_adjusted_cost_usd / denom,
      reasoning: cost.reasoning_adjusted_cost_usd / denom,
    };
  }

  const effectiveMultiplier =
    cost && cost.list_cost_usd > 0 ? cost.adjusted_cost_usd / cost.list_cost_usd : null;

  return {
    cache_hit_ratio: cacheHitRatio,
    cache_list_savings_usd: cost?.cache_list_savings_usd ?? 0,
    cache_adjusted_savings_usd: cost?.cache_adjusted_savings_usd ?? 0,
    reasoning_share_ratio: reasoningShareRatio,
    cost_shares: costShares,
    high_context_call_count: cost?.high_context_call_count ?? 0,
    priced_call_count: cost?.priced_call_count ?? 0,
    high_context_adjusted_cost_usd: cost?.high_context_adjusted_cost_usd ?? 0,
    effective_multiplier: effectiveMultiplier,
  };
}

export function computeQuotaPace(options: {
  spentUsd: number;
  quotaLimitUsd?: number;
  filters: UsageFilters;
}): QuotaPaceProjection | undefined {
  const { spentUsd, quotaLimitUsd, filters } = options;
  if (quotaLimitUsd === undefined || !Number.isFinite(quotaLimitUsd) || quotaLimitUsd <= 0) {
    return undefined;
  }
  const period = resolveQuotaPeriodWindow(filters.time_preset, {
    timezone: filters.timezone ?? filters.pricing?.timezone,
    week_mode: filters.week_mode ?? filters.pricing?.quota?.week_mode,
    week_start_day: filters.week_start_day ?? filters.pricing?.quota?.week_start_day,
    week_reset_hour: filters.week_reset_hour ?? filters.pricing?.quota?.week_reset_hour,
    now_ms: filters.now_ms,
  });
  if (!period) return undefined;

  const totalMs = Math.max(1, period.window_end_ms - period.window_start_ms);
  const elapsedMs = period.rolling
    ? totalMs
    : Math.min(totalMs, Math.max(0, period.now_ms - period.window_start_ms));
  const elapsedRatio = elapsedMs / totalMs;
  const quotaPercent = (spentUsd / quotaLimitUsd) * 100;

  let projectedPeriodCostUsd: number | null = null;
  if (period.rolling) {
    projectedPeriodCostUsd = spentUsd;
  } else if (elapsedMs >= MIN_ELAPSED_FOR_PROJECTION_MS) {
    projectedPeriodCostUsd = spentUsd / elapsedRatio;
  }

  let estimatedDaysToLimit: number | null = null;
  if (spentUsd >= quotaLimitUsd) {
    estimatedDaysToLimit = 0;
  } else if (spentUsd > 0 && elapsedMs >= MIN_ELAPSED_FOR_PROJECTION_MS) {
    const ratePerDay = spentUsd / (elapsedMs / 86_400_000);
    if (ratePerDay > 0) {
      estimatedDaysToLimit = (quotaLimitUsd - spentUsd) / ratePerDay;
    }
  }

  let status: QuotaPaceStatus = "on_track";
  if (quotaPercent >= 100) {
    status = "over_limit";
  } else if (period.rolling) {
    status = quotaPercent >= 85 ? "fast" : quotaPercent <= 50 ? "under_pace" : "on_track";
  } else if (elapsedRatio >= 0.05) {
    const spendFraction = quotaPercent / 100;
    if (spendFraction > elapsedRatio * 1.15) status = "fast";
    else if (spendFraction < elapsedRatio * 0.85) status = "under_pace";
  }

  return {
    period_label: period.period_label,
    window_start_ms: period.window_start_ms,
    window_end_ms: period.window_end_ms,
    elapsed_ms: elapsedMs,
    total_ms: totalMs,
    elapsed_ratio: elapsedRatio,
    spent_usd: spentUsd,
    quota_limit_usd: quotaLimitUsd,
    quota_percent: quotaPercent,
    projected_period_cost_usd: projectedPeriodCostUsd,
    estimated_days_to_limit: estimatedDaysToLimit,
    status,
  };
}

export function computeHourlyProfile(
  rows: readonly UsageAggregationRow[],
  resolveRowCostUsd: (row: UsageAggregationRow) => number,
): UsageHourlyProfileCell[] {
  const cells: UsageHourlyProfileCell[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    total_tokens: 0,
    adjusted_cost_usd: 0,
    call_count: 0,
  }));
  for (const row of rows) {
    if (!Number.isFinite(row.timestamp_ms)) continue;
    const hour = Math.min(23, Math.max(0, Math.floor(row.local_hour)));
    const cell = cells[hour]!;
    cell.total_tokens += row.total_tokens;
    cell.adjusted_cost_usd += resolveRowCostUsd(row);
    cell.call_count += 1;
  }
  return cells;
}

export function enrichSessionRollup(
  rollup: UsageStatsRollup,
  rowsBySession: ReadonlyMap<string, readonly UsageAggregationRow[]>,
  sourceData: UsageSourceData,
): UsageStatsRollup {
  if (rollup.dimension !== "session") return rollup;

  const sessionsById = new Map(sourceData.listResolvedSessions().map((s) => [s.id, s]));
  const contributionsById = new Map(
    (sourceData.listSessionContributions?.() ?? []).map((c) => [c.session_ref, c]),
  );
  const familiesByParentId = new Map(
    (sourceData.listSessionFamilies?.() ?? []).map((f) => [f.parent_session_ref, f]),
  );

  const enrichedRows: UsageStatsRollupRow[] = rollup.rows.map((row) => {
    const members = rowsBySession.get(row.key) ?? [];
    const first = members[0];
    const session = sessionsById.get(row.key);
    const contribution = contributionsById.get(row.key);
    const family = familiesByParentId.get(row.key);

    // Pick the model with the highest token total inside this session window.
    const tokensByModel = new Map<string, number>();
    let latestTs = Number.NEGATIVE_INFINITY;
    for (const member of members) {
      if (member.model && member.model !== "unknown") {
        tokensByModel.set(member.model, (tokensByModel.get(member.model) ?? 0) + member.total_tokens);
      }
      if (Number.isFinite(member.timestamp_ms) && member.timestamp_ms > latestTs) {
        latestTs = member.timestamp_ms;
      }
    }
    let primaryModel = session?.model;
    let maxModelTokens = -1;
    for (const [model, tok] of tokensByModel.entries()) {
      if (tok > maxModelTokens) {
        maxModelTokens = tok;
        primaryModel = model;
      }
    }

    const stats = contribution?.stats;
    const meta: UsageSessionRollupMeta = {
      session_id: row.key,
      title: row.label,
      project_label: first?.project_label ?? "Unassigned",
      source_label: first?.source_label ?? session?.source_platform ?? "unknown",
      primary_model: primaryModel,
      delegated_child_count: family?.child_count ?? 0,
      tool_call_count: stats?.tool_call_count ?? 0,
      tool_error_count: stats?.tool_error_count ?? 0,
      last_activity_at: Number.isFinite(latestTs) ? new Date(latestTs).toISOString() : session?.updated_at,
    };

    return {
      ...row,
      session_meta: meta,
    };
  });

  return {
    ...rollup,
    rows: enrichedRows,
  };
}

export interface DenseTimePoint {
  key: string;
  label: string;
  adjusted_cost_usd: number;
  total_tokens: number;
  has_data: boolean;
}

const HOUR_KEY_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):00$/u;
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/u;

function parseHourKeyMs(key: string, timeZone: string): number | undefined {
  const match = HOUR_KEY_RE.exec(key);
  if (!match) return undefined;
  return localWallTimeToEpochMs(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    0,
    timeZone,
  );
}

function makeEmptyTimeRollupRow(dimension: "hour" | "hour_of_day", key: string): UsageStatsRollupRow {
  const cost = createEmptyCostBreakdown();
  return {
    key,
    label: key,
    dimension,
    turn_count: 0,
    turns_with_token_usage: 0,
    turn_coverage_ratio: 0,
    turns_with_primary_model: 0,
    total_input_tokens: 0,
    total_cache_read_input_tokens: 0,
    total_cache_creation_input_tokens: 0,
    total_cached_input_tokens: 0,
    total_output_tokens: 0,
    total_reasoning_output_tokens: 0,
    total_billable_output_tokens: 0,
    total_tokens: 0,
    usage_event_count: 0,
    cost,
    efficiency: computeUsageEfficiency(
      {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: 0,
        billable_output_tokens: 0,
      },
      cost,
    ),
  };
}

/**
 * Build a gap-filled chronological (or 24h clock) time series from rollup rows so
 * charts/sparklines preserve real empty hours/days instead of gluing sparse points together.
 */
export function buildDenseTimeSeries(
  rows: readonly UsageStatsRollupRow[],
  bucket: UsageTimeBucket,
  options: { timezone?: string; maxPoints?: number } = {},
): DenseTimePoint[] {
  if (rows.length === 0) return [];
  const maxPoints = Math.max(2, options.maxPoints ?? 48);
  const byKey = new Map(rows.map((row) => [row.key, row]));

  if (bucket === "hour_of_day") {
    return Array.from({ length: 24 }, (_, hour) => {
      const key = `${String(hour).padStart(2, "0")}:00`;
      const row = byKey.get(key);
      return {
        key,
        label: key,
        adjusted_cost_usd: row?.cost?.adjusted_cost_usd ?? 0,
        total_tokens: row?.total_tokens ?? 0,
        has_data: Boolean(row && (row.total_tokens > 0 || (row.cost?.adjusted_cost_usd ?? 0) > 0)),
      };
    });
  }

  if (bucket === "hour") {
    const timeZone = resolveUsageTimezone(options.timezone);
    const parsed = rows
      .map((row) => ({ row, ms: parseHourKeyMs(row.key, timeZone) }))
      .filter((item): item is { row: UsageStatsRollupRow; ms: number } => item.ms !== undefined)
      .sort((a, b) => a.ms - b.ms);
    if (parsed.length === 0) return fallbackPoints(rows, maxPoints);
    const firstMs = parsed[0]!.ms;
    const lastMs = parsed[parsed.length - 1]!.ms;
    const startMs = Math.max(firstMs, lastMs - (maxPoints - 1) * 3_600_000);
    const points: DenseTimePoint[] = [];
    const seenKeys = new Set<string>();
    for (let ts = startMs; ts <= lastMs; ts += 3_600_000) {
      const key = extractLocalTimeParts(ts, timeZone).hourKey;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const row = byKey.get(key);
      points.push({
        key,
        label: row?.label ?? key,
        adjusted_cost_usd: row?.cost?.adjusted_cost_usd ?? 0,
        total_tokens: row?.total_tokens ?? 0,
        has_data: Boolean(row && (row.total_tokens > 0 || (row.cost?.adjusted_cost_usd ?? 0) > 0)),
      });
    }
    return points;
  }

  if (bucket === "day") {
    const parsed = rows
      .map((row) => {
        const match = DAY_KEY_RE.exec(row.key);
        if (!match) return undefined;
        return { row, ms: Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) };
      })
      .filter((item): item is { row: UsageStatsRollupRow; ms: number } => item !== undefined)
      .sort((a, b) => a.ms - b.ms);
    if (parsed.length === 0) return fallbackPoints(rows, maxPoints);
    const firstMs = parsed[0]!.ms;
    const lastMs = parsed[parsed.length - 1]!.ms;
    const startMs = Math.max(firstMs, lastMs - (maxPoints - 1) * 86_400_000);
    const points: DenseTimePoint[] = [];
    for (let ts = startMs; ts <= lastMs; ts += 86_400_000) {
      const d = new Date(ts);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      const row = byKey.get(key);
      points.push({
        key,
        label: row?.label ?? key,
        adjusted_cost_usd: row?.cost?.adjusted_cost_usd ?? 0,
        total_tokens: row?.total_tokens ?? 0,
        has_data: Boolean(row && (row.total_tokens > 0 || (row.cost?.adjusted_cost_usd ?? 0) > 0)),
      });
    }
    return points;
  }

  if (bucket === "month") {
    const parsed = rows
      .map((row) => {
        const match = MONTH_KEY_RE.exec(row.key);
        if (!match) return undefined;
        return { row, ym: Number(match[1]) * 12 + (Number(match[2]) - 1) };
      })
      .filter((item): item is { row: UsageStatsRollupRow; ym: number } => item !== undefined)
      .sort((a, b) => a.ym - b.ym);
    if (parsed.length === 0) return fallbackPoints(rows, maxPoints);
    const firstYm = parsed[0]!.ym;
    const lastYm = parsed[parsed.length - 1]!.ym;
    const startYm = Math.max(firstYm, lastYm - (maxPoints - 1));
    const points: DenseTimePoint[] = [];
    for (let ym = startYm; ym <= lastYm; ym += 1) {
      const year = Math.floor(ym / 12);
      const month = (ym % 12) + 1;
      const key = `${year}-${String(month).padStart(2, "0")}`;
      const row = byKey.get(key);
      points.push({
        key,
        label: row?.label ?? key,
        adjusted_cost_usd: row?.cost?.adjusted_cost_usd ?? 0,
        total_tokens: row?.total_tokens ?? 0,
        has_data: Boolean(row && (row.total_tokens > 0 || (row.cost?.adjusted_cost_usd ?? 0) > 0)),
      });
    }
    return points;
  }

  return fallbackPoints(rows, maxPoints);
}

function fallbackPoints(rows: readonly UsageStatsRollupRow[], maxPoints: number): DenseTimePoint[] {
  return [...rows]
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(-maxPoints)
    .map((row) => ({
      key: row.key,
      label: row.label,
      adjusted_cost_usd: row.cost?.adjusted_cost_usd ?? 0,
      total_tokens: row.total_tokens,
      has_data: row.total_tokens > 0 || (row.cost?.adjusted_cost_usd ?? 0) > 0,
    }));
}

/**
 * Fill empty intermediate hours in short (<= maxSpanHours) chronological hourly rollups
 * so tables/quadrants preserve real gaps (e.g. 23:00 and 00:00 between 22:00 and 01:00).
 */
export function densifyShortHourlyRollupRows(
  rows: readonly UsageStatsRollupRow[],
  options: { timezone?: string; maxSpanHours?: number } = {},
): UsageStatsRollupRow[] {
  if (rows.length < 2) return [...rows];
  const timeZone = resolveUsageTimezone(options.timezone);
  const maxSpanHours = options.maxSpanHours ?? 48;
  const parsed = rows
    .map((row) => ({ row, ms: parseHourKeyMs(row.key, timeZone) }))
    .filter((item): item is { row: UsageStatsRollupRow; ms: number } => item.ms !== undefined)
    .sort((a, b) => a.ms - b.ms);
  if (parsed.length < 2) return [...rows];

  const firstMs = parsed[0]!.ms;
  const lastMs = parsed[parsed.length - 1]!.ms;
  if (lastMs - firstMs > maxSpanHours * 3_600_000) return [...rows];

  const byKey = new Map(rows.map((row) => [row.key, row]));
  const result: UsageStatsRollupRow[] = [];
  const seen = new Set<string>();
  for (let ts = firstMs; ts <= lastMs; ts += 3_600_000) {
    const key = extractLocalTimeParts(ts, timeZone).hourKey;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(byKey.get(key) ?? makeEmptyTimeRollupRow("hour", key));
  }
  return result;
}

/** Pad missing 00:00..23:00 clock slots for non-empty hour_of_day rollups. */
export function densifyHourOfDayRollupRows(rows: readonly UsageStatsRollupRow[]): UsageStatsRollupRow[] {
  if (rows.length === 0) return [];
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return Array.from({ length: 24 }, (_, hour) => {
    const key = `${String(hour).padStart(2, "0")}:00`;
    return byKey.get(key) ?? makeEmptyTimeRollupRow("hour_of_day", key);
  });
}
