/**
 * Role: Native pre-launch startup context resolver for DeepSeek Harness (`dsh`).
 * Resolves `$DSH_HOME` (default `~/.dsh`), profile directories (`profiles/<name>/`),
 * Cordis YAML layers (`cordis.yml`, `cordis.patch.yml`, `settings.yaml`), legacy configs,
 * `@deepseek-ai/dsh-mcp-client` YAML MCP declarations (strictly redacted), `AGENTS.md`
 * instructions, skills, subagents, and plugins.
 * Security boundary: `.credentials.yaml` is checked for existence only and NEVER read.
 * Excludes history correlation, CLI formatting, and secret value retention.
 */

import path from "node:path";
import type {
  AgentStartupResolution,
  DeepSeekHarnessStartupContext,
  McpServerConfigEntry,
  ResolvedMcpServerState,
} from "@cchistory/domain";
import {
  asRecord,
  buildRedactedMcpEntry,
  createReadTracker,
  estimateTextTokens,
  listSkillEntriesInDir,
  pathExists,
  readTrackedJsonObject,
  readTrackedTextFile,
  readTrackedTomlObject,
  safeReadDir,
  stripMcpResolutionFields,
  type NativeStartupResolverInput,
  type StartupReadTracker,
} from "./shared.js";

const CORDIS_FILENAMES = ["cordis.yml", "cordis.yaml", "cordis.patch.yml", "cordis.patch.yaml"];
const SETTINGS_FILENAMES = ["settings.yaml", "settings.yml"];
const LEGACY_JSON_FILENAMES = ["config.json", "mcp.json", "mcp_servers.json"];

export async function resolveDeepSeekHarnessStartup(
  input: NativeStartupResolverInput,
): Promise<AgentStartupResolution> {
  const tracker = createReadTracker("deepseek_harness");
  const dshHome = input.env.DSH_HOME?.trim()
    ? path.resolve(input.env.DSH_HOME.trim())
    : path.join(input.homeDir, ".dsh");

  // Security invariant: check presence only; NEVER read `.credentials.yaml`.
  const credentialsFilePresent = await pathExists(path.join(dshHome, ".credentials.yaml"));

  const profiles: DeepSeekHarnessStartupContext["profiles"] = [];
  const cordisLayers: DeepSeekHarnessStartupContext["cordis_layers"] = [];
  const mcpById = new Map<string, ResolvedMcpServerState>();
  const mcpHistory: ResolvedMcpServerState[] = [];

  // 1. Discover `$DSH_HOME/profiles/<name>/`
  const profilesDir = path.join(dshHome, "profiles");
  const profileEntries = (await safeReadDir(tracker, profilesDir))
    .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of profileEntries) {
    const profileDir = path.join(profilesDir, entry.name);
    const childEntries = (await safeReadDir(tracker, profileDir))
      .filter((child) => child.isFile() && !child.name.startsWith("."))
      .map((child) => child.name)
      .sort((a, b) => a.localeCompare(b));
    profiles.push({ name: entry.name, dir: profileDir, files: childEntries });

    for (const filename of CORDIS_FILENAMES) {
      if (!childEntries.includes(filename)) continue;
      const fullPath = path.join(profileDir, filename);
      const file = await readTrackedTextFile(tracker, fullPath, "dsh_cordis_profile");
      if (!file) continue;
      cordisLayers.push({
        path: fullPath,
        layer: "profile",
        profile_name: entry.name,
        size_bytes: file.sizeBytes,
      });
      extractCordisYamlMcp(file.content, `profile:${entry.name}`, "user", fullPath, mcpById, mcpHistory);
    }

    for (const filename of LEGACY_JSON_FILENAMES) {
      if (!childEntries.includes(filename)) continue;
      const fullPath = path.join(profileDir, filename);
      await extractLegacyJsonMcp(tracker, fullPath, `profile:${entry.name}`, "user", mcpById, mcpHistory);
    }
  }

  // 2. Top-level `$DSH_HOME` Cordis layers, settings, and legacy configs
  for (const filename of CORDIS_FILENAMES) {
    const fullPath = path.join(dshHome, filename);
    const file = await readTrackedTextFile(tracker, fullPath, "dsh_cordis_user");
    if (!file) continue;
    cordisLayers.push({ path: fullPath, layer: "user_patch", size_bytes: file.sizeBytes });
    extractCordisYamlMcp(file.content, "user_patch", "user", fullPath, mcpById, mcpHistory);
  }

  for (const filename of SETTINGS_FILENAMES) {
    const fullPath = path.join(dshHome, filename);
    const file = await readTrackedTextFile(tracker, fullPath, "dsh_settings");
    if (!file) continue;
    cordisLayers.push({ path: fullPath, layer: "settings", size_bytes: file.sizeBytes });
    extractCordisYamlMcp(file.content, "settings", "user", fullPath, mcpById, mcpHistory);
  }

  await extractLegacyConfigsInDir(tracker, dshHome, "legacy_config", "user", cordisLayers, mcpById, mcpHistory);

  // 3. Project `.dsh/` overrides across ancestor chain
  for (const dir of input.ancestorDirsRootToCwd) {
    const projectDshDir = path.join(dir, ".dsh");
    for (const filename of CORDIS_FILENAMES) {
      const fullPath = path.join(projectDshDir, filename);
      const file = await readTrackedTextFile(tracker, fullPath, "dsh_cordis_project");
      if (!file) continue;
      cordisLayers.push({ path: fullPath, layer: "project_dsh", size_bytes: file.sizeBytes });
      extractCordisYamlMcp(file.content, "project_dsh", "project", fullPath, mcpById, mcpHistory);
    }
    await extractLegacyConfigsInDir(tracker, projectDshDir, "project_dsh", "project", cordisLayers, mcpById, mcpHistory);
  }

  // 4. Instructions: `$DSH_HOME/AGENTS.md` + project ancestor chain `AGENTS.md`
  const instructions: DeepSeekHarnessStartupContext["instructions"] = [];
  const homeAgentsMd = path.join(dshHome, "AGENTS.md");
  const homeAgentsFile = await readTrackedTextFile(tracker, homeAgentsMd, "dsh_instruction:dsh_home");
  if (homeAgentsFile) {
    instructions.push({
      path: homeAgentsMd,
      layer: "dsh_home",
      size_bytes: homeAgentsFile.sizeBytes,
      estimated_tokens: estimateTextTokens(homeAgentsFile.content, "deepseek"),
    });
  }
  for (let i = 0; i < input.ancestorDirsRootToCwd.length; i += 1) {
    const dir = input.ancestorDirsRootToCwd[i]!;
    const layer = i === input.ancestorDirsRootToCwd.length - 1 ? "project" : "ancestor";
    const filePath = path.join(dir, "AGENTS.md");
    const file = await readTrackedTextFile(tracker, filePath, `dsh_instruction:${layer}`);
    if (file) {
      instructions.push({
        path: filePath,
        layer,
        size_bytes: file.sizeBytes,
        estimated_tokens: estimateTextTokens(file.content, "deepseek"),
      });
    }
  }

  // 5. Skills, subagents, plugins
  const skillsByName = new Map<string, DeepSeekHarnessStartupContext["skills"][number]>();
  const skillHistory: DeepSeekHarnessStartupContext["skills"] = [];
  await collectDshSkills(tracker, path.join(dshHome, "skills"), "user", skillsByName, skillHistory);
  await collectDshSkills(tracker, path.join(input.homeDir, ".agents", "skills"), "user", skillsByName, skillHistory);
  for (const dir of input.ancestorDirsRootToCwd) {
    await collectDshSkills(tracker, path.join(dir, ".dsh", "skills"), "project", skillsByName, skillHistory);
    await collectDshSkills(tracker, path.join(dir, ".agents", "skills"), "project", skillsByName, skillHistory);
  }

  const subagents: DeepSeekHarnessStartupContext["subagents"] = [];
  await collectNamedDirEntries(tracker, path.join(dshHome, "agents"), "user", subagents);
  for (const dir of input.ancestorDirsRootToCwd) {
    await collectNamedDirEntries(tracker, path.join(dir, ".dsh", "agents"), "project", subagents);
  }

  const plugins: DeepSeekHarnessStartupContext["plugins"] = [];
  await collectNamedDirEntries(tracker, path.join(dshHome, "plugins"), "user", plugins);
  for (const dir of input.ancestorDirsRootToCwd) {
    await collectNamedDirEntries(tracker, path.join(dir, ".dsh", "plugins"), "project", plugins);
  }

  const instructionBytes = instructions.reduce((sum, entry) => sum + entry.size_bytes, 0);
  const instructionTokens = instructions.reduce((sum, entry) => sum + entry.estimated_tokens, 0);
  const effectiveMcp: McpServerConfigEntry[] = mcpHistory
    .filter((entry) => entry.status === "effective")
    .map(stripMcpResolutionFields);

  const native: DeepSeekHarnessStartupContext = {
    client: "deepseek_harness",
    dsh_home: dshHome,
    credentials_file_present: credentialsFilePresent,
    profiles,
    cordis_layers: cordisLayers,
    instructions,
    mcp_servers: mcpHistory,
    skills: skillHistory,
    subagents,
    plugins,
    startup_footprint: {
      instruction_bytes: instructionBytes,
      instruction_estimated_tokens: instructionTokens,
    },
  };

  return {
    client: "deepseek_harness",
    display_name: "DeepSeek Harness",
    resolution_tier: "native",
    project_dir: input.projectDir,
    git_root: input.gitRoot,
    files_read: tracker.filesRead,
    mcp_servers: effectiveMcp,
    diagnostics: tracker.diagnostics,
    native,
  };
}

async function extractLegacyConfigsInDir(
  tracker: StartupReadTracker,
  dir: string,
  layerName: string,
  scope: "user" | "project",
  cordisLayers: DeepSeekHarnessStartupContext["cordis_layers"],
  mcpById: Map<string, ResolvedMcpServerState>,
  mcpHistory: ResolvedMcpServerState[],
): Promise<void> {
  const tomlPath = path.join(dir, "config.toml");
  const tomlObj = await readTrackedTomlObject(tracker, tomlPath, "dsh_legacy_toml");
  if (tomlObj) {
    const fileRef = tracker.filesRead.find((f) => f.path === path.resolve(tomlPath));
    cordisLayers.push({ path: tomlPath, layer: "legacy_config", size_bytes: fileRef?.size_bytes ?? 0 });
    const mcpMap = asRecord(tomlObj.mcp_servers) ?? asRecord(tomlObj.mcpServers);
    if (mcpMap) {
      for (const [id, rawVal] of Object.entries(mcpMap)) {
        const rec = asRecord(rawVal);
        if (rec && id.trim()) {
          registerDshMcp(id.trim(), rec, layerName, scope, tomlPath, mcpById, mcpHistory);
        }
      }
    }
  }

  for (const filename of LEGACY_JSON_FILENAMES) {
    const fullPath = path.join(dir, filename);
    const added = await extractLegacyJsonMcp(tracker, fullPath, layerName, scope, mcpById, mcpHistory);
    if (added) {
      const fileRef = tracker.filesRead.find((f) => f.path === path.resolve(fullPath));
      cordisLayers.push({ path: fullPath, layer: "legacy_config", size_bytes: fileRef?.size_bytes ?? 0 });
    }
  }
}

async function extractLegacyJsonMcp(
  tracker: StartupReadTracker,
  filePath: string,
  layerName: string,
  scope: "user" | "project",
  mcpById: Map<string, ResolvedMcpServerState>,
  mcpHistory: ResolvedMcpServerState[],
): Promise<boolean> {
  const obj = await readTrackedJsonObject(tracker, filePath, "dsh_legacy_json", true);
  if (!obj) return false;
  const mcpMap = asRecord(obj.mcpServers) ?? asRecord(obj.mcp_servers) ?? asRecord(asRecord(obj.mcp)?.servers);
  if (mcpMap) {
    for (const [id, rawVal] of Object.entries(mcpMap)) {
      const rec = asRecord(rawVal);
      if (rec && id.trim()) {
        registerDshMcp(id.trim(), rec, layerName, scope, filePath, mcpById, mcpHistory);
      }
    }
  }
  return true;
}

/**
 * Zero-dep indentation-based YAML extractor for Cordis `@deepseek-ai/dsh-mcp-client`
 * plugin blocks and top-level `mcpServers` / `mcp_servers` maps.
 * Extracts only structural fields (`serverName`, `transport`, `command`, `args`, `url`,
 * `enabled`/`disabled`) and key names of `env`/`headers` — never secret values.
 */
export function extractCordisYamlMcp(
  yamlContent: string,
  layerName: string,
  scope: "user" | "project",
  sourcePath: string,
  mcpById: Map<string, ResolvedMcpServerState>,
  mcpHistory: ResolvedMcpServerState[],
): void {
  const lines = yamlContent.replace(/\r\n/gu, "\n").split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const stripped = stripYamlComment(raw);
    if (!stripped.trim()) continue;
    const indent = countIndent(raw);

    // Match Cordis plugin key: `~?@deepseek-ai/dsh-mcp-client(:instance)?:` or `~?dsh-mcp-client(:instance)?:`
    const keyMatch = /^['"]?(~?(?:@deepseek-ai\/)?dsh-mcp-client(?::[^:'"\s]+)?)['"]?\s*:\s*(.*)$/u.exec(
      stripped.trim(),
    );
    if (keyMatch) {
      const fullKey = keyMatch[1]!;
      const disabledByPrefix = fullKey.startsWith("~");
      const cleanKey = disabledByPrefix ? fullKey.slice(1) : fullKey;
      const suffix = cleanKey.includes(":") ? cleanKey.slice(cleanKey.indexOf(":") + 1).trim() : "";
      const blockEnd = findBlockEnd(lines, i + 1, indent);
      const parsed = parseSimpleYamlBlock(lines.slice(i + 1, blockEnd));
      const serverId = typeof parsed.serverName === "string" && parsed.serverName
        ? parsed.serverName
        : typeof parsed.name === "string" && parsed.name
          ? parsed.name
          : suffix || "dsh-mcp-client";
      if (disabledByPrefix) parsed.disabled = true;
      registerDshMcp(
        serverId,
        parsed,
        layerName,
        scope,
        sourcePath,
        mcpById,
        mcpHistory,
        disabledByPrefix ? "cordis_disabled_prefix" : undefined,
      );
      i = blockEnd - 1;
      continue;
    }

    // Match simple YAML `mcpServers:` or `mcp_servers:` container
    const mcpContainerMatch = /^(mcpServers|mcp_servers)\s*:\s*$/u.exec(stripped.trim());
    if (mcpContainerMatch) {
      const containerEnd = findBlockEnd(lines, i + 1, indent);
      let cursor = i + 1;
      while (cursor < containerEnd) {
        const subRaw = lines[cursor]!;
        const subStripped = stripYamlComment(subRaw);
        if (!subStripped.trim()) {
          cursor += 1;
          continue;
        }
        const subIndent = countIndent(subRaw);
        const subKeyMatch = /^['"]?([^:'"\s]+)['"]?\s*:\s*$/u.exec(subStripped.trim());
        if (!subKeyMatch) {
          cursor += 1;
          continue;
        }
        const entryEnd = findBlockEnd(lines, cursor + 1, subIndent);
        const parsed = parseSimpleYamlBlock(lines.slice(cursor + 1, entryEnd));
        registerDshMcp(subKeyMatch[1]!, parsed, layerName, scope, sourcePath, mcpById, mcpHistory);
        cursor = entryEnd;
      }
      i = containerEnd - 1;
    }
  }
}

function parseSimpleYamlBlock(blockLines: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let baseIndent: number | null = null;
  let activeKey: string | null = null;
  let activeIndent = -1;

  for (const rawLine of blockLines) {
    const cleaned = stripYamlComment(rawLine);
    if (!cleaned.trim()) continue;
    const indent = countIndent(rawLine);
    if (baseIndent === null) baseIndent = indent;

    if (activeKey && indent > activeIndent) {
      const trimmed = cleaned.trim();
      if (trimmed.startsWith("- ")) {
        const list = (Array.isArray(result[activeKey]) ? result[activeKey] : []) as string[];
        list.push(unquote(trimmed.slice(2).trim()));
        result[activeKey] = list;
      } else {
        const nestedKv = /^['"]?([A-Za-z0-9_.-]+)['"]?\s*:/u.exec(trimmed);
        if (nestedKv) {
          const mapObj = (asRecord(result[activeKey]) ?? {}) as Record<string, string>;
          // Record key name only; never store secret value in env/headers maps.
          mapObj[nestedKv[1]!] = "";
          result[activeKey] = mapObj;
        }
      }
      continue;
    }

    activeKey = null;
    if (indent !== baseIndent) continue;

    const kv = /^['"]?([A-Za-z0-9_.-]+)['"]?\s*:\s*(.*)$/u.exec(cleaned.trim());
    if (!kv) continue;
    const key = kv[1]!;
    const rawVal = kv[2]!.trim();
    if (rawVal === "") {
      activeKey = key;
      activeIndent = indent;
      continue;
    }
    if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      result[key] = rawVal
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
      continue;
    }
    if (rawVal === "true") result[key] = true;
    else if (rawVal === "false") result[key] = false;
    else result[key] = unquote(rawVal);
  }

  return result;
}

function registerDshMcp(
  serverId: string,
  rec: Record<string, unknown>,
  layerName: string,
  scope: "user" | "project",
  sourcePath: string,
  mcpById: Map<string, ResolvedMcpServerState>,
  history: ResolvedMcpServerState[],
  explicitDisabledReason?: string,
): void {
  const base = buildRedactedMcpEntry("deepseek_harness", scope, sourcePath, serverId, rec);
  const prev = mcpById.get(serverId);
  if (prev && prev.status === "effective") {
    prev.status = "shadowed";
    prev.shadowed_by = `${layerName}:${sourcePath}`;
  }
  const state: ResolvedMcpServerState = {
    ...base,
    status: base.enabled ? "effective" : "disabled",
    precedence_layer: layerName,
    ...(base.enabled ? {} : { disabled_reason: explicitDisabledReason ?? "disabled_in_config" }),
  };
  mcpById.set(serverId, state);
  history.push(state);
}

async function collectDshSkills(
  tracker: StartupReadTracker,
  dirPath: string,
  scope: "user" | "project",
  byName: Map<string, DeepSeekHarnessStartupContext["skills"][number]>,
  history: DeepSeekHarnessStartupContext["skills"],
): Promise<void> {
  for (const item of await listSkillEntriesInDir(tracker, dirPath)) {
    const prev = byName.get(item.name);
    if (prev?.status === "effective") {
      prev.status = "shadowed";
      prev.shadowed_by = item.path;
    }
    const entry: DeepSeekHarnessStartupContext["skills"][number] = {
      name: item.name,
      path: item.path,
      scope,
      ...(item.description ? { description: item.description } : {}),
      status: "effective",
    };
    byName.set(item.name, entry);
    history.push(entry);
  }
}

async function collectNamedDirEntries(
  tracker: StartupReadTracker,
  dirPath: string,
  scope: "user" | "project",
  out: Array<{ name: string; path: string; scope: "user" | "project" }>,
): Promise<void> {
  for (const entry of await safeReadDir(tracker, dirPath)) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) continue;
    out.push({ name: entry.name.replace(/\.(?:md|markdown|json|yaml|yml|js|ts)$/iu, ""), path: path.join(dirPath, entry.name), scope });
  }
}

function findBlockEnd(lines: string[], startIndex: number, parentIndent: number): number {
  let idx = startIndex;
  while (idx < lines.length) {
    const line = lines[idx]!;
    if (stripYamlComment(line).trim() !== "" && countIndent(line) <= parentIndent) break;
    idx += 1;
  }
  return idx;
}

function countIndent(line: string): number {
  let count = 0;
  while (count < line.length && (line[count] === " " || line[count] === "\t")) count += line[count] === "\t" ? 2 : 1;
  return count;
}

function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "\"" && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/u.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function unquote(value: string): string {
  return (value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))
    ? value.slice(1, -1)
    : value;
}
