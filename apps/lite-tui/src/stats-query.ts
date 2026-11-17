/**
 * Role: Query/cross-filter resolution and sorting helpers for the Lite TUI statistics
 * dashboard (Project × Model × Source × Time).
 * Excludes state reducers (stats-state.ts) and ANSI rendering (stats-render.ts).
 */

import type { UsageMatrixSort, UsageStatsDimension, UsageStatsRollupRow } from "@cchistory/domain";
import type { LiteBrowserModel } from "./model.js";
import type { LiteStatsResolvedViewData, LiteStatsState } from "./stats-state.js";

export function sortStatsRollupRows(
  rows: readonly UsageStatsRollupRow[],
  sortBy: UsageMatrixSort,
  isTime: boolean,
): UsageStatsRollupRow[] {
  const copy = [...rows];
  if (isTime && (sortBy === "adjusted_cost" || sortBy === "label")) {
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
  const matrixDimensions: UsageStatsDimension[] = ["project", "model", "source", stats.timeBucket];
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

  return {
    breakdown,
    quadrantRows: {
      project: sortStatsRollupRows(projectRows, stats.sortBy, false),
      model: sortStatsRollupRows(modelRows, stats.sortBy, false),
      source: sortStatsRollupRows(sourceRows, stats.sortBy, false),
      day: sortStatsRollupRows(timeRows, stats.sortBy, true),
    },
    matrixRows: breakdown.matrix?.rows ?? [],
    modelResolutions: breakdown.model_resolutions,
  };
}
