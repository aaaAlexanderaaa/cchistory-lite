/**
 * Role: Pure domain contracts for usage cost, model pricing aliases, multipliers,
 * period quotas, and multi-dimensional usage matrix/breakdown projections.
 * Excludes pricing data catalogs, I/O, and aggregation logic (owned by canonical).
 */

import type { UsageStatsDimension, UsageStatsOverview, UsageStatsRollup } from "./index.js";

export type UsageTimePreset = "all" | "today" | "24h" | "7d" | "30d" | "week" | "month";
export type UsageTimeBucket = "day" | "week" | "month";
export type UsageWeekMode = "rolling_7d" | "iso_week" | "custom_reset";
export type UsageMatrixSort = "adjusted_cost" | "list_cost" | "tokens" | "turns" | "label";

export interface ModelTokenPrices {
  /** USD per 1M uncached input tokens. */
  input: number;
  /** USD per 1M generated output tokens. */
  output: number;
  /** USD per 1M cache read tokens. */
  cache_read?: number;
  /** USD per 1M cache creation/write tokens. */
  cache_write?: number;
  /** USD per 1M reasoning output tokens (defaults to `output` when omitted). */
  reasoning?: number;
  /** Whole-request rates when input (including cache) exceeds the threshold. */
  context_tiers?: ModelContextPriceTier[];
}

export interface ModelContextPriceTier {
  above_input_tokens: number;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
}

export interface ModelCostMultipliers {
  /** Overall multiplier applied to every component for this model (default 1). */
  model?: number;
  /** Multiplier for non-cached input tokens (default 1). */
  input?: number;
  /** Multiplier for cache read tokens (default 1). */
  cache_read?: number;
  /** Multiplier for cache creation/write tokens (default 1). */
  cache_write?: number;
  /** Multiplier for non-reasoning output tokens (default 1). */
  output?: number;
  /** Multiplier for reasoning output tokens (default 1). */
  reasoning?: number;
}

export interface NormalizedModelCostMultipliers {
  model: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
}

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  prices: ModelTokenPrices;
}

export interface QuotaConfig {
  weekly_usd?: number;
  monthly_usd?: number;
  custom_usd?: number;
  week_mode?: UsageWeekMode;
  /** 0 = Sunday .. 6 = Saturday (used when week_mode is custom_reset; default 1 = Monday). */
  week_start_day?: number;
  /** Local hour 0..23 when weekly quota resets (used when week_mode is custom_reset; default 0). */
  week_reset_hour?: number;
}

export interface UsagePricingConfig {
  schema?: "cchistory-lite-pricing/v1";
  timezone?: string;
  aliases?: Record<string, string>;
  catalog_overrides?: Record<string, ModelCatalogEntry>;
  multipliers?: Record<string, ModelCostMultipliers>;
  default_multipliers?: ModelCostMultipliers;
  quota?: QuotaConfig;
}

export interface UsageCostBreakdown {
  list_cost_usd: number;
  adjusted_cost_usd: number;
  input_list_cost_usd: number;
  cache_read_list_cost_usd: number;
  cache_write_list_cost_usd: number;
  output_list_cost_usd: number;
  reasoning_list_cost_usd: number;
  input_adjusted_cost_usd: number;
  cache_read_adjusted_cost_usd: number;
  cache_write_adjusted_cost_usd: number;
  output_adjusted_cost_usd: number;
  reasoning_adjusted_cost_usd: number;
  priced_tokens: number;
  unpriced_tokens: number;
  unpriced_models: string[];
  quota_limit_usd?: number;
  quota_percent?: number;
}

export type ModelPricingMatchKind = "custom" | "exact" | "alias" | "normalized" | "unpriced";

export interface ModelPricingResolution {
  raw_model: string;
  resolved_model?: string;
  provider?: string;
  match_kind: ModelPricingMatchKind;
  unit_prices?: ModelTokenPrices;
  multipliers: NormalizedModelCostMultipliers;
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  list_cost_usd: number;
  adjusted_cost_usd: number;
  quota_percent?: number;
}

export interface UsageMatrixRow {
  keys: string[];
  labels: string[];
  dimensions: UsageStatsDimension[];
  turn_count: number;
  usage_event_count: number;
  total_input_tokens: number;
  total_cache_read_input_tokens: number;
  total_cache_creation_input_tokens: number;
  total_cached_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_output_tokens: number;
  total_billable_output_tokens: number;
  total_tokens: number;
  cost: UsageCostBreakdown;
}

export interface UsageMatrixResult {
  generated_at: string;
  dimensions: UsageStatsDimension[];
  rows: UsageMatrixRow[];
  excluded_zero_token_turns?: number;
}

export interface UsageBreakdownSnapshot {
  generated_at: string;
  timezone: string;
  week_mode: UsageWeekMode;
  time_dimension: UsageTimeBucket;
  effective_after_date?: string;
  effective_before_date?: string;
  overview: UsageStatsOverview;
  by_project: UsageStatsRollup;
  by_model: UsageStatsRollup;
  by_source: UsageStatsRollup;
  by_time: UsageStatsRollup;
  matrix?: UsageMatrixResult;
  model_resolutions: ModelPricingResolution[];
  quota_limit_usd?: number;
  quota_percent?: number;
}
