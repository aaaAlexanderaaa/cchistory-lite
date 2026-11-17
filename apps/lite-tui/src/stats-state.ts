/**
 * Role: Pure state, actions, cursor/filter reducers, and in-memory multiplier/alias/quota
 * calibration for the Lite TUI's Plan A statistics dashboard (`i` overlay).
 * Excludes ANSI frame rendering (stats-render.ts) and core usage arithmetic (canonical).
 */

import type {
  ModelCostMultipliers,
  UsageBreakdownSnapshot,
  UsageMatrixSort,
  UsageStatsRollupRow,
  UsageTimeBucket,
  UsageTimePreset,
  UsageWeekMode,
} from "@cchistory/domain";
import type { LiteBrowserModel } from "./model.js";
import { resolveStatsViewData, sortStatsRollupRows } from "./stats-query.js";
export { resolveStatsViewData, sortStatsRollupRows };

export type LiteStatsView = "quad" | "matrix" | "multipliers";
export type LiteStatsQuadrant = "source" | "project" | "model" | "day";
export type LiteStatsMultiplierColumn = "model" | "input" | "cache_read" | "cache_write" | "output" | "reasoning";

export const STATS_QUADRANTS: readonly LiteStatsQuadrant[] = ["source", "project", "model", "day"];
export const STATS_MULTIPLIER_COLUMNS: readonly LiteStatsMultiplierColumn[] = [
  "model",
  "input",
  "cache_read",
  "cache_write",
  "output",
  "reasoning",
];
export const STATS_TIME_PRESETS: readonly UsageTimePreset[] = ["all", "today", "24h", "week", "7d", "month", "30d"];
export const STATS_TIME_BUCKETS: readonly UsageTimeBucket[] = ["day", "week", "month"];
export const STATS_WEEK_MODES: readonly UsageWeekMode[] = ["rolling_7d", "iso_week", "custom_reset"];
export const STATS_SORT_OPTIONS: readonly UsageMatrixSort[] = [
  "adjusted_cost",
  "list_cost",
  "tokens",
  "turns",
  "label",
];

export interface LiteStatsFilters {
  projectIds: string[];
  models: string[];
  sourceIds: string[];
  timeKeys: string[];
}

export interface LiteStatsCursors {
  source: number;
  project: number;
  model: number;
  day: number;
  matrix: number;
  multipliers: number;
}

export interface LiteStatsTextEdit {
  target: "alias" | "quota" | "multiplier";
  rawModel?: string;
  col?: LiteStatsMultiplierColumn;
  value: string;
  placeholder?: string;
}

export interface LiteStatsState {
  view: LiteStatsView;
  activeQuadrant: LiteStatsQuadrant;
  timePreset: UsageTimePreset;
  timeBucket: UsageTimeBucket;
  weekMode: UsageWeekMode;
  sortBy: UsageMatrixSort;
  filters: LiteStatsFilters;
  cursors: LiteStatsCursors;
  multiplierColIndex: number;
  customAliases: Record<string, string>;
  multiplierOverrides: Record<string, ModelCostMultipliers>;
  quotaUsdOverride?: number;
  editing?: LiteStatsTextEdit;
}

export type LiteStatsAction =
  | { type: "stats-cycle-quadrant"; reverse?: boolean }
  | { type: "stats-focus-quadrant"; quadrant: LiteStatsQuadrant }
  | { type: "stats-set-view"; view: LiteStatsView }
  | { type: "stats-toggle-view"; view: Exclude<LiteStatsView, "quad"> }
  | { type: "stats-move"; delta: number }
  | { type: "stats-jump"; edge: "first" | "last" }
  | { type: "stats-toggle-selection" }
  | { type: "stats-clear-filters" }
  | { type: "stats-cycle-time-preset" }
  | { type: "stats-cycle-time-bucket" }
  | { type: "stats-cycle-week-mode" }
  | { type: "stats-cycle-sort" }
  | { type: "stats-multiplier-col"; delta: number }
  | { type: "stats-multiplier-step"; delta: number }
  | { type: "stats-multiplier-set"; value: number }
  | { type: "stats-multiplier-toggle-zero" }
  | { type: "stats-start-edit"; target: LiteStatsTextEdit["target"] }
  | { type: "stats-edit-char"; char: string }
  | { type: "stats-edit-backspace" }
  | { type: "stats-edit-commit" }
  | { type: "stats-edit-cancel" }
  | { type: "stats-reset-overrides" };

export interface LiteStatsResolvedViewData {
  breakdown: UsageBreakdownSnapshot;
  quadrantRows: Record<LiteStatsQuadrant, UsageStatsRollupRow[]>;
  matrixRows: NonNullable<UsageBreakdownSnapshot["matrix"]>["rows"];
  modelResolutions: UsageBreakdownSnapshot["model_resolutions"];
}

export function createLiteStatsState(model?: LiteBrowserModel): LiteStatsState {
  return {
    view: "quad",
    activeQuadrant: "source",
    timePreset: "all",
    timeBucket: "day",
    weekMode: model?.pricingConfig?.quota?.week_mode ?? "rolling_7d",
    sortBy: "adjusted_cost",
    filters: { projectIds: [], models: [], sourceIds: [], timeKeys: [] },
    cursors: { source: 0, project: 0, model: 0, day: 0, matrix: 0, multipliers: 0 },
    multiplierColIndex: 0,
    customAliases: {},
    multiplierOverrides: {},
    quotaUsdOverride: undefined,
    editing: undefined,
  };
}

export function activeFilterSelection(stats: LiteStatsState, quadrant: LiteStatsQuadrant): readonly string[] {
  switch (quadrant) {
    case "project":
      return stats.filters.projectIds;
    case "model":
      return stats.filters.models;
    case "source":
      return stats.filters.sourceIds;
    case "day":
      return stats.filters.timeKeys;
  }
}

export function hasActiveStatsFilters(stats: LiteStatsState): boolean {
  return (
    stats.filters.projectIds.length > 0 ||
    stats.filters.models.length > 0 ||
    stats.filters.sourceIds.length > 0 ||
    stats.filters.timeKeys.length > 0 ||
    stats.timePreset !== "all"
  );
}

function toggleKey(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter((item) => item !== key) : [...list, key];
}

function activeListLength(data: LiteStatsResolvedViewData, stats: LiteStatsState): number {
  if (stats.view === "matrix") return data.matrixRows.length;
  if (stats.view === "multipliers") return data.modelResolutions.length;
  return data.quadrantRows[stats.activeQuadrant].length;
}

function activeCursorKey(stats: LiteStatsState): keyof LiteStatsCursors {
  if (stats.view === "matrix") return "matrix";
  if (stats.view === "multipliers") return "multipliers";
  return stats.activeQuadrant;
}

function clampStatsCursors(stats: LiteStatsState, data: LiteStatsResolvedViewData): LiteStatsState {
  const clamp = (value: number, len: number) => (len <= 0 ? 0 : Math.min(Math.max(0, value), len - 1));
  return {
    ...stats,
    cursors: {
      source: clamp(stats.cursors.source, data.quadrantRows.source.length),
      project: clamp(stats.cursors.project, data.quadrantRows.project.length),
      model: clamp(stats.cursors.model, data.quadrantRows.model.length),
      day: clamp(stats.cursors.day, data.quadrantRows.day.length),
      matrix: clamp(stats.cursors.matrix, data.matrixRows.length),
      multipliers: clamp(stats.cursors.multipliers, data.modelResolutions.length),
    },
  };
}

function roundMult(value: number): number {
  return Math.max(0, Math.round(value * 100) / 100);
}

function getSelectedModelResolution(data: LiteStatsResolvedViewData, stats: LiteStatsState) {
  const idx = Math.min(stats.cursors.multipliers, Math.max(0, data.modelResolutions.length - 1));
  return data.modelResolutions[idx];
}

export function reduceLiteStatsState(
  model: LiteBrowserModel,
  stats: LiteStatsState,
  action: LiteStatsAction,
): LiteStatsState {
  const data = resolveStatsViewData(model, stats);
  const clamped = clampStatsCursors(stats, data);

  switch (action.type) {
    case "stats-cycle-quadrant": {
      const idx = STATS_QUADRANTS.indexOf(clamped.activeQuadrant);
      const nextIdx = (idx + (action.reverse ? -1 : 1) + STATS_QUADRANTS.length) % STATS_QUADRANTS.length;
      return { ...clamped, activeQuadrant: STATS_QUADRANTS[nextIdx] ?? "source" };
    }
    case "stats-focus-quadrant":
      return { ...clamped, view: "quad", activeQuadrant: action.quadrant };
    case "stats-set-view":
      return { ...clamped, view: action.view, editing: undefined };
    case "stats-toggle-view":
      return { ...clamped, view: clamped.view === action.view ? "quad" : action.view, editing: undefined };
    case "stats-move": {
      const key = activeCursorKey(clamped);
      const len = activeListLength(data, clamped);
      if (len === 0) return clamped;
      const next = Math.min(Math.max(0, clamped.cursors[key] + action.delta), len - 1);
      return { ...clamped, cursors: { ...clamped.cursors, [key]: next } };
    }
    case "stats-jump": {
      const key = activeCursorKey(clamped);
      const len = activeListLength(data, clamped);
      const next = action.edge === "first" ? 0 : Math.max(0, len - 1);
      return { ...clamped, cursors: { ...clamped.cursors, [key]: next } };
    }
    case "stats-toggle-selection": {
      if (clamped.view !== "quad") return clamped;
      const rows = data.quadrantRows[clamped.activeQuadrant];
      const row = rows[clamped.cursors[clamped.activeQuadrant]];
      if (!row) return clamped;
      const nextFilters: LiteStatsFilters = { ...clamped.filters };
      if (clamped.activeQuadrant === "project") nextFilters.projectIds = toggleKey(nextFilters.projectIds, row.key);
      else if (clamped.activeQuadrant === "model") nextFilters.models = toggleKey(nextFilters.models, row.key);
      else if (clamped.activeQuadrant === "source") nextFilters.sourceIds = toggleKey(nextFilters.sourceIds, row.key);
      else nextFilters.timeKeys = toggleKey(nextFilters.timeKeys, row.key);
      const updated = { ...clamped, filters: nextFilters };
      return clampStatsCursors(updated, resolveStatsViewData(model, updated));
    }
    case "stats-clear-filters": {
      const updated: LiteStatsState = {
        ...clamped,
        timePreset: "all",
        filters: { projectIds: [], models: [], sourceIds: [], timeKeys: [] },
      };
      return clampStatsCursors(updated, resolveStatsViewData(model, updated));
    }
    case "stats-cycle-time-preset": {
      const idx = STATS_TIME_PRESETS.indexOf(clamped.timePreset);
      const nextPreset = STATS_TIME_PRESETS[(idx + 1) % STATS_TIME_PRESETS.length] ?? "all";
      const updated = { ...clamped, timePreset: nextPreset };
      return clampStatsCursors(updated, resolveStatsViewData(model, updated));
    }
    case "stats-cycle-time-bucket": {
      const idx = STATS_TIME_BUCKETS.indexOf(clamped.timeBucket);
      const nextBucket = STATS_TIME_BUCKETS[(idx + 1) % STATS_TIME_BUCKETS.length] ?? "day";
      const updated = {
        ...clamped,
        timeBucket: nextBucket,
        filters: { ...clamped.filters, timeKeys: [] },
      };
      return clampStatsCursors(updated, resolveStatsViewData(model, updated));
    }
    case "stats-cycle-week-mode": {
      const idx = STATS_WEEK_MODES.indexOf(clamped.weekMode);
      const nextMode = STATS_WEEK_MODES[(idx + 1) % STATS_WEEK_MODES.length] ?? "rolling_7d";
      const updated = { ...clamped, weekMode: nextMode };
      return clampStatsCursors(updated, resolveStatsViewData(model, updated));
    }
    case "stats-cycle-sort": {
      const idx = STATS_SORT_OPTIONS.indexOf(clamped.sortBy);
      const nextSort = STATS_SORT_OPTIONS[(idx + 1) % STATS_SORT_OPTIONS.length] ?? "adjusted_cost";
      return { ...clamped, sortBy: nextSort };
    }
    case "stats-multiplier-col": {
      const nextCol = (clamped.multiplierColIndex + action.delta + STATS_MULTIPLIER_COLUMNS.length) % STATS_MULTIPLIER_COLUMNS.length;
      return { ...clamped, multiplierColIndex: nextCol };
    }
    case "stats-multiplier-step": {
      const targetModel = getSelectedModelResolution(data, clamped);
      if (!targetModel) return clamped;
      const col = STATS_MULTIPLIER_COLUMNS[clamped.multiplierColIndex] ?? "model";
      const currentVal = targetModel.multipliers[col];
      const step = currentVal >= 2 && action.delta > 0 ? 0.25 : action.delta;
      const nextVal = roundMult(currentVal + step);
      const rawKey = targetModel.raw_model;
      return {
        ...clamped,
        multiplierOverrides: {
          ...clamped.multiplierOverrides,
          [rawKey]: { ...(clamped.multiplierOverrides[rawKey] ?? {}), [col]: nextVal },
        },
      };
    }
    case "stats-multiplier-set": {
      const targetModel = getSelectedModelResolution(data, clamped);
      if (!targetModel) return clamped;
      const col = STATS_MULTIPLIER_COLUMNS[clamped.multiplierColIndex] ?? "model";
      const rawKey = targetModel.raw_model;
      return {
        ...clamped,
        multiplierOverrides: {
          ...clamped.multiplierOverrides,
          [rawKey]: { ...(clamped.multiplierOverrides[rawKey] ?? {}), [col]: roundMult(action.value) },
        },
      };
    }
    case "stats-multiplier-toggle-zero": {
      const targetModel = getSelectedModelResolution(data, clamped);
      if (!targetModel) return clamped;
      const col = STATS_MULTIPLIER_COLUMNS[clamped.multiplierColIndex] ?? "model";
      const currentVal = targetModel.multipliers[col];
      const nextVal = currentVal === 0 ? 1 : 0;
      const rawKey = targetModel.raw_model;
      return {
        ...clamped,
        multiplierOverrides: {
          ...clamped.multiplierOverrides,
          [rawKey]: { ...(clamped.multiplierOverrides[rawKey] ?? {}), [col]: nextVal },
        },
      };
    }
    case "stats-start-edit": {
      if (action.target === "quota") {
        const currentQuota = data.breakdown.quota_limit_usd;
        return {
          ...clamped,
          editing: {
            target: "quota",
            value: "",
            placeholder: currentQuota !== undefined ? String(currentQuota) : undefined,
          },
        };
      }
      const targetModel = getSelectedModelResolution(data, clamped);
      if (!targetModel) return clamped;
      if (action.target === "alias") {
        return {
          ...clamped,
          editing: {
            target: "alias",
            rawModel: targetModel.raw_model,
            value: "",
            placeholder: targetModel.resolved_model,
          },
        };
      }
      const col = STATS_MULTIPLIER_COLUMNS[clamped.multiplierColIndex] ?? "model";
      return {
        ...clamped,
        editing: {
          target: "multiplier",
          rawModel: targetModel.raw_model,
          col,
          value: "",
          placeholder: String(targetModel.multipliers[col]),
        },
      };
    }
    case "stats-edit-char":
      return clamped.editing
        ? { ...clamped, editing: { ...clamped.editing, value: `${clamped.editing.value}${action.char}` } }
        : clamped;
    case "stats-edit-backspace":
      return clamped.editing
        ? { ...clamped, editing: { ...clamped.editing, value: clamped.editing.value.slice(0, Math.max(0, clamped.editing.value.length - 1)) } }
        : clamped;
    case "stats-edit-cancel":
      return { ...clamped, editing: undefined };
    case "stats-edit-commit": {
      const edit = clamped.editing;
      if (!edit) return clamped;
      const trimmed = edit.value.trim();
      if (!trimmed) {
        return { ...clamped, editing: undefined };
      }
      if (edit.target === "quota") {
        if (trimmed === "0" || trimmed.toLowerCase() === "clear" || trimmed.toLowerCase() === "none") {
          return { ...clamped, quotaUsdOverride: undefined, editing: undefined };
        }
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed) || parsed <= 0) return { ...clamped, editing: undefined };
        return { ...clamped, quotaUsdOverride: parsed, editing: undefined };
      }
      if (edit.target === "alias" && edit.rawModel) {
        const nextAliases = { ...clamped.customAliases };
        if (trimmed.toLowerCase() === "clear" || trimmed.toLowerCase() === "none") {
          delete nextAliases[edit.rawModel];
        } else {
          nextAliases[edit.rawModel] = trimmed;
        }
        return { ...clamped, customAliases: nextAliases, editing: undefined };
      }
      if (edit.target === "multiplier" && edit.rawModel && edit.col) {
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed) || parsed < 0) return { ...clamped, editing: undefined };
        return {
          ...clamped,
          multiplierOverrides: {
            ...clamped.multiplierOverrides,
            [edit.rawModel]: { ...(clamped.multiplierOverrides[edit.rawModel] ?? {}), [edit.col]: roundMult(parsed) },
          },
          editing: undefined,
        };
      }
      return { ...clamped, editing: undefined };
    }
    case "stats-reset-overrides":
      return {
        ...clamped,
        customAliases: {},
        multiplierOverrides: {},
        quotaUsdOverride: undefined,
        editing: undefined,
      };
  }
}
