/**
 * Role: Per-client read-only discovery orchestration for local AI coding agent configs,
 * MCP server entries, skills, rules, subagent definitions, plugins, and hooks.
 * Excludes low-level file/TOML/redaction I/O (config-io.ts, redaction.ts) and history correlation.
 */

import os from "node:os";
import path from "node:path";
import type {
  AgentConfigScope,
  AgentInventoryClient,
  DiscoveredAgentClientEntry,
  DiscoveredAgentInventory,
} from "@cchistory/domain";
import {
  DEFAULT_MAX_CONFIG_FILE_BYTES,
  addExtension,
  asRecord,
  extractBooleanPluginMap,
  extractMcpServersRecord,
  extractNamedObjectExtensions,
  markConfigured,
  markInstalled,
  normalizeComparablePath,
  pathExists,
  readBoundedTextFile,
  readJsonConfig,
  readTomlConfig,
  recordSingleRuleFile,
  scanExtensionDirectory,
  uniquePaths,
  type InventoryScanContext,
} from "./config-io.js";
import { extractCordisYamlMcp } from "./startup/deepseek-harness.js";
import { stripMcpResolutionFields } from "./startup/shared.js";
import type { ResolvedMcpServerState } from "@cchistory/domain";

export interface ReadAgentConfigInventoryOptions {
  homeDir?: string;
  projectDir?: string;
  env?: NodeJS.ProcessEnv;
  maxFileBytes?: number;
}

const CLIENT_META: ReadonlyArray<{ client: AgentInventoryClient; display_name: string }> = [
  { client: "codex", display_name: "Codex" },
  { client: "claude_code", display_name: "Claude Code" },
  { client: "grok", display_name: "Grok CLI" },
  { client: "antigravity", display_name: "Google Antigravity" },
  { client: "opencode", display_name: "OpenCode" },
  { client: "deepseek_harness", display_name: "DeepSeek Harness" },
  { client: "gemini", display_name: "Gemini CLI" },
];

export async function readAgentConfigInventory(
  options: ReadAgentConfigInventoryOptions = {},
): Promise<DiscoveredAgentInventory> {
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const projectDir = options.projectDir ? path.resolve(options.projectDir) : null;
  // When --home is explicitly overridden without an explicit env map, avoid leaking host env overrides.
  const env: NodeJS.ProcessEnv = options.env ?? (options.homeDir ? {} : process.env);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_CONFIG_FILE_BYTES;

  const ctx: InventoryScanContext = {
    homeDir,
    projectDir,
    env,
    maxFileBytes,
    clients: new Map(
      CLIENT_META.map((meta) => [
        meta.client,
        {
          client: meta.client,
          display_name: meta.display_name,
          installed: false,
          configured: false,
          config_paths: new Set<string>(),
        },
      ]),
    ),
    mcpServers: [],
    mcpSeenKeys: new Set(),
    extensions: [],
    extensionSeenKeys: new Set(),
    diagnostics: [],
  };

  await Promise.all([
    scanCodex(ctx),
    scanClaudeCode(ctx),
    scanGrok(ctx),
    scanAntigravity(ctx),
    scanOpenCode(ctx),
    scanDeepSeekHarness(ctx),
    scanGeminiCli(ctx),
  ]);

  const agents: DiscoveredAgentClientEntry[] = CLIENT_META.map(({ client }) => {
    const acc = ctx.clients.get(client)!;
    return {
      client: acc.client,
      display_name: acc.display_name,
      installed: acc.installed,
      configured: acc.configured,
      config_paths: [...acc.config_paths].sort((a, b) => a.localeCompare(b)),
    };
  });

  ctx.mcpServers.sort(
    (a, b) => a.client.localeCompare(b.client) || a.server_id.localeCompare(b.server_id) || a.scope.localeCompare(b.scope),
  );
  ctx.extensions.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.client.localeCompare(b.client) || a.name.localeCompare(b.name),
  );
  ctx.diagnostics.sort((a, b) => a.client.localeCompare(b.client) || a.path.localeCompare(b.path));

  return {
    home_dir: homeDir,
    project_dir: projectDir,
    agents,
    mcp_servers: ctx.mcpServers,
    extensions: ctx.extensions,
    diagnostics: ctx.diagnostics,
  };
}

async function scanCodex(ctx: InventoryScanContext): Promise<void> {
  const codexRoot = path.join(ctx.homeDir, ".codex");
  if (await pathExists(codexRoot)) markInstalled(ctx, "codex");

  const configPath = path.join(codexRoot, "config.toml");
  const parsed = await readTomlConfig(ctx, "codex", configPath);
  if (parsed) {
    extractMcpServersRecord(ctx, "codex", "user", configPath, asRecord(parsed.mcp_servers));
    extractNamedObjectExtensions(ctx, "codex", "subagent", "user", configPath, asRecord(parsed.agents));
    extractNamedObjectExtensions(ctx, "codex", "hook", "user", configPath, asRecord(parsed.hooks));
  }

  await scanExtensionDirectory(ctx, "codex", "skill", "user", path.join(codexRoot, "skills"));
  await scanExtensionDirectory(ctx, "codex", "subagent", "user", path.join(codexRoot, "agents"));
  await scanExtensionDirectory(ctx, "codex", "rule", "user", path.join(codexRoot, "rules"));
  await scanExtensionDirectory(ctx, "codex", "plugin", "user", path.join(codexRoot, "plugins"));
  await recordSingleRuleFile(ctx, "codex", "user", path.join(codexRoot, "AGENTS.md"));

  if (ctx.projectDir) {
    const projConfig = path.join(ctx.projectDir, ".codex", "config.toml");
    const projParsed = await readTomlConfig(ctx, "codex", projConfig);
    if (projParsed) {
      extractMcpServersRecord(ctx, "codex", "project", projConfig, asRecord(projParsed.mcp_servers));
      extractNamedObjectExtensions(ctx, "codex", "subagent", "project", projConfig, asRecord(projParsed.agents));
    }
    await scanExtensionDirectory(ctx, "codex", "skill", "project", path.join(ctx.projectDir, ".codex", "skills"));
    await scanExtensionDirectory(ctx, "codex", "subagent", "project", path.join(ctx.projectDir, ".codex", "agents"));
    await recordSingleRuleFile(ctx, "codex", "project", path.join(ctx.projectDir, "AGENTS.md"));
  }
}

async function scanClaudeCode(ctx: InventoryScanContext): Promise<void> {
  const claudeDir = path.join(ctx.homeDir, ".claude");
  const claudeJsonPath = path.join(ctx.homeDir, ".claude.json");
  if ((await pathExists(claudeDir)) || (await pathExists(claudeJsonPath))) {
    markInstalled(ctx, "claude_code");
  }

  const claudeJson = await readJsonConfig(ctx, "claude_code", claudeJsonPath);
  if (claudeJson) {
    extractMcpServersRecord(ctx, "claude_code", "user", claudeJsonPath, asRecord(claudeJson.mcpServers));
    const projectsMap = asRecord(claudeJson.projects);
    if (projectsMap) {
      const normalizedProj = ctx.projectDir ? normalizeComparablePath(ctx.projectDir) : null;
      for (const [projKey, projValue] of Object.entries(projectsMap)) {
        if (normalizedProj && normalizeComparablePath(projKey) !== normalizedProj) continue;
        const projRec = asRecord(projValue);
        extractMcpServersRecord(ctx, "claude_code", "project", claudeJsonPath, asRecord(projRec?.mcpServers));
      }
    }
  }

  const settingsPath = path.join(claudeDir, "settings.json");
  const settingsJson = await readJsonConfig(ctx, "claude_code", settingsPath);
  if (settingsJson) {
    extractMcpServersRecord(ctx, "claude_code", "user", settingsPath, asRecord(settingsJson.mcpServers));
    extractBooleanPluginMap(ctx, "claude_code", "user", settingsPath, asRecord(settingsJson.enabledPlugins));
    extractNamedObjectExtensions(ctx, "claude_code", "hook", "user", settingsPath, asRecord(settingsJson.hooks));
  }

  const installedPluginsPath = path.join(claudeDir, "plugins", "installed_plugins.json");
  const installedPlugins = await readJsonConfig(ctx, "claude_code", installedPluginsPath);
  if (installedPlugins) {
    extractNamedObjectExtensions(
      ctx,
      "claude_code",
      "plugin",
      "user",
      installedPluginsPath,
      asRecord(installedPlugins.plugins),
    );
  }

  await scanExtensionDirectory(ctx, "claude_code", "skill", "user", path.join(claudeDir, "skills"));
  await scanExtensionDirectory(ctx, "claude_code", "skill", "user", path.join(claudeDir, "commands"));
  await scanExtensionDirectory(ctx, "claude_code", "subagent", "user", path.join(claudeDir, "agents"));
  await scanExtensionDirectory(ctx, "claude_code", "rule", "user", path.join(claudeDir, "rules"));
  await recordSingleRuleFile(ctx, "claude_code", "user", path.join(claudeDir, "CLAUDE.md"));

  if (ctx.projectDir) {
    const projectMcpPath = path.join(ctx.projectDir, ".mcp.json");
    const projectMcp = await readJsonConfig(ctx, "claude_code", projectMcpPath);
    if (projectMcp) {
      extractMcpServersRecord(ctx, "claude_code", "project", projectMcpPath, asRecord(projectMcp.mcpServers));
    }

    for (const rel of [".claude/settings.json", ".claude/settings.local.json"]) {
      const pSettingsPath = path.join(ctx.projectDir, rel);
      const pSettings = await readJsonConfig(ctx, "claude_code", pSettingsPath);
      if (!pSettings) continue;
      extractMcpServersRecord(ctx, "claude_code", "project", pSettingsPath, asRecord(pSettings.mcpServers));
      extractBooleanPluginMap(ctx, "claude_code", "project", pSettingsPath, asRecord(pSettings.enabledPlugins));
      extractNamedObjectExtensions(ctx, "claude_code", "hook", "project", pSettingsPath, asRecord(pSettings.hooks));
    }

    await scanExtensionDirectory(ctx, "claude_code", "skill", "project", path.join(ctx.projectDir, ".claude", "skills"));
    await scanExtensionDirectory(ctx, "claude_code", "skill", "project", path.join(ctx.projectDir, ".claude", "commands"));
    await scanExtensionDirectory(ctx, "claude_code", "subagent", "project", path.join(ctx.projectDir, ".claude", "agents"));
    await scanExtensionDirectory(ctx, "claude_code", "rule", "project", path.join(ctx.projectDir, ".claude", "rules"));
    await recordSingleRuleFile(ctx, "claude_code", "project", path.join(ctx.projectDir, "CLAUDE.md"));
  }
}

async function scanGrok(ctx: InventoryScanContext): Promise<void> {
  const grokDir = path.join(ctx.homeDir, ".grok");
  if (await pathExists(grokDir)) markInstalled(ctx, "grok");

  const configTomlPath = path.join(grokDir, "config.toml");
  const parsedToml = await readTomlConfig(ctx, "grok", configTomlPath);
  if (parsedToml) {
    extractMcpServersRecord(ctx, "grok", "user", configTomlPath, asRecord(parsedToml.mcp_servers));
    extractMcpServersRecord(ctx, "grok", "user", configTomlPath, asRecord(parsedToml.mcp));
    extractNamedObjectExtensions(ctx, "grok", "subagent", "user", configTomlPath, asRecord(parsedToml.agents));
    extractNamedObjectExtensions(ctx, "grok", "hook", "user", configTomlPath, asRecord(parsedToml.hooks));
  }

  for (const name of ["mcp.json", "settings.json"]) {
    const jsonPath = path.join(grokDir, name);
    const parsedJson = await readJsonConfig(ctx, "grok", jsonPath);
    if (!parsedJson) continue;
    extractMcpServersRecord(ctx, "grok", "user", jsonPath, asRecord(parsedJson.mcpServers ?? parsedJson.mcp_servers));
  }

  await scanExtensionDirectory(ctx, "grok", "skill", "user", path.join(grokDir, "skills"));
  await scanExtensionDirectory(ctx, "grok", "subagent", "user", path.join(grokDir, "agents"));
  await scanExtensionDirectory(ctx, "grok", "rule", "user", path.join(grokDir, "rules"));
  await scanExtensionDirectory(ctx, "grok", "plugin", "user", path.join(grokDir, "plugins"));
  await recordSingleRuleFile(ctx, "grok", "user", path.join(grokDir, "AGENTS.md"));
}

async function scanAntigravity(ctx: InventoryScanContext): Promise<void> {
  const antigravityDir = path.join(ctx.homeDir, ".gemini", "antigravity");
  const geminiConfigMcp = path.join(ctx.homeDir, ".gemini", "config", "mcp_config.json");
  const agyMcp = path.join(antigravityDir, "mcp_config.json");

  if ((await pathExists(antigravityDir)) || (await pathExists(geminiConfigMcp))) {
    markInstalled(ctx, "antigravity");
  }

  for (const mcpPath of [geminiConfigMcp, agyMcp]) {
    const parsed = await readJsonConfig(ctx, "antigravity", mcpPath);
    if (!parsed) continue;
    extractMcpServersRecord(ctx, "antigravity", "user", mcpPath, asRecord(parsed.mcpServers ?? parsed.mcp_servers));
  }

  await scanExtensionDirectory(ctx, "antigravity", "skill", "user", path.join(antigravityDir, "skills"));
  await scanExtensionDirectory(ctx, "antigravity", "skill", "user", path.join(antigravityDir, "global_workflows"));
  await scanExtensionDirectory(ctx, "antigravity", "rule", "user", path.join(antigravityDir, "rules"));
  await scanExtensionDirectory(ctx, "antigravity", "subagent", "user", path.join(antigravityDir, "agents"));
  await scanExtensionDirectory(ctx, "antigravity", "plugin", "user", path.join(antigravityDir, "plugins"));
  await scanExtensionDirectory(ctx, "antigravity", "plugin", "user", path.join(ctx.homeDir, ".gemini", "extensions"));

  if (ctx.projectDir) {
    await scanExtensionDirectory(ctx, "antigravity", "skill", "project", path.join(ctx.projectDir, ".agents", "skills"));
    await scanExtensionDirectory(ctx, "antigravity", "skill", "project", path.join(ctx.projectDir, ".agents", "workflows"));
    await scanExtensionDirectory(ctx, "antigravity", "rule", "project", path.join(ctx.projectDir, ".agents", "rules"));
  }
}

async function scanOpenCode(ctx: InventoryScanContext): Promise<void> {
  const xdgConfig = ctx.env.XDG_CONFIG_HOME?.trim();
  const configDirs = uniquePaths([
    ...(xdgConfig ? [path.join(xdgConfig, "opencode")] : []),
    path.join(ctx.homeDir, ".config", "opencode"),
  ]);
  const dataDir = path.join(ctx.homeDir, ".local", "share", "opencode");

  for (const dir of [...configDirs, dataDir]) {
    if (await pathExists(dir)) markInstalled(ctx, "opencode");
  }

  const userConfigFiles: string[] = [];
  for (const dir of configDirs) {
    userConfigFiles.push(path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc"));
  }
  userConfigFiles.push(path.join(dataDir, "opencode.json"), path.join(dataDir, "opencode.jsonc"));

  for (const filePath of uniquePaths(userConfigFiles)) {
    const parsed = await readJsonConfig(ctx, "opencode", filePath, true);
    if (!parsed) continue;
    await extractOpenCodeConfig(ctx, "user", filePath, parsed);
  }

  for (const dir of configDirs) {
    await scanExtensionDirectory(ctx, "opencode", "skill", "user", path.join(dir, "skills"));
    await scanExtensionDirectory(ctx, "opencode", "subagent", "user", path.join(dir, "agent"));
    await scanExtensionDirectory(ctx, "opencode", "subagent", "user", path.join(dir, "agents"));
    await scanExtensionDirectory(ctx, "opencode", "plugin", "user", path.join(dir, "plugins"));
    await scanExtensionDirectory(ctx, "opencode", "rule", "user", path.join(dir, "rules"));
    await recordSingleRuleFile(ctx, "opencode", "user", path.join(dir, "AGENTS.md"));
  }

  if (ctx.projectDir) {
    for (const fileName of ["opencode.json", "opencode.jsonc"]) {
      const pFile = path.join(ctx.projectDir, fileName);
      const parsed = await readJsonConfig(ctx, "opencode", pFile, true);
      if (!parsed) continue;
      await extractOpenCodeConfig(ctx, "project", pFile, parsed);
    }
    const dotOpencode = path.join(ctx.projectDir, ".opencode");
    for (const fileName of ["opencode.json", "opencode.jsonc"]) {
      const pFile = path.join(dotOpencode, fileName);
      const parsed = await readJsonConfig(ctx, "opencode", pFile, true);
      if (!parsed) continue;
      await extractOpenCodeConfig(ctx, "project", pFile, parsed);
    }
    await scanExtensionDirectory(ctx, "opencode", "skill", "project", path.join(dotOpencode, "skills"));
    await scanExtensionDirectory(ctx, "opencode", "subagent", "project", path.join(dotOpencode, "agent"));
    await scanExtensionDirectory(ctx, "opencode", "subagent", "project", path.join(dotOpencode, "agents"));
    await scanExtensionDirectory(ctx, "opencode", "plugin", "project", path.join(dotOpencode, "plugins"));
  }
}

async function extractOpenCodeConfig(
  ctx: InventoryScanContext,
  scope: AgentConfigScope,
  filePath: string,
  parsed: Record<string, unknown>,
): Promise<void> {
  const mcpRoot = asRecord(parsed.mcp ?? parsed.mcpServers);
  const v2Servers = asRecord(mcpRoot?.servers);
  if (v2Servers) extractMcpServersRecord(ctx, "opencode", scope, filePath, v2Servers);
  if (mcpRoot) {
    const v1Only: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(mcpRoot)) {
      if (key === "servers" && v2Servers) continue;
      v1Only[key] = val;
    }
    extractMcpServersRecord(ctx, "opencode", scope, filePath, v1Only);
  }
  extractNamedObjectExtensions(ctx, "opencode", "subagent", scope, filePath, asRecord(parsed.agent ?? parsed.agents));
  const pluginList = Array.isArray(parsed.plugin)
    ? parsed.plugin
    : Array.isArray(parsed.plugins)
      ? parsed.plugins
      : [];
  for (const item of pluginList) {
    if (typeof item === "string" && item.trim()) {
      addExtension(ctx, { kind: "plugin", name: item.trim(), client: "opencode", scope, enabled: true, source_path: filePath });
    }
  }
  const instructions = Array.isArray(parsed.instructions) ? parsed.instructions : [];
  const configDir = path.dirname(filePath);
  for (const item of instructions) {
    if (typeof item !== "string" || !item.trim()) continue;
    const raw = item.trim();
    if (!/[*?{}]/u.test(raw) && !/^[a-z]+:\/\//iu.test(raw)) {
      const target = raw.startsWith("~/")
        ? path.join(ctx.homeDir, raw.slice(2))
        : path.isAbsolute(raw)
          ? raw
          : path.resolve(configDir, raw);
      if (!(await pathExists(target))) continue;
    }
    addExtension(ctx, { kind: "rule", name: raw, client: "opencode", scope, source_path: filePath });
  }
}

async function scanDeepSeekHarness(ctx: InventoryScanContext): Promise<void> {
  const envHome = ctx.env.DSH_HOME?.trim();
  const roots = uniquePaths([
    ...(envHome ? [path.resolve(envHome)] : []),
    path.join(ctx.homeDir, ".dsh"),
  ]);

  for (const root of roots) {
    if (await pathExists(root)) markInstalled(ctx, "deepseek_harness");

    const tomlPath = path.join(root, "config.toml");
    const parsedToml = await readTomlConfig(ctx, "deepseek_harness", tomlPath);
    if (parsedToml) {
      extractMcpServersRecord(ctx, "deepseek_harness", "user", tomlPath, asRecord(parsedToml.mcp_servers ?? parsedToml.mcp));
      extractNamedObjectExtensions(ctx, "deepseek_harness", "subagent", "user", tomlPath, asRecord(parsedToml.agents));
      extractNamedObjectExtensions(ctx, "deepseek_harness", "hook", "user", tomlPath, asRecord(parsedToml.hooks));
    }

    for (const fileName of ["config.json", "mcp.json", "mcp_servers.json"]) {
      const jsonPath = path.join(root, fileName);
      const parsedJson = await readJsonConfig(ctx, "deepseek_harness", jsonPath);
      if (!parsedJson) continue;
      extractMcpServersRecord(
        ctx,
        "deepseek_harness",
        "user",
        jsonPath,
        asRecord(parsedJson.mcpServers ?? parsedJson.mcp_servers ?? parsedJson.mcp),
      );
      extractNamedObjectExtensions(ctx, "deepseek_harness", "subagent", "user", jsonPath, asRecord(parsedJson.agents));
    }

    await scanExtensionDirectory(ctx, "deepseek_harness", "skill", "user", path.join(root, "skills"));
    await scanExtensionDirectory(ctx, "deepseek_harness", "subagent", "user", path.join(root, "agents"));
    await scanExtensionDirectory(ctx, "deepseek_harness", "rule", "user", path.join(root, "rules"));
    await scanExtensionDirectory(ctx, "deepseek_harness", "plugin", "user", path.join(root, "plugins"));
    await recordSingleRuleFile(ctx, "deepseek_harness", "user", path.join(root, "AGENTS.md"));
    for (const cordisName of ["cordis.yml", "cordis.yaml", "cordis.patch.yml", "cordis.patch.yaml", "settings.yaml", "settings.yml"]) {
      await scanDeepSeekCordisFile(ctx, "user", path.join(root, cordisName));
    }
  }

  if (ctx.projectDir) {
    const projectDsh = path.join(ctx.projectDir, ".dsh");
    for (const cordisName of ["cordis.yml", "cordis.yaml", "cordis.patch.yml", "cordis.patch.yaml"]) {
      await scanDeepSeekCordisFile(ctx, "project", path.join(projectDsh, cordisName));
    }
    const projTomlPath = path.join(projectDsh, "config.toml");
    const projToml = await readTomlConfig(ctx, "deepseek_harness", projTomlPath);
    if (projToml) {
      extractMcpServersRecord(ctx, "deepseek_harness", "project", projTomlPath, asRecord(projToml.mcp_servers ?? projToml.mcp));
    }
    for (const fileName of ["config.json", "mcp.json", "mcp_servers.json"]) {
      const jsonPath = path.join(projectDsh, fileName);
      const parsedJson = await readJsonConfig(ctx, "deepseek_harness", jsonPath);
      if (!parsedJson) continue;
      extractMcpServersRecord(ctx, "deepseek_harness", "project", jsonPath, asRecord(parsedJson.mcpServers ?? parsedJson.mcp_servers ?? parsedJson.mcp));
    }
    await scanExtensionDirectory(ctx, "deepseek_harness", "skill", "project", path.join(projectDsh, "skills"));
    await scanExtensionDirectory(ctx, "deepseek_harness", "subagent", "project", path.join(projectDsh, "agents"));
    await scanExtensionDirectory(ctx, "deepseek_harness", "plugin", "project", path.join(projectDsh, "plugins"));
  }
}

async function scanDeepSeekCordisFile(
  ctx: InventoryScanContext,
  scope: AgentConfigScope,
  cordisPath: string,
): Promise<void> {
  const content = await readBoundedTextFile(ctx, "deepseek_harness", cordisPath);
  if (content === undefined) return;
  markConfigured(ctx, "deepseek_harness", cordisPath);
  const byId = new Map<string, ResolvedMcpServerState>();
  const history: ResolvedMcpServerState[] = [];
  extractCordisYamlMcp(content, scope === "project" ? "project_dsh" : "user_patch", scope, cordisPath, byId, history);
  for (const state of history) {
    const base = stripMcpResolutionFields(state);
    const dedupeKey = `${base.client}\0${base.scope}\0${base.server_id}\0${base.source_path}`;
    if (ctx.mcpSeenKeys.has(dedupeKey)) continue;
    ctx.mcpSeenKeys.add(dedupeKey);
    ctx.mcpServers.push(base);
  }
}

async function scanGeminiCli(ctx: InventoryScanContext): Promise<void> {
  const geminiDir = path.join(ctx.homeDir, ".gemini");
  const settingsPath = path.join(geminiDir, "settings.json");
  if ((await pathExists(settingsPath)) || (await pathExists(path.join(geminiDir, "GEMINI.md")))) {
    markInstalled(ctx, "gemini");
  }
  const settings = await readJsonConfig(ctx, "gemini", settingsPath);
  if (settings) {
    extractMcpServersRecord(ctx, "gemini", "user", settingsPath, asRecord(settings.mcpServers));
  }
  await recordSingleRuleFile(ctx, "gemini", "user", path.join(geminiDir, "GEMINI.md"));
  if (ctx.projectDir) {
    await recordSingleRuleFile(ctx, "gemini", "project", path.join(ctx.projectDir, "GEMINI.md"));
  }
}
