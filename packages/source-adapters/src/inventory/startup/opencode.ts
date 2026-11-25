/**
 * Role: Native pre-launch startup context resolver for OpenCode.
 * Resolves the 3-tier `opencode.json[c]` cascade (global < project root < project `.opencode/`),
 * `AGENTS.md` + `CLAUDE.md` fallback (`OPENCODE_DISABLE_CLAUDE_CODE`), literal `instructions`
 * entries, v1 (`mcp.<id>`) and v2 (`mcp.servers.<id>`) MCP configs, agents, skills, commands,
 * and plugins.
 * Excludes history correlation, CLI formatting, and secret value retention.
 */

import path from "node:path";
import type {
  AgentStartupResolution,
  McpServerConfigEntry,
  OpenCodeInstructionEntry,
  OpenCodeStartupContext,
  ResolvedMcpServerState,
} from "@cchistory/domain";
import {
  asNonEmptyString,
  asRecord,
  buildRedactedMcpEntry,
  createReadTracker,
  estimateTokens,
  listSkillEntriesInDir,
  normalizeComparablePath,
  parseMarkdownFrontmatter,
  readTrackedJsonObject,
  readTrackedTextFile,
  safeReadDir,
  stripMcpResolutionFields,
  type NativeStartupResolverInput,
  type StartupReadTracker,
} from "./shared.js";

type ConfigLayer = "global" | "project_root" | "project_local";

export async function resolveOpenCodeStartup(
  input: NativeStartupResolverInput,
): Promise<AgentStartupResolution> {
  const tracker = createReadTracker("opencode");
  const xdgConfigHome = input.env.XDG_CONFIG_HOME?.trim()
    ? path.resolve(input.env.XDG_CONFIG_HOME.trim())
    : path.join(input.homeDir, ".config");
  const globalConfigDir = path.join(xdgConfigHome, "opencode");

  const claudeMdFallbackDisabled = isEnvFlagTrue(input.env.OPENCODE_DISABLE_CLAUDE_CODE)
    || isEnvFlagTrue(input.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT);

  const configFiles: OpenCodeStartupContext["config_cascade"]["files"] = [];
  const loadedConfigs: Array<{ layer: ConfigLayer; path: string; data: Record<string, unknown> }> = [];

  // 1. Global config cascade entry (`opencode.json` / `opencode.jsonc` + optional OPENCODE_CONFIG)
  await loadConfigCandidates(tracker, globalConfigDir, "global", configFiles, loadedConfigs);
  const envConfigPath = input.env.OPENCODE_CONFIG?.trim();
  if (envConfigPath) {
    const resolvedEnvPath = path.resolve(envConfigPath);
    const data = await readTrackedJsonObject(tracker, resolvedEnvPath, "opencode_config", true);
    if (data) {
      configFiles.push({ path: resolvedEnvPath, layer: "global" });
      loadedConfigs.push({ layer: "global", path: resolvedEnvPath, data });
    }
  }

  // 2. Project root and `.opencode/` local configs across ancestor chain
  for (let i = 0; i < input.ancestorDirsRootToCwd.length; i += 1) {
    const dir = input.ancestorDirsRootToCwd[i]!;
    const isRoot = i === 0;
    const rootLayer: ConfigLayer = isRoot ? "project_root" : "project_local";
    await loadConfigCandidates(tracker, dir, rootLayer, configFiles, loadedConfigs);
    await loadConfigCandidates(tracker, path.join(dir, ".opencode"), "project_local", configFiles, loadedConfigs);
  }

  let effectiveModel: string | undefined;
  let smallModel: string | undefined;
  let defaultAgent: string | undefined;
  const providerNames = new Set<string>();
  const instructionPatterns: string[] = [];
  const instructionRefs: Array<{ pattern: string; baseDir: string }> = [];
  const seenPattern = new Set<string>();

  const mcpById = new Map<string, ResolvedMcpServerState>();
  const mcpHistory: ResolvedMcpServerState[] = [];
  const agentsByName = new Map<string, OpenCodeStartupContext["agents"][number]>();
  const agentHistory: OpenCodeStartupContext["agents"] = [];
  const plugins: OpenCodeStartupContext["plugins"] = [];

  for (const cfg of loadedConfigs) {
    const model = asNonEmptyString(cfg.data.model);
    if (model) effectiveModel = model;
    const small = asNonEmptyString(cfg.data.small_model);
    if (small) smallModel = small;
    const defAgent = asNonEmptyString(cfg.data.default_agent);
    if (defAgent) defaultAgent = defAgent;

    const providerObj = asRecord(cfg.data.provider) ?? asRecord(cfg.data.providers);
    if (providerObj) {
      for (const key of Object.keys(providerObj)) {
        if (key.trim()) providerNames.add(key.trim());
      }
    }

    if (Array.isArray(cfg.data.instructions)) {
      const cfgDir = path.dirname(cfg.path);
      for (const item of cfg.data.instructions) {
        if (typeof item !== "string" || !item.trim()) continue;
        const pat = item.trim();
        instructionRefs.push({ pattern: pat, baseDir: cfgDir });
        if (!seenPattern.has(pat)) {
          seenPattern.add(pat);
          instructionPatterns.push(pat);
        }
      }
    }

    const scope: "user" | "project" = cfg.layer === "global" ? "user" : "project";
    extractConfigMcpServers(cfg.data, cfg.layer, scope, cfg.path, mcpById, mcpHistory);
    extractConfigAgents(cfg.data, scope, cfg.path, agentsByName, agentHistory);
    extractConfigPlugins(cfg.data, scope, cfg.path, plugins);
  }

  // Instructions: global AGENTS.md (or ~/.claude/CLAUDE.md fallback), project chain, literal patterns
  const instructions: OpenCodeInstructionEntry[] = [];
  const seenInstructions = new Set<string>();

  await tryAddInstruction(tracker, path.join(globalConfigDir, "AGENTS.md"), "global_agents_md", instructions, seenInstructions);
  if (instructions.length === 0 && !claudeMdFallbackDisabled) {
    await tryAddInstruction(tracker, path.join(input.homeDir, ".claude", "CLAUDE.md"), "claude_md_fallback", instructions, seenInstructions);
  }

  for (const dir of input.ancestorDirsRootToCwd) {
    const addedAgentsMd = await tryAddInstruction(tracker, path.join(dir, "AGENTS.md"), "project_agents_md", instructions, seenInstructions);
    if (!addedAgentsMd && !claudeMdFallbackDisabled) {
      await tryAddInstruction(tracker, path.join(dir, "CLAUDE.md"), "claude_md_fallback", instructions, seenInstructions);
    }
  }

  for (const ref of instructionRefs) {
    if (/[*?{}]/u.test(ref.pattern) || /^[a-z]+:\/\//iu.test(ref.pattern)) continue;
    const expanded = ref.pattern.startsWith("~/")
      ? path.join(input.homeDir, ref.pattern.slice(2))
      : path.isAbsolute(ref.pattern)
        ? ref.pattern
        : path.resolve(ref.baseDir, ref.pattern);
    const added = await tryAddInstruction(tracker, expanded, "config_instructions", instructions, seenInstructions);
    if (!added) {
      const resolved = path.resolve(expanded);
      const norm = normalizeComparablePath(resolved);
      if (!seenInstructions.has(norm)) {
        seenInstructions.add(norm);
        instructions.push({ path: resolved, source: "config_instructions", exists: false, size_bytes: 0, estimated_tokens: 0 });
      }
    }
  }

  // Directory-based agents, skills, commands, plugins
  await collectDirectoryAgents(tracker, globalConfigDir, "user", agentsByName, agentHistory);
  for (const dir of input.ancestorDirsRootToCwd) {
    await collectDirectoryAgents(tracker, path.join(dir, ".opencode"), "project", agentsByName, agentHistory);
  }

  const skillsByName = new Map<string, OpenCodeStartupContext["skills"][number]>();
  const skillHistory: OpenCodeStartupContext["skills"] = [];
  await collectOpenCodeSkills(tracker, path.join(globalConfigDir, "skills"), "user", skillsByName, skillHistory);
  await collectOpenCodeSkills(tracker, path.join(input.homeDir, ".agents", "skills"), "user", skillsByName, skillHistory);
  for (const dir of input.ancestorDirsRootToCwd) {
    await collectOpenCodeSkills(tracker, path.join(dir, ".opencode", "skills"), "project", skillsByName, skillHistory);
    await collectOpenCodeSkills(tracker, path.join(dir, ".agents", "skills"), "project", skillsByName, skillHistory);
  }

  const commands: OpenCodeStartupContext["commands"] = [];
  await collectOpenCodeCommands(tracker, globalConfigDir, "user", commands);
  for (const dir of input.ancestorDirsRootToCwd) {
    await collectOpenCodeCommands(tracker, path.join(dir, ".opencode"), "project", commands);
  }

  await collectDirectoryPlugins(tracker, globalConfigDir, "user", plugins);
  for (const dir of input.ancestorDirsRootToCwd) {
    await collectDirectoryPlugins(tracker, path.join(dir, ".opencode"), "project", plugins);
  }

  const existingInstructions = instructions.filter((entry) => entry.exists !== false);
  const instructionBytes = existingInstructions.reduce((sum, entry) => sum + entry.size_bytes, 0);
  const instructionTokens = existingInstructions.reduce((sum, entry) => sum + entry.estimated_tokens, 0);

  const effectiveMcp: McpServerConfigEntry[] = mcpHistory
    .filter((entry) => entry.status === "effective")
    .map(stripMcpResolutionFields);

  const native: OpenCodeStartupContext = {
    client: "opencode",
    config_cascade: {
      files: configFiles,
      ...(effectiveModel ? { effective_model: effectiveModel } : {}),
      ...(smallModel ? { small_model: smallModel } : {}),
      ...(defaultAgent ? { default_agent: defaultAgent } : {}),
      claude_md_fallback_disabled: claudeMdFallbackDisabled,
      configured_instruction_patterns: instructionPatterns,
      provider_names: [...providerNames].sort((a, b) => a.localeCompare(b)),
    },
    instructions,
    mcp_servers: mcpHistory,
    agents: agentHistory,
    skills: skillHistory,
    commands,
    plugins,
    startup_footprint: {
      instruction_bytes: instructionBytes,
      instruction_estimated_tokens: instructionTokens,
      instruction_file_count: existingInstructions.length,
    },
  };

  return {
    client: "opencode",
    display_name: "OpenCode",
    resolution_tier: "native",
    project_dir: input.projectDir,
    git_root: input.gitRoot,
    files_read: tracker.filesRead,
    mcp_servers: effectiveMcp,
    diagnostics: tracker.diagnostics,
    native,
  };
}

async function loadConfigCandidates(
  tracker: StartupReadTracker,
  dir: string,
  layer: ConfigLayer,
  filesOut: OpenCodeStartupContext["config_cascade"]["files"],
  loadedOut: Array<{ layer: ConfigLayer; path: string; data: Record<string, unknown> }>,
): Promise<void> {
  for (const filename of ["opencode.json", "opencode.jsonc"]) {
    const filePath = path.resolve(dir, filename);
    const data = await readTrackedJsonObject(tracker, filePath, `opencode_config:${layer}`, true);
    if (!data) continue;
    filesOut.push({ path: filePath, layer });
    loadedOut.push({ layer, path: filePath, data });
  }
}

function extractConfigMcpServers(
  config: Record<string, unknown>,
  layer: ConfigLayer,
  scope: "user" | "project",
  sourcePath: string,
  mcpById: Map<string, ResolvedMcpServerState>,
  history: ResolvedMcpServerState[],
): void {
  const mcpRoot = asRecord(config.mcp);
  if (!mcpRoot) return;

  // v2 shape: `mcp.servers.<id>`
  const v2Servers = asRecord(mcpRoot.servers);
  if (v2Servers) {
    for (const [id, rawVal] of Object.entries(v2Servers)) {
      const rec = asRecord(rawVal);
      if (!rec || !id.trim()) continue;
      registerMcpCandidate(id.trim(), rec, layer, scope, sourcePath, mcpById, history);
    }
  }

  // v1 shape: `mcp.<id>` (skip `servers` container when v2 shape was used)
  for (const [id, rawVal] of Object.entries(mcpRoot)) {
    if (id === "servers" && v2Servers) continue;
    const rec = asRecord(rawVal);
    if (!rec || !id.trim()) continue;
    if (!("command" in rec || "url" in rec || "serverUrl" in rec || "type" in rec || "transport" in rec || "enabled" in rec)) {
      continue;
    }
    registerMcpCandidate(id.trim(), rec, layer, scope, sourcePath, mcpById, history);
  }
}

function registerMcpCandidate(
  serverId: string,
  rec: Record<string, unknown>,
  layer: ConfigLayer,
  scope: "user" | "project",
  sourcePath: string,
  mcpById: Map<string, ResolvedMcpServerState>,
  history: ResolvedMcpServerState[],
): void {
  const base = buildRedactedMcpEntry("opencode", scope, sourcePath, serverId, rec);
  const existing = mcpById.get(serverId);
  if (existing && existing.status === "effective") {
    existing.status = "shadowed";
    existing.shadowed_by = `${layer}:${sourcePath}`;
  }
  const state: ResolvedMcpServerState = {
    ...base,
    status: base.enabled ? "effective" : "disabled",
    precedence_layer: layer,
    ...(base.enabled ? {} : { disabled_reason: "disabled_in_config" }),
  };
  mcpById.set(serverId, state);
  history.push(state);
}

function extractConfigAgents(
  config: Record<string, unknown>,
  scope: "user" | "project",
  sourcePath: string,
  byName: Map<string, OpenCodeStartupContext["agents"][number]>,
  history: OpenCodeStartupContext["agents"],
): void {
  const agentMap = asRecord(config.agent) ?? asRecord(config.agents);
  if (!agentMap) return;
  for (const [name, rawVal] of Object.entries(agentMap)) {
    const rec = asRecord(rawVal);
    if (!rec || !name.trim()) continue;
    addAgentEntry(
      {
        name: name.trim(),
        source: "config",
        scope,
        path: sourcePath,
        ...(asNonEmptyString(rec.mode) ? { mode: asNonEmptyString(rec.mode) } : {}),
        ...(asNonEmptyString(rec.model) ? { model: asNonEmptyString(rec.model) } : {}),
        ...(asNonEmptyString(rec.description) ? { description: asNonEmptyString(rec.description) } : {}),
        status: "effective",
      },
      byName,
      history,
    );
  }
}

async function collectDirectoryAgents(
  tracker: StartupReadTracker,
  baseDir: string,
  scope: "user" | "project",
  byName: Map<string, OpenCodeStartupContext["agents"][number]>,
  history: OpenCodeStartupContext["agents"],
): Promise<void> {
  for (const sub of ["agent", "agents"]) {
    const dir = path.join(baseDir, sub);
    const entries = await safeReadDir(tracker, dir);
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(?:md|markdown)$/iu.test(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const file = await readTrackedTextFile(tracker, fullPath, "opencode_agent");
      const fm = file ? parseMarkdownFrontmatter(file.content) : undefined;
      const name = fm?.scalars.name || entry.name.replace(/\.(?:md|markdown)$/iu, "");
      addAgentEntry(
        {
          name,
          source: "directory",
          scope,
          path: fullPath,
          ...(fm?.scalars.mode ? { mode: fm.scalars.mode } : {}),
          ...(fm?.scalars.model ? { model: fm.scalars.model } : {}),
          ...(fm?.scalars.description ? { description: fm.scalars.description } : {}),
          status: "effective",
        },
        byName,
        history,
      );
    }
  }
}

function addAgentEntry(
  entry: OpenCodeStartupContext["agents"][number],
  byName: Map<string, OpenCodeStartupContext["agents"][number]>,
  history: OpenCodeStartupContext["agents"],
): void {
  const prev = byName.get(entry.name);
  if (prev && prev.status === "effective") {
    prev.status = "shadowed";
    prev.shadowed_by = entry.path;
  }
  byName.set(entry.name, entry);
  history.push(entry);
}

async function collectOpenCodeSkills(
  tracker: StartupReadTracker,
  dirPath: string,
  scope: "user" | "project",
  byName: Map<string, OpenCodeStartupContext["skills"][number]>,
  history: OpenCodeStartupContext["skills"],
): Promise<void> {
  const found = await listSkillEntriesInDir(tracker, dirPath);
  for (const item of found) {
    const prev = byName.get(item.name);
    if (prev && prev.status === "effective") {
      prev.status = "shadowed";
      prev.shadowed_by = item.path;
    }
    const entry: OpenCodeStartupContext["skills"][number] = {
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

async function collectOpenCodeCommands(
  tracker: StartupReadTracker,
  baseDir: string,
  scope: "user" | "project",
  out: OpenCodeStartupContext["commands"],
): Promise<void> {
  for (const sub of ["command", "commands"]) {
    const dir = path.join(baseDir, sub);
    const entries = await safeReadDir(tracker, dir);
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(?:md|markdown)$/iu.test(entry.name)) continue;
      out.push({
        name: entry.name.replace(/\.(?:md|markdown)$/iu, ""),
        path: path.join(dir, entry.name),
        scope,
      });
    }
  }
}

function extractConfigPlugins(
  config: Record<string, unknown>,
  scope: "user" | "project",
  sourcePath: string,
  out: OpenCodeStartupContext["plugins"],
): void {
  const raw = Array.isArray(config.plugin)
    ? config.plugin
    : Array.isArray(config.plugins)
      ? config.plugins
      : [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push({ name: item.trim(), source: "config", scope, path: sourcePath });
    }
  }
}

async function collectDirectoryPlugins(
  tracker: StartupReadTracker,
  baseDir: string,
  scope: "user" | "project",
  out: OpenCodeStartupContext["plugins"],
): Promise<void> {
  for (const sub of ["plugin", "plugins"]) {
    const dir = path.join(baseDir, sub);
    const entries = await safeReadDir(tracker, dir);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isFile() || entry.isDirectory() || entry.isSymbolicLink()) {
        out.push({
          name: entry.name.replace(/\.(?:js|mjs|cjs|ts)$/iu, ""),
          source: "directory",
          scope,
          path: path.join(dir, entry.name),
        });
      }
    }
  }
}

async function tryAddInstruction(
  tracker: StartupReadTracker,
  filePath: string,
  source: OpenCodeInstructionEntry["source"],
  out: OpenCodeInstructionEntry[],
  seen: Set<string>,
): Promise<boolean> {
  const resolved = path.resolve(filePath);
  const norm = normalizeComparablePath(resolved);
  if (seen.has(norm)) return true;
  const file = await readTrackedTextFile(tracker, resolved, `opencode_instruction:${source}`);
  if (!file) return false;
  seen.add(norm);
  out.push({
    path: resolved,
    source,
    size_bytes: file.sizeBytes,
    estimated_tokens: estimateTokens(file.sizeBytes),
  });
  return true;
}

function isEnvFlagTrue(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
