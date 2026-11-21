/**
 * Role: Query/cross-filter resolution and sorting helpers for the Lite TUI statistics
 * dashboard (Project × Model × Source × Time).
 * Excludes state reducers (stats-state.ts) and ANSI rendering (stats-render.ts).
 */

import type {
  UsageMatrixSort,
  UsageStatsDimension,
  UsageStatsRollupRow,
  UsageTimeBucket,
} from "@cchistory/domain";
import { densifyShortHourlyRollupRows } from "@cchistory/live-runtime";
import type { LiteBrowserModel } from "./model.js";
import type { LiteStatsMatrixGroup, LiteStatsResolvedViewData, LiteStatsState } from "./stats-state.js";

export function resolveMatrixDimensions(
  group: LiteStatsMatrixGroup,
  timeBucket: UsageTimeBucket,
): UsageStatsDimension[] {
  switch (group) {
    case "project_model":
      return ["project", "model"];
    case "model_time":
      return ["model", timeBucket];
    case "project_time":
      return ["project", timeBucket];
    case "all_4":
      return ["project", "model", "source", timeBucket];
  }
}

export function sortStatsRollupRows(
  rows: readonly UsageStatsRollupRow[],
  sortBy: UsageMatrixSort,
  isTime: boolean,
  timeBucket?: UsageTimeBucket,
): UsageStatsRollupRow[] {
  const copy = [...rows];
  if (isTime && (sortBy === "adjusted_cost" || sortBy === "label")) {
    // 00:00..23:00 hour-of-day reads top-to-bottom in clock order; calendar buckets read newest-first.
    if (timeBucket === "hour_of_day") {
      return copy.sort((a, b) => a.key.localeCompare(b.key));
    }
    return copy.sort((a, b) => b.key.localeCompare(a.key));
  }
  return copy.sort((a, b) => {
    switch (sortBy) {
      case "adjusted_cost": {
        const diff = (b.cost?.adjusted_cost_usd ?? 0) - (a.cost?.adjusted_cost_usd ?? 0);
        if (Math.abs(diff) > 1e-9) return diff;
        return b.total_tokens - a.total_tokens || a.label.localeCompare(b.label);
      }
      case "list_cost": {
        const diff = (b.cost?.list_cost_usd ?? 0) - (a.cost?.list_cost_usd ?? 0);
        if (Math.abs(diff) > 1e-9) return diff;
        return b.total_tokens - a.total_tokens || a.label.localeCompare(b.label);
      }
      case "tokens":
        return b.total_tokens - a.total_tokens || b.turn_count - a.turn_count || a.label.localeCompare(b.label);
      case "turns":
        return b.turn_count - a.turn_count || b.total_tokens - a.total_tokens || a.label.localeCompare(b.label);
      case "label":
        return isTime ? b.key.localeCompare(a.key) : a.label.localeCompare(b.label);
    }
  });
}

export function resolveStatsViewData(
  model: LiteBrowserModel,
  stats: LiteStatsState,
  nowMs?: number,
): LiteStatsResolvedViewData {
  const baseParams = {
    timePreset: stats.timePreset,
    timeBucket: stats.timeBucket,
    weekMode: stats.weekMode,
    nowMs,
    sortBy: stats.sortBy,
    customAliases: stats.customAliases,
    multiplierOverrides: stats.multiplierOverrides,
    quotaUsdOverride: stats.quotaUsdOverride,
  };
  const matrixDimensions: UsageStatsDimension[] = resolveMatrixDimensions(stats.matrixGroup, stats.timeBucket);
  const breakdown = model.getUsageBreakdown({
    ...baseParams,
    projectIds: stats.filters.projectIds,
    models: stats.filters.models,
    sourceIds: stats.filters.sourceIds,
    timeKeys: stats.filters.timeKeys,
    matrixDimensions,
  });

  // For quadrants that already have checked items, compute peer choices filtered
  // only by the other three axes so multi-select remains reachable.
  const projectRows =
    stats.filters.projectIds.length > 0
      ? model.getUsageBreakdown({
          ...baseParams,
          models: stats.filters.models,
          sourceIds: stats.filters.sourceIds,
          timeKeys: stats.filters.timeKeys,
          matrixDimensions: [],
        }).by_project.rows
      : breakdown.by_project.rows;

  const modelRows =
    stats.filters.models.length > 0
      ? model.getUsageBreakdown({
          ...baseParams,
          projectIds: stats.filters.projectIds,
          sourceIds: stats.filters.sourceIds,
          timeKeys: stats.filters.timeKeys,
          matrixDimensions: [],
        }).by_model.rows
      : breakdown.by_model.rows;

  const sourceRows =
    stats.filters.sourceIds.length > 0
      ? model.getUsageBreakdown({
          ...baseParams,
          projectIds: stats.filters.projectIds,
          models: stats.filters.models,
          timeKeys: stats.filters.timeKeys,
          matrixDimensions: [],
        }).by_source.rows
      : breakdown.by_source.rows;

  const timeRows =
    stats.filters.timeKeys.length > 0
      ? model.getUsageBreakdown({
          ...baseParams,
          projectIds: stats.filters.projectIds,
          models: stats.filters.models,
          sourceIds: stats.filters.sourceIds,
          matrixDimensions: [],
        }).by_time.rows
      : breakdown.by_time.rows;

  const displayTimeRows =
    stats.timeBucket === "hour"
      ? densifyShortHourlyRollupRows(timeRows, { timezone: breakdown.timezone, maxSpanHours: 48 })
      : timeRows;

  const diagnostics = breakdown.diagnostics;
  const traceReport =
    stats.view === "trace" && stats.traceSessionId
      ? model.getSessionTrace({
          sessionId: stats.traceSessionId,
          includeSubagents: stats.traceIncludeSubagents,
          onlyAnomalies: stats.traceOnlyAnomalies,
          weekMode: stats.weekMode,
          customAliases: stats.customAliases,
          multiplierOverrides: stats.multiplierOverrides,
          quotaUsdOverride: stats.quotaUsdOverride,
        })
      : undefined;

  return {
    breakdown,
    quadrantRows: {
      project: sortStatsRollupRows(projectRows, stats.sortBy, false),
      model: sortStatsRollupRows(modelRows, stats.sortBy, false),
      source: sortStatsRollupRows(sourceRows, stats.sortBy, false),
      day: sortStatsRollupRows(displayTimeRows, stats.sortBy, true, stats.timeBucket),
    },
    matrixRows: breakdown.matrix?.rows ?? [],
    sessionRows: sortStatsRollupRows(breakdown.by_session?.rows ?? [], stats.sortBy, false),
    anomalies: diagnostics?.anomalies ?? [],
    families: diagnostics?.families ?? [],
    toolPatterns: diagnostics?.tool_patterns ?? [],
    traceReport,
    modelResolutions: breakdown.model_resolutions,
  };
}
