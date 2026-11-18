/** Verify generic name resolution and billing boundaries using synthetic catalog fixtures. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ModelCatalogEntry, ModelPricingMatchKind, UsagePricingConfig } from "@cchistory/domain";
import { createModelNameMatcher } from "./model-name-matching.js";
import { addModelUsageToCostBreakdown, createEmptyCostBreakdown, resolveModelPricing, type UsageTokenQuantities } from "./usage-pricing.js";

interface MatchingCase {
  raw: string;
  expected: string | null;
  kind: ModelPricingMatchKind;
  config?: UsagePricingConfig;
  input_rate?: number;
}
const fixture = JSON.parse(readFileSync(new URL("../../../mock_data/fixtures/pricing-catalog/model-names.json", import.meta.url), "utf8")) as {
  catalog: Record<string, ModelCatalogEntry>;
  default_aliases: Record<string, string>;
  cases: MatchingCase[];
  builtin_cases: MatchingCase[];
  upstream_comparison: {
    aliases: Record<string, string>;
    tokens: UsageTokenQuantities;
    cases: { raw: string; ccusage_cost_usd: number; lite_cost_usd: number | null }[];
  };
};

for (const item of fixture.cases) {
  test(`generic model matching: ${item.raw} -> ${item.expected ?? "unpriced"} (${item.kind})`, () => {
    const matcher = createModelNameMatcher(fixture.catalog, fixture.default_aliases);
    const match = matcher(item.raw, item.config);
    assert.equal(match?.entry.id ?? null, item.expected);
    assert.equal(match?.kind ?? "unpriced", item.kind);
    if (item.input_rate !== undefined) assert.equal(match?.entry.prices.input, item.input_rate);
    // Catalog insertion order must not alter prices, including normalized ambiguities.
    const reversed = createModelNameMatcher(Object.fromEntries(Object.entries(fixture.catalog).reverse()),
      Object.fromEntries(Object.entries(fixture.default_aliases).reverse()));
    const reversedConfig = item.config && { ...item.config,
      aliases: item.config.aliases && Object.fromEntries(Object.entries(item.config.aliases).reverse()) };
    assert.deepEqual(reversed(item.raw, reversedConfig), match);
  });
}

for (const item of fixture.builtin_cases) {
  test(`bundled model matching: ${item.raw} -> ${item.expected ?? "unpriced"}`, () => {
    const match = resolveModelPricing(item.raw);
    assert.equal(match.resolved_model ?? null, item.expected);
    if (item.input_rate !== undefined) assert.equal(match.unit_prices?.input, item.input_rate);
    if (!item.expected) assert.equal(match.match_kind, "unpriced");
  });
}

test("alias and custom-price edits take effect on the next resolution with the same config object", () => {
  const matcher = createModelNameMatcher(fixture.catalog, {});
  const config: UsagePricingConfig = { aliases: { private: "fixture-7.2" }, catalog_overrides: {} };
  assert.equal(matcher("private", config)?.entry.id, "fixture-7.2");
  config.aliases!.private = "fixture-7.2-fast";
  assert.equal(matcher("private", config)?.entry.id, "fixture-7.2-fast");
  config.catalog_overrides!["fixture-7.2-fast"] = { id: "custom-fast", provider: "fixture", prices: { input: 20, output: 60 } };
  assert.equal(matcher("private", config)?.entry.prices.input, 20);
  config.catalog_overrides!["fixture-7.2-fast"]!.prices.input = 30;
  assert.equal(matcher("private", config)?.entry.prices.input, 30);
  delete config.aliases!.private;
  assert.equal(matcher("private", config), undefined);
});

test("raw model multipliers keep precedence after generic names and Fast aliases resolve", () => {
  const config: UsagePricingConfig = { aliases: { gateway: "grok-4.7" }, default_multipliers: { model: 2 },
    multipliers: { "grok-4.7-build-fast": { model: 3, cache_read: 4 }, "gateway-fast": { model: 5 } } };
  const resolved = resolveModelPricing("gateway-fast", config);
  assert.equal(resolved.resolved_model, "grok-4.7-build-fast");
  assert.equal(resolved.multipliers.model, 5);
  assert.equal(resolved.multipliers.cache_read, 4);
});

test("published ccusage replay agrees on ordinary suffix costs and retains Lite's separate Fast rates", () => {
  const comparison = fixture.upstream_comparison;
  for (const item of comparison.cases) {
    const cost = createEmptyCostBreakdown();
    addModelUsageToCostBreakdown(cost, item.raw, comparison.tokens, { aliases: comparison.aliases });
    if (item.lite_cost_usd === null) {
      assert.equal(cost.priced_tokens, 0, item.raw);
      assert.equal(cost.unpriced_tokens, 3000, item.raw);
    } else {
      assert.ok(Math.abs(cost.list_cost_usd - item.lite_cost_usd) < 1e-12, item.raw);
      assert.equal(cost.priced_tokens, 3000, item.raw);
      // Official Fast supplements deliberately supersede the upstream snapshot's base-rate fallback.
      if (!item.raw.endsWith("-fast")) assert.equal(item.lite_cost_usd, item.ccusage_cost_usd, item.raw);
    }
  }
});
