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

      catalog[normalizedKey] = {
        id: bareId,
        provider: providerId,
        prices,
      };
    }
  }
  return catalog;
}

function roundPrice(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function renderBuiltinCatalogTs(catalog, fetchedAt) {
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
 * (${fetchedAt}, ${entries.length} models across canonical providers) plus default local model aliases.
 * Excludes runtime network fetches and user-specific multipliers (owned by usage-pricing.ts).
 */

import type { ModelCatalogEntry } from "@cchistory/domain";

export const MODEL_PRICING_CATALOG_SNAPSHOT_DATE = ${JSON.stringify(fetchedAt)};

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
  let outFile;
  let updateBuiltin = false;
  let url = DEFAULT_API_URL;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--from-file") inputFile = args[++index];
    else if (arg === "--out") outFile = args[++index];
    else if (arg === "--update-builtin") updateBuiltin = true;
    else if (arg === "--url") url = args[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/refresh-models-dev-pricing.mjs [--from-file <api.json> | --url <url>] [--update-builtin | --out <pricing.json>]");
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
  const fetchedAt = new Date().toISOString().slice(0, 10);

  if (updateBuiltin) {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const target = path.join(repoRoot, "packages", "canonical", "src", "model-pricing-catalog.ts");
    await writeFile(target, renderBuiltinCatalogTs(catalog, fetchedAt), "utf8");
    console.log(`Updated ${target} (${Object.keys(catalog).length} models, snapshot ${fetchedAt}).`);
  }

  if (outFile) {
    const target = path.resolve(process.cwd(), outFile);
    const payload = {
      schema: "cchistory-lite-pricing/v1",
      snapshot_date: fetchedAt,
      source: inputFile ? path.resolve(process.cwd(), inputFile) : url,
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
