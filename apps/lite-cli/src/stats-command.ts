/**
 * Role: CLI `stats` option parsing, pricing/multiplier config loading, and
 * `--export-pricing` output for CC History Lite.
 * Excludes human table formatting (stats-render.ts) and core usage math (canonical via live-runtime).
 */

import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ProjectIdentity,
  SourceStatus,
  UsageBreakdownSnapshot,
  UsageMatrixResult,
  UsageMatrixSort,
  UsagePricingConfig,
  UsageStatsDimension,
  UsageStatsRollup,
  UsageTimeBucket,
  UsageWeekMode,
} from "@cchistory/domain";
import {
  UNASSIGNED_PROJECT_KEY,
  buildPricingConfigTemplate,
  mergeUsagePricingConfigs,
  parseDateEnd,
  parseDateOrRelativeStart,
  parseUsagePricingInput,
  resolveDefaultTimeBucket,
  resolveEffectiveQuotaLimitUsd,
  resolveUsageTimezone,
  type LiveHistorySnapshot,
  type UsageFilters,
} from "@cchistory/live-runtime";
import type { JsonOutputMode } from "./json-v2.js";
import { renderEnhancedStats } from "./stats-render.js";

export interface StatsCliIo {
  cwd: string;
  homeDir?: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  isTTY: boolean;
  now?: () => number;
  columns?: number;
}

export interface ParsedStatsArgs {
  values: Map<string, string[]>;
  booleans: Set<string>;
}

export interface StatsCommandDeps {
  UsageError: new (message: string, code?: string) => Error;
  requireSource: (snapshot: LiveHistorySnapshot, ref: string) => SourceStatus;
  requireProject: (snapshot: LiveHistorySnapshot, ref: string) => ProjectIdentity;
  assertSafeExportDestination: (outputPath: string, snapshot: LiveHistorySnapshot, homeDir: string | undefined) => Promise<void>;
  renderMeta: (line: string) => string;
  renderDashRow: (line: string) => string;
  emitOutput: (
    io: StatsCliIo,
    jsonMode: JsonOutputMode,
    payload: Record<string, unknown>,
    text: string,
    snapshot: LiveHistorySnapshot,
    directoryScope?: string,
  ) => void;
  jsonSchema: string;
}

const VALID_DIMENSIONS = new Set<UsageStatsDimension>(["source", "project", "model", "session", "hour", "hour_of_day", "day", "week", "month"]);
const VALID_WEEK_MODES = new Set<UsageWeekMode>(["rolling_7d", "iso_week", "custom_reset"]);
const VALID_SORTS = new Set<UsageMatrixSort>(["adjusted_cost", "list_cost", "tokens", "turns", "label"]);

function expandHomePath(raw: string, cwd: string, homeDir?: string): string {
  const home = homeDir ?? os.homedir();
  const expanded = raw === "~" ? home : raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(home, raw.slice(2)) : raw;
  return path.resolve(cwd, expanded);
}

function parseSingleValue(
  parsed: ParsedStatsArgs,
  name: string,
  UsageError: StatsCommandDeps["UsageError"],
): string | undefined {
  const entries = parsed.values.get(name) ?? [];
  if (entries.length > 1) throw new UsageError(`--${name} may only be specified once.`);
  return entries.at(-1);
}

export function parseStatsDimensions(
  rawValues: readonly string[],
  UsageError: StatsCommandDeps["UsageError"],
): UsageStatsDimension[] {
  const result: UsageStatsDimension[] = [];
  const seen = new Set<UsageStatsDimension>();
  for (const raw of rawValues) {
    for (const part of raw.split(",")) {
      const normalized = part.trim().toLowerCase() as UsageStatsDimension;
      if (!normalized) continue;
      if (!VALID_DIMENSIONS.has(normalized)) {
        throw new UsageError(`--by dimensions must be source, project, model, session, hour, hour_of_day, day, week, or month; received ${JSON.stringify(part.trim())}.`);
      }
      if (!seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    }
  }
  if (rawValues.length > 0 && result.length === 0) {
    throw new UsageError("--by requires at least one dimension.");
  }
  return result;
}

function parseModelMultiplierArg(
  raw: string,
  flagName: string,
  UsageError: StatsCommandDeps["UsageError"],
): { model?: string; value: number } {
  const eqIndex = raw.indexOf("=");
  if (eqIndex === -1) {
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new UsageError(`${flagName} expects <number> or <model>=<number> (>= 0); received ${JSON.stringify(raw)}.`);
    }
    return { value: parsed };
  }
  const model = raw.slice(0, eqIndex).trim();
  const num = Number(raw.slice(eqIndex + 1).trim());
  if (!model || !Number.isFinite(num) || num < 0) {
    throw new UsageError(`${flagName} expects <model>=<number> (>= 0); received ${JSON.stringify(raw)}.`);
  }
  return { model: model.toLowerCase() === "default" ? undefined : model, value: num };
}

function parseAliasArg(raw: string, UsageError: StatsCommandDeps["UsageError"]): { rawModel: string; targetModel: string } {
  const eqIndex = raw.indexOf("=");
  const rawModel = eqIndex > 0 ? raw.slice(0, eqIndex).trim() : "";
  const targetModel = eqIndex > 0 ? raw.slice(eqIndex + 1).trim() : "";
  if (!rawModel || !targetModel) {
    throw new UsageError(`--alias must use <raw-model>=<catalog-model>; received ${JSON.stringify(raw)}.`);
  }
  return { rawModel, targetModel };
}

async function readPricingFile(
  filePath: string,
  UsageError: StatsCommandDeps["UsageError"],
): Promise<UsagePricingConfig> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read pricing config file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseUsagePricingInput(JSON.parse(content));
  } catch (error) {
    throw new UsageError(`Invalid pricing config JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadCliPricingConfig(options: {
  parsed: ParsedStatsArgs;
  cwd: string;
  homeDir?: string;
  envPricingPath?: string;
  UsageError: StatsCommandDeps["UsageError"];
}): Promise<{ config: UsagePricingConfig; explicitQuotaUsd?: number; loadedFiles: string[] }> {
  const { parsed, cwd, homeDir, envPricingPath, UsageError } = options;
  const layers: UsagePricingConfig[] = [];
  const loadedFiles: string[] = [];

  if (envPricingPath?.trim()) {
    const resolvedEnvPath = expandHomePath(envPricingPath.trim(), cwd, homeDir);
    layers.push(await readPricingFile(resolvedEnvPath, UsageError));
    loadedFiles.push(resolvedEnvPath);
  }
  for (const fileArg of parsed.values.get("pricing") ?? []) {
    const resolved = expandHomePath(fileArg, cwd, homeDir);
    layers.push(await readPricingFile(resolved, UsageError));
    loadedFiles.push(resolved);
  }

  const inline: UsagePricingConfig = {
    schema: "cchistory-lite-pricing/v1",
    aliases: {},
    multipliers: {},
  };

  const tzFlag = parseSingleValue(parsed, "tz", UsageError);
  if (tzFlag) {
    try {
      inline.timezone = resolveUsageTimezone(tzFlag);
    } catch {
      throw new UsageError(`Invalid timezone for --tz: ${JSON.stringify(tzFlag)}.`);
    }
  }

  const weekModeRaw = parseSingleValue(parsed, "week-mode", UsageError);
  if (weekModeRaw) {
    if (!VALID_WEEK_MODES.has(weekModeRaw as UsageWeekMode)) {
      throw new UsageError(`--week-mode must be rolling_7d, iso_week, or custom_reset; received ${JSON.stringify(weekModeRaw)}.`);
    }
    inline.quota = { ...(inline.quota ?? {}), week_mode: weekModeRaw as UsageWeekMode };
  }

  let explicitQuotaUsd: number | undefined;
  const quotaRaw = parseSingleValue(parsed, "quota", UsageError);
  if (quotaRaw !== undefined) {
    const quotaUsd = Number(quotaRaw);
    if (!Number.isFinite(quotaUsd) || quotaUsd <= 0) {
      throw new UsageError(`--quota must be a positive USD number; received ${JSON.stringify(quotaRaw)}.`);
    }
    explicitQuotaUsd = quotaUsd;
    inline.quota = { ...(inline.quota ?? {}), custom_usd: quotaUsd };
  }

  for (const rawAlias of parsed.values.get("alias") ?? []) {
    const { rawModel, targetModel } = parseAliasArg(rawAlias, UsageError);
    inline.aliases![rawModel] = targetModel;
  }

  const applyMultiplier = (raw: string, flagName: string, field: "model" | "cache_read" | "cache_write") => {
    const { model, value } = parseModelMultiplierArg(raw, flagName, UsageError);
    if (!model) {
      inline.default_multipliers = { ...(inline.default_multipliers ?? {}), [field]: value };
    } else {
      inline.multipliers![model] = { ...(inline.multipliers![model] ?? {}), [field]: value };
    }
  };
  for (const raw of parsed.values.get("multiplier") ?? []) applyMultiplier(raw, "--multiplier", "model");
  for (const raw of parsed.values.get("cache-read-multiplier") ?? []) applyMultiplier(raw, "--cache-read-multiplier", "cache_read");
  for (const raw of parsed.values.get("cache-write-multiplier") ?? []) applyMultiplier(raw, "--cache-write-multiplier", "cache_write");

  layers.push(inline);
  return {
    config: mergeUsagePricingConfigs(...layers),
    explicitQuotaUsd,
    loadedFiles,
  };
}

export async function runStatsCommand(options: {
  parsed: ParsedStatsArgs;
  snapshot: LiveHistorySnapshot;
  io: StatsCliIo;
  jsonMode: JsonOutputMode;
  directoryScope?: string;
  deps: StatsCommandDeps;
}): Promise<void> {
  const { parsed, snapshot, io, jsonMode, directoryScope, deps } = options;
  const { UsageError, requireProject, requireSource, assertSafeExportDestination, emitOutput, jsonSchema } = deps;

  const sortRaw = parseSingleValue(parsed, "sort", UsageError);
  const sortBy: UsageMatrixSort = sortRaw
    ? VALID_SORTS.has(sortRaw as UsageMatrixSort)
      ? (sortRaw as UsageMatrixSort)
      : (() => {
          throw new UsageError(`--sort must be adjusted_cost, list_cost, tokens, turns, or label; received ${JSON.stringify(sortRaw)}.`);
        })()
    : "adjusted_cost";

  const dimensions = parseStatsDimensions(parsed.values.get("by") ?? [], UsageError);
  const projectRefs = parsed.values.get("project") ?? [];
  const projectIds = projectRefs.map((ref) =>
    ref.trim().toLowerCase() === UNASSIGNED_PROJECT_KEY ? UNASSIGNED_PROJECT_KEY : requireProject(snapshot, ref).project_id,
  );
  const sourceIds = (parsed.values.get("source") ?? []).map((ref) => requireSource(snapshot, ref).id);
  const modelQueries = parsed.values.get("model") ?? [];

  const { config: pricingConfig, explicitQuotaUsd } = await loadCliPricingConfig({
    parsed,
    cwd: io.cwd,
    homeDir: io.homeDir,
    envPricingPath: process.env.CCHISTORY_PRICING_CONFIG,
    UsageError,
  });

  const timeZone = resolveUsageTimezone(pricingConfig.timezone);
  const weekMode = pricingConfig.quota?.week_mode ?? "rolling_7d";
  const nowMs = io.now?.() ?? Date.now();
  const timeOpts = { timezone: timeZone, week_mode: weekMode, now_ms: nowMs };

  let timePreset: UsageFilters["time_preset"] = "all";
  let afterTs: number | undefined;
  let beforeTs: number | undefined;
  let afterDate: string | undefined;
  let beforeDate: string | undefined;

  const sinceRaw = parseSingleValue(parsed, "since", UsageError);
  if (sinceRaw) {
    try {
      const bounds = parseDateOrRelativeStart(sinceRaw, timeOpts);
      timePreset = bounds.preset ?? "all";
      afterTs = bounds.after_ts;
      beforeTs = bounds.before_ts;
      afterDate = bounds.after_date;
      beforeDate = bounds.before_date;
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
  }
  const fromRaw = parseSingleValue(parsed, "from", UsageError);
  if (fromRaw) {
    try {
      const bounds = parseDateOrRelativeStart(fromRaw, timeOpts);
      if (!sinceRaw && bounds.preset) timePreset = bounds.preset;
      afterTs = bounds.after_ts;
      afterDate = bounds.after_date;
      if (bounds.before_ts !== undefined) beforeTs = bounds.before_ts;
      if (bounds.before_date !== undefined) beforeDate = bounds.before_date;
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
  }
  const toRaw = parseSingleValue(parsed, "to", UsageError);
  if (toRaw) {
    try {
      const bounds = parseDateEnd(toRaw, timeOpts);
      beforeTs = bounds.before_ts;
      beforeDate = bounds.before_date;
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
  }

  const timeDimFromBy = dimensions.find(
    (d): d is UsageTimeBucket => d === "hour" || d === "hour_of_day" || d === "day" || d === "week" || d === "month",
  );
  const timeDimension: UsageTimeBucket =
    timeDimFromBy ??
    resolveDefaultTimeBucket({
      preset: timePreset,
      after_ts: afterTs,
      before_ts: beforeTs,
      now_ms: nowMs,
    });

  const filters: UsageFilters = {
    project_ids: projectIds.length > 0 ? projectIds : undefined,
    source_ids: sourceIds.length > 0 ? sourceIds : undefined,
    model_queries: modelQueries.length > 0 ? modelQueries : undefined,
    directory_scope: directoryScope,
    timezone: timeZone,
    week_mode: weekMode,
    now_ms: nowMs,
    time_dimension: timeDimension,
    time_preset: timePreset,
    after_ts: afterTs,
    before_ts: beforeTs,
    after_date: afterDate,
    before_date: beforeDate,
    pricing: pricingConfig,
    quota_limit_usd: resolveEffectiveQuotaLimitUsd(pricingConfig, timePreset, explicitQuotaUsd),
  };

  const matrixDims: UsageStatsDimension[] = dimensions.length >= 2 ? dimensions : ["project", "model", "source", timeDimension];
  const breakdown = snapshot.getUsageBreakdown({
    filters,
    time_dimension: timeDimension,
    matrix_dimensions: matrixDims,
    sort_by: sortBy,
  });

  const exportTarget = parseSingleValue(parsed, "export-pricing", UsageError);
  if (exportTarget !== undefined) {
    const template = buildPricingConfigTemplate(breakdown.model_resolutions, pricingConfig, timeZone);
    const jsonText = `${JSON.stringify(template, null, 2)}\n`;
    if (exportTarget === "-") {
      io.stdout(jsonText);
      return;
    }
    const resolvedDest = expandHomePath(exportTarget, io.cwd, io.homeDir);
    await assertSafeExportDestination(resolvedDest, snapshot, io.homeDir);
    await writeFile(resolvedDest, jsonText, "utf8");
    if (jsonMode !== "none") {
      io.stderr(`Wrote pricing template to ${resolvedDest}\n`);
    }
  }

  const singleDim = dimensions.length === 1 ? dimensions[0] : undefined;
  const rollup: UsageStatsRollup | undefined = singleDim
    ? selectRollup(snapshot, breakdown, singleDim, filters)
    : undefined;
  const matrix: UsageMatrixResult | undefined = dimensions.length >= 2 ? breakdown.matrix : undefined;
  const explainPricing = parsed.booleans.has("explain-pricing");

  const payload: Record<string, unknown> = {
    schema: jsonSchema,
    kind: "stats",
    overview: breakdown.overview,
    rollup,
    ...(breakdown.efficiency ? { efficiency: breakdown.efficiency } : {}),
    ...(breakdown.quota_pace ? { quota_pace: breakdown.quota_pace } : {}),
    ...(matrix ? { matrix } : {}),
    ...(dimensions.length === 0 ? { breakdown } : {}),
    ...(explainPricing ? { model_resolutions: breakdown.model_resolutions } : {}),
  };

  const useColor =
    io.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
  const exportNotice = exportTarget && exportTarget !== "-" ? expandHomePath(exportTarget, io.cwd, io.homeDir) : undefined;
  const rendered = renderEnhancedStats({
    breakdown,
    rollup,
    matrix,
    directoryScope,
    cwd: io.cwd,
    modelQueries,
    projectRefs,
    sourceIds,
    explainPricing,
    exportNotice,
    useColor,
    renderMeta: deps.renderMeta,
    renderDashRow: deps.renderDashRow,
    columns: io.columns ?? 120,
  });

  emitOutput(io, jsonMode, payload, rendered, snapshot, directoryScope);
}

function selectRollup(
  snapshot: LiveHistorySnapshot,
  breakdown: UsageBreakdownSnapshot,
  dimension: UsageStatsDimension,
  filters: UsageFilters,
): UsageStatsRollup {
  switch (dimension) {
    case "project":
      return breakdown.by_project;
    case "model":
      return breakdown.by_model;
    case "source":
      return breakdown.by_source;
    case "session":
      return breakdown.by_session ?? snapshot.getUsageRollup("session", filters);
    case "host":
      return snapshot.getUsageRollup("host", filters);
    case "hour":
    case "hour_of_day":
    case "day":
    case "week":
    case "month":
      return breakdown.by_time;
  }
}
