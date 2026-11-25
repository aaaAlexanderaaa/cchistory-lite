/**
 * Role: Pure domain contracts for per-tool native pre-launch startup context
 * resolution (Claude Code, Codex, Google Antigravity, OpenCode, DeepSeek Harness)
 * paired with a thin shared shell (files read, redacted MCP entries, diagnostics).
 * Excludes filesystem scanning, secret redaction, activity correlation, and rendering.
 */

import type {
  AgentInventoryDiagnostic,
  McpServerConfigEntry,
} from "./agent-inventory.js";

export type AgentStartupResolutionTier = "native" | "basic" | "unsupported";

export interface StartupLoadedFileRef {
  path: string;
  size_bytes: number;
  role: string;
}

export interface RedactedHookEntry {
  name?: string;
  event: string;
  matcher?: string;
  command?: string;
  enabled: boolean;
  source_path: string;
}

export interface ResolvedMcpServerState extends McpServerConfigEntry {
  status: "effective" | "shadowed" | "disabled" | "trust_gated";
  precedence_layer: string;
  shadowed_by?: string;
  disabled_reason?: string;
  from_plugin?: string;
}

/* -------------------------------------------------------------------------- */
/* Claude Code native startup context                                         */
/* -------------------------------------------------------------------------- */

export interface ClaudeMdImportRef {
  raw_ref: string;
  resolved_path: string;
  exists: boolean;
  size_bytes?: number;
  estimated_tokens?: number;
  cycle?: boolean;
  depth: number;
}

export interface ClaudeMdEntry {
  path: string;
  layer: "managed" | "user" | "ancestor" | "project" | "project_local";
  size_bytes: number;
  estimated_tokens: number;
  imports: ClaudeMdImportRef[];
}

export interface ClaudeRuleEntry {
  name: string;
  path: string;
  scope: "user" | "project";
  mode: "always" | "path_scoped";
  paths?: string[];
  size_bytes: number;
  estimated_tokens: number;
}

export interface ClaudePluginEntry {
  name: string;
  enabled: boolean;
  source_path: string;
  install_path?: string;
  version?: string;
  bundled_skills: string[];
  bundled_commands: string[];
  bundled_agents: string[];
  bundled_mcp_servers: string[];
  bundled_hooks: string[];
}

export interface ClaudeSubagentEntry {
  name: string;
  path: string;
  scope: "user" | "project" | "plugin";
  description?: string;
  model?: string;
  tools?: string[];
  status: "effective" | "shadowed";
  shadowed_by?: string;
}

export interface ClaudeSkillOrCommandEntry {
  name: string;
  path: string;
  scope: "user" | "project" | "plugin";
  description?: string;
  status: "effective" | "shadowed";
  shadowed_by?: string;
}

export interface ClaudeCodeStartupContext {
  client: "claude_code";
  claude_md_chain: ClaudeMdEntry[];
  rules: ClaudeRuleEntry[];
  settings_cascade: {
    files: Array<{ path: string; layer: "user" | "project" | "project_local" }>;
    effective_model?: string;
    permission_mode?: string;
    permissions?: { allow_count: number; ask_count: number; deny_count: number };
    disabled_mcpjson_servers: string[];
    enabled_mcpjson_servers: string[];
    enable_all_project_mcp_servers?: boolean;
  };
  mcp_servers: ResolvedMcpServerState[];
  plugins: ClaudePluginEntry[];
  skills: ClaudeSkillOrCommandEntry[];
  commands: ClaudeSkillOrCommandEntry[];
  subagents: ClaudeSubagentEntry[];
  hooks: RedactedHookEntry[];
  startup_footprint: {
    always_loaded_bytes: number;
    always_loaded_estimated_tokens: number;
    claude_md_count: number;
    resolved_import_count: number;
    missing_import_count: number;
    always_rule_count: number;
    path_scoped_rule_count: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Codex native startup context                                               */
/* -------------------------------------------------------------------------- */

export interface CodexInstructionEntry {
  path: string;
  directory: string;
  layer: "global" | "repo_root" | "ancestor" | "cwd";
  kind: "agents_override_md" | "agents_md" | "fallback";
  status: "effective" | "shadowed" | "truncated" | "budget_exhausted";
  shadowed_by?: string;
  size_bytes: number;
  included_bytes: number;
  dropped_bytes: number;
  estimated_tokens: number;
}

export interface CodexStartupContext {
  client: "codex";
  codex_home: string;
  config_cascade: {
    global_config_path: string | null;
    project_config_path: string | null;
    project_trust_level: string | null;
    project_config_trusted: boolean;
    effective_model?: string;
    model_reasoning_effort?: string;
    approval_policy?: string;
    sandbox_mode?: string;
    project_doc_max_bytes: number;
    project_doc_fallback_filenames: string[];
    active_profile?: string;
    profiles: string[];
  };
  instruction_chain: CodexInstructionEntry[];
  mcp_servers: ResolvedMcpServerState[];
  agents: Array<{ name: string; source: "toml" | "file"; scope: "user" | "project"; path: string; model?: string; description?: string }>;
  skills: Array<{ name: string; path: string; scope: "user" | "project"; description?: string; status: "effective" | "shadowed"; shadowed_by?: string }>;
  hooks: RedactedHookEntry[];
  startup_footprint: {
    loaded_bytes: number;
    budget_bytes: number;
    budget_used_ratio: number;
    estimated_tokens: number;
    truncated_file_count: number;
    budget_exhausted_file_count: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Google Antigravity native startup context                                  */
/* -------------------------------------------------------------------------- */

export interface AntigravityRuleEntry {
  name: string;
  path: string;
  source: "directory_rule" | "workspace_rules_dir" | "global" | "plugin";
  plugin_name?: string;
  trigger: "always_on" | "model_decision" | "glob" | "manual";
  globs?: string[];
  size_bytes: number;
  capped_bytes: number;
  truncated_by_file_cap: boolean;
  estimated_tokens: number;
  budget_status: "inlined" | "demoted_to_pointer" | "on_demand";
  includes: Array<{ label: string; raw_ref: string; resolved_path: string; exists: boolean }>;
}

export interface AntigravityPluginEntry {
  dir_name: string;
  display_name: string;
  path: string;
  scope: "workspace" | "global" | "declared_manifest";
  enabled: boolean;
  enabled_source: "config_json" | "plugin_json" | "default";
  bundled_skills: string[];
  bundled_rules: string[];
  bundled_mcp_servers: string[];
  bundled_hooks: string[];
}

export interface AntigravityStartupContext {
  client: "antigravity";
  discovery_roots: Array<{ path: string; kind: "workspace_dot_dir" | "global_config" | "global_antigravity" | "manifest_entry" }>;
  rules: AntigravityRuleEntry[];
  plugins: AntigravityPluginEntry[];
  skills: Array<{
    name: string;
    path: string;
    source: "workspace" | "skills_json" | "global" | "plugin";
    plugin_name?: string;
    description?: string;
    status: "effective" | "shadowed";
    shadowed_by?: string;
  }>;
  workflows: Array<{ name: string; path: string; scope: "workspace" | "global" }>;
  hooks: RedactedHookEntry[];
  mcp_servers: ResolvedMcpServerState[];
  startup_footprint: {
    per_file_cap_bytes: number;
    aggregate_rules_budget_tokens: number;
    inlined_rules_bytes: number;
    inlined_rules_estimated_tokens: number;
    demoted_rule_count: number;
    truncated_rule_count: number;
  };
}

/* -------------------------------------------------------------------------- */
/* OpenCode native startup context                                            */
/* -------------------------------------------------------------------------- */

export interface OpenCodeInstructionEntry {
  path: string;
  source: "global_agents_md" | "project_agents_md" | "claude_md_fallback" | "config_instructions";
  exists?: boolean;
  size_bytes: number;
  estimated_tokens: number;
}

export interface OpenCodeStartupContext {
  client: "opencode";
  config_cascade: {
    files: Array<{ path: string; layer: "global" | "project_root" | "project_local" }>;
    effective_model?: string;
    small_model?: string;
    default_agent?: string;
    claude_md_fallback_disabled: boolean;
    configured_instruction_patterns: string[];
    provider_names: string[];
  };
  instructions: OpenCodeInstructionEntry[];
  mcp_servers: ResolvedMcpServerState[];
  agents: Array<{
    name: string;
    source: "config" | "directory";
    scope: "user" | "project";
    path: string;
    mode?: string;
    model?: string;
    description?: string;
    status: "effective" | "shadowed";
    shadowed_by?: string;
  }>;
  skills: Array<{ name: string; path: string; scope: "user" | "project"; description?: string; status: "effective" | "shadowed"; shadowed_by?: string }>;
  commands: Array<{ name: string; path: string; scope: "user" | "project" }>;
  plugins: Array<{ name: string; source: "config" | "directory"; scope: "user" | "project"; path: string }>;
  startup_footprint: {
    instruction_bytes: number;
    instruction_estimated_tokens: number;
    instruction_file_count: number;
  };
}

/* -------------------------------------------------------------------------- */
/* DeepSeek Harness native startup context                                    */
/* -------------------------------------------------------------------------- */

export interface DeepSeekHarnessStartupContext {
  client: "deepseek_harness";
  dsh_home: string;
  credentials_file_present: boolean;
  profiles: Array<{
    name: string;
    dir: string;
    files: string[];
  }>;
  cordis_layers: Array<{
    path: string;
    layer: "profile" | "user_patch" | "project_dsh" | "settings" | "legacy_config";
    profile_name?: string;
    size_bytes: number;
  }>;
  instructions: Array<{
    path: string;
    layer: "dsh_home" | "ancestor" | "project";
    size_bytes: number;
    estimated_tokens: number;
  }>;
  mcp_servers: ResolvedMcpServerState[];
  skills: Array<{ name: string; path: string; scope: "user" | "project"; description?: string; status: "effective" | "shadowed"; shadowed_by?: string }>;
  subagents: Array<{ name: string; path: string; scope: "user" | "project" }>;
  plugins: Array<{ name: string; path: string; scope: "user" | "project" }>;
  startup_footprint: {
    instruction_bytes: number;
    instruction_estimated_tokens: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Unsupported / basic fallback + shared outer shell                          */
/* -------------------------------------------------------------------------- */

export interface UnsupportedAgentStartupContext {
  client: string;
  supported: false;
  reason: string;
}

export type AgentStartupContext =
  | ClaudeCodeStartupContext
  | CodexStartupContext
  | AntigravityStartupContext
  | OpenCodeStartupContext
  | DeepSeekHarnessStartupContext
  | UnsupportedAgentStartupContext;

export interface AgentStartupResolution {
  client: string;
  display_name: string;
  resolution_tier: AgentStartupResolutionTier;
  project_dir: string | null;
  git_root: string | null;
  files_read: StartupLoadedFileRef[];
  mcp_servers: McpServerConfigEntry[];
  diagnostics: AgentInventoryDiagnostic[];
  native: AgentStartupContext;
}
