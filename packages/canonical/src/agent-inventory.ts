/**
 * Role: Pure canonical correlation of discovered AI agent configs, MCP servers, and
 * extensions against native session tool-call activity over a configurable time window,
 * plus read-only v1 JSON envelope construction.
 * Excludes filesystem scanning, secret redaction, and CLI/TUI formatting.
 */

import {
  AGENT_INVENTORY_SCHEMA,
  DEFAULT_ENVELOPE_STALE_AFTER_SECONDS,
  maxIso,
  type AgentInventoryActivitySummary,
  type AgentInventoryDiagnostic,
  type AgentInventoryEntry,
  type AgentInventoryEnvelopeItem,
  type AgentInventoryReport,
  type AgentInventorySummary,
  type AgentStartupResolution,
  type DiscoveredAgentInventory,
  type McpServerInventoryEntry,
  type ReadOnlyEnvelopeStatus,
  type ReadOnlyEnvelopeV1,
  type SessionProjection,
} from "@cchistory/domain";
import { parseDateOrRelativeStart } from "./usage-time.js";

export const DEFAULT_INVENTORY_WINDOW = "30d";

export interface CorrelateAgentInventoryInput {
  discovered: DiscoveredAgentInventory;
  startupContexts?: readonly AgentStartupResolution[];
  sessions?: readonly SessionProjection[];
  window?: string;
  nowMs?: number;
  skipActivity?: boolean;
}

export interface BuildAgentInventoryEnvelopeOptions {
  hostId: string;
  staleAfterSeconds?: number;
  activityError?: string | null;
}

interface ObservedToolEvent {
  platform: string;
  toolName: string;
  targetSignature?: string;
  count: number;
  lastUsedAt: string;
}

export function correlateAgentInventory(input: CorrelateAgentInventoryInput): AgentInventoryReport {
  const nowMs = input.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const windowLabel = (input.window?.trim() || DEFAULT_INVENTORY_WINDOW);
  const bounds = parseDateOrRelativeStart(windowLabel, { now_ms: nowMs, timezone: "UTC" });
  const afterTs = bounds.after_ts;
  const sinceAt = afterTs !== undefined ? new Date(afterTs).toISOString() : null;

  const mergedMcpConfigs = input.discovered.mcp_servers;
  const mergedDiagnostics = mergeDiagnostics(
    input.discovered.diagnostics,
    input.startupContexts,
  );
  const startupContextsField =
    input.startupContexts !== undefined ? { startup_contexts: [...input.startupContexts] } : {};

  const correlated = !input.skipActivity && input.sessions !== undefined;

  if (!correlated) {
    const agents: AgentInventoryEntry[] = input.discovered.agents.map((agent) => ({
      ...agent,
      active_in_window: null,
      session_count: null,
      last_active_at: null,
    }));
    const mcpServers: McpServerInventoryEntry[] = mergedMcpConfigs.map((server) => ({
      ...server,
      used_in_window: null,
      call_count: null,
      last_used_at: null,
    }));

    return {
      schema: AGENT_INVENTORY_SCHEMA,
      kind: "agent_inventory",
      generated_at: generatedAt,
      home_dir: input.discovered.home_dir,
      project_dir: input.discovered.project_dir,
      summary: buildInventorySummary(agents, mcpServers, input.discovered.extensions, mergedDiagnostics, false),
      activity: {
        correlated: false,
        window: windowLabel,
        since_at: sinceAt,
        until_at: generatedAt,
        total_sessions: 0,
        total_tool_calls: 0,
        matched_mcp_calls: 0,
        unmatched_mcp_tool_names: [],
      },
      agents,
      mcp_servers: mcpServers,
      extensions: [...input.discovered.extensions],
      unused_mcp_servers: [],
      diagnostics: mergedDiagnostics,
      ...startupContextsField,
    };
  }

  const sessions = input.sessions ?? [];
  const platformSessions = new Map<string, { count: number; lastActiveAt: string | null }>();
  const toolEvents: ObservedToolEvent[] = [];
  let totalSessionsInWindow = 0;

  for (const session of sessions) {
    const sessionToolEvents = collectSessionToolEventsInWindow(session, afterTs);
    const sessionTsIso = session.updated_at || session.created_at;
    const sessionTsMs = Date.parse(sessionTsIso);
    const inWindow =
      afterTs === undefined ||
      (Number.isFinite(sessionTsMs) && sessionTsMs >= afterTs) ||
      sessionToolEvents.length > 0;

    if (!inWindow) continue;

    totalSessionsInWindow += 1;
    const prev = platformSessions.get(session.source_platform) ?? { count: 0, lastActiveAt: null };
    prev.count += 1;
    prev.lastActiveAt = maxIso(prev.lastActiveAt ?? undefined, sessionTsIso) ?? prev.lastActiveAt;
    for (const ev of sessionToolEvents) {
      prev.lastActiveAt = maxIso(prev.lastActiveAt ?? undefined, ev.lastUsedAt) ?? prev.lastActiveAt;
      toolEvents.push(ev);
    }
    platformSessions.set(session.source_platform, prev);
  }

  const agents: AgentInventoryEntry[] = input.discovered.agents.map((agent) => {
    const stats = platformSessions.get(agent.client);
    return {
      ...agent,
      active_in_window: Boolean(stats && stats.count > 0),
      session_count: stats?.count ?? 0,
      last_active_at: stats?.lastActiveAt ?? null,
    };
  });

  const serverAccumulators = mergedMcpConfigs.map((server) => ({
    server,
    normalizedId: normalizeServerToken(server.server_id),
    callCount: 0,
    lastUsedAt: null as string | null,
    matchedTools: new Set<string>(),
  }));

  let totalToolCalls = 0;
  let matchedMcpCalls = 0;
  const unmatchedMcpTools = new Set<string>();

  for (const event of toolEvents) {
    totalToolCalls += event.count;
    const matchedIndices: number[] = [];

    for (let idx = 0; idx < serverAccumulators.length; idx += 1) {
      const acc = serverAccumulators[idx]!;
      if (acc.server.client !== event.platform) continue;
      if (matchesMcpServer(event.toolName, event.targetSignature, acc.server.server_id, acc.normalizedId)) {
        matchedIndices.push(idx);
      }
    }

    if (matchedIndices.length > 0) {
      matchedMcpCalls += event.count;
      for (const idx of matchedIndices) {
        const acc = serverAccumulators[idx]!;
        acc.callCount += event.count;
        acc.lastUsedAt = maxIso(acc.lastUsedAt ?? undefined, event.lastUsedAt) ?? acc.lastUsedAt;
        acc.matchedTools.add(event.toolName);
      }
    } else if (looksLikeMcpToolName(event.toolName)) {
      unmatchedMcpTools.add(`${event.platform}:${event.toolName}`);
    }
  }

  const mcpServers: McpServerInventoryEntry[] = serverAccumulators.map((acc) => ({
    ...acc.server,
    used_in_window: acc.callCount > 0,
    call_count: acc.callCount,
    last_used_at: acc.lastUsedAt,
    ...(acc.matchedTools.size > 0
      ? { matched_tool_names: [...acc.matchedTools].sort((a, b) => a.localeCompare(b)) }
      : {}),
  }));

  const unusedMcpServers = mcpServers
    .filter((server) => server.enabled && server.used_in_window === false)
    .map((server) => ({
      server_id: server.server_id,
      client: server.client,
      scope: server.scope,
      source_path: server.source_path,
    }));

  const activity: AgentInventoryActivitySummary = {
    correlated: true,
    window: windowLabel,
    since_at: sinceAt,
    until_at: generatedAt,
    total_sessions: totalSessionsInWindow,
    total_tool_calls: totalToolCalls,
    matched_mcp_calls: matchedMcpCalls,
    unmatched_mcp_tool_names: [...unmatchedMcpTools].sort((a, b) => a.localeCompare(b)).slice(0, 50),
  };

  return {
    schema: AGENT_INVENTORY_SCHEMA,
    kind: "agent_inventory",
    generated_at: generatedAt,
    home_dir: input.discovered.home_dir,
    project_dir: input.discovered.project_dir,
    summary: buildInventorySummary(agents, mcpServers, input.discovered.extensions, mergedDiagnostics, true),
    activity,
    agents,
    mcp_servers: mcpServers,
    extensions: [...input.discovered.extensions],
    unused_mcp_servers: unusedMcpServers,
    diagnostics: mergedDiagnostics,
    ...startupContextsField,
  };
}

export function buildAgentInventoryEnvelope(
  report: AgentInventoryReport,
  options: BuildAgentInventoryEnvelopeOptions,
): ReadOnlyEnvelopeV1<AgentInventorySummary, AgentInventoryEnvelopeItem> {
  const hasWarnOrError = report.diagnostics.some((d) => d.severity === "warning" || d.severity === "error");
  let status: ReadOnlyEnvelopeStatus = "ok";
  if (options.activityError) status = "partial";
  else if (hasWarnOrError) status = "partial";

  const items: AgentInventoryEnvelopeItem[] = [
    ...report.agents.map((agent) => ({ item_type: "agent" as const, ...agent })),
    ...report.mcp_servers.map((server) => ({ item_type: "mcp_server" as const, ...server })),
    ...report.extensions.map((ext) => ({ item_type: "extension" as const, ...ext })),
    ...(report.startup_contexts ?? []).map((ctx) => ({ item_type: "startup_context" as const, ...ctx })),
  ];

  return {
    schema_version: 1,
    domain: "ai_agents",
    owner: "cchistory-lite",
    host_id: options.hostId,
    generated_at: report.generated_at,
    stale_after_seconds: options.staleAfterSeconds ?? DEFAULT_ENVELOPE_STALE_AFTER_SECONDS,
    status,
    error: options.activityError ?? null,
    summary: report.summary,
    delta: null,
    items,
  };
}

function collectSessionToolEventsInWindow(
  session: SessionProjection,
  afterTs: number | undefined,
): ObservedToolEvent[] {
  const platform = session.source_platform;
  const fromUsageEvents = new Map<string, ObservedToolEvent>();
  const toolCountsFromUsage = new Map<string, number>();

  for (const event of session.usage_events ?? []) {
    const eventTsMs = Date.parse(event.created_at);
    if (afterTs !== undefined && (!Number.isFinite(eventTsMs) || eventTsMs < afterTs)) {
      continue;
    }
    for (const tool of event.emitted_tool_calls ?? []) {
      const name = tool.tool_name.trim();
      if (!name) continue;
      const key = `${name}\0${tool.target_signature ?? ""}`;
      const existing = fromUsageEvents.get(key);
      if (existing) {
        existing.count += 1;
        existing.lastUsedAt = maxIso(existing.lastUsedAt, event.created_at) ?? existing.lastUsedAt;
      } else {
        fromUsageEvents.set(key, {
          platform,
          toolName: name,
          targetSignature: tool.target_signature,
          count: 1,
          lastUsedAt: event.created_at,
        });
      }
      toolCountsFromUsage.set(name, (toolCountsFromUsage.get(name) ?? 0) + 1);
    }
  }

  const out = [...fromUsageEvents.values()];

  // Include lightweight session-level tool counts for adapters without per-call usage events
  // or when per-call tool summaries were capped.
  for (const entry of session.tool_usage_summary ?? []) {
    const tsMs = Date.parse(entry.last_used_at);
    if (afterTs !== undefined && (!Number.isFinite(tsMs) || tsMs < afterTs)) {
      continue;
    }
    const alreadyCounted = toolCountsFromUsage.get(entry.tool_name) ?? 0;
    const remaining = entry.call_count - alreadyCounted;
    if (remaining <= 0) continue;
    out.push({
      platform,
      toolName: entry.tool_name,
      ...(entry.target_server ? { targetSignature: entry.target_server } : {}),
      count: remaining,
      lastUsedAt: entry.last_used_at,
    });
  }

  return out;
}

export function matchesMcpServer(
  toolName: string,
  targetSignature: string | undefined,
  rawServerId: string,
  normalizedServerId = normalizeServerToken(rawServerId),
): boolean {
  const trimmedTool = toolName.trim();
  if (!trimmedTool || !normalizedServerId) return false;
  const lowerTool = trimmedTool.toLowerCase();

  // Generic wrapper tools (e.g. Antigravity call_mcp_tool / use_mcp_tool) carry server name in targetSignature.
  if (lowerTool === "call_mcp_tool" || lowerTool === "use_mcp_tool") {
    if (!targetSignature) return false;
    const sigToken = normalizeServerToken(targetSignature.split(/[:/\s]/u, 1)[0] ?? targetSignature);
    return sigToken === normalizedServerId;
  }

  // Standard double-underscore form: `mcp__<server>__<tool>` or `<server>__<tool>`
  const mcpDouble = /^mcp__([^_](?:.*?))__.+$/iu.exec(trimmedTool);
  if (mcpDouble) {
    return normalizeServerToken(mcpDouble[1]!) === normalizedServerId;
  }
  const plainDouble = /^([^_].*?)__.+$/u.exec(trimmedTool);
  if (plainDouble) {
    return normalizeServerToken(plainDouble[1]!) === normalizedServerId;
  }

  // Colon or slash namespaced forms: `mcp:<server>:<tool>`, `<server>:<tool>`, `<server>/<tool>`
  const mcpColon = /^mcp[:/]([^:/]+)[:/].+$/iu.exec(trimmedTool);
  if (mcpColon) {
    return normalizeServerToken(mcpColon[1]!) === normalizedServerId;
  }
  const plainNamespace = /^([^:/]+)[:/].+$/u.exec(trimmedTool);
  if (plainNamespace) {
    return normalizeServerToken(plainNamespace[1]!) === normalizedServerId;
  }

  // Single-underscore `mcp_<server>_<tool>` form (prefix match on normalized server id).
  if (lowerTool.startsWith("mcp_")) {
    const rest = lowerTool.slice(4).replace(/[^a-z0-9]+/gu, "_");
    if (rest.startsWith(`${normalizedServerId}_`) && rest.length > normalizedServerId.length + 1) {
      return true;
    }
  }

  return false;
}

function looksLikeMcpToolName(toolName: string): boolean {
  const lower = toolName.trim().toLowerCase();
  return lower.startsWith("mcp__") || lower.startsWith("mcp_") || lower.startsWith("mcp:") || lower === "call_mcp_tool";
}

function normalizeServerToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function buildInventorySummary(
  agents: readonly AgentInventoryEntry[],
  mcpServers: readonly McpServerInventoryEntry[],
  extensions: readonly DiscoveredAgentInventory["extensions"][number][],
  diagnostics: readonly DiscoveredAgentInventory["diagnostics"][number][],
  correlated: boolean,
): AgentInventorySummary {
  let skillCount = 0;
  let ruleCount = 0;
  let subagentCount = 0;
  let pluginCount = 0;
  let hookCount = 0;
  for (const ext of extensions) {
    if (ext.kind === "skill") skillCount += 1;
    else if (ext.kind === "rule") ruleCount += 1;
    else if (ext.kind === "subagent") subagentCount += 1;
    else if (ext.kind === "plugin") pluginCount += 1;
    else if (ext.kind === "hook") hookCount += 1;
  }

  return {
    agent_count: agents.length,
    installed_agent_count: agents.filter((a) => a.installed).length,
    configured_agent_count: agents.filter((a) => a.configured).length,
    active_agent_count: correlated ? agents.filter((a) => a.active_in_window === true).length : null,
    mcp_server_count: mcpServers.length,
    used_mcp_server_count: correlated ? mcpServers.filter((s) => s.used_in_window === true).length : null,
    unused_mcp_server_count: correlated ? mcpServers.filter((s) => s.enabled && s.used_in_window === false).length : null,
    skill_count: skillCount,
    rule_count: ruleCount,
    subagent_count: subagentCount,
    plugin_count: pluginCount,
    hook_count: hookCount,
    extension_count: extensions.length,
    diagnostic_count: diagnostics.length,
  };
}

function mergeDiagnostics(
  base: readonly AgentInventoryDiagnostic[],
  startupContexts?: readonly AgentStartupResolution[],
): AgentInventoryDiagnostic[] {
  if (!startupContexts || startupContexts.length === 0) return [...base];
  const out: AgentInventoryDiagnostic[] = [...base];
  const seen = new Set(base.map((d) => `${d.client}\0${d.code}\0${d.path}\0${d.detail}`));
  for (const ctx of startupContexts) {
    for (const diag of ctx.diagnostics) {
      const key = `${diag.client}\0${diag.code}\0${diag.path}\0${diag.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(diag);
    }
  }
  return out;
}
