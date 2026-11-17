/**
 * Role: Parsing, merging, and templating `cchistory-lite-pricing/v1` and raw
 * `models.dev/api.json` pricing/multiplier/quota configurations.
 * Excludes runtime cost calculation and model alias lookup (owned by usage-pricing.ts).
 */

import type {
  ModelCatalogEntry,
  ModelCostMultipliers,
  ModelPricingResolution,
  QuotaConfig,
  UsagePricingConfig,
  UsageTimePreset,
} from "@cchistory/domain";

const MODELS_DEV_PROVIDER_PRIORITY = [
  "anthropic",
  "openai",
  "google",
  "google-vertex",
  "google-vertex-anthropic",
  "xai",
  "deepseek",
  "moonshotai",
  "zhipuai",
  "zai",
  "alibaba",
  "minimax",
  "mistral",
  "cohere",
  "opencode",
  "openrouter",
] as const;

export function mergeUsagePricingConfigs(
  ...configs: Array<UsagePricingConfig | undefined>
): UsagePricingConfig {
  const merged: UsagePricingConfig = {
    schema: "cchistory-lite-pricing/v1",
    aliases: {},
    catalog_overrides: {},
    multipliers: {},
  };
  for (const config of configs) {
    if (!config) continue;
    if (config.timezone) merged.timezone = config.timezone;
    if (config.aliases) {
      for (const [raw, target] of Object.entries(config.aliases)) {
        const key = raw.trim().toLowerCase();
        const value = target.trim();
        if (key && value) merged.aliases![key] = value;
      }
    }
    if (config.catalog_overrides) {
      for (const [raw, entry] of Object.entries(config.catalog_overrides)) {
        const key = raw.trim().toLowerCase();
        if (key) merged.catalog_overrides![key] = entry;
      }
    }
    if (config.default_multipliers) {
      merged.default_multipliers = {
        ...merged.default_multipliers,
        ...config.default_multipliers,
      };
    }
    if (config.multipliers) {
      for (const [raw, mult] of Object.entries(config.multipliers)) {
        const key = raw.trim().toLowerCase();
        if (!key) continue;
        merged.multipliers![key] = { ...merged.multipliers![key], ...mult };
      }
    }
    if (config.quota) {
      merged.quota = { ...merged.quota, ...config.quota };
    }
  }
  return merged;
}

export function parseUsagePricingInput(raw: unknown): UsagePricingConfig {
  if (!isPlainObject(raw)) {
    throw new Error("Pricing config JSON must be an object.");
  }

  if (looksLikeModelsDevApi(raw)) {
    return {
      schema: "cchistory-lite-pricing/v1",
      catalog_overrides: extractCatalogOverridesFromModelsDev(raw),
    };
  }

  const config: UsagePricingConfig = { schema: "cchistory-lite-pricing/v1" };
  if (typeof raw.timezone === "string" && raw.timezone.trim()) {
    config.timezone = raw.timezone.trim();
  }
  if (isPlainObject(raw.aliases)) {
    config.aliases = {};
    for (const [key, value] of Object.entries(raw.aliases)) {
      if (typeof value === "string" && key.trim() && value.trim()) {
        config.aliases[key.trim().toLowerCase()] = value.trim();
      }
    }
  }

  const catalogRaw = isPlainObject(raw.catalog_overrides)
    ? raw.catalog_overrides
    : isPlainObject(raw.prices)
      ? raw.prices
      : undefined;
  if (catalogRaw) {
    config.catalog_overrides = {};
    for (const [key, value] of Object.entries(catalogRaw)) {
      const parsed = parseCatalogEntry(key, value);
      if (parsed) config.catalog_overrides[key.trim().toLowerCase()] = parsed;
    }
  }

  if (isPlainObject(raw.default_multipliers)) {
    config.default_multipliers = parseMultiplierObject(raw.default_multipliers);
  }

  const multipliersRaw = isPlainObject(raw.multipliers)
    ? raw.multipliers
    : isPlainObject(raw.models)
      ? raw.models
      : undefined;
  if (multipliersRaw) {
    config.multipliers = {};
    for (const [key, value] of Object.entries(multipliersRaw)) {
      if (!isPlainObject(value) || !key.trim()) continue;
      const lowerKey = key.trim().toLowerCase();
      if (typeof value.alias === "string" && value.alias.trim()) {
        config.aliases ??= {};
        config.aliases[lowerKey] = value.alias.trim();
      }
      if (isPlainObject(value.prices)) {
        const entry = parseCatalogEntry(key, { provider: "custom", prices: value.prices });
        if (entry) {
          config.catalog_overrides ??= {};
          config.catalog_overrides[lowerKey] = entry;
        }
      }
      const mult = parseMultiplierObject(value);
      if (Object.keys(mult).length > 0) {
        config.multipliers[lowerKey] = mult;
      }
    }
  }

  if (isPlainObject(raw.quota)) {
    config.quota = parseQuotaObject(raw.quota);
  }

  return config;
}

export function resolveEffectiveQuotaLimitUsd(
  config: UsagePricingConfig | undefined,
  timePreset: UsageTimePreset = "all",
  explicitQuotaUsd?: number,
): number | undefined {
  if (typeof explicitQuotaUsd === "number" && Number.isFinite(explicitQuotaUsd) && explicitQuotaUsd > 0) {
    return explicitQuotaUsd;
  }
  const quota = config?.quota;
  if (!quota) return undefined;
  if (timePreset === "month" || timePreset === "30d") {
    return quota.monthly_usd ?? quota.custom_usd ?? quota.weekly_usd;
  }
  if (timePreset === "week" || timePreset === "7d") {
    return quota.weekly_usd ?? quota.custom_usd ?? quota.monthly_usd;
  }
  return quota.custom_usd ?? quota.weekly_usd ?? quota.monthly_usd;
}

export function buildPricingConfigTemplate(
  resolutions: readonly ModelPricingResolution[],
  config?: UsagePricingConfig,
  timezone?: string,
): UsagePricingConfig {
  const aliases: Record<string, string> = { ...(config?.aliases ?? {}) };
  const multipliers: Record<string, ModelCostMultipliers> = {};
  for (const res of resolutions) {
    if (res.match_kind === "alias" && res.resolved_model && !aliases[res.raw_model.toLowerCase()]) {
      aliases[res.raw_model] = res.resolved_model;
    }
    multipliers[res.raw_model] = {
      model: res.multipliers.model,
      input: res.multipliers.input,
      cache_read: res.multipliers.cache_read,
      cache_write: res.multipliers.cache_write,
      output: res.multipliers.output,
      reasoning: res.multipliers.reasoning,
    };
  }
  return {
    schema: "cchistory-lite-pricing/v1",
    timezone: timezone ?? config?.timezone,
    quota: config?.quota,
    aliases,
    catalog_overrides: config?.catalog_overrides,
    default_multipliers: config?.default_multipliers,
    multipliers,
  };
}

function looksLikeModelsDevApi(raw: Record<string, unknown>): boolean {
  for (const key of ["anthropic", "openai", "google", "openrouter"]) {
    const entry = raw[key];
    if (isPlainObject(entry) && isPlainObject(entry.models)) return true;
  }
  const values = Object.values(raw).slice(0, 5);
  return values.length > 0 && values.some((entry) => isPlainObject(entry) && isPlainObject(entry.models));
}

function extractCatalogOverridesFromModelsDev(rawApi: Record<string, unknown>): Record<string, ModelCatalogEntry> {
  const catalog: Record<string, ModelCatalogEntry> = {};
  const providers = [
    ...MODELS_DEV_PROVIDER_PRIORITY.filter((id) => Object.prototype.hasOwnProperty.call(rawApi, id)),
    ...Object.keys(rawApi).filter((id) => !MODELS_DEV_PROVIDER_PRIORITY.includes(id as never)),
  ];
  for (const providerId of providers) {
    const provider = rawApi[providerId];
    if (!isPlainObject(provider) || !isPlainObject(provider.models)) continue;
    for (const [modelKey, spec] of Object.entries(provider.models)) {
      if (!isPlainObject(spec) || !isPlainObject(spec.cost)) continue;
      const cost = spec.cost;
      if (typeof cost.input !== "number" && typeof cost.output !== "number") continue;
      const bareId = modelKey.includes("/") ? modelKey.split("/").at(-1)! : modelKey;
      const lower = bareId.toLowerCase();
      if (catalog[lower]) continue;
      catalog[lower] = {
        id: bareId,
        provider: providerId,
        prices: {
          input: asNonNeg(cost.input) ?? 0,
          output: asNonNeg(cost.output) ?? 0,
          ...(asNonNeg(cost.cache_read) !== undefined ? { cache_read: asNonNeg(cost.cache_read) } : {}),
          ...(asNonNeg(cost.cache_write) !== undefined ? { cache_write: asNonNeg(cost.cache_write) } : {}),
          ...(asNonNeg(cost.reasoning) !== undefined ? { reasoning: asNonNeg(cost.reasoning) } : {}),
        },
      };
    }
  }
  return catalog;
}

function parseCatalogEntry(id: string, value: unknown): ModelCatalogEntry | undefined {
  if (!isPlainObject(value)) return undefined;
  const priceObj = isPlainObject(value.prices) ? value.prices : value;
  const input = asNonNeg(priceObj.input);
  const output = asNonNeg(priceObj.output);
  if (input === undefined && output === undefined) return undefined;
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : id,
    provider: typeof value.provider === "string" && value.provider.trim() ? value.provider.trim() : "custom",
    prices: {
      input: input ?? 0,
      output: output ?? 0,
      ...(asNonNeg(priceObj.cache_read) !== undefined ? { cache_read: asNonNeg(priceObj.cache_read) } : {}),
      ...(asNonNeg(priceObj.cache_write) !== undefined ? { cache_write: asNonNeg(priceObj.cache_write) } : {}),
      ...(asNonNeg(priceObj.reasoning) !== undefined ? { reasoning: asNonNeg(priceObj.reasoning) } : {}),
    },
  };
}

function parseMultiplierObject(raw: Record<string, unknown>): ModelCostMultipliers {
  const result: ModelCostMultipliers = {};
  const model = asNonNeg(raw.model ?? raw.model_multiplier);
  const input = asNonNeg(raw.input ?? raw.input_multiplier);
  const cacheRead = asNonNeg(raw.cache_read ?? raw.cache_read_multiplier);
  const cacheWrite = asNonNeg(raw.cache_write ?? raw.cache_write_multiplier);
  const output = asNonNeg(raw.output ?? raw.output_multiplier);
  const reasoning = asNonNeg(raw.reasoning ?? raw.reasoning_multiplier);
  if (model !== undefined) result.model = model;
  if (input !== undefined) result.input = input;
  if (cacheRead !== undefined) result.cache_read = cacheRead;
  if (cacheWrite !== undefined) result.cache_write = cacheWrite;
  if (output !== undefined) result.output = output;
  if (reasoning !== undefined) result.reasoning = reasoning;
  return result;
}

function parseQuotaObject(raw: Record<string, unknown>): QuotaConfig {
  const quota: QuotaConfig = {};
  if (asNonNeg(raw.weekly_usd) !== undefined) quota.weekly_usd = asNonNeg(raw.weekly_usd);
  if (asNonNeg(raw.monthly_usd) !== undefined) quota.monthly_usd = asNonNeg(raw.monthly_usd);
  if (asNonNeg(raw.custom_usd) !== undefined) quota.custom_usd = asNonNeg(raw.custom_usd);
  if (raw.week_mode === "rolling_7d" || raw.week_mode === "iso_week" || raw.week_mode === "custom_reset") {
    quota.week_mode = raw.week_mode;
  }
  if (typeof raw.week_start_day === "number" && Number.isInteger(raw.week_start_day) && raw.week_start_day >= 0 && raw.week_start_day <= 6) {
    quota.week_start_day = raw.week_start_day;
  }
  if (typeof raw.week_reset_hour === "number" && Number.isInteger(raw.week_reset_hour) && raw.week_reset_hour >= 0 && raw.week_reset_hour <= 23) {
    quota.week_reset_hour = raw.week_reset_hour;
  }
  return quota;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function asNonNeg(value: unknown): number | undefined {
  return isFiniteNonNegative(value) ? value : undefined;
}
