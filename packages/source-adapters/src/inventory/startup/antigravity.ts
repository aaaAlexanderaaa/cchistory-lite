/**
 * Role: Native pre-launch startup context resolver for Google Antigravity, aligned with
 * the Antigravity Customization System docs (rules, skills, plugins, hooks, MCP, JSON manifests).
 * Resolves workspace .agents/.agent/_agents/_agent hierarchy (CWD -> Git root), skills.json /
 * plugins.json manifests, plugin bundle expansion with config.json enablement precedence,
 * 24 KB per-file rule cap, 20,000-token defaultRulesBudget demotion, workflows, hooks, and MCP.
 */

import path from "node:path";
import type {
  AgentStartupResolution,
  AntigravityPluginEntry,
  AntigravityRuleEntry,
  AntigravityStartupContext,
  McpServerConfigEntry,
  RedactedHookEntry,
  ResolvedMcpServerState,
} from "@cchistory/domain";
import {
  expandJsonManifest,
  extractAntigravityHooks,
  extractAntigravityIncludes,
  matchesManifestFilter,
  readPluginManifest,
  resolveSafeRealPath,
} from "./antigravity-helpers.js";
import {
  asNonEmptyString,
  asRecord,
  buildRedactedMcpEntry,
  createReadTracker,
  estimateTokens,
  listSkillEntriesInDir,
  parseMarkdownFrontmatter,
  pathExists,
  readTrackedJsonObject,
  readTrackedTextFile,
  safeReadDir,
  stripMcpResolutionFields,
  type NativeStartupResolverInput,
} from "./shared.js";

const WORKSPACE_DOT_DIRS = [".agents", ".agent", "_agents", "_agent"] as const;
const AGY_PER_FILE_CAP_BYTES = 24_000;
const AGY_RULES_BUDGET_TOKENS = 20_000;

export async function resolveAntigravityStartup(
  input: NativeStartupResolverInput,
): Promise<AgentStartupResolution> {
  const tracker = createReadTracker("antigravity");
  const globalConfigDir = path.join(input.homeDir, ".gemini", "config");
  const globalAgyDir = path.join(input.homeDir, ".gemini", "antigravity");

  const discoveryRoots: AntigravityStartupContext["discovery_roots"] = [];
  const workspaceDotDirs: string[] = [];

  // Walk CWD up to Git root (highest priority first)
  const dirsCwdToRoot = [...input.ancestorDirsRootToCwd].reverse();
  for (const dir of dirsCwdToRoot) {
    for (const dotName of WORKSPACE_DOT_DIRS) {
      const candidate = path.join(dir, dotName);
      if (await pathExists(candidate)) {
        workspaceDotDirs.push(candidate);
        discoveryRoots.push({ path: candidate, kind: "workspace_dot_dir" });
      }
    }
  }
  if (await pathExists(globalConfigDir)) discoveryRoots.push({ path: globalConfigDir, kind: "global_config" });
  if (await pathExists(globalAgyDir)) discoveryRoots.push({ path: globalAgyDir, kind: "global_antigravity" });

  // Read plugin enablement overrides from config.json (config.json beats plugin.json#disabled)
  const pluginEnableOverrides = new Map<string, boolean>();
  for (const cfgPath of [
    path.join(globalAgyDir, "config.json"),
    path.join(globalConfigDir, "config.json"),
  ]) {
    const cfg = await readTrackedJsonObject(tracker, cfgPath, "antigravity_config");
    const pluginsMap = asRecord(cfg?.plugins);
    if (!pluginsMap) continue;
    for (const [dirName, val] of Object.entries(pluginsMap)) {
      const enabled = asRecord(val)?.enabled;
      if (typeof enabled === "boolean") pluginEnableOverrides.set(dirName, enabled);
    }
  }

  // Resolve plugins (workspace dot-dirs > plugins.json manifests > global)
  const plugins: AntigravityPluginEntry[] = [];
  const seenPluginDirs = new Set<string>();
  const pluginSkills: Array<{ name: string; path: string; description?: string; pluginName: string }> = [];
  const pluginRuleFiles: Array<{ path: string; pluginName: string }> = [];
  const pluginMcps: Array<{ entry: McpServerConfigEntry; pluginName: string }> = [];
  const hooks: RedactedHookEntry[] = [];

  const scanPluginContainer = async (
    containerDir: string,
    scope: AntigravityPluginEntry["scope"],
    filter?: { includeOnly?: string[]; exclude?: string[] },
  ) => {
    const entries = await safeReadDir(tracker, containerDir);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      if (!matchesManifestFilter(entry.name, filter)) continue;
      const pluginDir = path.join(containerDir, entry.name);
      const canonicalDir = await resolveSafeRealPath(pluginDir);
      if (seenPluginDirs.has(canonicalDir)) continue;

      const manifest = await readPluginManifest(tracker, pluginDir);
      if (!manifest && scope === "workspace") continue;
      seenPluginDirs.add(canonicalDir);

      const override = pluginEnableOverrides.get(entry.name);
      const manifestDisabled = manifest?.disabled === true;
      const enabled = override !== undefined ? override : !manifestDisabled;
      const enabledSource: AntigravityPluginEntry["enabled_source"] =
        override !== undefined ? "config_json" : manifestDisabled ? "plugin_json" : "default";

      const pluginEntry: AntigravityPluginEntry = {
        dir_name: entry.name,
        display_name: asNonEmptyString(manifest?.name) ?? entry.name,
        path: pluginDir,
        scope,
        enabled,
        enabled_source: enabledSource,
        bundled_skills: [],
        bundled_rules: [],
        bundled_mcp_servers: [],
        bundled_hooks: [],
      };

      if (enabled) {
        const bSkills = await listSkillEntriesInDir(tracker, path.join(pluginDir, "skills"));
        for (const s of bSkills) {
          pluginEntry.bundled_skills.push(s.name);
          pluginSkills.push({ ...s, pluginName: pluginEntry.display_name });
        }
        const bRulesDir = path.join(pluginDir, "rules");
        for (const rEntry of await safeReadDir(tracker, bRulesDir)) {
          if (rEntry.name.startsWith(".") || !rEntry.isFile() || !/\.(?:md|markdown)$/iu.test(rEntry.name)) continue;
          pluginEntry.bundled_rules.push(rEntry.name);
          pluginRuleFiles.push({ path: path.join(bRulesDir, rEntry.name), pluginName: pluginEntry.display_name });
        }
        const bMcpPath = path.join(pluginDir, "mcp_config.json");
        const bMcp = await readTrackedJsonObject(tracker, bMcpPath, "antigravity_plugin_mcp");
        const bServers = asRecord(bMcp?.mcpServers ?? bMcp?.mcp_servers);
        if (bServers) {
          for (const [id, val] of Object.entries(bServers)) {
            const rec = asRecord(val);
            if (!rec) continue;
            pluginEntry.bundled_mcp_servers.push(id);
            pluginMcps.push({
              entry: buildRedactedMcpEntry("antigravity", scope === "workspace" ? "project" : "user", bMcpPath, id, rec),
              pluginName: pluginEntry.display_name,
            });
          }
        }
        const bHooksPath = path.join(pluginDir, "hooks.json");
        const bHooks = await readTrackedJsonObject(tracker, bHooksPath, "antigravity_plugin_hooks");
        if (bHooks) {
          const before = hooks.length;
          extractAntigravityHooks(bHooks, bHooksPath, hooks);
          for (let i = before; i < hooks.length; i += 1) {
            pluginEntry.bundled_hooks.push(`${hooks[i]!.name ?? "hook"}:${hooks[i]!.event}`);
          }
        }
      }

      plugins.push(pluginEntry);
    }
  };

  for (const dotDir of workspaceDotDirs) {
    await scanPluginContainer(path.join(dotDir, "plugins"), "workspace");
    const manifestEntries = await expandJsonManifest(
      tracker,
      path.join(dotDir, "plugins.json"),
      input.homeDir,
      input.gitRoot ?? input.projectDir,
    );
    for (const me of manifestEntries) {
      discoveryRoots.push({ path: me.dir, kind: "manifest_entry" });
      await scanPluginContainer(me.dir, "declared_manifest", me);
    }
  }
  await scanPluginContainer(path.join(globalConfigDir, "plugins"), "global");
  await scanPluginContainer(path.join(globalAgyDir, "plugins"), "global");
  await scanPluginContainer(path.join(input.homeDir, ".gemini", "extensions"), "global");

  // Hooks from workspace dot-dirs and global config
  for (const dotDir of workspaceDotDirs) {
    const hPath = path.join(dotDir, "hooks.json");
    const hObj = await readTrackedJsonObject(tracker, hPath, "antigravity_hooks");
    if (hObj) extractAntigravityHooks(hObj, hPath, hooks);
  }
  for (const hPath of [path.join(globalConfigDir, "hooks.json"), path.join(globalAgyDir, "hooks.json")]) {
    const hObj = await readTrackedJsonObject(tracker, hPath, "antigravity_hooks");
    if (hObj) extractAntigravityHooks(hObj, hPath, hooks);
  }

  // Rules (deduplicated by resolved real path, 24 KB per-file cap, 20,000-token aggregate budget)
  const rules: AntigravityRuleEntry[] = [];
  const seenRulePaths = new Set<string>();
  let remainingRulesTokens = AGY_RULES_BUDGET_TOKENS;

  const addRuleFile = async (
    filePath: string,
    source: AntigravityRuleEntry["source"],
    pluginName?: string,
    allowFrontmatter = false,
  ) => {
    const realPath = await resolveSafeRealPath(filePath);
    if (seenRulePaths.has(realPath)) return;
    const file = await readTrackedTextFile(tracker, filePath, "antigravity_rule");
    if (!file) return;
    seenRulePaths.add(realPath);

    let trigger: AntigravityRuleEntry["trigger"] = "always_on";
    let globs: string[] | undefined;
    if (allowFrontmatter) {
      const fm = parseMarkdownFrontmatter(file.content);
      const rawTrig = fm.scalars.trigger?.toLowerCase();
      if (rawTrig === "model_decision" || rawTrig === "glob" || rawTrig === "manual" || rawTrig === "always_on") {
        trigger = rawTrig;
      }
      if (fm.lists.globs?.length) globs = fm.lists.globs;
      else if (fm.scalars.globs) globs = [fm.scalars.globs];
    }

    const includes = await extractAntigravityIncludes(filePath, file.content, input.homeDir);
    const cappedBytes = Math.min(file.sizeBytes, AGY_PER_FILE_CAP_BYTES);
    const estTokens = estimateTokens(cappedBytes);
    let budgetStatus: AntigravityRuleEntry["budget_status"];
    if (trigger !== "always_on") {
      budgetStatus = "on_demand";
    } else if (estTokens <= remainingRulesTokens) {
      budgetStatus = "inlined";
      remainingRulesTokens -= estTokens;
    } else {
      budgetStatus = "demoted_to_pointer";
    }

    rules.push({
      name: path.basename(filePath),
      path: path.resolve(filePath),
      source,
      ...(pluginName ? { plugin_name: pluginName } : {}),
      trigger,
      ...(globs ? { globs } : {}),
      size_bytes: file.sizeBytes,
      capped_bytes: cappedBytes,
      truncated_by_file_cap: file.sizeBytes > AGY_PER_FILE_CAP_BYTES,
      estimated_tokens: estTokens,
      budget_status: budgetStatus,
      includes,
    });
  };

  for (const dir of dirsCwdToRoot) {
    await addRuleFile(path.join(dir, "GEMINI.md"), "directory_rule");
    await addRuleFile(path.join(dir, "AGENTS.md"), "directory_rule");
  }
  for (const dotDir of workspaceDotDirs) {
    const rDir = path.join(dotDir, "rules");
    for (const entry of await safeReadDir(tracker, rDir)) {
      if (entry.name.startsWith(".") || !entry.isFile() || !/\.(?:md|markdown)$/iu.test(entry.name)) continue;
      await addRuleFile(path.join(rDir, entry.name), "workspace_rules_dir", undefined, true);
    }
  }
  for (const gDir of [path.join(globalConfigDir, "rules"), path.join(globalAgyDir, "rules")]) {
    for (const entry of await safeReadDir(tracker, gDir)) {
      if (entry.name.startsWith(".") || !entry.isFile() || !/\.(?:md|markdown)$/iu.test(entry.name)) continue;
      await addRuleFile(path.join(gDir, entry.name), "global", undefined, true);
    }
  }
  for (const pRule of pluginRuleFiles) {
    await addRuleFile(pRule.path, "plugin", pRule.pluginName, true);
  }

  // Skills precedence: workspace .agents/skills > workspace skills.json > global > plugin
  const skills: AntigravityStartupContext["skills"] = [];
  const skillWinners = new Map<string, string>();
  const addAgySkill = (
    item: { name: string; path: string; description?: string },
    source: AntigravityStartupContext["skills"][number]["source"],
    pluginName?: string,
  ) => {
    const key = item.name.toLowerCase();
    const winner = skillWinners.get(key);
    if (winner) {
      skills.push({ ...item, source, ...(pluginName ? { plugin_name: pluginName } : {}), status: "shadowed", shadowed_by: winner });
    } else {
      skillWinners.set(key, `${source} (${item.path})`);
      skills.push({ ...item, source, ...(pluginName ? { plugin_name: pluginName } : {}), status: "effective" });
    }
  };

  for (const dotDir of workspaceDotDirs) {
    for (const s of await listSkillEntriesInDir(tracker, path.join(dotDir, "skills"))) addAgySkill(s, "workspace");
    const manifestEntries = await expandJsonManifest(
      tracker,
      path.join(dotDir, "skills.json"),
      input.homeDir,
      input.gitRoot ?? input.projectDir,
    );
    for (const me of manifestEntries) {
      discoveryRoots.push({ path: me.dir, kind: "manifest_entry" });
      for (const s of await listSkillEntriesInDir(tracker, me.dir)) {
        if (matchesManifestFilter(s.name, me)) addAgySkill(s, "skills_json");
      }
    }
  }
  for (const s of await listSkillEntriesInDir(tracker, path.join(globalConfigDir, "skills"))) addAgySkill(s, "global");
  for (const s of await listSkillEntriesInDir(tracker, path.join(globalAgyDir, "skills"))) addAgySkill(s, "global");
  for (const s of pluginSkills) addAgySkill(s, "plugin", s.pluginName);

  // Workflows
  const workflows: AntigravityStartupContext["workflows"] = [];
  for (const dotDir of workspaceDotDirs) {
    for (const w of await listSkillEntriesInDir(tracker, path.join(dotDir, "workflows"))) {
      workflows.push({ name: w.name, path: w.path, scope: "workspace" });
    }
  }
  for (const w of await listSkillEntriesInDir(tracker, path.join(globalAgyDir, "global_workflows"))) {
    workflows.push({ name: w.name, path: w.path, scope: "global" });
  }

  // MCP servers: ~/.gemini/config/mcp_config.json + ~/.gemini/antigravity/mcp_config.json + enabled plugin mcp_config.json
  const mcpServers: ResolvedMcpServerState[] = [];
  const mcpWinners = new Map<string, string>();
  const registerMcp = (entry: McpServerConfigEntry, layer: string, pluginName?: string) => {
    const key = entry.server_id.toLowerCase();
    if (!entry.enabled) {
      mcpServers.push({ ...entry, status: "disabled", precedence_layer: layer, disabled_reason: "config_disabled", ...(pluginName ? { from_plugin: pluginName } : {}) });
      return;
    }
    const winner = mcpWinners.get(key);
    if (winner) {
      mcpServers.push({ ...entry, status: "shadowed", precedence_layer: layer, shadowed_by: winner, ...(pluginName ? { from_plugin: pluginName } : {}) });
    } else {
      mcpWinners.set(key, `${layer} (${entry.source_path})`);
      mcpServers.push({ ...entry, status: "effective", precedence_layer: layer, ...(pluginName ? { from_plugin: pluginName } : {}) });
    }
  };

  for (const mcpPath of [
    path.join(globalConfigDir, "mcp_config.json"),
    path.join(globalAgyDir, "mcp_config.json"),
  ]) {
    const parsed = await readTrackedJsonObject(tracker, mcpPath, "antigravity_mcp");
    const servers = asRecord(parsed?.mcpServers ?? parsed?.mcp_servers);
    if (!servers) continue;
    for (const [id, val] of Object.entries(servers)) {
      const rec = asRecord(val);
      if (rec) registerMcp(buildRedactedMcpEntry("antigravity", "user", mcpPath, id, rec), "global_mcp_config");
    }
  }
  for (const pm of pluginMcps) {
    registerMcp(pm.entry, "plugin", pm.pluginName);
  }

  const inlinedRules = rules.filter((r) => r.budget_status === "inlined");
  const inlinedBytes = inlinedRules.reduce((sum, r) => sum + r.capped_bytes, 0);
  const inlinedTokens = inlinedRules.reduce((sum, r) => sum + r.estimated_tokens, 0);

  const native: AntigravityStartupContext = {
    client: "antigravity",
    discovery_roots: discoveryRoots,
    rules,
    plugins,
    skills,
    workflows,
    hooks,
    mcp_servers: mcpServers,
    startup_footprint: {
      per_file_cap_bytes: AGY_PER_FILE_CAP_BYTES,
      aggregate_rules_budget_tokens: AGY_RULES_BUDGET_TOKENS,
      inlined_rules_bytes: inlinedBytes,
      inlined_rules_estimated_tokens: inlinedTokens,
      demoted_rule_count: rules.filter((r) => r.budget_status === "demoted_to_pointer").length,
      truncated_rule_count: rules.filter((r) => r.truncated_by_file_cap).length,
    },
  };

  return {
    client: "antigravity",
    display_name: "Google Antigravity",
    resolution_tier: "native",
    project_dir: input.projectDir,
    git_root: input.gitRoot,
    files_read: tracker.filesRead,
    mcp_servers: mcpServers.filter((m) => m.status === "effective").map(stripMcpResolutionFields),
    diagnostics: tracker.diagnostics,
    native,
  };
}
