/** Verify the offline catalog refresh against provider, unit and context-tier evidence. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyOfficialPriceSupplements, extractCatalogFromModelsDev, mergeLiteLlmCatalog, renderBuiltinCatalogTs } from "./refresh-models-dev-pricing.mjs";

const fixture = JSON.parse(await readFile(new URL("../mock_data/fixtures/pricing-catalog/refresh.json", import.meta.url), "utf8"));

test("refresh retains direct-provider prices and context tiers while filling absent providers", () => {
  const catalog = extractCatalogFromModelsDev(fixture.models_dev);
  assert.equal(catalog["fixture-official"].prices.input, 2);
  assert.equal(catalog["fixture-official"].prices.context_tiers[0].cache_read, 1);
  assert.equal(catalog["fixture-unique"].prices.input, 1);
  assert.equal(catalog["fixture-invalid"], undefined);
});

test("LiteLLM fallback converts per-token USD and preserves primary model prices", () => {
  const catalog = mergeLiteLlmCatalog(extractCatalogFromModelsDev(fixture.models_dev), fixture.litellm);
  assert.equal(catalog["fixture-official"].prices.input, 2);
  assert.deepEqual(catalog["fixture-new"].prices, { input: 2, output: 10, cache_read: 0.1,
    context_tiers: [{ above_input_tokens: 200000, input: 4 }] });
  assert.equal(catalog["fixture-reseller"], undefined);
  assert.equal(catalog["fixture-asset"], undefined);
});

test("generated snapshots preserve model aliases and exact upstream provenance", () => {
  const source = renderBuiltinCatalogTs({}, "2026-11-17", ["https://fixture.example/prices.json"]);
  assert.ok(source.includes('"gemini-pro-orchestrator": "gemini-4-carbon"'));
  assert.equal(source.includes('"grok-4.7-build":'), false);
  assert.ok(source.includes('MODEL_PRICING_CATALOG_SOURCES = ["https://fixture.example/prices.json"]'));
});

test("official Fast supplement preserves distinct short/long-context rates and upstream precedence", () => {
  const catalog = applyOfficialPriceSupplements({});
  assert.deepEqual(catalog["grok-4.7-build-fast"].prices, { input: 4, output: 12, cache_read: 1,
    context_tiers: [{ above_input_tokens: 200000, input: 6, output: 18, cache_read: 1.5 }] });
  const upstream = { id: "grok-4.7-build-fast", provider: "xai", prices: { input: 5, output: 15 } };
  assert.equal(applyOfficialPriceSupplements({ "grok-4.7-build-fast": upstream })["grok-4.7-build-fast"], upstream);
});
