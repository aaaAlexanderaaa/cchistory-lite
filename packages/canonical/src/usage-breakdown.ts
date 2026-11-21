/**
 * Role: Usage overview, single-dimension rollup, multi-dimension matrix, and full
 * four-axis breakdown builders with dual-layer cost calculation.
 * Excludes raw row extraction/filtering (owned by usage.ts) and pricing lookup (usage-pricing.ts).
 */

import type {
  ModelPricingResolution,
  UsageBreakdownSnapshot,
  UsageCostBreakdown,
  UsageMatrixResult,
  UsageMatrixRow,
  UsageMatrixSort,
  UsageStatsDimension,
  UsageStatsOverview,
  UsageStatsRollup,
  UsageStatsRollupRow,
  UsageTimeBucket,
} from "@cchistory/domain";
import { nowIso } from "@cchistory/domain";
import {
  compareUsageRollupRows,
  extractUnfilteredUsageRows,
  filterUsageRows,
  sumUsageRows,
  usageDimensionKey,
  usageDimensionLabel,
  type UsageAggregationRow,
  type UsageFilters,
  type UsageSourceData,
} from "./usage.js";
import {
  addResolvedModelUsageToCostBreakdown,
  buildModelPricingResolutions,
  createEmptyCostBreakdown,
  resolveModelPricing,
  type ResolvedModelPricing,
  type UsageTokenQuantities,
} from "./usage-pricing.js";
import { resolveEffectiveQuotaLimitUsd } from "./usage-pricing-config.js";
import { resolveDefaultTimeBucket, resolveUsageTimezone } from "./usage-time.js";
import {
  computeHourlyProfile,
  computeQuotaPace,
  computeUsageEfficiency,
  densifyHourOfDayRollupRows,
  enrichSessionRollup,
} from "./usage-diagnostics.js";
import { computeUsageDiagnosticsReport } from "./usage-anomalies.js";

export function countUsageTurns(
  rows: readonly UsageAggregationRow[],
  predicate: (row: UsageAggregationRow) => boolean = () => true,
): number {
  const ids = new Set<string>();
  for (const row of rows) if (row.turn_id !== null && predicate(row)) ids.add(row.turn_id);
  return ids.size;
}

export function countExcludedZeroTokenTurns(params: UsageSourceData & { filters: UsageFilters }): number {
  const sessionsById = new Map(params.listResolvedSessions().map((session) => [session.id, session]));
  const baseRows = extractUnfilteredUsageRows(params, params.filters);
  return filterUsageRows(baseRows, { ...params.filters, include_known_zero_token: true }, sessionsById)
    .filter((row) => row.zero_token_reason && !row.has_token_usage).length;
}

export function computeUsageOverview(params: UsageSourceData & { filters: UsageFilters }): UsageStatsOverview {
  const sessionsById = new Map(params.listResolvedSessions().map((session) => [session.id, session]));
  const baseRows = extractUnfilteredUsageRows(params, params.filters);
  const rows = filterUsageRows(baseRows, params.filters, sessionsById);
  const excludedCount = params.filters.include_known_zero_token
    ? 0
    : filterUsageRows(baseRows, { ...params.filters, include_known_zero_token: true }, sessionsById)
        .filter((row) => row.zero_token_reason && !row.has_token_usage).length;
  return buildOverviewFromRows(rows, excludedCount, params.filters);
}

export function computeUsageRollup(
  params: UsageSourceData & { dimension: UsageStatsDimension; filters: UsageFilters },
): UsageStatsRollup {
  const sessionsById = new Map(params.listResolvedSessions().map((session) => [session.id, session]));
  const baseRows = extractUnfilteredUsageRows(params, params.filters);
  const rows = filterUsageRows(baseRows, params.filters, sessionsById);
  const excludedCount = params.filters.include_known_zero_token
    ? 0
    : filterUsageRows(baseRows, { ...params.filters, include_known_zero_token: true }, sessionsById)
        .filter((row) => row.zero_token_reason && !row.has_token_usage).length;
  const rollup = buildRollupFromRows(params.dimension, rows, excludedCount, params.filters);
  if (params.dimension === "session") {
    const bySession = groupRowsByKey(rows, "session");
    const { report } = computeUsageDiagnosticsReport({ rows, filters: params.filters, sourceData: params });
    return enrichSessionRollup(rollup, bySession, params, report);
  }
  return rollup;
}

export function buildOverviewFromRows(
  rows: readonly UsageAggregationRow[],
  excludedCount: number,
  filters: UsageFilters,
): UsageStatsOverview {
  const turnCount = countUsageTurns(rows);
  const turnsWithTokenUsage = countUsageTurns(rows, (row) => row.has_token_usage);
  const turnsWithPrimaryModel = countUsageTurns(rows, (row) => row.model !== "unknown");
  const totalInput = sumUsageRows(rows, "input_tokens");
  const totalCacheRead = sumUsageRows(rows, "cache_read_input_tokens");
  const totalCacheWrite = sumUsageRows(rows, "cache_creation_input_tokens");
  const totalCached = sumUsageRows(rows, "cached_input_tokens");
  const totalOutput = sumUsageRows(rows, "output_tokens");
  const totalReasoning = sumUsageRows(rows, "reasoning_output_tokens");
  const totalBillableOutput = sumUsageRows(rows, "billable_output_tokens");
  const cost = computeCostForRows(rows, filters);
  return {
    generated_at: nowIso(),
    total_turns: turnCount,
    turns_with_token_usage: turnsWithTokenUsage,
    turn_coverage_ratio: turnCount === 0 ? 0 : turnsWithTokenUsage / turnCount,
    turns_with_primary_model: turnsWithPrimaryModel,
    total_input_tokens: totalInput,
    total_cache_read_input_tokens: totalCacheRead,
    total_cache_creation_input_tokens: totalCacheWrite,
    total_cached_input_tokens: totalCached,
    total_output_tokens: totalOutput,
    total_reasoning_output_tokens: totalReasoning,
    total_billable_output_tokens: totalBillableOutput,
    total_tokens: sumUsageRows(rows, "total_tokens"),
    usage_event_count: rows.length,
    excluded_zero_token_turns: excludedCount > 0 ? excludedCount : undefined,
    cost,
    efficiency: computeUsageEfficiency(
      {
        input_tokens: totalInput,
        cache_read_input_tokens: totalCacheRead,
        cache_creation_input_tokens: totalCacheWrite,
        reasoning_output_tokens: totalReasoning,
        billable_output_tokens: totalBillableOutput,
      },
      cost,
    ),
  };
}

export function buildRollupFromRows(
  dimension: UsageStatsDimension,
  rows: readonly UsageAggregationRow[],
  excludedCount: number,
  filters: UsageFilters,
): UsageStatsRollup {
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
      total_cache_read_input_tokens: 0,
      total_cache_creation_input_tokens: 0,
      total_cached_input_tokens: 0,
      total_output_tokens: 0,
      total_reasoning_output_tokens: 0,
      total_billable_output_tokens: 0,
      total_tokens: 0,
      usage_event_count: 0,
    };
    const members = groupRows.get(key) ?? [];
    members.push(row);
    groupRows.set(key, members);

    current.total_input_tokens += row.input_tokens;
    current.total_cache_read_input_tokens = (current.total_cache_read_input_tokens ?? 0) + row.cache_read_input_tokens;
    current.total_cache_creation_input_tokens =
      (current.total_cache_creation_input_tokens ?? 0) + row.cache_creation_input_tokens;
    current.total_cached_input_tokens += row.cached_input_tokens;
    current.total_output_tokens += row.output_tokens;
    current.total_reasoning_output_tokens += row.reasoning_output_tokens;
    current.total_billable_output_tokens = (current.total_billable_output_tokens ?? 0) + row.billable_output_tokens;
    current.total_tokens += row.total_tokens;
    current.usage_event_count = (current.usage_event_count ?? 0) + 1;
    groups.set(key, current);
  }

  const rollupRows = [...groups.values()]
    .map((row) => {
      const members = groupRows.get(row.key)!;
      const turnCount = countUsageTurns(members);
      const withUsage = countUsageTurns(members, (member) => member.has_token_usage);
      const cost = computeCostForRows(members, filters);
      return {
        ...row,
        turn_count: turnCount,
        turns_with_token_usage: withUsage,
        turns_with_primary_model: countUsageTurns(members, (member) => member.model !== "unknown"),
        turn_coverage_ratio: turnCount === 0 ? 0 : withUsage / turnCount,
        cost,
        efficiency: computeUsageEfficiency(
          {
            input_tokens: row.total_input_tokens,
            cache_read_input_tokens: row.total_cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: row.total_cache_creation_input_tokens ?? 0,
            reasoning_output_tokens: row.total_reasoning_output_tokens,
            billable_output_tokens: row.total_billable_output_tokens ?? row.total_output_tokens,
          },
          cost,
        ),
      };
    })
    .sort((left, right) => compareUsageRollupRows(dimension, left, right));

  const finalRows = dimension === "hour_of_day" ? densifyHourOfDayRollupRows(rollupRows) : rollupRows;

  return {
    generated_at: nowIso(),
    dimension,
    rows: finalRows,
    excluded_zero_token_turns: excludedCount > 0 ? excludedCount : undefined,
  };
}

export function aggregateTokensByModel(rows: readonly UsageAggregationRow[]): Map<string, UsageTokenQuantities> {
  const byModel = new Map<string, UsageTokenQuantities>();
  for (const row of rows) {
    let bucket = byModel.get(row.model);
    if (!bucket) {
      bucket = {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        non_reasoning_output_tokens: 0,
        reasoning_for_billing_tokens: 0,
        total_tokens: 0,
      };
      byModel.set(row.model, bucket);
    }
    bucket.input_tokens += row.input_tokens;
    bucket.cache_read_input_tokens += row.cache_read_input_tokens;
    bucket.cache_creation_input_tokens += row.cache_creation_input_tokens;
    bucket.non_reasoning_output_tokens += row.non_reasoning_output_tokens;
    bucket.reasoning_for_billing_tokens += row.reasoning_for_billing_tokens;
    bucket.total_tokens += row.total_tokens;
  }
  return byModel;
}

export function computeCostForRows(rows: readonly UsageAggregationRow[], filters: UsageFilters): UsageCostBreakdown {
  const quotaLimitUsd = resolveEffectiveQuotaLimitUsd(
    filters.pricing,
    filters.time_preset ?? "all",
    filters.quota_limit_usd,
  );
  const cost = createEmptyCostBreakdown(quotaLimitUsd);
  const resolutions = new Map<string, ResolvedModelPricing>();
  for (const row of rows) {
    let resolved = resolutions.get(row.model);
    if (!resolved) {
      resolved = resolveModelPricing(row.model, filters.pricing);
      resolutions.set(row.model, resolved);
    }
    addResolvedModelUsageToCostBreakdown(cost, resolved, row, quotaLimitUsd);
  }
  return cost;
}

export function computeUsageMatrix(
  params: UsageSourceData & {
    dimensions: readonly UsageStatsDimension[];
    filters: UsageFilters;
    sortBy?: UsageMatrixSort;
  },
): UsageMatrixResult {
  const sessionsById = new Map(params.listResolvedSessions().map((session) => [session.id, session]));
  const baseRows = extractUnfilteredUsageRows(params, params.filters);
  const rows = filterUsageRows(baseRows, params.filters, sessionsById);
  const excludedCount = params.filters.include_known_zero_token
    ? 0
    : filterUsageRows(baseRows, { ...params.filters, include_known_zero_token: true }, sessionsById)
        .filter((row) => row.zero_token_reason && !row.has_token_usage).length;
  return buildMatrixFromRows(params.dimensions, rows, excludedCount, params.filters, params.sortBy);
}

export function computeUsageBreakdown(
  params: UsageSourceData & {
    filters: UsageFilters;
    time_dimension?: UsageTimeBucket;
    matrix_dimensions?: readonly UsageStatsDimension[];
    sort_by?: UsageMatrixSort;
    cached_base_rows?: readonly UsageAggregationRow[];
  },
): UsageBreakdownSnapshot {
  const sessionsById = new Map(params.listResolvedSessions().map((session) => [session.id, session]));
  const baseRows = params.cached_base_rows ?? extractUnfilteredUsageRows(params, params.filters);
  const rows = filterUsageRows(baseRows, params.filters, sessionsById);
  const excludedCount = params.filters.include_known_zero_token
    ? 0
    : filterUsageRows(baseRows, { ...params.filters, include_known_zero_token: true }, sessionsById)
        .filter((row) => row.zero_token_reason && !row.has_token_usage).length;

  const timeZone = resolveUsageTimezone(params.filters.timezone ?? params.filters.pricing?.timezone);
  const weekMode = params.filters.week_mode ?? params.filters.pricing?.quota?.week_mode ?? "rolling_7d";
  const timeDimension =
    params.time_dimension ??
    params.filters.time_dimension ??
    resolveDefaultTimeBucket({
      preset: params.filters.time_preset,
      after_ts: params.filters.after_ts,
      before_ts: params.filters.before_ts,
      now_ms: params.filters.now_ms,
    });
  const quotaLimitUsd = resolveEffectiveQuotaLimitUsd(
    params.filters.pricing,
    params.filters.time_preset ?? "all",
    params.filters.quota_limit_usd,
  );

  const { report: diagnostics } = computeUsageDiagnosticsReport({
    rows,
    filters: params.filters,
    sourceData: params,
  });

  const overview = buildOverviewFromRows(rows, excludedCount, params.filters);
  const by_project = buildRollupFromRows("project", rows, excludedCount, params.filters);
  const by_model = buildRollupFromRows("model", rows, excludedCount, params.filters);
  const by_source = buildRollupFromRows("source", rows, excludedCount, params.filters);
  const by_time = buildRollupFromRows(timeDimension, rows, excludedCount, params.filters);
  const rawBySession = buildRollupFromRows("session", rows, excludedCount, params.filters);
  const by_session = enrichSessionRollup(rawBySession, groupRowsByKey(rows, "session"), params, diagnostics);
  const matrix = params.matrix_dimensions?.length
    ? buildMatrixFromRows(params.matrix_dimensions, rows, excludedCount, params.filters, params.sort_by)
    : undefined;
  const model_resolutions: ModelPricingResolution[] = buildModelPricingResolutions(
    aggregateTokensByModel(rows),
    params.filters.pricing,
    quotaLimitUsd,
    rows,
  );

  const resolutionsCache = new Map<string, ResolvedModelPricing>();
  const hourly_profile = computeHourlyProfile(rows, (row) => {
    let resolved = resolutionsCache.get(row.model);
    if (!resolved) {
      resolved = resolveModelPricing(row.model, params.filters.pricing);
      resolutionsCache.set(row.model, resolved);
    }
    const single = createEmptyCostBreakdown();
    addResolvedModelUsageToCostBreakdown(single, resolved, row);
    return single.adjusted_cost_usd;
  });
  const quota_pace = computeQuotaPace({
    spentUsd: overview.cost?.adjusted_cost_usd ?? 0,
    quotaLimitUsd,
    filters: params.filters,
  });

  return {
    generated_at: nowIso(),
    timezone: timeZone,
    week_mode: weekMode,
    time_dimension: timeDimension,
    effective_after_date: params.filters.after_date,
    effective_before_date: params.filters.before_date,
    overview,
    by_project,
    by_model,
    by_source,
    by_time,
    by_session,
    matrix,
    model_resolutions,
    quota_limit_usd: quotaLimitUsd,
    quota_percent: overview.cost?.quota_percent,
    efficiency: overview.efficiency,
    quota_pace,
    hourly_profile,
    diagnostics,
  };
}

function groupRowsByKey(
  rows: readonly UsageAggregationRow[],
  dimension: UsageStatsDimension,
): Map<string, UsageAggregationRow[]> {
  const map = new Map<string, UsageAggregationRow[]>();
  for (const row of rows) {
    const key = usageDimensionKey(row, dimension);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

export function buildMatrixFromRows(
  dimensions: readonly UsageStatsDimension[],
  rows: readonly UsageAggregationRow[],
  excludedCount: number,
  filters: UsageFilters,
  sortBy: UsageMatrixSort = "adjusted_cost",
): UsageMatrixResult {
  const dims = dimensions.length > 0 ? [...dimensions] : (["project", "model", "source", "day"] as UsageStatsDimension[]);
  const groups = new Map<string, { keys: string[]; labels: string[]; members: UsageAggregationRow[] }>();

  for (const row of rows) {
    const keys = dims.map((dim) => usageDimensionKey(row, dim));
    const labels = dims.map((dim) => usageDimensionLabel(row, dim));
    const compositeKey = JSON.stringify(keys);
    let bucket = groups.get(compositeKey);
    if (!bucket) {
      bucket = { keys, labels, members: [] };
      groups.set(compositeKey, bucket);
    }
    bucket.members.push(row);
  }

  const matrixRows: UsageMatrixRow[] = [];
  for (const bucket of groups.values()) {
    const members = bucket.members;
    const turnCount = countUsageTurns(members);
    const totalInput = sumUsageRows(members, "input_tokens");
    const totalCacheRead = sumUsageRows(members, "cache_read_input_tokens");
    const totalCacheWrite = sumUsageRows(members, "cache_creation_input_tokens");
    const totalOutput = sumUsageRows(members, "output_tokens");
    const totalReasoning = sumUsageRows(members, "reasoning_output_tokens");
    const totalBillableOutput = sumUsageRows(members, "billable_output_tokens");
    const cost = computeCostForRows(members, filters);
    matrixRows.push({
      keys: bucket.keys,
      labels: bucket.labels,
      dimensions: dims,
      turn_count: turnCount,
      usage_event_count: members.length,
      total_input_tokens: totalInput,
      total_cache_read_input_tokens: totalCacheRead,
      total_cache_creation_input_tokens: totalCacheWrite,
      total_cached_input_tokens: sumUsageRows(members, "cached_input_tokens"),
      total_output_tokens: totalOutput,
      total_reasoning_output_tokens: totalReasoning,
      total_billable_output_tokens: totalBillableOutput,
      total_tokens: sumUsageRows(members, "total_tokens"),
      cost,
      efficiency: computeUsageEfficiency(
        {
          input_tokens: totalInput,
          cache_read_input_tokens: totalCacheRead,
          cache_creation_input_tokens: totalCacheWrite,
          reasoning_output_tokens: totalReasoning,
          billable_output_tokens: totalBillableOutput,
        },
        cost,
      ),
    });
  }

  matrixRows.sort((left, right) => compareMatrixRows(left, right, sortBy));

  return {
    generated_at: nowIso(),
    dimensions: dims,
    rows: matrixRows,
    excluded_zero_token_turns: excludedCount > 0 ? excludedCount : undefined,
  };
}

function compareMatrixRows(left: UsageMatrixRow, right: UsageMatrixRow, sortBy: UsageMatrixSort): number {
  if (sortBy === "adjusted_cost" && left.cost.adjusted_cost_usd !== right.cost.adjusted_cost_usd) {
    return right.cost.adjusted_cost_usd - left.cost.adjusted_cost_usd;
  }
  if (sortBy === "list_cost" && left.cost.list_cost_usd !== right.cost.list_cost_usd) {
    return right.cost.list_cost_usd - left.cost.list_cost_usd;
  }
  if (sortBy === "turns" && left.turn_count !== right.turn_count) {
    return right.turn_count - left.turn_count;
  }
  if (sortBy === "label") {
    return left.labels.join(" | ").localeCompare(right.labels.join(" | "));
  }
  if (left.total_tokens !== right.total_tokens) {
    return right.total_tokens - left.total_tokens;
  }
  if (left.turn_count !== right.turn_count) {
    return right.turn_count - left.turn_count;
  }
  return left.labels.join(" | ").localeCompare(right.labels.join(" | "));
}
