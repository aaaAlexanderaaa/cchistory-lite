/**
 * Role: Native pre-launch startup context resolver for OpenAI Codex CLI.
 * Resolves ~/.codex/config.toml + trusted .codex/config.toml, [projects.<dir>].trust_level,
 * profiles, AGENTS.override.md / AGENTS.md / fallback chain from global -> Git root -> cwd
 * with cumulative project_doc_max_bytes (32 KiB default) truncation tracking, MCP servers,
 * agents, skills, and hooks.
 * Excludes history scanning, activity correlation, and CLI formatting.
 */

import path from "node:path";
import type {
  AgentStartupResolution,
  CodexInstructionEntry,
  CodexStartupContext,
  RedactedHookEntry,
  ResolvedMcpServerState,
} from "@cchistory/domain";
import { redactMcpCommand } from "../redaction.js";
import {
  asNonEmptyString,
  asRecord,
  buildRedactedMcpEntry,
  createReadTracker,
  estimateTokens,
  listSkillEntriesInDir,
  normalizeComparablePath,
  readTrackedTextFile,
  readTrackedTomlObject,
  safeReadDir,
  stripMcpResolutionFields,
  type NativeStartupResolverInput,
  type StartupReadTracker,
} from "./shared.js";

const DEFAULT_CODEX_DOC_MAX_BYTES = 32_768;

export async function resolveCodexStartup(
  input: NativeStartupResolverInput,
): Promise<AgentStartupResolution> {
  const tracker = createReadTracker("codex");
  const envCodexHome = input.env.CODEX_HOME?.trim();
  const codexHome = envCodexHome ? path.resolve(envCodexHome) : path.join(input.homeDir, ".codex");

  const globalConfigPath = path.join(codexHome, "config.toml");
  const globalConfig = await readTrackedTomlObject(tracker, globalConfigPath, "codex_config");

  // Determine project trust level from global `[projects."<path>"].trust_level`
  const projectTrustLevel = resolveCodexTrustLevel(globalConfig, input.projectDir, input.gitRoot);
  const projectTrusted = projectTrustLevel === "trusted";

  // Check for project `.codex/config.toml` (closest in ancestor chain)
  let projectConfigPath: string | null = null;
  let projectConfig: Record<string, unknown> | undefined;
  for (let i = input.ancestorDirsRootToCwd.length - 1; i >= 0; i -= 1) {
    const candidate = path.join(input.ancestorDirsRootToCwd[i]!, ".codex", "config.toml");
    const parsed = await readTrackedTomlObject(tracker, candidate, "codex_project_config");
    if (parsed) {
      projectConfigPath = candidate;
      projectConfig = parsed;
      break;
    }
  }

  // Merge non-secret config settings (project applies only when trusted)
  const effectiveLayers = [
    ...(globalConfig ? [{ path: globalConfigPath, data: globalConfig, scope: "user" as const }] : []),
    ...(projectConfig && projectConfigPath && projectTrusted
      ? [{ path: projectConfigPath, data: projectConfig, scope: "project" as const }]
      : []),
  ];

  let effectiveModel: string | undefined;
  let reasoningEffort: string | undefined;
  let approvalPolicy: string | undefined;
  let sandboxMode: string | undefined;
  let projectDocMaxBytes = DEFAULT_CODEX_DOC_MAX_BYTES;
  let fallbackFilenames: string[] = [];
  let activeProfile: string | undefined;
  const profileNames = new Set<string>();

  for (const layer of effectiveLayers) {
    const model = asNonEmptyString(layer.data.model);
    if (model) effectiveModel = model;
    const effort = asNonEmptyString(layer.data.model_reasoning_effort);
    if (effort) reasoningEffort = effort;
    const approval = asNonEmptyString(layer.data.approval_policy);
    if (approval) approvalPolicy = approval;
    const sandbox = asNonEmptyString(layer.data.sandbox_mode);
    if (sandbox) sandboxMode = sandbox;
    if (typeof layer.data.project_doc_max_bytes === "number" && layer.data.project_doc_max_bytes > 0) {
      projectDocMaxBytes = Math.floor(layer.data.project_doc_max_bytes);
    }
    if (Array.isArray(layer.data.project_doc_fallback_filenames)) {
      fallbackFilenames = layer.data.project_doc_fallback_filenames.filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      );
    }
    const profile = asNonEmptyString(layer.data.profile);
    if (profile) activeProfile = profile;
    const profiles = asRecord(layer.data.profiles);
    if (profiles) {
      for (const name of Object.keys(profiles)) profileNames.add(name);
    }
  }

  // Apply active profile scalar overrides if present
  if (activeProfile) {
    for (const layer of effectiveLayers) {
      const profileCfg = asRecord(asRecord(layer.data.profiles)?.[activeProfile]);
      if (!profileCfg) continue;
      const model = asNonEmptyString(profileCfg.model);
      if (model) effectiveModel = model;
      const effort = asNonEmptyString(profileCfg.model_reasoning_effort);
      if (effort) reasoningEffort = effort;
      const approval = asNonEmptyString(profileCfg.approval_policy);
      if (approval) approvalPolicy = approval;
      const sandbox = asNonEmptyString(profileCfg.sandbox_mode);
      if (sandbox) sandboxMode = sandbox;
    }
  }

  // Build exact Codex instruction chain: global -> Git root -> ... -> cwd, with AGENTS.override.md shadowing + 32 KiB cap
  const instructionChain: CodexInstructionEntry[] = [];
  let remainingBudget = projectDocMaxBytes;

  const inspectInstructionDir = async (
    dir: string,
    layer: CodexInstructionEntry["layer"],
    candidates: Array<{ fileName: string; kind: CodexInstructionEntry["kind"] }>,
  ) => {
    const found: Array<{ fileName: string; filePath: string; kind: CodexInstructionEntry["kind"]; sizeBytes: number }> = [];
    for (const cand of candidates) {
      const filePath = path.join(dir, cand.fileName);
      const file = await readTrackedTextFile(tracker, filePath, "codex_instructions");
      if (file && file.sizeBytes > 0) {
        found.push({ fileName: cand.fileName, filePath, kind: cand.kind, sizeBytes: file.sizeBytes });
      }
    }
    if (found.length === 0) return;

    const winner = found[0]!;
    let status: CodexInstructionEntry["status"];
    let includedBytes: number;
    let droppedBytes: number;

    if (remainingBudget <= 0) {
      status = "budget_exhausted";
      includedBytes = 0;
      droppedBytes = winner.sizeBytes;
    } else if (winner.sizeBytes <= remainingBudget) {
      status = "effective";
      includedBytes = winner.sizeBytes;
      droppedBytes = 0;
      remainingBudget -= winner.sizeBytes;
    } else {
      status = "truncated";
      includedBytes = remainingBudget;
      droppedBytes = winner.sizeBytes - remainingBudget;
      remainingBudget = 0;
    }

    instructionChain.push({
      path: winner.filePath,
      directory: dir,
      layer,
      kind: winner.kind,
      status,
      size_bytes: winner.sizeBytes,
      included_bytes: includedBytes,
      dropped_bytes: droppedBytes,
      estimated_tokens: estimateTokens(includedBytes),
    });

    for (let i = 1; i < found.length; i += 1) {
      const shadowed = found[i]!;
      instructionChain.push({
        path: shadowed.filePath,
        directory: dir,
        layer,
        kind: shadowed.kind,
        status: "shadowed",
        shadowed_by: winner.filePath,
        size_bytes: shadowed.sizeBytes,
        included_bytes: 0,
        dropped_bytes: shadowed.sizeBytes,
        estimated_tokens: 0,
      });
    }
  };

  await inspectInstructionDir(codexHome, "global", [
    { fileName: "AGENTS.override.md", kind: "agents_override_md" },
    { fileName: "AGENTS.md", kind: "agents_md" },
  ]);

  const projectCandidates: Array<{ fileName: string; kind: CodexInstructionEntry["kind"] }> = [
    { fileName: "AGENTS.override.md", kind: "agents_override_md" },
    { fileName: "AGENTS.md", kind: "agents_md" },
    ...fallbackFilenames
      .filter((name) => name !== "AGENTS.override.md" && name !== "AGENTS.md")
      .map((fileName) => ({ fileName, kind: "fallback" as const })),
  ];

  for (let i = 0; i < input.ancestorDirsRootToCwd.length; i += 1) {
    const dir = input.ancestorDirsRootToCwd[i]!;
    const layer: CodexInstructionEntry["layer"] =
      i === input.ancestorDirsRootToCwd.length - 1
        ? "cwd"
        : i === 0 && input.gitRoot
          ? "repo_root"
          : "ancestor";
    await inspectInstructionDir(dir, layer, projectCandidates);
  }

  // MCP servers: trusted project config > global config; untrusted project MCPs marked `trust_gated`
  const mcpServers: ResolvedMcpServerState[] = [];
  const winners = new Map<string, string>();

  if (projectConfig && projectConfigPath) {
    const projMcp = asRecord(projectConfig.mcp_servers);
    if (projMcp) {
      for (const [id, val] of Object.entries(projMcp)) {
        const rec = asRecord(val);
        if (!rec) continue;
        const entry = buildRedactedMcpEntry("codex", "project", projectConfigPath, id, rec);
        if (!projectTrusted) {
          mcpServers.push({
            ...entry,
            status: "trust_gated",
            precedence_layer: "project_config",
            disabled_reason: "project_not_trusted_in_global_config",
          });
        } else if (!entry.enabled) {
          mcpServers.push({ ...entry, status: "disabled", precedence_layer: "project_config", disabled_reason: "config_disabled" });
        } else {
          winners.set(id.toLowerCase(), `project_config (${projectConfigPath})`);
          mcpServers.push({ ...entry, status: "effective", precedence_layer: "project_config" });
        }
      }
    }
  }

  if (globalConfig) {
    const userMcp = asRecord(globalConfig.mcp_servers);
    if (userMcp) {
      for (const [id, val] of Object.entries(userMcp)) {
        const rec = asRecord(val);
        if (!rec) continue;
        const entry = buildRedactedMcpEntry("codex", "user", globalConfigPath, id, rec);
        if (!entry.enabled) {
          mcpServers.push({ ...entry, status: "disabled", precedence_layer: "global_config", disabled_reason: "config_disabled" });
          continue;
        }
        const winner = winners.get(id.toLowerCase());
        if (winner) {
          mcpServers.push({ ...entry, status: "shadowed", precedence_layer: "global_config", shadowed_by: winner });
        } else {
          winners.set(id.toLowerCase(), `global_config (${globalConfigPath})`);
          mcpServers.push({ ...entry, status: "effective", precedence_layer: "global_config" });
        }
      }
    }
  }

  // Agents ([agents.*] in TOML + agents/ dirs)
  const agents: CodexStartupContext["agents"] = [];
  for (const layer of effectiveLayers) {
    const tomlAgents = asRecord(layer.data.agents);
    if (!tomlAgents) continue;
    for (const [name, val] of Object.entries(tomlAgents)) {
      const rec = asRecord(val);
      agents.push({
        name,
        source: "toml",
        scope: layer.scope,
        path: layer.path,
        ...(asNonEmptyString(rec?.model) ? { model: asNonEmptyString(rec?.model) } : {}),
        ...(asNonEmptyString(rec?.description) ? { description: asNonEmptyString(rec?.description) } : {}),
      });
    }
  }
  await collectCodexAgentFiles(tracker, path.join(codexHome, "agents"), "user", agents);
  if (input.projectDir) {
    await collectCodexAgentFiles(tracker, path.join(input.projectDir, ".codex", "agents"), "project", agents);
  }

  // Skills (project .codex/skills + .agents/skills > user ~/.codex/skills)
  const skills: CodexStartupContext["skills"] = [];
  const skillWinners = new Map<string, string>();
  const addSkills = (
    items: Array<{ name: string; path: string; description?: string }>,
    scope: "project" | "user",
  ) => {
    for (const item of items) {
      const key = item.name.toLowerCase();
      const winner = skillWinners.get(key);
      if (winner) {
        skills.push({ ...item, scope, status: "shadowed", shadowed_by: winner });
      } else {
        skillWinners.set(key, `${scope} (${item.path})`);
        skills.push({ ...item, scope, status: "effective" });
      }
    }
  };
  if (input.projectDir) {
    addSkills(await listSkillEntriesInDir(tracker, path.join(input.projectDir, ".codex", "skills")), "project");
    addSkills(await listSkillEntriesInDir(tracker, path.join(input.projectDir, ".agents", "skills")), "project");
  }
  addSkills(await listSkillEntriesInDir(tracker, path.join(codexHome, "skills")), "user");

  // Hooks
  const hooks: RedactedHookEntry[] = [];
  for (const layer of effectiveLayers) {
    const hooksObj = asRecord(layer.data.hooks);
    if (!hooksObj) continue;
    for (const [event, val] of Object.entries(hooksObj)) {
      const rec = asRecord(val);
      const cmd = redactMcpCommand(asNonEmptyString(rec?.command) ?? (typeof val === "string" ? val : undefined));
      hooks.push({
        event,
        ...(cmd ? { command: cmd } : {}),
        enabled: rec?.enabled !== false,
        source_path: layer.path,
      });
    }
  }

  const loadedBytes = instructionChain.reduce((sum, entry) => sum + entry.included_bytes, 0);
  const truncatedCount = instructionChain.filter((e) => e.status === "truncated").length;
  const exhaustedCount = instructionChain.filter((e) => e.status === "budget_exhausted").length;

  const native: CodexStartupContext = {
    client: "codex",
    codex_home: codexHome,
    config_cascade: {
      global_config_path: globalConfig ? globalConfigPath : null,
      project_config_path: projectConfigPath,
      project_trust_level: projectTrustLevel,
      project_config_trusted: projectTrusted,
      ...(effectiveModel ? { effective_model: effectiveModel } : {}),
      ...(reasoningEffort ? { model_reasoning_effort: reasoningEffort } : {}),
      ...(approvalPolicy ? { approval_policy: approvalPolicy } : {}),
      ...(sandboxMode ? { sandbox_mode: sandboxMode } : {}),
      project_doc_max_bytes: projectDocMaxBytes,
      project_doc_fallback_filenames: fallbackFilenames,
      ...(activeProfile ? { active_profile: activeProfile } : {}),
      profiles: [...profileNames].sort(),
    },
    instruction_chain: instructionChain,
    mcp_servers: mcpServers,
    agents,
    skills,
    hooks,
    startup_footprint: {
      loaded_bytes: loadedBytes,
      budget_bytes: projectDocMaxBytes,
      budget_used_ratio: projectDocMaxBytes > 0 ? Number((loadedBytes / projectDocMaxBytes).toFixed(4)) : 0,
      estimated_tokens: estimateTokens(loadedBytes),
      truncated_file_count: truncatedCount,
      budget_exhausted_file_count: exhaustedCount,
    },
  };

  return {
    client: "codex",
    display_name: "Codex",
    resolution_tier: "native",
    project_dir: input.projectDir,
    git_root: input.gitRoot,
    files_read: tracker.filesRead,
    mcp_servers: mcpServers.filter((m) => m.status === "effective").map(stripMcpResolutionFields),
    diagnostics: tracker.diagnostics,
    native,
  };
}

function resolveCodexTrustLevel(
  globalConfig: Record<string, unknown> | undefined,
  projectDir: string | null,
  gitRoot: string | null,
): string | null {
  const projects = asRecord(globalConfig?.projects);
  if (!projects || !projectDir) return null;
  const candidates = [projectDir, ...(gitRoot ? [gitRoot] : [])].map(normalizeComparablePath);
  for (const target of candidates) {
    for (const [key, val] of Object.entries(projects)) {
      if (normalizeComparablePath(key) !== target) continue;
      const trust = asNonEmptyString(asRecord(val)?.trust_level);
      if (trust) return trust;
    }
  }
  return null;
}

async function collectCodexAgentFiles(
  tracker: StartupReadTracker,
  dirPath: string,
  scope: "user" | "project",
  out: CodexStartupContext["agents"],
): Promise<void> {
  const entries = await safeReadDir(tracker, dirPath);
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.isFile()) continue;
    const fullPath = path.join(dirPath, entry.name);
    const name = entry.name.replace(/\.(?:toml|md|json)$/iu, "");
    out.push({ name, source: "file", scope, path: fullPath });
  }
}
