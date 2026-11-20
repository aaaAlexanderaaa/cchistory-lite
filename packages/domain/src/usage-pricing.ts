/**
 * Role: Pure domain contracts for usage cost, model pricing aliases, multipliers,
 * period quotas, and multi-dimensional usage matrix/breakdown projections.
 * Excludes pricing data catalogs, I/O, and aggregation logic (owned by canonical).
 */

import type { UsageStatsDimension, UsageStatsOverview, UsageStatsRollup } from "./index.js";

export type UsageTimePreset = "all" | "today" | "24h" | "7d" | "30d" | "week" | "month";
export type UsageTimeBucket = "hour" | "hour_of_day" | "day" | "week" | "month";
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

export interface UsageCostShares {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
}

export interface UsageEfficiencyMetrics {
  /** cache_read / (input + cache_read + cache_creation); null when total input is 0. */
  cache_hit_ratio: number | null;
  /** Estimated list USD saved by cache reads compared with paying uncached input rate. */
  cache_list_savings_usd: number;
  /** Estimated adjusted USD saved by cache reads compared with paying adjusted uncached input rate. */
  cache_adjusted_savings_usd: number;
  /** reasoning_for_billing / billable_output; null when billable output is 0. */
  reasoning_share_ratio: number | null;
  /** Per-component share (0..1) of adjusted_cost_usd; null when adjusted_cost_usd is 0. */
  cost_shares: UsageCostShares | null;
  /** Count of priced calls whose input triggered a long-context price tier. */
  high_context_call_count: number;
  /** Total priced calls evaluated for this scope. */
  priced_call_count: number;
  /** Adjusted USD attributable to calls priced at a long-context tier. */
  high_context_adjusted_cost_usd: number;
  /** Effective aggregate cost multiplier (adjusted_cost_usd / list_cost_usd); null when list cost is 0. */
  effective_multiplier?: number | null;
}

export type QuotaPaceStatus = "over_limit" | "fast" | "on_track" | "under_pace";

export interface QuotaPaceProjection {
  period_label: string;
  window_start_ms: number;
  window_end_ms: number;
  elapsed_ms: number;
  total_ms: number;
  /** Fraction of the period elapsed (0..1). */
  elapsed_ratio: number;
  spent_usd: number;
  quota_limit_usd: number;
  quota_percent: number;
  /** Projected spend over the full period at the current average rate; null when elapsed < 60s. */
  projected_period_cost_usd: number | null;
  /** Estimated days until reaching quota_limit_usd at the current average rate; null when rate <= 0 or already over. */
  estimated_days_to_limit: number | null;
  status: QuotaPaceStatus;
}

export interface UsageSessionRollupMeta {
  session_id: string;
  title: string;
  project_label: string;
  source_label: string;
  primary_model?: string;
  delegated_child_count: number;
  tool_call_count: number;
  tool_error_count: number;
  last_activity_at?: string;
}

export interface UsageHourlyProfileCell {
  /** Local hour 0..23. */
  hour: number;
  total_tokens: number;
  adjusted_cost_usd: number;
  call_count: number;
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
  cache_list_savings_usd?: number;
  cache_adjusted_savings_usd?: number;
  high_context_call_count?: number;
  priced_call_count?: number;
  high_context_adjusted_cost_usd?: number;
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
  efficiency?: UsageEfficiencyMetrics;
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
  by_session?: UsageStatsRollup;
  matrix?: UsageMatrixResult;
  model_resolutions: ModelPricingResolution[];
  quota_limit_usd?: number;
  quota_percent?: number;
  efficiency?: UsageEfficiencyMetrics;
  quota_pace?: QuotaPaceProjection;
  hourly_profile?: UsageHourlyProfileCell[];
}
