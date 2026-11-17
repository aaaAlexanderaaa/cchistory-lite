/**
 * Role: Model pricing alias resolution and dual-layer cost calculation (list USD vs
 * multiplier-adjusted USD and period quota percentage).
 * Excludes pricing file parsing (owned by usage-pricing-config.ts) and history aggregation.
 */

import type {
  ModelCatalogEntry,
  ModelCostMultipliers,
  ModelPricingMatchKind,
  ModelPricingResolution,
  ModelTokenPrices,
  NormalizedModelCostMultipliers,
  UsageCostBreakdown,
  UsagePricingConfig,
} from "@cchistory/domain";
import { BUILTIN_MODEL_PRICING_CATALOG, DEFAULT_MODEL_ALIASES } from "./model-pricing-catalog.js";

const PROVIDER_PREFIX_RE = /^(?:anthropic|google|openai|xai|deepseek|moonshotai|zhipuai|zai|alibaba|minimax|mistral|cohere|opencode|openrouter|google-vertex|google-vertex-anthropic|vertex_ai)\//iu;
const REGION_OR_TAG_SUFFIX_RE = /(?:@[a-z0-9-]+|:(?:thinking|free|exacto|beta))$/iu;
const VARIANT_SUFFIX_RE = /-(?:xhigh|high|medium|low|minimal|max|tiered|fast|thinking|preview|latest|customtools)$/iu;
const DATE_SUFFIX_RE = /-\d{8}$/u;

export interface ResolvedModelPricing {
  raw_model: string;
  resolved_model?: string;
  provider?: string;
  match_kind: ModelPricingMatchKind;
  unit_prices?: ModelTokenPrices;
  multipliers: NormalizedModelCostMultipliers;
}

export interface UsageTokenQuantities {
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

  const customAliases = config?.aliases ?? {};
  const customCatalog = config?.catalog_overrides ?? {};

  const lookupCatalog = (candidate: string): { entry: ModelCatalogEntry; source: "custom" | "builtin" } | undefined => {
    const key = candidate.trim().toLowerCase();
    if (!key) return undefined;
    const customEntry = customCatalog[key];
    if (customEntry) return { entry: customEntry, source: "custom" };
    const builtinEntry = BUILTIN_MODEL_PRICING_CATALOG[key];
    if (builtinEntry) return { entry: builtinEntry, source: "builtin" };
    return undefined;
  };

  const resolveChain = (
    start: string,
  ): { entry: ModelCatalogEntry; kind: Exclude<ModelPricingMatchKind, "unpriced">; aliasKey?: string } | undefined => {
    let current = start.trim().toLowerCase();
    const visited = new Set<string>();
    let usedAlias = false;

    for (let hop = 0; hop < 4; hop += 1) {
      if (!current || visited.has(current)) break;
      visited.add(current);

      const customTarget = customAliases[current];
      if (customTarget) {
        current = customTarget.trim().toLowerCase();
        usedAlias = true;
        continue;
      }
      const direct = lookupCatalog(current);
      if (direct) {
        return {
          entry: direct.entry,
          kind: direct.source === "custom" ? "custom" : usedAlias ? "alias" : "exact",
          aliasKey: usedAlias ? current : undefined,
        };
      }
      const defaultTarget = DEFAULT_MODEL_ALIASES[current];
      if (defaultTarget) {
        current = defaultTarget.trim().toLowerCase();
        usedAlias = true;
        continue;
      }
      break;
    }

    for (const candidate of generateNormalizedCandidates(current)) {
      const customTarget = customAliases[candidate];
      if (customTarget) {
        const aliased = lookupCatalog(customTarget);
        if (aliased) {
          return {
            entry: aliased.entry,
            kind: aliased.source === "custom" ? "custom" : "alias",
            aliasKey: aliased.entry.id.toLowerCase(),
          };
        }
      }
      const defaultTarget = DEFAULT_MODEL_ALIASES[candidate];
      if (defaultTarget) {
        const aliased = lookupCatalog(defaultTarget);
        if (aliased) {
          return {
            entry: aliased.entry,
            kind: aliased.source === "custom" ? "custom" : "alias",
            aliasKey: aliased.entry.id.toLowerCase(),
          };
        }
      }
      const hit = lookupCatalog(candidate);
      if (hit) {
        return {
          entry: hit.entry,
          kind: hit.source === "custom" ? "custom" : usedAlias ? "alias" : "normalized",
          aliasKey: hit.entry.id.toLowerCase(),
        };
      }
    }
    return undefined;
  };

  const matched = resolveChain(lower);
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
  if (!resolved.unit_prices) {
    target.unpriced_tokens += tokens.total_tokens;
    if (!target.unpriced_models.includes(resolved.raw_model)) {
      target.unpriced_models.push(resolved.raw_model);
    }
    return resolved;
  }

  const prices = resolved.unit_prices;
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
  target.adjusted_cost_usd += inAdj + crAdj + cwAdj + outAdj + reasonAdj;

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
): ModelPricingResolution[] {
  const resolutions: ModelPricingResolution[] = [];
  for (const [rawModel, tokens] of rowsByModel.entries()) {
    const cost = createEmptyCostBreakdown(quotaLimitUsd);
    const resolved = addModelUsageToCostBreakdown(cost, rawModel, tokens, config, quotaLimitUsd);
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

function generateNormalizedCandidates(rawLower: string): string[] {
  const candidates: string[] = [];
  const push = (value: string) => {
    const clean = value.trim().toLowerCase();
    if (clean && clean !== rawLower && !candidates.includes(clean)) {
      candidates.push(clean);
    }
  };

  let base = rawLower.replace(PROVIDER_PREFIX_RE, "");
  push(base);
  base = base.replace(REGION_OR_TAG_SUFFIX_RE, "");
  push(base);

  let stripped = base;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = stripped.replace(VARIANT_SUFFIX_RE, "");
    if (next === stripped) break;
    stripped = next;
    push(stripped);
  }

  for (const stem of [base, stripped]) {
    if (DATE_SUFFIX_RE.test(stem)) {
      push(stem.replace(DATE_SUFFIX_RE, ""));
    }
    push(stem.replace(/(\d)\.(\d)/gu, "$1-$2"));
    push(stem.replace(/(claude-[a-z]+-)(\d)-(\d)/gu, "$1$2.$3"));
  }

  return candidates;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
