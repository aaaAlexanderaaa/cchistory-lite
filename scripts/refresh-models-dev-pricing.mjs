#!/usr/bin/env node
/**
 * Role: Refresh the bundled models.dev pricing snapshot (`--update-builtin`) or extract
 * a local `cchistory-lite-pricing/v1` base catalog file (`--out <path>`) from models.dev/api.json.
 * Excludes runtime CLI/TUI execution; runs only when explicitly invoked by a user or maintainer.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_API_URL = "https://models.dev/api.json";
// Same immutable LiteLLM revision as ccusage 58866ba (2026-11-17).
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/9a1e3bde9453f9b1316790fc51e6c098d9447d7b/model_prices_and_context_window.json";
const XAI_PRICING_URL = "https://docs.x.ai/developers/pricing";
const GOOGLE_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";
const PROVIDER_PRIORITY = [
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
];

export function extractCatalogFromModelsDev(rawApi) {
  if (!rawApi || typeof rawApi !== "object" || Array.isArray(rawApi)) {
    throw new Error("Expected models.dev api.json root object keyed by provider.");
  }
  const catalog = {};
  const orderedProviders = [
    ...PROVIDER_PRIORITY.filter((id) => Object.prototype.hasOwnProperty.call(rawApi, id)),
    ...Object.keys(rawApi).filter(id => !PROVIDER_PRIORITY.includes(id)).sort(),
  ];

  for (const providerId of orderedProviders) {
    const provider = rawApi[providerId];
    const models = provider && typeof provider === "object" ? provider.models : undefined;
    if (!models || typeof models !== "object") continue;

    for (const [modelKey, spec] of Object.entries(models)) {
      if (!spec || typeof spec !== "object") continue;
      const cost = spec.cost;
      if (!cost || typeof cost !== "object") continue;
      if (typeof cost.input !== "number" && typeof cost.output !== "number") continue;
      if (![cost.input ?? 0, cost.output ?? 0].every(value => Number.isFinite(value) && value >= 0)) continue;

      const bareId = modelKey.includes("/") ? modelKey.split("/").at(-1) : modelKey;
      const normalizedKey = bareId.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(catalog, normalizedKey)) continue;

      const prices = {
        input: roundPrice(cost.input ?? 0),
        output: roundPrice(cost.output ?? 0),
      };
      if (typeof cost.cache_read === "number") prices.cache_read = roundPrice(cost.cache_read);
      if (typeof cost.cache_write === "number") prices.cache_write = roundPrice(cost.cache_write);
      if (typeof cost.reasoning === "number") prices.reasoning = roundPrice(cost.reasoning);
      const tiers = extractContextTiers(cost);
      if (tiers.length) prices.context_tiers = tiers;

      catalog[normalizedKey] = {
        id: bareId,
        provider: providerId,
        prices,
      };
    }
  }
  return catalog;
}

function extractContextTiers(cost) {
  return (Array.isArray(cost.tiers) ? cost.tiers : []).flatMap(entry => {
    if (entry?.tier?.type !== "context" || !Number.isFinite(entry.tier.size) || entry.tier.size < 0) return [];
    const tier = { above_input_tokens: entry.tier.size };
    for (const field of ["input", "output", "cache_read", "cache_write", "reasoning"]) {
      if (Number.isFinite(entry[field]) && entry[field] >= 0) tier[field] = roundPrice(entry[field]);
    }
    return Object.keys(tier).length > 1 ? [tier] : [];
  }).sort((a, b) => a.above_input_tokens - b.above_input_tokens);
}

/** Fill absent models from direct providers; models.dev retains precedence. */
export function mergeLiteLlmCatalog(catalog, raw) {
  const providers = new Set(["openai", "anthropic", "xai", "gemini", "deepseek", "mistral", "cohere_chat"]);
  for (const [key, spec] of Object.entries(raw)) {
    if (!spec || !providers.has(spec.litellm_provider) || spec.mode !== "chat") continue;
    const input = spec.input_cost_per_token;
    const output = spec.output_cost_per_token;
    if (![input, output].every(value => Number.isFinite(value) && value >= 0)) continue;
    const id = key.includes("/") ? key.split("/").at(-1) : key;
    const normalized = id.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(catalog, normalized)) continue;
    const prices = { input: roundPrice(input * 1e6), output: roundPrice(output * 1e6) };
    const fields = { cache_read: "cache_read_input_token_cost", cache_write: "cache_creation_input_token_cost" };
    for (const [target, field] of Object.entries(fields)) {
      if (Number.isFinite(spec[field]) && spec[field] >= 0) prices[target] = roundPrice(spec[field] * 1e6);
    }
    const tiers = [];
    for (const threshold of [128000, 200000, 272000]) {
      const suffix = `_above_${threshold / 1000}k_tokens`;
      const tier = { above_input_tokens: threshold };
      for (const [target, field] of Object.entries({ input: "input_cost_per_token", output: "output_cost_per_token", ...fields })) {
        if (Number.isFinite(spec[field + suffix]) && spec[field + suffix] >= 0) tier[target] = roundPrice(spec[field + suffix] * 1e6);
      }
      if (Object.keys(tier).length > 1) tiers.push(tier);
    }
    if (tiers.length) prices.context_tiers = tiers;
    catalog[normalized] = { id, provider: spec.litellm_provider, prices };
  }
  return catalog;
}

/** Official rates absent from older upstream model snapshots (upstream retains precedence via ??=). */
export function applyOfficialPriceSupplements(catalog) {
  catalog["grok-4.7-build-fast"] ??= {
    id: "grok-4.7-build-fast",
    provider: "xai",
    prices: {
      input: 4, output: 12, cache_read: 1,
      context_tiers: [{ above_input_tokens: 200000, input: 6, output: 18, cache_read: 1.5 }],
    },
  };
  catalog["gemini-4-neon"] ??= {
    id: "gemini-4-neon",
    provider: "google",
    prices: { input: 3, output: 15, cache_read: 0.15 },
  };
  return catalog;
}

function roundPrice(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function renderBuiltinCatalogTs(catalog, fetchedAt, sources = [DEFAULT_API_URL, LITELLM_URL]) {
  const entries = Object.entries(catalog).sort(([left], [right]) => left.localeCompare(right));
  const chunkSize = 8;
  const serializedEntries = [];
  for (let index = 0; index < entries.length; index += chunkSize) {
    const slice = entries.slice(index, index + chunkSize);
    serializedEntries.push(
      slice.map(([key, entry]) => `${JSON.stringify(key)}:${JSON.stringify(entry)}`).join(","),
    );
  }

  return `/**
 * Role: Bundled offline baseline catalog extracted from https://models.dev/api.json
 * with missing direct-provider models from the ccusage-pinned LiteLLM snapshot
 * and official tool-variant supplements.
 * (${fetchedAt}, ${entries.length} priced models) plus default local model aliases.
 * Excludes runtime network fetches and user-specific multipliers (owned by usage-pricing.ts).
 */

import type { ModelCatalogEntry } from "@cchistory/domain";

export const MODEL_PRICING_CATALOG_SNAPSHOT_DATE = ${JSON.stringify(fetchedAt)};
export const MODEL_PRICING_CATALOG_SOURCES = ${JSON.stringify(sources)} as const;

/** Default aliases for tool-internal model IDs (e.g. Antigravity codenames). */
export const DEFAULT_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "gemini-pro-orchestrator": "gemini-4-carbon",
  "gemini-flash-worker-agy": "gemini-4-hydrogen",
  "gemini-pro": "gemini-4-carbon",
  "gemini-flash": "gemini-4-hydrogen",
  "gemini-pro-high": "gemini-4-carbon",
  "gemini-pro-low": "gemini-4-carbon",
  "gemini-3-pro": "gemini-3.1-pro-preview",
  "gemini-3-flash": "gemini-3-flash-preview",
};

const RAW_CATALOG: Record<string, ModelCatalogEntry> = {
${serializedEntries.join(",\n")}
};

export const BUILTIN_MODEL_PRICING_CATALOG: Readonly<Record<string, ModelCatalogEntry>> = RAW_CATALOG;
`;
}

async function main() {
  const args = process.argv.slice(2);
  let inputFile;
  let liteLlmFile;
  let outFile;
  let updateBuiltin = false;
  let url = DEFAULT_API_URL;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--from-file") inputFile = args[++index];
    else if (arg === "--litellm-file") liteLlmFile = args[++index];
    else if (arg === "--out") outFile = args[++index];
    else if (arg === "--update-builtin") updateBuiltin = true;
    else if (arg === "--url") url = args[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/refresh-models-dev-pricing.mjs [--from-file <api.json> | --url <url>] [--litellm-file <prices.json>] [--update-builtin | --out <pricing.json>]");
      return;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!updateBuiltin && !outFile) {
    throw new Error("Specify either --update-builtin or --out <path>.");
  }

  const rawText = inputFile
    ? await readFile(path.resolve(process.cwd(), inputFile), "utf8")
    : await fetch(url).then(async (response) => {
        if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
        return response.text();
      });

  const apiJson = JSON.parse(rawText);
  const catalog = extractCatalogFromModelsDev(apiJson);
  const sources = [inputFile ? DEFAULT_API_URL : url];
  if (liteLlmFile || !inputFile) {
    const text = liteLlmFile ? await readFile(path.resolve(liteLlmFile), "utf8")
      : await fetch(LITELLM_URL).then(response => {
        if (!response.ok) throw new Error(`Failed to fetch LiteLLM: HTTP ${response.status}`);
        return response.text();
      });
    mergeLiteLlmCatalog(catalog, JSON.parse(text));
    sources.push(LITELLM_URL);
  }
  const hadGrokFast = Object.prototype.hasOwnProperty.call(catalog, "grok-4.7-build-fast");
  const hadGeminiNeon = Object.prototype.hasOwnProperty.call(catalog, "gemini-4-neon");
  applyOfficialPriceSupplements(catalog);
  if (!hadGrokFast && Object.prototype.hasOwnProperty.call(catalog, "grok-4.7-build-fast")) sources.push(XAI_PRICING_URL);
  if (!hadGeminiNeon && Object.prototype.hasOwnProperty.call(catalog, "gemini-4-neon")) sources.push(GOOGLE_PRICING_URL);
  const fetchedAt = new Date().toISOString().slice(0, 10);

  if (updateBuiltin) {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const target = path.join(repoRoot, "packages", "canonical", "src", "model-pricing-catalog.ts");
    await writeFile(target, renderBuiltinCatalogTs(catalog, fetchedAt, sources), "utf8");
    console.log(`Updated ${target} (${Object.keys(catalog).length} models, snapshot ${fetchedAt}).`);
  }

  if (outFile) {
    const target = path.resolve(process.cwd(), outFile);
    const payload = {
      schema: "cchistory-lite-pricing/v1",
      snapshot_date: fetchedAt,
      source: inputFile ? path.resolve(process.cwd(), inputFile) : url,
      sources,
      catalog_overrides: catalog,
    };
    await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`Wrote local pricing catalog to ${target} (${Object.keys(catalog).length} models).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
