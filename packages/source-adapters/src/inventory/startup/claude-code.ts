/**
 * Role: Native pre-launch startup context resolver for Claude Code.
 * Resolves CLAUDE.md / CLAUDE.local.md chains with recursive @path imports,
 * .claude/rules YAML frontmatter paths, settings.json / settings.local.json cascade,
 * installed plugin bundle expansion, and 4-tier MCP precedence (local > project > user > plugin).
 * Excludes history scanning, activity correlation, and CLI formatting.
 */

import path from "node:path";
import type {
  AgentStartupResolution,
  ClaudeCodeStartupContext,
  ClaudeMdEntry,
  ClaudePluginEntry,
  ClaudeRuleEntry,
  McpServerConfigEntry,
  RedactedHookEntry,
  ResolvedMcpServerState,
} from "@cchistory/domain";
import {
  asStringArray,
  collectClaudeRules,
  expandClaudePluginBundle,
  extractClaudeHooks,
  listClaudeSubagents,
  loadClaudeMdEntry,
  resolveNamedEntries,
  resolveSubagentEntries,
} from "./claude-code-helpers.js";
import {
  asNonEmptyString,
  asRecord,
  buildRedactedMcpEntry,
  createReadTracker,
  estimateTokens,
  listSkillEntriesInDir,
  normalizeComparablePath,
  readTrackedJsonObject,
  stripMcpResolutionFields,
  type NativeStartupResolverInput,
} from "./shared.js";

export async function resolveClaudeCodeStartup(
  input: NativeStartupResolverInput,
): Promise<AgentStartupResolution> {
  const tracker = createReadTracker("claude_code");
  const claudeDir = path.join(input.homeDir, ".claude");
  const claudeJsonPath = path.join(input.homeDir, ".claude.json");

  // 1. Settings cascade: user < project < project_local
  const settingsFiles: Array<{ path: string; layer: "user" | "project" | "project_local"; data: Record<string, unknown> }> = [];
  const userSettingsPath = path.join(claudeDir, "settings.json");
  const userSettings = await readTrackedJsonObject(tracker, userSettingsPath, "settings");
  if (userSettings) settingsFiles.push({ path: userSettingsPath, layer: "user", data: userSettings });

  for (const dir of input.ancestorDirsRootToCwd) {
    const projSettingsPath = path.join(dir, ".claude", "settings.json");
    const projSettings = await readTrackedJsonObject(tracker, projSettingsPath, "settings");
    if (projSettings) settingsFiles.push({ path: projSettingsPath, layer: "project", data: projSettings });

    const localSettingsPath = path.join(dir, ".claude", "settings.local.json");
    const localSettings = await readTrackedJsonObject(tracker, localSettingsPath, "settings");
    if (localSettings) settingsFiles.push({ path: localSettingsPath, layer: "project_local", data: localSettings });
  }

  let effectiveModel: string | undefined;
  let permissionMode: string | undefined;
  const allowSet = new Set<string>();
  const askSet = new Set<string>();
  const denySet = new Set<string>();
  const disabledMcpjson = new Set<string>();
  const enabledMcpjson = new Set<string>();
  let enableAllProjectMcp: boolean | undefined;
  const enabledPluginsMap = new Map<string, { enabled: boolean; sourcePath: string }>();
  const hooks: RedactedHookEntry[] = [];

  for (const sf of settingsFiles) {
    const model = asNonEmptyString(sf.data.model);
    if (model) effectiveModel = model;

    const perms = asRecord(sf.data.permissions);
    if (perms) {
      const mode = asNonEmptyString(perms.defaultMode);
      if (mode) permissionMode = mode;
      for (const item of asStringArray(perms.allow)) allowSet.add(item);
      for (const item of asStringArray(perms.ask)) askSet.add(item);
      for (const item of asStringArray(perms.deny)) denySet.add(item);
    }

    for (const name of asStringArray(sf.data.disabledMcpjsonServers)) disabledMcpjson.add(name);
    for (const name of asStringArray(sf.data.enabledMcpjsonServers)) enabledMcpjson.add(name);
    if (typeof sf.data.enableAllProjectMcpServers === "boolean") {
      enableAllProjectMcp = sf.data.enableAllProjectMcpServers;
    }

    const pluginMap = asRecord(sf.data.enabledPlugins);
    if (pluginMap) {
      for (const [pluginName, val] of Object.entries(pluginMap)) {
        if (typeof val === "boolean") {
          enabledPluginsMap.set(pluginName, { enabled: val, sourcePath: sf.path });
        }
      }
    }

    extractClaudeHooks(asRecord(sf.data.hooks), sf.path, hooks);
  }

  // 2. CLAUDE.md / CLAUDE.local.md chain + recursive @imports
  const claudeMdChain: ClaudeMdEntry[] = [];
  if (!input.isolatedHome) {
    const managedCandidates =
      process.platform === "darwin"
        ? ["/Library/Application Support/ClaudeCode/CLAUDE.md"]
        : ["/etc/claude-code/CLAUDE.md"];
    for (const mPath of managedCandidates) {
      const entry = await loadClaudeMdEntry(tracker, mPath, "managed", input.homeDir);
      if (entry) claudeMdChain.push(entry);
    }
  }

  const userClaudeMd = await loadClaudeMdEntry(tracker, path.join(claudeDir, "CLAUDE.md"), "user", input.homeDir);
  if (userClaudeMd) claudeMdChain.push(userClaudeMd);

  for (let i = 0; i < input.ancestorDirsRootToCwd.length; i += 1) {
    const dir = input.ancestorDirsRootToCwd[i]!;
    const isCwd = i === input.ancestorDirsRootToCwd.length - 1;
    const layer = isCwd ? "project" : "ancestor";

    const rootMd = await loadClaudeMdEntry(tracker, path.join(dir, "CLAUDE.md"), layer, input.homeDir);
    if (rootMd) claudeMdChain.push(rootMd);
    const dotMd = await loadClaudeMdEntry(tracker, path.join(dir, ".claude", "CLAUDE.md"), layer, input.homeDir);
    if (dotMd) claudeMdChain.push(dotMd);
    if (isCwd) {
      const localMd = await loadClaudeMdEntry(tracker, path.join(dir, "CLAUDE.local.md"), "project_local", input.homeDir);
      if (localMd) claudeMdChain.push(localMd);
    }
  }

  // 3. .claude/rules/*.md (user + repo ancestor chain) with YAML frontmatter `paths:`
  const rules: ClaudeRuleEntry[] = [];
  await collectClaudeRules(tracker, path.join(claudeDir, "rules"), "user", rules);
  for (const dir of input.ancestorDirsRootToCwd) {
    await collectClaudeRules(tracker, path.join(dir, ".claude", "rules"), "project", rules);
  }

  // 4. Plugins (`installed_plugins.json` + `enabledPlugins`) with bundle expansion
  const plugins: ClaudePluginEntry[] = [];
  const pluginMcpCandidates: Array<{ entry: McpServerConfigEntry; pluginName: string }> = [];
  const pluginSkills: Array<{ name: string; path: string; description?: string }> = [];
  const pluginCommands: Array<{ name: string; path: string; description?: string }> = [];
  const pluginSubagents: Array<{ name: string; path: string; description?: string; model?: string; tools?: string[] }> = [];

  const installedPluginsPath = path.join(claudeDir, "plugins", "installed_plugins.json");
  const installedJson = await readTrackedJsonObject(tracker, installedPluginsPath, "plugins_registry");
  const installedMap = asRecord(installedJson?.plugins) ?? {};
  const allPluginNames = new Set([...Object.keys(installedMap), ...enabledPluginsMap.keys()]);

  for (const pluginName of [...allPluginNames].sort((a, b) => a.localeCompare(b))) {
    const enabledInfo = enabledPluginsMap.get(pluginName);
    const enabled = enabledInfo ? enabledInfo.enabled : true;
    const rawMeta = installedMap[pluginName];
    const metaObj = Array.isArray(rawMeta) ? asRecord(rawMeta[0]) : asRecord(rawMeta);
    const installPath = asNonEmptyString(metaObj?.installPath);
    const version = asNonEmptyString(metaObj?.version);

    const pluginEntry: ClaudePluginEntry = {
      name: pluginName,
      enabled,
      source_path: enabledInfo?.sourcePath ?? installedPluginsPath,
      ...(installPath ? { install_path: installPath } : {}),
      ...(version ? { version } : {}),
      bundled_skills: [],
      bundled_commands: [],
      bundled_agents: [],
      bundled_mcp_servers: [],
      bundled_hooks: [],
    };

    if (enabled && installPath) {
      await expandClaudePluginBundle(
        tracker,
        pluginEntry,
        installPath,
        pluginMcpCandidates,
        pluginSkills,
        pluginCommands,
        pluginSubagents,
        hooks,
      );
    }
    plugins.push(pluginEntry);
  }

  // 5. MCP servers precedence: local (~/.claude.json#projects[dir]) > project (.mcp.json) > user (~/.claude.json) > plugin
  const claudeJson = await readTrackedJsonObject(tracker, claudeJsonPath, "claude_json");
  const localMcpRaw: Array<{ id: string; rec: Record<string, unknown>; path: string }> = [];
  const userMcpRaw: Array<{ id: string; rec: Record<string, unknown>; path: string }> = [];
  const projectMcpRaw: Array<{ id: string; rec: Record<string, unknown>; path: string }> = [];

  if (claudeJson) {
    const userMap = asRecord(claudeJson.mcpServers);
    if (userMap) {
      for (const [id, val] of Object.entries(userMap)) {
        const rec = asRecord(val);
        if (rec) userMcpRaw.push({ id, rec, path: claudeJsonPath });
      }
    }
    const projectsMap = asRecord(claudeJson.projects);
    if (projectsMap && input.projectDir) {
      const targetNorm = normalizeComparablePath(input.projectDir);
      for (const [projKey, projVal] of Object.entries(projectsMap)) {
        if (normalizeComparablePath(projKey) !== targetNorm) continue;
        const projMcp = asRecord(asRecord(projVal)?.mcpServers);
        if (!projMcp) continue;
        for (const [id, val] of Object.entries(projMcp)) {
          const rec = asRecord(val);
          if (rec) localMcpRaw.push({ id, rec, path: claudeJsonPath });
        }
      }
    }
  }

  // Project `.mcp.json` files: closer directory overrides parent repo root
  for (let i = input.ancestorDirsRootToCwd.length - 1; i >= 0; i -= 1) {
    const dir = input.ancestorDirsRootToCwd[i]!;
    const dotMcpPath = path.join(dir, ".mcp.json");
    const dotMcp = await readTrackedJsonObject(tracker, dotMcpPath, "mcp_config");
    const projMap = asRecord(dotMcp?.mcpServers);
    if (projMap) {
      for (const [id, val] of Object.entries(projMap)) {
        const rec = asRecord(val);
        if (rec) projectMcpRaw.push({ id, rec, path: dotMcpPath });
      }
    }
  }

  const mcpServers: ResolvedMcpServerState[] = [];
  const winningMcpById = new Map<string, string>();

  const registerMcpLayer = (
    items: Array<{ id: string; entry: McpServerConfigEntry; layer: string; pluginName?: string }>,
  ) => {
    for (const item of items) {
      const key = item.id.toLowerCase();
      const disabledBySetting = item.layer === "project" && disabledMcpjson.has(item.id);
      if (!item.entry.enabled || disabledBySetting) {
        mcpServers.push({
          ...item.entry,
          enabled: false,
          status: "disabled",
          precedence_layer: item.layer,
          disabled_reason: disabledBySetting ? "disabledMcpjsonServers" : "config_disabled",
          ...(item.pluginName ? { from_plugin: item.pluginName } : {}),
        });
        continue;
      }
      const winner = winningMcpById.get(key);
      if (winner) {
        mcpServers.push({
          ...item.entry,
          status: "shadowed",
          precedence_layer: item.layer,
          shadowed_by: winner,
          ...(item.pluginName ? { from_plugin: item.pluginName } : {}),
        });
      } else {
        winningMcpById.set(key, `${item.layer} (${item.entry.source_path})`);
        mcpServers.push({
          ...item.entry,
          status: "effective",
          precedence_layer: item.layer,
          ...(item.pluginName ? { from_plugin: item.pluginName } : {}),
        });
      }
    }
  };

  registerMcpLayer(
    localMcpRaw.map((x) => ({
      id: x.id,
      entry: buildRedactedMcpEntry("claude_code", "project", x.path, x.id, x.rec),
      layer: "local",
    })),
  );
  registerMcpLayer(
    projectMcpRaw.map((x) => ({
      id: x.id,
      entry: buildRedactedMcpEntry("claude_code", "project", x.path, x.id, x.rec),
      layer: "project",
    })),
  );
  registerMcpLayer(
    userMcpRaw.map((x) => ({
      id: x.id,
      entry: buildRedactedMcpEntry("claude_code", "user", x.path, x.id, x.rec),
      layer: "user",
    })),
  );
  registerMcpLayer(
    pluginMcpCandidates.map((x) => ({
      id: x.entry.server_id,
      entry: x.entry,
      layer: "plugin",
      pluginName: x.pluginName,
    })),
  );

  // 6. Skills, commands, subagents (precedence: project > user > plugin)
  const projSkills = input.projectDir ? await listSkillEntriesInDir(tracker, path.join(input.projectDir, ".claude", "skills")) : [];
  const userSkills = await listSkillEntriesInDir(tracker, path.join(claudeDir, "skills"));
  const skills = resolveNamedEntries(projSkills, userSkills, pluginSkills);

  const projCommands = input.projectDir ? await listSkillEntriesInDir(tracker, path.join(input.projectDir, ".claude", "commands")) : [];
  const userCommands = await listSkillEntriesInDir(tracker, path.join(claudeDir, "commands"));
  const commands = resolveNamedEntries(projCommands, userCommands, pluginCommands);

  const projAgents = input.projectDir ? await listClaudeSubagents(tracker, path.join(input.projectDir, ".claude", "agents")) : [];
  const userAgents = await listClaudeSubagents(tracker, path.join(claudeDir, "agents"));
  const subagents = resolveSubagentEntries(projAgents, userAgents, pluginSubagents);

  // 7. Startup context footprint
  let alwaysBytes = 0;
  let resolvedImports = 0;
  let missingImports = 0;
  for (const entry of claudeMdChain) {
    alwaysBytes += entry.size_bytes;
    for (const imp of entry.imports) {
      if (imp.exists && !imp.cycle) {
        resolvedImports += 1;
        alwaysBytes += imp.size_bytes ?? 0;
      } else if (!imp.exists) {
        missingImports += 1;
      }
    }
  }
  const alwaysRules = rules.filter((r) => r.mode === "always");
  for (const r of alwaysRules) alwaysBytes += r.size_bytes;

  const native: ClaudeCodeStartupContext = {
    client: "claude_code",
    claude_md_chain: claudeMdChain,
    rules,
    settings_cascade: {
      files: settingsFiles.map((f) => ({ path: f.path, layer: f.layer })),
      ...(effectiveModel ? { effective_model: effectiveModel } : {}),
      ...(permissionMode ? { permission_mode: permissionMode } : {}),
      ...(allowSet.size + askSet.size + denySet.size > 0
        ? { permissions: { allow_count: allowSet.size, ask_count: askSet.size, deny_count: denySet.size } }
        : {}),
      disabled_mcpjson_servers: [...disabledMcpjson].sort(),
      enabled_mcpjson_servers: [...enabledMcpjson].sort(),
      ...(enableAllProjectMcp !== undefined ? { enable_all_project_mcp_servers: enableAllProjectMcp } : {}),
    },
    mcp_servers: mcpServers,
    plugins,
    skills,
    commands,
    subagents,
    hooks,
    startup_footprint: {
      always_loaded_bytes: alwaysBytes,
      always_loaded_estimated_tokens: estimateTokens(alwaysBytes),
      claude_md_count: claudeMdChain.length,
      resolved_import_count: resolvedImports,
      missing_import_count: missingImports,
      always_rule_count: alwaysRules.length,
      path_scoped_rule_count: rules.length - alwaysRules.length,
    },
  };

  return {
    client: "claude_code",
    display_name: "Claude Code",
    resolution_tier: "native",
    project_dir: input.projectDir,
    git_root: input.gitRoot,
    files_read: tracker.filesRead,
    mcp_servers: mcpServers.filter((m) => m.status === "effective").map(stripMcpResolutionFields),
    diagnostics: tracker.diagnostics,
    native,
  };
}
