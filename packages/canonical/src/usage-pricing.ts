/**
 * Role: Model pricing alias resolution and dual-layer cost calculation (list USD vs
 * multiplier-adjusted USD and period quota percentage).
 * Excludes pricing file parsing (owned by usage-pricing-config.ts) and history aggregation.
 */

import type {
  ModelCostMultipliers,
  ModelPricingMatchKind,
  ModelPricingResolution,
  ModelTokenPrices,
  NormalizedModelCostMultipliers,
  UsageCostBreakdown,
  UsagePricingConfig,
} from "@cchistory/domain";
import { BUILTIN_MODEL_PRICING_CATALOG, DEFAULT_MODEL_ALIASES } from "./model-pricing-catalog.js";
import { createModelNameMatcher } from "./model-name-matching.js";

const matchModelName = createModelNameMatcher(BUILTIN_MODEL_PRICING_CATALOG, DEFAULT_MODEL_ALIASES);

export interface ResolvedModelPricing {
  raw_model: string;
  resolved_model?: string;
  provider?: string;
  match_kind: ModelPricingMatchKind;
  unit_prices?: ModelTokenPrices;
  multipliers: NormalizedModelCostMultipliers;
}

export interface UsageTokenQuantities {
  /** Present only for an individual native call, never a turn/model aggregate. */
  context_input_tokens?: number;
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  non_reasoning_output_tokens: number;
  reasoning_for_billing_tokens: number;
  total_tokens: number;
}

export function normalizeMultipliers(
  ...layers: Array<ModelCostMultipliers | undefined>
): NormalizedModelCostMultipliers {
  const result: NormalizedModelCostMultipliers = {
    model: 1,
    input: 1,
    cache_read: 1,
    cache_write: 1,
    output: 1,
    reasoning: 1,
  };
  for (const layer of layers) {
    if (!layer) continue;
    if (isFiniteNonNegative(layer.model)) result.model = layer.model;
    if (isFiniteNonNegative(layer.input)) result.input = layer.input;
    if (isFiniteNonNegative(layer.cache_read)) result.cache_read = layer.cache_read;
    if (isFiniteNonNegative(layer.cache_write)) result.cache_write = layer.cache_write;
    if (isFiniteNonNegative(layer.output)) result.output = layer.output;
    if (isFiniteNonNegative(layer.reasoning)) result.reasoning = layer.reasoning;
  }
  return result;
}

export function resolveModelPricing(
  rawModel: string,
  config?: UsagePricingConfig,
): ResolvedModelPricing {
  const trimmed = rawModel.trim() || "unknown";
  const lower = trimmed.toLowerCase();

  const matched = matchModelName(lower, config);
  const resolvedKey = matched?.entry.id.toLowerCase();
  const multipliers = normalizeMultipliers(
    config?.default_multipliers,
    resolvedKey ? config?.multipliers?.[resolvedKey] : undefined,
    matched?.aliasKey ? config?.multipliers?.[matched.aliasKey] : undefined,
    config?.multipliers?.[lower],
  );

  if (!matched) {
    return {
      raw_model: trimmed,
      match_kind: "unpriced",
      multipliers,
    };
  }

  return {
    raw_model: trimmed,
    resolved_model: matched.entry.id,
    provider: matched.entry.provider,
    match_kind: matched.kind,
    unit_prices: matched.entry.prices,
    multipliers,
  };
}

export function createEmptyCostBreakdown(quotaLimitUsd?: number): UsageCostBreakdown {
  return {
    list_cost_usd: 0,
    adjusted_cost_usd: 0,
    input_list_cost_usd: 0,
    cache_read_list_cost_usd: 0,
    cache_write_list_cost_usd: 0,
    output_list_cost_usd: 0,
    reasoning_list_cost_usd: 0,
    input_adjusted_cost_usd: 0,
    cache_read_adjusted_cost_usd: 0,
    cache_write_adjusted_cost_usd: 0,
    output_adjusted_cost_usd: 0,
    reasoning_adjusted_cost_usd: 0,
    priced_tokens: 0,
    unpriced_tokens: 0,
    unpriced_models: [],
    quota_limit_usd: quotaLimitUsd,
    quota_percent: quotaLimitUsd && quotaLimitUsd > 0 ? 0 : undefined,
    cache_list_savings_usd: 0,
    cache_adjusted_savings_usd: 0,
    high_context_call_count: 0,
    priced_call_count: 0,
    high_context_adjusted_cost_usd: 0,
  };
}

export function addModelUsageToCostBreakdown(
  target: UsageCostBreakdown,
  rawModel: string,
  tokens: UsageTokenQuantities,
  config?: UsagePricingConfig,
  quotaLimitUsd?: number,
): ResolvedModelPricing {
  const resolved = resolveModelPricing(rawModel, config);
  return addResolvedModelUsageToCostBreakdown(target, resolved, tokens, quotaLimitUsd);
}

/** Reuses a model resolution within one synchronous aggregation; tiers remain per call. */
export function addResolvedModelUsageToCostBreakdown(
  target: UsageCostBreakdown,
  resolved: ResolvedModelPricing,
  tokens: UsageTokenQuantities,
  quotaLimitUsd?: number,
): ResolvedModelPricing {
  if (!resolved.unit_prices) {
    target.unpriced_tokens += tokens.total_tokens;
    if (!target.unpriced_models.includes(resolved.raw_model)) {
      target.unpriced_models.push(resolved.raw_model);
    }
    return resolved;
  }

  let prices = resolved.unit_prices;
  let highContextTierApplied = false;
  if (tokens.context_input_tokens !== undefined) {
    const tier = prices.context_tiers?.filter(item => tokens.context_input_tokens! > item.above_input_tokens)
      .sort((left, right) => right.above_input_tokens - left.above_input_tokens)[0];
    if (tier) {
      prices = { ...prices, ...tier };
      highContextTierApplied = true;
    }
  }
  const m = resolved.multipliers;
  const cacheReadRate = prices.cache_read ?? prices.input;
  const cacheWriteRate = prices.cache_write ?? prices.input;
  const reasoningRate = prices.reasoning ?? prices.output;

  const inList = (tokens.input_tokens / 1_000_000) * prices.input;
  const crList = (tokens.cache_read_input_tokens / 1_000_000) * cacheReadRate;
  const cwList = (tokens.cache_creation_input_tokens / 1_000_000) * cacheWriteRate;
  const outList = (tokens.non_reasoning_output_tokens / 1_000_000) * prices.output;
  const reasonList = (tokens.reasoning_for_billing_tokens / 1_000_000) * reasoningRate;

  const inAdj = inList * m.model * m.input;
  const crAdj = crList * m.model * m.cache_read;
  const cwAdj = cwList * m.model * m.cache_write;
  const outAdj = outList * m.model * m.output;
  const reasonAdj = reasonList * m.model * m.reasoning;

  const callAdj = inAdj + crAdj + cwAdj + outAdj + reasonAdj;
  const cacheReadMillions = tokens.cache_read_input_tokens / 1_000_000;
  const cacheListSavings = cacheReadMillions * Math.max(0, prices.input - cacheReadRate);
  const cacheAdjSavings = Math.max(
    0,
    cacheReadMillions * (prices.input * m.model * m.input - cacheReadRate * m.model * m.cache_read),
  );

  target.input_list_cost_usd += inList;
  target.cache_read_list_cost_usd += crList;
  target.cache_write_list_cost_usd += cwList;
  target.output_list_cost_usd += outList;
  target.reasoning_list_cost_usd += reasonList;
  target.list_cost_usd += inList + crList + cwList + outList + reasonList;

  target.input_adjusted_cost_usd += inAdj;
  target.cache_read_adjusted_cost_usd += crAdj;
  target.cache_write_adjusted_cost_usd += cwAdj;
  target.output_adjusted_cost_usd += outAdj;
  target.reasoning_adjusted_cost_usd += reasonAdj;
  target.adjusted_cost_usd += callAdj;

  target.cache_list_savings_usd = (target.cache_list_savings_usd ?? 0) + cacheListSavings;
  target.cache_adjusted_savings_usd = (target.cache_adjusted_savings_usd ?? 0) + cacheAdjSavings;
  target.priced_call_count = (target.priced_call_count ?? 0) + 1;
  if (highContextTierApplied) {
    target.high_context_call_count = (target.high_context_call_count ?? 0) + 1;
    target.high_context_adjusted_cost_usd = (target.high_context_adjusted_cost_usd ?? 0) + callAdj;
  }

  target.priced_tokens += tokens.total_tokens;
  if (quotaLimitUsd && quotaLimitUsd > 0) {
    target.quota_limit_usd = quotaLimitUsd;
    target.quota_percent = (target.adjusted_cost_usd / quotaLimitUsd) * 100;
  }
  return resolved;
}

export function buildModelPricingResolutions(
  rowsByModel: ReadonlyMap<string, UsageTokenQuantities>,
  config?: UsagePricingConfig,
  quotaLimitUsd?: number,
  callRows?: readonly (UsageTokenQuantities & { model: string })[],
): ModelPricingResolution[] {
  const resolutions: ModelPricingResolution[] = [];
  for (const [rawModel, tokens] of rowsByModel.entries()) {
    const cost = createEmptyCostBreakdown(quotaLimitUsd);
    const resolved = resolveModelPricing(rawModel, config);
    if (callRows) {
      for (const row of callRows) if (row.model === rawModel) {
        addResolvedModelUsageToCostBreakdown(cost, resolved, row, quotaLimitUsd);
      }
    } else addResolvedModelUsageToCostBreakdown(cost, resolved, tokens, quotaLimitUsd);
    resolutions.push({
      raw_model: resolved.raw_model,
      resolved_model: resolved.resolved_model,
      provider: resolved.provider,
      match_kind: resolved.match_kind,
      unit_prices: resolved.unit_prices,
      multipliers: resolved.multipliers,
      input_tokens: tokens.input_tokens,
      cache_read_input_tokens: tokens.cache_read_input_tokens,
      cache_creation_input_tokens: tokens.cache_creation_input_tokens,
      output_tokens: tokens.non_reasoning_output_tokens,
      reasoning_output_tokens: tokens.reasoning_for_billing_tokens,
      total_tokens: tokens.total_tokens,
      list_cost_usd: cost.list_cost_usd,
      adjusted_cost_usd: cost.adjusted_cost_usd,
      quota_percent: quotaLimitUsd && quotaLimitUsd > 0 ? (cost.adjusted_cost_usd / quotaLimitUsd) * 100 : undefined,
    });
  }
  return resolutions.sort((left, right) => {
    if (right.adjusted_cost_usd !== left.adjusted_cost_usd) {
      return right.adjusted_cost_usd - left.adjusted_cost_usd;
    }
    if (right.total_tokens !== left.total_tokens) {
      return right.total_tokens - left.total_tokens;
    }
    return left.raw_model.localeCompare(right.raw_model);
  });
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
