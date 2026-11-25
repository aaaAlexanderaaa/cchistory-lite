/**
 * Role: Native human-readable CLI renderer for per-tool pre-launch startup contexts.
 * Renders each supported tool (Claude Code, Codex, Google Antigravity, OpenCode,
 * DeepSeek Harness) using its own native concepts, precedence layers, and budget metrics
 * rather than flattening them into a lowest-common-denominator table.
 * Excludes JSON serialization, filesystem reads, and command argument parsing.
 */

import type {
  AgentStartupResolution,
  AntigravityStartupContext,
  ClaudeCodeStartupContext,
  CodexStartupContext,
  DeepSeekHarnessStartupContext,
  OpenCodeStartupContext,
  RedactedHookEntry,
  ResolvedMcpServerState,
} from "@cchistory/domain";

export function renderStartupContexts(
  resolutions: readonly AgentStartupResolution[],
  explicitAgentFilter: boolean,
  scopeNote?: string,
): string[] {
  if (resolutions.length === 0) return [];
  const first = resolutions[0]!;
  const scopeParts: string[] = [];
  if (first.project_dir) scopeParts.push(`dir=${first.project_dir}`);
  if (first.git_root) scopeParts.push(`git_root=${first.git_root}`);
  if (scopeNote) scopeParts.push(scopeNote);
  const headerSuffix = scopeParts.length > 0 ? ` · ${scopeParts.join(" · ")}` : " · global scope";
  const lines: string[] = [`Pre-Launch Startup Contexts${headerSuffix}`];

  for (const res of resolutions) {
    if (res.resolution_tier !== "native" || "supported" in res.native) {
      lines.push(`● ${res.display_name} [${res.client}] · tier=${res.resolution_tier}`);
      if ("supported" in res.native && res.native.supported === false) {
        lines.push(`  ${res.native.reason}`);
      }
      continue;
    }

    if (!explicitAgentFilter && res.files_read.length === 0 && !hasNonFileStartupSignal(res)) {
      lines.push(`○ ${res.display_name} [${res.client}] · no startup config/context files found`);
      continue;
    }

    const nativeCtx = res.native;
    switch (nativeCtx.client) {
      case "claude_code":
        lines.push(...renderClaudeCode(res, nativeCtx));
        break;
      case "codex":
        lines.push(...renderCodex(res, nativeCtx));
        break;
      case "antigravity":
        lines.push(...renderAntigravity(res, nativeCtx));
        break;
      case "opencode":
        lines.push(...renderOpenCode(res, nativeCtx));
        break;
      case "deepseek_harness":
        lines.push(...renderDeepSeekHarness(res, nativeCtx));
        break;
    }
    lines.push("");
  }

  return lines;
}

function renderClaudeCode(res: AgentStartupResolution, ctx: ClaudeCodeStartupContext): string[] {
  const fp = ctx.startup_footprint;
  const lines: string[] = [
    `● Claude Code [claude_code] · always-loaded ${formatBytes(fp.always_loaded_bytes)} (~${fp.always_loaded_estimated_tokens} tok) · ${res.files_read.length} files`,
  ];
  const s = ctx.settings_cascade;
  const settingBits: string[] = [];
  if (s.effective_model) settingBits.push(`model=${s.effective_model}`);
  if (s.permission_mode) settingBits.push(`permission_mode=${s.permission_mode}`);
  if (s.permissions) {
    settingBits.push(
      `perms(allow=${s.permissions.allow_count}, ask=${s.permissions.ask_count}, deny=${s.permissions.deny_count})`,
    );
  }
  if (s.disabled_mcpjson_servers.length > 0) {
    settingBits.push(`disabledMcpjson=[${s.disabled_mcpjson_servers.join(", ")}]`);
  }
  if (settingBits.length > 0 || s.files.length > 0) {
    lines.push(`  settings (${s.files.length}): ${settingBits.join(" · ") || s.files.map((f) => f.layer).join(" -> ")}`);
  }

  if (ctx.claude_md_chain.length > 0) {
    lines.push(`  CLAUDE.md chain (${ctx.claude_md_chain.length}, ${fp.resolved_import_count} @imports${fp.missing_import_count > 0 ? `, ${fp.missing_import_count} missing` : ""}):`);
    for (const entry of ctx.claude_md_chain) {
      lines.push(`    [${entry.layer}] ${entry.path} (${formatBytes(entry.size_bytes)}, ~${entry.estimated_tokens} tok)`);
      for (const imp of entry.imports) {
        const tag = imp.cycle
          ? "[cycle]"
          : !imp.exists
            ? "[missing]"
            : `${formatBytes(imp.size_bytes ?? 0)}`;
        lines.push(`      ${"  ".repeat(Math.max(0, imp.depth - 1))}↳ @${imp.raw_ref} -> ${imp.resolved_path} (${tag})`);
      }
    }
  }

  if (ctx.rules.length > 0) {
    lines.push(`  .claude/rules (${ctx.rules.length}: ${fp.always_rule_count} always, ${fp.path_scoped_rule_count} path-scoped):`);
    for (const rule of ctx.rules) {
      const modeText = rule.mode === "path_scoped" && rule.paths?.length
        ? `paths=[${rule.paths.join(", ")}]`
        : "always";
      lines.push(`    [${rule.scope}] ${rule.name} · ${modeText} (${formatBytes(rule.size_bytes)})`);
    }
  }

  appendResolvedMcpLines(lines, ctx.mcp_servers);

  if (ctx.plugins.length > 0) {
    lines.push(`  plugins (${ctx.plugins.length}):`);
    for (const p of ctx.plugins) {
      const bundle = [
        p.bundled_skills.length ? `${p.bundled_skills.length} skills` : "",
        p.bundled_commands.length ? `${p.bundled_commands.length} cmds` : "",
        p.bundled_agents.length ? `${p.bundled_agents.length} agents` : "",
        p.bundled_mcp_servers.length ? `${p.bundled_mcp_servers.length} mcp` : "",
        p.bundled_hooks.length ? `${p.bundled_hooks.length} hooks` : "",
      ].filter(Boolean);
      const bundleStr = bundle.length > 0 ? ` · bundle: ${bundle.join(", ")}` : "";
      lines.push(`    ${p.name} [${p.enabled ? "enabled" : "disabled"}]${bundleStr}`);
    }
  }

  appendCompactNamedList(lines, "skills", ctx.skills);
  appendCompactNamedList(lines, "commands", ctx.commands);
  appendCompactNamedList(lines, "subagents", ctx.subagents);
  appendHookLines(lines, ctx.hooks);
  return lines;
}

function renderCodex(res: AgentStartupResolution, ctx: CodexStartupContext): string[] {
  const fp = ctx.startup_footprint;
  const pct = Math.round(fp.budget_used_ratio * 100);
  const lines: string[] = [
    `● Codex [codex] · doc budget ${formatBytes(fp.loaded_bytes)} / ${formatBytes(fp.budget_bytes)} (${pct}%, ~${fp.estimated_tokens} tok) · ${res.files_read.length} files`,
  ];
  const c = ctx.config_cascade;
  const bits: string[] = [`codex_home=${ctx.codex_home}`];
  if (c.effective_model) bits.push(`model=${c.effective_model}`);
  if (c.model_reasoning_effort) bits.push(`effort=${c.model_reasoning_effort}`);
  if (c.approval_policy) bits.push(`approval=${c.approval_policy}`);
  if (c.sandbox_mode) bits.push(`sandbox=${c.sandbox_mode}`);
  if (c.active_profile) bits.push(`profile=${c.active_profile}`);
  if (c.profiles.length > 0) bits.push(`profiles=[${c.profiles.join(", ")}]`);
  lines.push(`  config: ${bits.join(" · ")}`);

  if (c.project_config_path) {
    const gateLabel = c.project_config_trusted
      ? c.project_trust_level && c.project_trust_level !== "trusted"
        ? `trusted (${c.project_trust_level})`
        : "trusted"
      : `TRUST-GATED (trust_level=${c.project_trust_level ?? "unset"}; project .codex/config.toml skipped)`;
    lines.push(`  project config: ${c.project_config_path} · ${gateLabel}`);
  }

  if (ctx.instruction_chain.length > 0) {
    lines.push(`  instruction chain (${ctx.instruction_chain.length}):`);
    for (const item of ctx.instruction_chain) {
      const extra =
        item.status === "shadowed"
          ? `shadowed by ${item.shadowed_by ?? "override"}`
          : item.status === "truncated"
            ? `truncated ${formatBytes(item.included_bytes)}/${formatBytes(item.size_bytes)}`
            : item.status === "budget_exhausted"
              ? `budget_exhausted (0/${formatBytes(item.size_bytes)})`
              : `${formatBytes(item.included_bytes)}`;
      lines.push(`    [${item.layer}] ${item.kind} · ${item.status} · ${item.path} (${extra})`);
    }
  }

  appendResolvedMcpLines(lines, ctx.mcp_servers);
  if (ctx.agents.length > 0) {
    lines.push(`  agents (${ctx.agents.length}): ${ctx.agents.map((a) => `${a.name} [${a.scope}/${a.source}]`).join(", ")}`);
  }
  appendCompactNamedList(lines, "skills", ctx.skills);
  appendHookLines(lines, ctx.hooks);
  return lines;
}

function renderAntigravity(res: AgentStartupResolution, ctx: AntigravityStartupContext): string[] {
  const fp = ctx.startup_footprint;
  const lines: string[] = [
    `● Google Antigravity [antigravity] · inlined rules ${formatBytes(fp.inlined_rules_bytes)} (~${fp.inlined_rules_estimated_tokens}/${fp.aggregate_rules_budget_tokens} tok budget, ${fp.demoted_rule_count} demoted, ${fp.truncated_rule_count} capped@24,000B) · ${res.files_read.length} files`,
  ];
  if (ctx.discovery_roots.length > 0) {
    lines.push(`  roots (${ctx.discovery_roots.length}): ${ctx.discovery_roots.map((r) => `${r.kind}:${r.path}`).join(" · ")}`);
  }
  if (ctx.rules.length > 0) {
    lines.push(`  rules (${ctx.rules.length}):`);
    for (const r of ctx.rules) {
      const sizeText = r.truncated_by_file_cap
        ? `truncated ${r.capped_bytes.toLocaleString("en-US")}/${r.size_bytes.toLocaleString("en-US")} B`
        : formatBytes(r.size_bytes);
      const flags = [
        `trigger=${r.trigger}`,
        r.budget_status,
        r.globs?.length ? `globs=[${r.globs.join(", ")}]` : "",
      ].filter(Boolean);
      const origin = r.plugin_name ? `${r.source}:${r.plugin_name}` : r.source;
      lines.push(`    [${origin}] ${r.path} · ${flags.join(" · ")} (${sizeText})`);
      for (const inc of r.includes) {
        lines.push(`      ↳ @[${inc.label}](${inc.raw_ref}) ${inc.exists ? "ok" : "[missing]"}`);
      }
    }
  }
  if (ctx.plugins.length > 0) {
    lines.push(`  plugins (${ctx.plugins.length}):`);
    for (const p of ctx.plugins) {
      const bundle = [
        p.bundled_rules.length ? `${p.bundled_rules.length} rules` : "",
        p.bundled_skills.length ? `${p.bundled_skills.length} skills` : "",
        p.bundled_mcp_servers.length ? `${p.bundled_mcp_servers.length} mcp` : "",
        p.bundled_hooks.length ? `${p.bundled_hooks.length} hooks` : "",
      ].filter(Boolean);
      lines.push(
        `    ${p.display_name} [${p.enabled ? "enabled" : "disabled"} via ${p.enabled_source}]` +
          (bundle.length > 0 ? ` · bundle: ${bundle.join(", ")}` : ""),
      );
    }
  }
  appendCompactNamedList(lines, "skills", ctx.skills);
  if (ctx.workflows.length > 0) {
    lines.push(`  workflows (${ctx.workflows.length}): ${ctx.workflows.map((w) => `${w.name} [${w.scope}]`).join(", ")}`);
  }
  appendResolvedMcpLines(lines, ctx.mcp_servers);
  appendHookLines(lines, ctx.hooks);
  return lines;
}

function renderOpenCode(res: AgentStartupResolution, ctx: OpenCodeStartupContext): string[] {
  const fp = ctx.startup_footprint;
  const lines: string[] = [
    `● OpenCode [opencode] · instructions ${formatBytes(fp.instruction_bytes)} (~${fp.instruction_estimated_tokens} tok, ${fp.instruction_file_count} files) · ${res.files_read.length} files`,
  ];
  const c = ctx.config_cascade;
  const bits: string[] = [];
  if (c.effective_model) bits.push(`model=${c.effective_model}`);
  if (c.small_model) bits.push(`small_model=${c.small_model}`);
  if (c.default_agent) bits.push(`default_agent=${c.default_agent}`);
  if (c.provider_names.length > 0) bits.push(`providers=[${c.provider_names.join(", ")}]`);
  bits.push(`claude_md_fallback=${c.claude_md_fallback_disabled ? "disabled" : "enabled"}`);
  lines.push(`  config (${c.files.length}): ${bits.join(" · ")}`);
  if (ctx.instructions.length > 0) {
    lines.push(`  instructions (${ctx.instructions.length}):`);
    for (const inst of ctx.instructions) {
      const sizeLabel =
        inst.exists === false ? "[missing]" : `${formatBytes(inst.size_bytes)}, ~${inst.estimated_tokens} tok`;
      lines.push(`    [${inst.source}] ${inst.path} (${sizeLabel})`);
    }
  }
  appendResolvedMcpLines(lines, ctx.mcp_servers);
  appendCompactNamedList(lines, "agents", ctx.agents);
  appendCompactNamedList(lines, "skills", ctx.skills);
  if (ctx.commands.length > 0) {
    lines.push(`  commands (${ctx.commands.length}): ${ctx.commands.map((cmd) => `${cmd.name} [${cmd.scope}]`).join(", ")}`);
  }
  if (ctx.plugins.length > 0) {
    lines.push(`  plugins (${ctx.plugins.length}): ${ctx.plugins.map((p) => `${p.name} [${p.scope}/${p.source}]`).join(", ")}`);
  }
  return lines;
}

function renderDeepSeekHarness(res: AgentStartupResolution, ctx: DeepSeekHarnessStartupContext): string[] {
  const fp = ctx.startup_footprint;
  const lines: string[] = [
    `● DeepSeek Harness [deepseek_harness] · dsh_home=${ctx.dsh_home} · instructions ${formatBytes(fp.instruction_bytes)} (~${fp.instruction_estimated_tokens} tok) · ${res.files_read.length} files`,
  ];
  if (ctx.credentials_file_present) {
    lines.push(`  credentials: .credentials.yaml present (never read)`);
  }
  if (ctx.profiles.length > 0) {
    lines.push(`  profiles (${ctx.profiles.length}): ${ctx.profiles.map((p) => `${p.name} (${p.files.join(", ") || "empty"})`).join(" · ")}`);
  }
  if (ctx.cordis_layers.length > 0) {
    lines.push(`  cordis layers (${ctx.cordis_layers.length}):`);
    for (const layer of ctx.cordis_layers) {
      const label = layer.profile_name ? `${layer.layer}:${layer.profile_name}` : layer.layer;
      lines.push(`    [${label}] ${layer.path} (${formatBytes(layer.size_bytes)})`);
    }
  }
  if (ctx.instructions.length > 0) {
    lines.push(`  instructions (${ctx.instructions.length}):`);
    for (const inst of ctx.instructions) {
      lines.push(`    [${inst.layer}] ${inst.path} (${formatBytes(inst.size_bytes)}, ~${inst.estimated_tokens} tok)`);
    }
  }
  appendResolvedMcpLines(lines, ctx.mcp_servers);
  appendCompactNamedList(lines, "skills", ctx.skills);
  if (ctx.subagents.length > 0) {
    lines.push(`  subagents (${ctx.subagents.length}): ${ctx.subagents.map((a) => `${a.name} [${a.scope}]`).join(", ")}`);
  }
  if (ctx.plugins.length > 0) {
    lines.push(`  plugins (${ctx.plugins.length}): ${ctx.plugins.map((p) => `${p.name} [${p.scope}]`).join(", ")}`);
  }
  return lines;
}

function appendResolvedMcpLines(lines: string[], servers: readonly ResolvedMcpServerState[]): void {
  if (servers.length === 0) return;
  lines.push(`  MCP servers (${servers.length}):`);
  for (const s of servers) {
    const tags = [s.status, s.precedence_layer, s.transport];
    if (s.from_plugin) tags.push(`plugin=${s.from_plugin}`);
    if (s.disabled_reason) tags.push(s.disabled_reason);
    if (s.shadowed_by) tags.push(`shadowed_by=${s.shadowed_by}`);
    const target = s.url ?? s.command ?? "-";
    lines.push(`    ${s.server_id} [${tags.join(" · ")}] -> ${target}`);
  }
}

function appendCompactNamedList(
  lines: string[],
  label: string,
  items: ReadonlyArray<{ name: string; status: "effective" | "shadowed"; scope?: string; source?: string }>,
): void {
  if (items.length === 0) return;
  const formatted = items.map((item) => {
    const loc = item.scope ?? item.source ?? "";
    const tag = item.status === "shadowed" ? `${loc}/shadowed` : loc;
    return tag ? `${item.name} [${tag}]` : item.name;
  });
  lines.push(`  ${label} (${items.length}): ${formatted.join(", ")}`);
}

function appendHookLines(lines: string[], hooks: readonly RedactedHookEntry[]): void {
  if (hooks.length === 0) return;
  lines.push(`  hooks (${hooks.length}):`);
  for (const h of hooks) {
    const head = h.name ? `${h.name}:${h.event}` : h.event;
    const matcher = h.matcher ? ` matcher=${h.matcher}` : "";
    const state = h.enabled ? "" : " [disabled]";
    const cmd = h.command ? ` -> ${h.command}` : "";
    lines.push(`    ${head}${matcher}${state}${cmd}`);
  }
}

function hasNonFileStartupSignal(res: AgentStartupResolution): boolean {
  if (!("supported" in res.native) && res.native.client === "deepseek_harness") {
    return res.native.credentials_file_present || res.native.profiles.length > 0;
  }
  return false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb >= 10 ? kb.toFixed(0) : kb.toFixed(1)} KiB`;
}
