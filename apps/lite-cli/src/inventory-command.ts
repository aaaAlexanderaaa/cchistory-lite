/**
 * Role: CLI `inventory` subcommand handling read-only AI agent / MCP / extension
 * configuration discovery, configurable-window tool activity correlation, v1 envelope
 * formatting, and human-readable grouped output.
 * Excludes low-level config parsing (source-adapters) and correlation semantics (canonical).
 */

import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatRelativeTime,
  type AgentExtensionEntry,
  type AgentExtensionKind,
  type AgentInventoryReport,
} from "@cchistory/domain";
import {
  DEFAULT_INVENTORY_WINDOW,
  NATIVE_STARTUP_CLIENT_IDS,
  buildAgentInventoryEnvelope,
  parseDateOrRelativeStart,
  scanAgentInventory,
  validateAgentStartupRefs,
  type LiveHistorySnapshot,
  type ScanLiteHistoryOptions,
} from "@cchistory/live-runtime";
import type { JsonOutputMode } from "./json-v2.js";
import { renderStartupContexts } from "./startup-render.js";

export interface InventoryCliIo {
  cwd: string;
  homeDir?: string;
  hostname?: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  isTTY: boolean;
  now?: () => number;
}

export interface ParsedInventoryArgs {
  values: Map<string, string[]>;
  booleans: Set<string>;
}

export interface InventoryCommandDeps {
  UsageError: new (message: string, code?: string) => Error;
  resolveDirectoryScope: () => string | undefined;
  scanHistory: (overrides?: Partial<ScanLiteHistoryOptions>) => Promise<LiveHistorySnapshot>;
}

const EXTENSION_SECTIONS: ReadonlyArray<{ kind: AgentExtensionKind; heading: string }> = [
  { kind: "skill", heading: "Skills" },
  { kind: "rule", heading: "Rules" },
  { kind: "subagent", heading: "Subagents" },
  { kind: "plugin", heading: "Plugins" },
  { kind: "hook", heading: "Hooks" },
];

export async function runInventoryCommand(
  parsed: ParsedInventoryArgs,
  io: InventoryCliIo,
  jsonMode: JsonOutputMode,
  deps: InventoryCommandDeps,
): Promise<void> {
  const nowMs = io.now?.() ?? Date.now();
  const homeRaw = singleValue(parsed, "home", deps.UsageError);
  const homeDir = homeRaw ? expandPath(homeRaw, io.cwd, io.homeDir) : io.homeDir;
  const projectDir = deps.resolveDirectoryScope();
  const agentRefs = parsed.values.get("agent") ?? [];
  const window = singleValue(parsed, "since", deps.UsageError) ?? DEFAULT_INVENTORY_WINDOW;
  const skipActivity = parsed.booleans.has("no-activity");
  const useEnvelope = parsed.booleans.has("envelope");
  const hostId = singleValue(parsed, "host-id", deps.UsageError) ?? io.hostname ?? os.hostname();

  if (parsed.values.has("dir") && projectDir) {
    try {
      const dirStat = await stat(projectDir);
      if (!dirStat.isDirectory()) {
        throw new deps.UsageError(`--dir path is not a directory: ${projectDir}`);
      }
    } catch (error) {
      if (error instanceof deps.UsageError) throw error;
      throw new deps.UsageError(
        `--dir path does not exist or is unreadable: ${projectDir} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  if (agentRefs.length > 0) {
    const { unknownRefs } = validateAgentStartupRefs(agentRefs);
    if (unknownRefs.length > 0) {
      throw new deps.UsageError(
        `Unknown --agent value${unknownRefs.length > 1 ? "s" : ""}: ${unknownRefs.join(", ")}. ` +
          `Native startup resolvers: ${NATIVE_STARTUP_CLIENT_IDS.join(", ")} (aliases: claude, agy, dsh, or all); ` +
          `other registered adapters report tier=basic/unsupported.`,
      );
    }
  }

  try {
    parseDateOrRelativeStart(window, { now_ms: nowMs, timezone: "UTC" });
  } catch (error) {
    throw new deps.UsageError(
      `Invalid --since value ${JSON.stringify(window)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let snapshot: LiveHistorySnapshot | undefined;
  if (!skipActivity) {
    snapshot = await deps.scanHistory({
      ...(homeDir ? { homeDir } : {}),
      contextMode: "none",
    });
  }

  const sessions = snapshot
    ? projectDir
      ? snapshot.listResolvedSessions({ directoryScope: projectDir })
      : snapshot.data.sessions
    : undefined;

  const report = await scanAgentInventory({
    homeDir,
    projectDir,
    ...(agentRefs.length > 0 ? { agentRefs } : {}),
    window,
    nowMs,
    skipActivity,
    sessions,
  });

  if (useEnvelope) {
    const envelope = buildAgentInventoryEnvelope(report, { hostId });
    io.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }

  if (jsonMode !== "none") {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const scopeNote =
    agentRefs.length > 0
      ? parsed.booleans.has("no-dir")
        ? "global scope (--no-dir)"
        : !parsed.values.has("dir")
          ? "cwd default; pass --no-dir for global only"
          : undefined
      : undefined;
  io.stdout(renderInventoryReport(report, nowMs, agentRefs.length > 0, scopeNote));
}

export function renderInventoryReport(
  report: AgentInventoryReport,
  nowMs = Date.now(),
  explicitAgentFilter = false,
  scopeNote?: string,
): string {
  const { summary, activity } = report;
  const isAllWindow = activity.window.trim().toLowerCase() === "all";
  const idleLabel = isAllWindow ? "no sessions" : `idle in ${activity.window}`;
  const unusedLabel = isAllWindow ? "unused" : `unused in ${activity.window}`;

  if (explicitAgentFilter && report.startup_contexts && report.startup_contexts.length > 0) {
    const selectedClients = new Set(report.startup_contexts.map((ctx) => ctx.client));
    const lines: string[] = [
      ...renderStartupContexts(report.startup_contexts, true, scopeNote),
    ];
    if (activity.correlated) {
      const matchedAgents = report.agents.filter((a) => selectedClients.has(a.client));
      const matchedMcps = report.mcp_servers.filter((s) => selectedClients.has(s.client));
      lines.push(`Activity (${activity.window})`);
      for (const agent of matchedAgents) {
        const rel = agent.last_active_at ? ` · last ${formatRelativeTime(agent.last_active_at, nowMs)}` : "";
        const state = agent.active_in_window ? `active (${agent.session_count ?? 0} sessions${rel})` : idleLabel;
        lines.push(`  ${agent.display_name} [${agent.client}]: ${state}`);
      }
      for (const server of matchedMcps) {
        const usage = server.used_in_window
          ? `${server.call_count ?? 0} calls${server.last_used_at ? `, last ${formatRelativeTime(server.last_used_at, nowMs)}` : ""}`
          : server.enabled
            ? unusedLabel
            : "disabled";
        lines.push(`  MCP ${server.server_id} (${server.client}/${server.scope}): ${usage}`);
      }
      lines.push("");
    }
    const relevantDiags = report.diagnostics.filter((d) => selectedClients.has(d.client));
    if (relevantDiags.length > 0) {
      lines.push(`Diagnostics (${relevantDiags.length})`);
      for (const diag of relevantDiags) {
        lines.push(`  [${diag.severity}] ${diag.client} ${diag.code}: ${diag.path} — ${diag.detail}`);
      }
      lines.push("");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const unusedPart =
    summary.unused_mcp_server_count !== null ? ` (${summary.unused_mcp_server_count} unused)` : "";
  const lines: string[] = [
    `Agent Inventory · ${summary.configured_agent_count} configured / ${summary.installed_agent_count} installed (${summary.agent_count} checked) · ` +
      `${summary.mcp_server_count} MCP servers${unusedPart} · ${summary.extension_count} extensions`,
  ];

  if (activity.correlated) {
    lines.push(
      `Activity window: ${activity.window} · ${activity.total_sessions} sessions · ` +
        `${activity.total_tool_calls} tool calls (${activity.matched_mcp_calls} matched MCP)`,
    );
  } else {
    lines.push(`Activity correlation: skipped (--no-activity)`);
  }
  if (report.project_dir) {
    lines.push(`Project scope: ${report.project_dir}`);
  }
  lines.push("");

  if (report.startup_contexts && report.startup_contexts.length > 0) {
    lines.push(...renderStartupContexts(report.startup_contexts, false, scopeNote));
    lines.push("");
    const startupGitRoot = report.startup_contexts[0]?.git_root;
    if (report.project_dir && startupGitRoot && startupGitRoot !== report.project_dir) {
      lines.push("Static Config Inventory (home + exact --dir; startup contexts above include git_root ancestors)");
    }
  }

  // Agents section
  lines.push("Agents");
  const visibleAgents = report.agents.filter((a) => a.installed || a.configured || a.active_in_window);
  if (visibleAgents.length === 0) {
    lines.push("  (no local AI agent configurations detected)");
  } else {
    for (const agent of visibleAgents) {
      const stateParts: string[] = [];
      stateParts.push(agent.configured ? "configured" : "installed");
      if (agent.active_in_window === true) {
        const rel = agent.last_active_at ? ` · last ${formatRelativeTime(agent.last_active_at, nowMs)}` : "";
        stateParts.push(`active (${agent.session_count ?? 0} sessions${rel})`);
      } else if (agent.active_in_window === false) {
        stateParts.push(idleLabel);
      }
      lines.push(`● ${agent.display_name} [${agent.client}] · ${stateParts.join(" · ")}`);
      if (agent.config_paths.length > 0) {
        lines.push(`  configs: ${agent.config_paths.join(", ")}`);
      }
    }
  }
  lines.push("");

  // MCP Servers section
  lines.push("MCP Servers");
  if (report.mcp_servers.length === 0) {
    lines.push("  (none configured)");
  } else {
    for (const server of report.mcp_servers) {
      const badges: string[] = [server.client, server.transport, server.scope];
      if (!server.enabled) badges.push("disabled");
      if (server.used_in_window === true) {
        const rel = server.last_used_at ? `, last ${formatRelativeTime(server.last_used_at, nowMs)}` : "";
        badges.push(`${server.call_count ?? 0} calls${rel}`);
      } else if (server.used_in_window === false && server.enabled) {
        badges.push(unusedLabel);
      }
      lines.push(`● ${server.server_id} · ${badges.join(" · ")}`);
      const target = server.url ?? server.command ?? "-";
      lines.push(`  target: ${target}`);
      const secretKeys: string[] = [];
      if (server.env_keys.length > 0) secretKeys.push(`env_keys=[${server.env_keys.join(", ")}]`);
      if (server.header_keys && server.header_keys.length > 0) {
        secretKeys.push(`header_keys=[${server.header_keys.join(", ")}]`);
      }
      if (secretKeys.length > 0) {
        lines.push(`  keys: ${secretKeys.join(" · ")}`);
      }
    }
  }
  lines.push("");

  // Extensions grouped by kind (skills, rules, subagents, plugins, hooks)
  const byKind = new Map<AgentExtensionKind, AgentExtensionEntry[]>();
  for (const ext of report.extensions) {
    const list = byKind.get(ext.kind) ?? [];
    list.push(ext);
    byKind.set(ext.kind, list);
  }
  let printedAnyExt = false;
  for (const { kind, heading } of EXTENSION_SECTIONS) {
    const entries = byKind.get(kind);
    if (!entries || entries.length === 0) continue;
    printedAnyExt = true;
    lines.push(`${heading} (${entries.length})`);
    const byClient = new Map<string, AgentExtensionEntry[]>();
    for (const entry of entries) {
      const key = `${entry.client} (${entry.scope})`;
      const list = byClient.get(key) ?? [];
      list.push(entry);
      byClient.set(key, list);
    }
    for (const [groupLabel, groupEntries] of byClient.entries()) {
      const names = groupEntries.map((entry) => (entry.enabled === false ? `${entry.name} [disabled]` : entry.name));
      lines.push(`  ${groupLabel}: ${names.join(", ")}`);
    }
    lines.push("");
  }
  if (!printedAnyExt) {
    lines.push("Extensions", "  (none detected)", "");
  }

  if (report.diagnostics.length > 0) {
    lines.push(`Diagnostics (${report.diagnostics.length})`);
    for (const diag of report.diagnostics) {
      lines.push(`  [${diag.severity}] ${diag.client} ${diag.code}: ${diag.path} — ${diag.detail}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function singleValue(
  parsed: ParsedInventoryArgs,
  name: string,
  UsageError: InventoryCommandDeps["UsageError"],
): string | undefined {
  const entries = parsed.values.get(name) ?? [];
  if (entries.length > 1) throw new UsageError(`--${name} may only be specified once.`);
  return entries.at(-1);
}

function expandPath(raw: string, cwd: string, homeDir?: string): string {
  const home = homeDir ?? os.homedir();
  const expanded =
    raw === "~" ? home : raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(home, raw.slice(2)) : raw;
  return path.resolve(cwd, expanded);
}
