/**
 * Role: Unit tests for canonical AI agent / MCP / extension activity correlation
 * and read-only v1 JSON envelope generation.
 * Excludes filesystem scanning (tested in source-adapters) and CLI parsing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoveredAgentInventory, SessionProjection } from "@cchistory/domain";
import { buildAgentInventoryEnvelope, correlateAgentInventory, matchesMcpServer } from "./agent-inventory.js";

const NOW_MS = Date.parse("2026-11-25T12:00:00.000Z");

function sampleDiscovered(): DiscoveredAgentInventory {
  return {
    home_dir: "/Users/mock_user",
    project_dir: "/workspace/demo",
    agents: [
      { client: "codex", display_name: "Codex", installed: true, configured: true, config_paths: ["/Users/mock_user/.codex/config.toml"] },
      { client: "claude_code", display_name: "Claude Code", installed: true, configured: true, config_paths: ["/Users/mock_user/.claude.json"] },
      { client: "grok", display_name: "Grok CLI", installed: true, configured: true, config_paths: ["/Users/mock_user/.grok/config.toml"] },
      { client: "antigravity", display_name: "Google Antigravity", installed: true, configured: true, config_paths: ["/Users/mock_user/.gemini/config/mcp_config.json"] },
      { client: "opencode", display_name: "OpenCode", installed: false, configured: false, config_paths: [] },
      { client: "deepseek_harness", display_name: "DeepSeek Harness", installed: false, configured: false, config_paths: [] },
      { client: "gemini", display_name: "Gemini CLI", installed: false, configured: false, config_paths: [] },
    ],
    mcp_servers: [
      {
        server_id: "portainer_ro",
        client: "codex",
        scope: "user",
        transport: "stdio",
        command: "node /workspace/portainer.js",
        args_count: 1,
        env_keys: ["PORTAINER_TOKEN"],
        enabled: true,
        source_path: "/Users/mock_user/.codex/config.toml",
      },
      {
        server_id: "uptime-kuma",
        client: "codex",
        scope: "user",
        transport: "sse",
        url: "https://kuma.example.test/sse?api_key=<redacted>",
        env_keys: [],
        header_keys: ["Authorization"],
        enabled: true,
        source_path: "/Users/mock_user/.codex/config.toml",
      },
      {
        server_id: "portainer_ro",
        client: "antigravity",
        scope: "user",
        transport: "http",
        url: "https://portainer.example.test/mcp",
        env_keys: [],
        enabled: true,
        source_path: "/Users/mock_user/.gemini/config/mcp_config.json",
      },
      {
        server_id: "grok_search",
        client: "grok",
        scope: "user",
        transport: "stdio",
        command: "grok-mcp",
        args_count: 0,
        env_keys: ["GROK_SEARCH_TOKEN"],
        enabled: true,
        source_path: "/Users/mock_user/.grok/config.toml",
      },
      {
        server_id: "disabled_srv",
        client: "claude_code",
        scope: "user",
        transport: "stdio",
        command: "disabled-mcp",
        args_count: 0,
        env_keys: [],
        enabled: false,
        source_path: "/Users/mock_user/.claude.json",
      },
    ],
    extensions: [
      { id: "codex:skill:user:repo-check", kind: "skill", name: "repo-check", client: "codex", scope: "user", source_path: "/Users/mock_user/.codex/skills/repo-check" },
      { id: "claude_code:subagent:user:code-reviewer", kind: "subagent", name: "code-reviewer", client: "claude_code", scope: "user", source_path: "/Users/mock_user/.claude/agents/code-reviewer.md" },
      { id: "claude_code:plugin:user:sec-pack", kind: "plugin", name: "sec-pack", client: "claude_code", scope: "user", enabled: true, source_path: "/Users/mock_user/.claude/settings.json" },
      { id: "claude_code:hook:user:PreToolUse", kind: "hook", name: "PreToolUse", client: "claude_code", scope: "user", enabled: true, source_path: "/Users/mock_user/.claude/settings.json" },
      { id: "codex:rule:user:AGENTS.md", kind: "rule", name: "AGENTS.md", client: "codex", scope: "user", source_path: "/Users/mock_user/.codex/AGENTS.md" },
    ],
    diagnostics: [],
  };
}

function makeSession(overrides: Partial<SessionProjection> & Pick<SessionProjection, "id" | "source_platform">): SessionProjection {
  return {
    source_id: `src:${overrides.source_platform}`,
    host_id: "host-a",
    created_at: "2026-11-20T10:00:00.000Z",
    updated_at: "2026-11-20T10:05:00.000Z",
    turn_count: 1,
    sync_axis: "current",
    ...overrides,
  };
}

test("correlateAgentInventory matches per-client MCP usage in 30d window and highlights unused servers", () => {
  const sessions: SessionProjection[] = [
    // Codex recent call to portainer_ro (matched) + unmatched mcp__ghost__ping
    makeSession({
      id: "sess:codex:1",
      source_platform: "codex",
      updated_at: "2026-11-24T08:00:00.000Z",
      usage_events: [
        {
          id: "ev-1",
          turn_id: "t-1",
          created_at: "2026-11-24T08:00:00.000Z",
          token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          emitted_tool_calls: [
            { tool_name: "mcp__portainer_ro__list_containers", status: "success" },
            { tool_name: "mcp__ghost__ping", status: "success" },
          ],
        },
      ],
    }),
    // Codex OLD call to uptime-kuma outside 30d window (must stay unused in 30d!)
    makeSession({
      id: "sess:codex:old",
      source_platform: "codex",
      created_at: "2026-09-01T08:00:00.000Z",
      updated_at: "2026-09-01T08:05:00.000Z",
      usage_events: [
        {
          id: "ev-old",
          turn_id: "t-old",
          created_at: "2026-09-01T08:05:00.000Z",
          token_usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
          emitted_tool_calls: [{ tool_name: "mcp__uptime_kuma__listMonitors", status: "success" }],
        },
      ],
    }),
    // Antigravity call_mcp_tool using target_signature
    makeSession({
      id: "sess:agy:1",
      source_platform: "antigravity",
      updated_at: "2026-11-25T06:00:00.000Z",
      usage_events: [
        {
          id: "ev-agy",
          turn_id: "t-agy",
          created_at: "2026-11-25T06:00:00.000Z",
          token_usage: { input_tokens: 80, output_tokens: 10, total_tokens: 90 },
          emitted_tool_calls: [
            { tool_name: "call_mcp_tool", target_signature: "portainer_ro:inspect_container", status: "success" },
          ],
        },
      ],
    }),
    // Grok session without usage_events, correlated via lightweight tool_usage_summary
    makeSession({
      id: "sess:grok:1",
      source_platform: "grok",
      updated_at: "2026-11-23T12:00:00.000Z",
      tool_usage_summary: [
        { tool_name: "grok_search__query", call_count: 3, last_used_at: "2026-11-23T12:00:00.000Z" },
      ],
    }),
  ];

  const report = correlateAgentInventory({
    discovered: sampleDiscovered(),
    sessions,
    window: "30d",
    nowMs: NOW_MS,
  });

  assert.equal(report.activity.correlated, true);
  assert.equal(report.activity.total_sessions, 3);
  assert.equal(report.activity.total_tool_calls, 6);
  assert.equal(report.activity.matched_mcp_calls, 5);
  assert.deepEqual(report.activity.unmatched_mcp_tool_names, ["codex:mcp__ghost__ping"]);

  const byKey = new Map(report.mcp_servers.map((s) => [`${s.client}:${s.server_id}`, s]));
  assert.equal(byKey.get("codex:portainer_ro")?.used_in_window, true);
  assert.equal(byKey.get("codex:portainer_ro")?.call_count, 1);
  assert.equal(byKey.get("codex:uptime-kuma")?.used_in_window, false);
  assert.equal(byKey.get("codex:uptime-kuma")?.call_count, 0);
  assert.equal(byKey.get("antigravity:portainer_ro")?.used_in_window, true);
  assert.equal(byKey.get("grok:grok_search")?.used_in_window, true);
  assert.equal(byKey.get("grok:grok_search")?.call_count, 3);

  // Disabled server is excluded from unused_mcp_servers highlight
  assert.deepEqual(
    report.unused_mcp_servers.map((u) => `${u.client}:${u.server_id}`),
    ["codex:uptime-kuma"],
  );
  assert.equal(report.summary.skill_count, 1);
  assert.equal(report.summary.rule_count, 1);
  assert.equal(report.summary.subagent_count, 1);
  assert.equal(report.summary.plugin_count, 1);
  assert.equal(report.summary.hook_count, 1);
  assert.equal(report.summary.used_mcp_server_count, 3);
  assert.equal(report.summary.unused_mcp_server_count, 1);

  const envelope = buildAgentInventoryEnvelope(report, { hostId: "lab-node-1" });
  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.domain, "ai_agents");
  assert.equal(envelope.owner, "cchistory-lite");
  assert.equal(envelope.host_id, "lab-node-1");
  assert.equal(envelope.stale_after_seconds, 86400);
  assert.equal(envelope.status, "ok");
  assert.equal(envelope.error, null);
  assert.equal(envelope.delta, null);
  assert.equal(envelope.items.length, report.agents.length + report.mcp_servers.length + report.extensions.length);
});

test("correlateAgentInventory supports skipActivity and partial envelope status on diagnostics", () => {
  const discovered = sampleDiscovered();
  discovered.diagnostics.push({
    code: "inventory_toml_parse_failed",
    severity: "warning",
    client: "codex",
    path: "/Users/mock_user/.codex/config.toml",
    detail: "TOML line 4: missing value",
  });
  const report = correlateAgentInventory({
    discovered,
    skipActivity: true,
    window: "30d",
    nowMs: NOW_MS,
  });
  assert.equal(report.activity.correlated, false);
  assert.equal(report.summary.active_agent_count, null);
  assert.equal(report.summary.used_mcp_server_count, null);
  assert.equal(report.mcp_servers[0]?.used_in_window, null);

  const envelope = buildAgentInventoryEnvelope(report, { hostId: "lab-node-2" });
  assert.equal(envelope.status, "partial");
});

test("matchesMcpServer handles naming variants without false positives", () => {
  assert.equal(matchesMcpServer("mcp__uptime_kuma__listMonitors", undefined, "uptime-kuma"), true);
  assert.equal(matchesMcpServer("mcp:portainer_ro:list_containers", undefined, "portainer_ro"), true);
  assert.equal(matchesMcpServer("portainer_ro/inspect_container", undefined, "portainer_ro"), true);
  assert.equal(matchesMcpServer("call_mcp_tool", "portainer_ro:inspect_container", "portainer_ro"), true);
  assert.equal(matchesMcpServer("read_file", "/workspace/portainer_ro/README.md", "portainer_ro"), false);
});
