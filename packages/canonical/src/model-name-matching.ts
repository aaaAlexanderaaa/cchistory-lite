/**
 * Role: Resolve catalog names and configured aliases with ccusage-style boundaries,
 * separator normalization and longest-key matching. Owns no rates, I/O or cost arithmetic.
 */
import type { ModelCatalogEntry, ModelPricingMatchKind, UsagePricingConfig } from "@cchistory/domain";

export interface ModelNameMatch {
  entry: ModelCatalogEntry;
  kind: Exclude<ModelPricingMatchKind, "unpriced">;
  aliasKey?: string;
}

interface CatalogName {
  key: string;
  entry: ModelCatalogEntry;
  source: "builtin" | "custom";
  spelling: string;
  comparable: string;
  qualifiers: string;
}

// These words carry model/rate identity through every automatic fallback.
const RATE_QUALIFIERS = new Set([
  "fast", "ultrafast", "flex", "priority", "nitro", "turbo", "free", "batch",
  "premium", "pro", "max", "mini", "nano", "flash", "lite", "heavy",
]);
const TOOL_SUFFIX = /-(?:xhigh|high|medium|low|minimal|thinking|tiered|customtools|preview|latest)$/u;
const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/u;
const ALIAS_HOP_LIMIT = 16;

function normalizeSpelling(value: string): string {
  return value.trim().toLowerCase().replace(/[.@_]/gu, "-");
}

function modelPart(value: string): string {
  return value.slice(value.lastIndexOf("/") + 1);
}

function qualifiers(value: string): string {
  return [...new Set(modelPart(value).split(/[^a-z0-9]+/u).filter(word => RATE_QUALIFIERS.has(word)))].sort().join("|");
}

/** Build is a tool label after a version; grok-build-0.1 retains its family name. */
function withoutToolLabel(value: string): string {
  const words = value.split("-");
  const versionIndex = words.findIndex(word => /^\d+(?:\.\d+)*$/u.test(word));
  return words.filter((word, index) => word !== "build" || versionIndex < 0 || index < versionIndex).join("-");
}

function nameForms(value: string): string[] {
  const full = value.trim().toLowerCase();
  const tails = [full];
  for (let slash = full.indexOf("/"); slash !== -1; slash = full.indexOf("/", slash + 1)) {
    tails.push(full.slice(slash + 1));
  }
  // Nested gateway/provider paths keep the most specific catalog or alias first.
  const forms = new Set([...tails, ...tails.map(withoutToolLabel)]);
  for (const form of [...forms]) {
    let current = form;
    while (true) {
      if (TOOL_SUFFIX.test(current)) current = current.replace(TOOL_SUFFIX, "");
      else if (DATE_SUFFIX.test(current) && /\d/u.test(current.replace(DATE_SUFFIX, ""))) current = current.replace(DATE_SUFFIX, "");
      else break;
      forms.add(current);
    }
  }
  return [...forms];
}

function containsKey(value: string, key: string): boolean {
  let index = value.indexOf(key);
  while (index !== -1) {
    const before = index > 0 ? value[index - 1] : undefined;
    const suffix = value.slice(index + key.length);
    if ((!before || !/[a-z0-9]/u.test(before)) && (!suffix || !/^[a-z0-9]/u.test(suffix))) {
      // A date suffix extends a known version. Other adjacent digits name a new version.
      if (!/\d$/u.test(key) || !/^[-.]\d/u.test(suffix) || /^[-.]\d{8}(?:[^a-z0-9]|$)/u.test(suffix)) return true;
    }
    index = value.indexOf(key, index + 1);
  }
  return false;
}

function pricesKey(entry: ModelCatalogEntry): string {
  const p = entry.prices;
  return JSON.stringify([p.input, p.output, p.cache_read ?? p.input, p.cache_write ?? p.input,
    p.reasoning ?? p.output, p.context_tiers ?? []]);
}

function catalogNames(catalog: Readonly<Record<string, ModelCatalogEntry>>, source: CatalogName["source"]): CatalogName[] {
  return Object.entries(catalog).map(([key, entry]) => {
    const spelling = normalizeSpelling(key);
    return { key, entry, source, spelling, comparable: withoutToolLabel(spelling), qualifiers: qualifiers(spelling) };
  });
}

function literalLookup(catalog: Readonly<Record<string, ModelCatalogEntry>>, key: string): ModelCatalogEntry | undefined {
  return Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : undefined;
}

function chooseEquivalent(names: CatalogName[]): CatalogName | null {
  const custom = names.filter(name => name.source === "custom");
  const choices = custom.length ? custom : names;
  if (new Set(choices.map(name => pricesKey(name.entry))).size > 1) return null;
  return choices.sort((a, b) => a.key.localeCompare(b.key, "en"))[0] ?? null;
}

export function createModelNameMatcher(
  builtinCatalog: Readonly<Record<string, ModelCatalogEntry>>,
  defaultAliases: Readonly<Record<string, string>>,
): (rawModel: string, config?: UsagePricingConfig) => ModelNameMatch | undefined {
  // Fixed catalog metadata is shared; per-request aliases and overrides stay live.
  const builtinNames = catalogNames(builtinCatalog, "builtin");

  return (rawModel, config) => {
    const customCatalog = config?.catalog_overrides ?? {};
    const customAliases = config?.aliases ?? {};
    let names: CatalogName[] | undefined;
    const allNames = () => names ??= [
      ...catalogNames(customCatalog, "custom"),
      ...builtinNames.filter(name => !Object.prototype.hasOwnProperty.call(customCatalog, name.key)),
    ];
    const aliasEntries = (aliases: Readonly<Record<string, string>>) => Object.entries(aliases)
      .filter(([, target]) => target.trim())
      .map(([key, target]) => ({ key, spelling: normalizeSpelling(key), target }));
    const findAlias = (value: string, aliases: Readonly<Record<string, string>>) => {
      if (Object.prototype.hasOwnProperty.call(aliases, value) && aliases[value]?.trim()) return aliases[value];
      for (const form of nameForms(value)) {
        if (Object.prototype.hasOwnProperty.call(aliases, form) && aliases[form]?.trim()) return aliases[form];
      }
      const entries = aliasEntries(aliases);
      for (const form of nameForms(value).map(normalizeSpelling)) {
        // Only the request loses tool labels; a configured key retains its authored scope.
        const exact = entries.filter(entry => entry.spelling === form);
        if (exact.length) return new Set(exact.map(entry => entry.target)).size === 1 ? exact[0]!.target : "";
      }
      // ccusage carries the Fast suffix through an alias; other billing modes use the same rule.
      const carrySuffix = (forms: string[], normalized: boolean) => {
        for (const form of forms) {
          let longest = -1;
          const targets = new Set<string>();
          for (const entry of entries) {
            const prefix = normalized ? entry.spelling : entry.key.trim().toLowerCase();
            if (!form.startsWith(prefix)) continue;
            const extension = form.slice(prefix.length);
            if (!/^[-.@_]/u.test(extension)) continue;
            const suffix = extension.slice(1).split(/[-.@_]/u);
            if (!suffix.length || !suffix.every(word => RATE_QUALIFIERS.has(word))) continue;
            if (prefix.length < longest) continue;
            if (prefix.length > longest) { targets.clear(); longest = prefix.length; }
            const target = entry.target.trim().toLowerCase();
            const targetWords = new Set(qualifiers(normalizeSpelling(target)).split("|"));
            const rest = suffix.filter(word => !targetWords.has(word));
            targets.add(`${target}${rest.length ? `-${rest.join("-")}` : ""}`);
          }
          if (targets.size) return targets.size === 1 ? [...targets][0]! : "";
        }
        return undefined;
      };
      return carrySuffix(nameForms(value), false) ?? carrySuffix(nameForms(value).map(normalizeSpelling), true);
    };

    let current = rawModel.trim().toLowerCase();
    const visited = new Set<string>();
    let usedAlias = false;
    const found = (name: CatalogName, exact = false): ModelNameMatch => ({
      entry: name.entry,
      kind: name.source === "custom" ? "custom" : usedAlias ? "alias" : exact ? "exact" : "normalized",
      aliasKey: name.key,
    });

    for (let hop = 0; hop < ALIAS_HOP_LIMIT; hop++) {
      if (!current || visited.has(current)) return undefined;
      visited.add(current);
      const customTarget = findAlias(current, customAliases);
      if (Object.prototype.hasOwnProperty.call(customAliases, current) && customTarget !== undefined) {
        current = customTarget.trim().toLowerCase(); usedAlias = true; continue;
      }
      const literalCustom = literalLookup(customCatalog, current);
      if (literalCustom) return found({ key: current, entry: literalCustom, source: "custom", spelling: current, comparable: current, qualifiers: "" }, true);
      const literalBuiltin = literalLookup(builtinCatalog, current);
      if (literalBuiltin) return found({ key: current, entry: literalBuiltin, source: "builtin", spelling: current, comparable: current, qualifiers: "" }, true);
      if (customTarget !== undefined) { current = customTarget.trim().toLowerCase(); usedAlias = true; continue; }
      const defaultTarget = findAlias(current, defaultAliases);
      if (defaultTarget !== undefined) { current = defaultTarget.trim().toLowerCase(); usedAlias = true; continue; }

      const literalForms = nameForms(current);
      const required = qualifiers(normalizeSpelling(current));
      // Preserve authored separator spelling before comparing equivalent spellings:
      // models.dev can price model-4.7 and model-4-7 as distinct provider entries.
      for (const form of literalForms) {
        const custom = literalLookup(customCatalog, form);
        if (custom) return found({ key: form, entry: custom, source: "custom", spelling: form, comparable: form, qualifiers: "" });
        const builtin = literalLookup(builtinCatalog, form);
        if (builtin) return found({ key: form, entry: builtin, source: "builtin", spelling: form, comparable: form, qualifiers: "" });
        const normalized = normalizeSpelling(form);
        const exact = allNames().filter(name => name.qualifiers === required &&
          (name.spelling === normalized || name.comparable === normalized));
        if (exact.length) {
          const selected = chooseEquivalent(exact);
          return selected ? found(selected) : undefined;
        }
      }

      const forms = [...new Set(literalForms.map(normalizeSpelling))];
      const candidates = allNames().filter(name => /\d/u.test(name.comparable) && name.qualifiers === required);
      const matchesKey = (form: string, key: string) => {
        // A suffix or version alone carries too little identity for fuzzy pricing.
        const model = modelPart(form);
        if (!/[a-z]/u.test(model) || !/\d/u.test(model)) return false;
        if (containsKey(form, key)) return true;
        if (!containsKey(key, form)) return false;
        // Reverse matching may select a dated release, while specific model/tier extensions stay explicit.
        const rest = key.slice(key.indexOf(form) + form.length);
        return !rest || /^-\d{8}(?:[^a-z0-9]|$)/u.test(rest);
      };
      const rawMatches = candidates.filter(name => literalForms.some(form => matchesKey(form, withoutToolLabel(name.key))));
      const matches = (rawMatches.length ? rawMatches : candidates.filter(name => {
        // Unversioned routing labels use exact matching, as in ccusage's exact-only catalog.
        return forms.some(form => matchesKey(form, name.comparable));
      })).sort((a, b) => b.comparable.length - a.comparable.length || a.key.localeCompare(b.key, "en"));
      if (!matches.length) return undefined;
      const longest = matches[0]!.comparable.length;
      const selected = chooseEquivalent(matches.filter(name => name.comparable.length === longest));
      return selected ? found(selected) : undefined;
    }
    return undefined;
  };
}
