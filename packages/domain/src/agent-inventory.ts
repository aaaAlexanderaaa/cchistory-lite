/**
 * Role: Pure domain contracts for read-only AI agent / MCP / extension configuration
 * inventory, lightweight per-session tool usage summaries, and the shared read-only v1
 * multi-host JSON envelope.
 * Excludes filesystem scanning, secret redaction, activity correlation, and CLI rendering.
 */

export const AGENT_INVENTORY_SCHEMA = "cchistory-lite-inventory/v1";
export const DEFAULT_ENVELOPE_STALE_AFTER_SECONDS = 86_400;

export type AgentInventoryClient =
  | "codex"
  | "claude_code"
  | "grok"
  | "antigravity"
  | "opencode"
  | "deepseek_harness"
  | "gemini";

export type McpTransportKind = "stdio" | "http" | "sse" | "unknown";
export type AgentExtensionKind = "skill" | "rule" | "subagent" | "plugin" | "hook";
export type AgentConfigScope = "user" | "project";

export interface SessionToolUsageCount {
  tool_name: string;
  target_server?: string;
  call_count: number;
  last_used_at: string;
}

export interface DiscoveredAgentClientEntry {
  client: AgentInventoryClient;
  display_name: string;
  installed: boolean;
  configured: boolean;
  config_paths: string[];
}

export interface AgentInventoryEntry extends DiscoveredAgentClientEntry {
  active_in_window: boolean | null;
  session_count: number | null;
  last_active_at: string | null;
}

export interface McpServerConfigEntry {
  server_id: string;
  client: AgentInventoryClient;
  scope: AgentConfigScope;
  transport: McpTransportKind;
  command?: string;
  args_count?: number;
  url?: string;
  env_keys: string[];
  header_keys?: string[];
  enabled: boolean;
  source_path: string;
}

export interface McpServerInventoryEntry extends McpServerConfigEntry {
  used_in_window: boolean | null;
  call_count: number | null;
  last_used_at: string | null;
  matched_tool_names?: string[];
}

export interface AgentExtensionEntry {
  id: string;
  kind: AgentExtensionKind;
  name: string;
  client: AgentInventoryClient;
  scope: AgentConfigScope;
  enabled?: boolean;
  source_path: string;
}

export interface AgentInventoryDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  client: AgentInventoryClient | (string & {});
  path: string;
  detail: string;
}

export interface DiscoveredAgentInventory {
  home_dir: string;
  project_dir: string | null;
  agents: DiscoveredAgentClientEntry[];
  mcp_servers: McpServerConfigEntry[];
  extensions: AgentExtensionEntry[];
  diagnostics: AgentInventoryDiagnostic[];
}

export interface AgentInventorySummary {
  agent_count: number;
  installed_agent_count: number;
  configured_agent_count: number;
  active_agent_count: number | null;
  mcp_server_count: number;
  used_mcp_server_count: number | null;
  unused_mcp_server_count: number | null;
  skill_count: number;
  rule_count: number;
  subagent_count: number;
  plugin_count: number;
  hook_count: number;
  extension_count: number;
  diagnostic_count: number;
}

export interface AgentInventoryActivitySummary {
  correlated: boolean;
  window: string;
  since_at: string | null;
  until_at: string;
  total_sessions: number;
  total_tool_calls: number;
  matched_mcp_calls: number;
  unmatched_mcp_tool_names: string[];
}

export interface UnusedMcpServerRef {
  server_id: string;
  client: AgentInventoryClient;
  scope: AgentConfigScope;
  source_path: string;
}

export interface AgentInventoryReport {
  schema: typeof AGENT_INVENTORY_SCHEMA;
  kind: "agent_inventory";
  generated_at: string;
  home_dir: string;
  project_dir: string | null;
  summary: AgentInventorySummary;
  activity: AgentInventoryActivitySummary;
  agents: AgentInventoryEntry[];
  mcp_servers: McpServerInventoryEntry[];
  extensions: AgentExtensionEntry[];
  unused_mcp_servers: UnusedMcpServerRef[];
  diagnostics: AgentInventoryDiagnostic[];
  /** Per-tool native pre-launch startup context resolutions (populated with --dir or --agent). */
  startup_contexts?: import("./agent-startup.js").AgentStartupResolution[];
}

export type ReadOnlyEnvelopeDomain = "ai_agents" | "projects";
export type ReadOnlyEnvelopeStatus = "ok" | "partial" | "error";

export interface ReadOnlyEnvelopeV1<TSummary = Record<string, unknown>, TItem = Record<string, unknown>> {
  schema_version: 1;
  domain: ReadOnlyEnvelopeDomain;
  owner: "cchistory-lite";
  host_id: string;
  generated_at: string;
  stale_after_seconds: number;
  status: ReadOnlyEnvelopeStatus;
  error: string | null;
  summary: TSummary;
  delta: null;
  items: TItem[];
}

export type AgentInventoryEnvelopeItem =
  | ({ item_type: "agent" } & AgentInventoryEntry)
  | ({ item_type: "mcp_server" } & McpServerInventoryEntry)
  | ({ item_type: "extension" } & AgentExtensionEntry)
  | ({ item_type: "startup_context" } & import("./agent-startup.js").AgentStartupResolution);
