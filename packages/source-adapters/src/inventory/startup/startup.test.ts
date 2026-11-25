/**
 * Role: Unit tests for the 5 per-tool native pre-launch startup resolvers
 * (Claude Code, Codex, Google Antigravity, OpenCode, DeepSeek Harness) plus
 * basic/unsupported tier reporting and secret-exclusion invariants.
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type {
  AntigravityStartupContext,
  ClaudeCodeStartupContext,
  CodexStartupContext,
  DeepSeekHarnessStartupContext,
  OpenCodeStartupContext,
} from "@cchistory/domain";
import { resolveAgentStartupContexts } from "./index.js";

const execFile = promisify(execFileCallback);

async function initTempGitRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await execFile("git", ["init", "-q"], { cwd: dir });
}

test("Claude Code native startup resolver handles @imports, cycles, rules paths, plugins, and 4-tier MCP", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cchistory-startup-claude-"));
  try {
    const home = path.join(tmp, "home");
    const repo = path.join(tmp, "repo");
    const appDir = path.join(repo, "packages", "app");
    const pluginInstall = path.join(tmp, "plugin-cache", "demo-kit");
    await initTempGitRepo(repo);
    await fs.mkdir(path.join(home, ".claude", "plugins"), { recursive: true });
    await fs.mkdir(path.join(home, ".claude", "rules"), { recursive: true });
    await fs.mkdir(path.join(repo, "docs"), { recursive: true });
    await fs.mkdir(path.join(appDir, ".claude", "rules"), { recursive: true });
    await fs.mkdir(path.join(pluginInstall, ".claude-plugin"), { recursive: true });
    await fs.mkdir(path.join(pluginInstall, "skills", "plug-skill"), { recursive: true });
    await fs.mkdir(path.join(pluginInstall, "agents"), { recursive: true });
    await fs.mkdir(path.join(pluginInstall, "hooks"), { recursive: true });

    await fs.writeFile(path.join(home, ".claude", "CLAUDE.md"), "# User instructions\n", "utf8");
    await fs.writeFile(
      path.join(repo, "CLAUDE.md"),
      [
        "# Repo guide",
        "@docs/arch.md",
        "@docs/missing.md",
        "```md",
        "@docs/ignored-in-fence.md",
        "```",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(repo, "docs", "arch.md"), "# Arch\n@./sub.md\n@../CLAUDE.md\n", "utf8");
    await fs.writeFile(path.join(repo, "docs", "sub.md"), "# Nested sub\n", "utf8");
    await fs.writeFile(path.join(appDir, "CLAUDE.local.md"), "# Local overrides\n", "utf8");

    await fs.writeFile(path.join(appDir, ".claude", "rules", "always.md"), "# Always rule\n", "utf8");
    await fs.writeFile(
      path.join(appDir, ".claude", "rules", "ts-only.md"),
      "---\npaths:\n  - \"src/**/*.ts\"\n---\n# TS rule\n",
      "utf8",
    );

    await fs.writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({
        model: "claude-sonnet-4",
        permissions: { defaultMode: "default", allow: ["Read(*)"] },
        enabledPlugins: { "demo-kit@local": true },
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ command: "guard --token=claudeHookSecret123" }] }],
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(appDir, ".claude", "settings.local.json"),
      JSON.stringify({
        model: "claude-opus-4",
        disabledMcpjsonServers: ["blocked_proj_mcp"],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(home, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: { "demo-kit@local": [{ installPath: pluginInstall, version: "1.2.0" }] },
      }),
      "utf8",
    );
    await fs.writeFile(path.join(pluginInstall, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo-kit" }), "utf8");
    await fs.writeFile(path.join(pluginInstall, "skills", "plug-skill", "SKILL.md"), "---\nname: plug-skill\ndescription: From plugin\n---\n", "utf8");
    await fs.writeFile(path.join(pluginInstall, "agents", "plug-agent.md"), "---\nname: plug-agent\nmodel: haiku\n---\n", "utf8");
    await fs.writeFile(
      path.join(pluginInstall, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          plugin_mcp: { command: "npx", args: ["-y", "demo-mcp"], env: { API_KEY: "pluginSecretVal" } },
          shared_srv: { command: "from-plugin" },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(pluginInstall, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "echo hi" }] }] } }),
      "utf8",
    );

    await fs.writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { shared_srv: { command: "from-user" } },
        projects: {
          [appDir]: {
            mcpServers: { shared_srv: { command: "from-local" } },
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(appDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared_srv: { command: "from-project" },
          blocked_proj_mcp: { command: "blocked-cmd" },
        },
      }),
      "utf8",
    );

    const [res] = await resolveAgentStartupContexts({
      homeDir: home,
      projectDir: appDir,
      agentRefs: ["claude_code"],
    });
    assert.ok(res && res.resolution_tier === "native" && res.native.client === "claude_code");
    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes("claudeHookSecret123"), false);
    assert.equal(serialized.includes("pluginSecretVal"), false);

    const ctx = res.native as ClaudeCodeStartupContext;
    assert.equal(ctx.settings_cascade.effective_model, "claude-opus-4");
    assert.equal(ctx.claude_md_chain.length, 3);
    const repoMd = ctx.claude_md_chain.find((e) => e.layer === "ancestor")!;
    assert.equal(repoMd.imports.some((i) => i.raw_ref === "docs/arch.md" && i.exists && i.depth === 1), true);
    assert.equal(repoMd.imports.some((i) => i.raw_ref === "./sub.md" && i.exists && i.depth === 2), true);
    assert.equal(repoMd.imports.some((i) => i.raw_ref === "../CLAUDE.md" && i.cycle === true), true);
    assert.equal(repoMd.imports.some((i) => i.raw_ref === "docs/missing.md" && i.exists === false), true);
    assert.equal(repoMd.imports.some((i) => i.raw_ref === "docs/ignored-in-fence.md"), false);

    assert.equal(ctx.startup_footprint.always_rule_count, 1);
    assert.equal(ctx.startup_footprint.path_scoped_rule_count, 1);
    assert.deepEqual(ctx.rules.find((r) => r.name === "ts-only")?.paths, ["src/**/*.ts"]);

    const sharedStates = ctx.mcp_servers.filter((m) => m.server_id === "shared_srv");
    assert.equal(sharedStates.find((m) => m.precedence_layer === "local")?.status, "effective");
    assert.equal(sharedStates.find((m) => m.precedence_layer === "project")?.status, "shadowed");
    assert.equal(sharedStates.find((m) => m.precedence_layer === "user")?.status, "shadowed");
    assert.equal(sharedStates.find((m) => m.precedence_layer === "plugin")?.status, "shadowed");
    assert.equal(
      ctx.mcp_servers.find((m) => m.server_id === "blocked_proj_mcp")?.disabled_reason,
      "disabledMcpjsonServers",
    );
    assert.equal(ctx.mcp_servers.find((m) => m.server_id === "plugin_mcp")?.status, "effective");
    assert.equal(ctx.mcp_servers.find((m) => m.server_id === "plugin_mcp")?.from_plugin, "demo-kit@local");
    assert.equal(ctx.skills.some((s) => s.name === "plug-skill" && s.scope === "plugin"), true);
    assert.equal(ctx.subagents.some((a) => a.name === "plug-agent" && a.model === "haiku"), true);
    assert.equal(ctx.hooks.length, 2);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Codex native startup resolver enforces AGENTS.override.md shadowing, byte budget, and trust_level gate", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cchistory-startup-codex-"));
  try {
    const home = path.join(tmp, "home");
    const codexHome = path.join(home, ".codex");
    const repo = path.join(tmp, "repo");
    const sub = path.join(repo, "sub");
    const deep = path.join(sub, "deep");
    await initTempGitRepo(repo);
    await fs.mkdir(codexHome, { recursive: true });
    await fs.mkdir(path.join(repo, ".codex"), { recursive: true });
    await fs.mkdir(deep, { recursive: true });

    await fs.writeFile(path.join(repo, "AGENTS.md"), "shadowed root agents\n", "utf8");
    await fs.writeFile(path.join(repo, "AGENTS.override.md"), "A".repeat(70), "utf8");
    await fs.writeFile(path.join(sub, "TEAM.md"), "B".repeat(80), "utf8");
    await fs.writeFile(path.join(deep, "AGENTS.md"), "C".repeat(40), "utf8");

    const baseGlobalToml = [
      'model = "gpt-5-global"',
      "project_doc_max_bytes = 120",
      'project_doc_fallback_filenames = ["TEAM.md"]',
      "",
      "[profiles.fast]",
      'model = "gpt-5-mini"',
      "",
      "[mcp_servers.global_srv]",
      'command = "global-mcp"',
    ].join("\n");
    await fs.writeFile(path.join(codexHome, "config.toml"), baseGlobalToml, "utf8");
    await fs.writeFile(
      path.join(repo, ".codex", "config.toml"),
      ['model = "gpt-5-project"', "[mcp_servers.proj_srv]", 'command = "proj-mcp"'].join("\n"),
      "utf8",
    );

    // 1. Untrusted project: `.codex/config.toml` must be trust-gated
    const [untrustedRes] = await resolveAgentStartupContexts({
      homeDir: home,
      projectDir: deep,
      env: { CODEX_HOME: codexHome },
      agentRefs: ["codex"],
    });
    assert.ok(untrustedRes && untrustedRes.native.client === "codex");
    const untrusted = untrustedRes.native as CodexStartupContext;
    assert.equal(untrusted.config_cascade.project_config_trusted, false);
    assert.equal(untrusted.config_cascade.effective_model, "gpt-5-global");
    assert.equal(untrusted.mcp_servers.find((m) => m.server_id === "proj_srv")?.status, "trust_gated");
    assert.deepEqual(untrusted.config_cascade.profiles, ["fast"]);

    const rootShadowed = untrusted.instruction_chain.find((i) => i.path === path.join(repo, "AGENTS.md"));
    const rootOverride = untrusted.instruction_chain.find((i) => i.path === path.join(repo, "AGENTS.override.md"));
    const subFallback = untrusted.instruction_chain.find((i) => i.path === path.join(sub, "TEAM.md"));
    const deepExhausted = untrusted.instruction_chain.find((i) => i.path === path.join(deep, "AGENTS.md"));
    assert.equal(rootShadowed?.status, "shadowed");
    assert.equal(rootOverride?.status, "effective");
    assert.equal(rootOverride?.included_bytes, 70);
    assert.equal(subFallback?.status, "truncated");
    assert.equal(subFallback?.included_bytes, 50);
    assert.equal(subFallback?.dropped_bytes, 30);
    assert.equal(deepExhausted?.status, "budget_exhausted");
    assert.equal(deepExhausted?.included_bytes, 0);
    assert.equal(untrusted.startup_footprint.loaded_bytes, 120);
    assert.equal(untrusted.startup_footprint.truncated_file_count, 1);
    assert.equal(untrusted.startup_footprint.budget_exhausted_file_count, 1);

    // 2. Trusted project: `.codex/config.toml` becomes effective
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      `${baseGlobalToml}\n\n[projects."${repo}"]\ntrust_level = "trusted"\n`,
      "utf8",
    );
    const [trustedRes] = await resolveAgentStartupContexts({
      homeDir: home,
      projectDir: deep,
      env: { CODEX_HOME: codexHome },
      agentRefs: ["codex"],
    });
    const trusted = trustedRes!.native as CodexStartupContext;
    assert.equal(trusted.config_cascade.project_config_trusted, true);
    assert.equal(trusted.config_cascade.effective_model, "gpt-5-project");
    assert.equal(trusted.mcp_servers.find((m) => m.server_id === "proj_srv")?.status, "effective");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Google Antigravity native startup resolver enforces 24KB cap, 20k-token budget demotion, manifests, and plugin config.json override", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cchistory-startup-agy-"));
  try {
    const home = path.join(tmp, "home");
    const repo = path.join(tmp, "repo");
    const sharedSkills = path.join(tmp, "shared-skills");
    await initTempGitRepo(repo);
    await fs.mkdir(path.join(home, ".gemini", "antigravity"), { recursive: true });
    await fs.mkdir(path.join(repo, ".agents", "rules"), { recursive: true });
    await fs.mkdir(path.join(repo, ".agents", "plugins", "plug-a", "rules"), { recursive: true });
    await fs.mkdir(path.join(repo, ".agents", "plugins", "plug-a", "skills", "bundle-skill"), { recursive: true });
    await fs.mkdir(path.join(sharedSkills, "keep-me"), { recursive: true });
    await fs.mkdir(path.join(sharedSkills, "drop-me"), { recursive: true });

    // Create 4 large rules (> 24 KB each -> capped at 24 KB = 6000 tok each -> 4th demoted past 20,000 tok budget)
    for (const idx of [1, 2, 3, 4]) {
      await fs.writeFile(
        path.join(repo, ".agents", "rules", `0${idx}-big.md`),
        `# Rule ${idx}\n${"x".repeat(25_000)}`,
        "utf8",
      );
    }
    await fs.writeFile(path.join(repo, ".agents", "rules", "spec.md"), "# Spec\n", "utf8");
    await fs.writeFile(
      path.join(repo, ".agents", "rules", "05-glob.md"),
      "---\ntrigger: glob\nglobs:\n  - \"**/*.ts\"\n---\nSee @[Spec](./spec.md)\n",
      "utf8",
    );

    // skills.json with exclude filter
    await fs.writeFile(path.join(sharedSkills, "keep-me", "SKILL.md"), "---\nname: keep-me\n---\n", "utf8");
    await fs.writeFile(path.join(sharedSkills, "drop-me", "SKILL.md"), "---\nname: drop-me\n---\n", "utf8");
    await fs.writeFile(
      path.join(repo, ".agents", "skills.json"),
      JSON.stringify({ entries: [{ path: sharedSkills, exclude: ["drop-me"] }] }),
      "utf8",
    );

    // Plugin disabled in plugin.json, re-enabled in config.json (config.json wins)
    await fs.writeFile(
      path.join(repo, ".agents", "plugins", "plug-a", "plugin.json"),
      JSON.stringify({ name: "Plug A", disabled: true }),
      "utf8",
    );
    await fs.writeFile(
      path.join(repo, ".agents", "plugins", "plug-a", "skills", "bundle-skill", "SKILL.md"),
      "---\nname: bundle-skill\n---\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(repo, ".agents", "plugins", "plug-a", "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          plug_srv: {
            url: "https://user:agySecretPass@srv-local:8080/mcp?token=agyQuerySecret",
            headers: { Authorization: "Bearer agyHeaderSecret" },
          },
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(home, ".gemini", "antigravity", "config.json"),
      JSON.stringify({ plugins: { "plug-a": { enabled: true } } }),
      "utf8",
    );

    const [res] = await resolveAgentStartupContexts({
      homeDir: home,
      projectDir: repo,
      agentRefs: ["antigravity"],
    });
    assert.ok(res && res.native.client === "antigravity");
    const serialized = JSON.stringify(res);
    for (const secret of ["agySecretPass", "agyQuerySecret", "agyHeaderSecret"]) {
      assert.equal(serialized.includes(secret), false, `Antigravity secret leaked: ${secret}`);
    }

    const ctx = res.native as AntigravityStartupContext;
    assert.equal(ctx.startup_footprint.truncated_rule_count, 4);
    assert.equal(ctx.startup_footprint.demoted_rule_count >= 1, true);
    const globRule = ctx.rules.find((r) => r.name === "05-glob.md")!;
    assert.equal(globRule.trigger, "glob");
    assert.equal(globRule.budget_status, "on_demand");
    assert.equal(globRule.includes[0]?.label, "Spec");
    assert.equal(globRule.includes[0]?.exists, true);

    const plug = ctx.plugins.find((p) => p.dir_name === "plug-a")!;
    assert.equal(plug.enabled, true);
    assert.equal(plug.enabled_source, "config_json");
    assert.deepEqual(plug.bundled_skills, ["bundle-skill"]);
    assert.deepEqual(plug.bundled_mcp_servers, ["plug_srv"]);
    assert.equal(ctx.skills.some((s) => s.name === "keep-me"), true);
    assert.equal(ctx.skills.some((s) => s.name === "drop-me"), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("OpenCode native startup resolver handles JSONC cascade, CLAUDE.md fallback toggle, and v1/v2 MCP", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cchistory-startup-oc-"));
  try {
    const home = path.join(tmp, "home");
    const repo = path.join(tmp, "repo");
    await initTempGitRepo(repo);
    await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true });
    await fs.mkdir(path.join(repo, ".opencode"), { recursive: true });

    await fs.writeFile(
      path.join(home, ".config", "opencode", "opencode.jsonc"),
      `{\n  // global comment\n  "model": "anthropic/claude-sonnet",\n  "mcp": { "legacy_srv": { "type": "local", "command": ["npx", "legacy"], } },\n}`,
      "utf8",
    );
    await fs.writeFile(
      path.join(repo, ".opencode", "opencode.jsonc"),
      `{\n  "model": "openai/gpt-5",\n  "mcp": { "servers": { "v2_srv": { "type": "remote", "url": "https://oc-local:3000/mcp?key=ocSecret" } } },\n}`,
      "utf8",
    );
    await fs.writeFile(path.join(repo, "CLAUDE.md"), "# Fallback Claude instructions\n", "utf8");

    const [enabledRes] = await resolveAgentStartupContexts({
      homeDir: home,
      projectDir: repo,
      env: {},
      agentRefs: ["opencode"],
    });
    assert.equal(JSON.stringify(enabledRes).includes("ocSecret"), false);
    const enabledCtx = enabledRes!.native as OpenCodeStartupContext;
    assert.equal(enabledCtx.config_cascade.effective_model, "openai/gpt-5");
    assert.equal(enabledCtx.instructions.some((i) => i.source === "claude_md_fallback"), true);
    assert.equal(enabledCtx.mcp_servers.some((m) => m.server_id === "legacy_srv" && m.status === "effective"), true);
    assert.equal(enabledCtx.mcp_servers.some((m) => m.server_id === "v2_srv" && m.status === "effective"), true);

    const [disabledRes] = await resolveAgentStartupContexts({
      homeDir: home,
      projectDir: repo,
      env: { OPENCODE_DISABLE_CLAUDE_CODE: "1" },
      agentRefs: ["opencode"],
    });
    const disabledCtx = disabledRes!.native as OpenCodeStartupContext;
    assert.equal(disabledCtx.config_cascade.claude_md_fallback_disabled, true);
    assert.equal(disabledCtx.instructions.some((i) => i.source === "claude_md_fallback"), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("DeepSeek Harness native startup resolver parses Cordis YAML MCP, never reads .credentials.yaml, and handles unsupported tiers", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cchistory-startup-dsh-"));
  try {
    const home = path.join(tmp, "home");
    const dshHome = path.join(home, ".dsh");
    const repo = path.join(tmp, "repo");
    const canary = "CANARY_DSH_CREDENTIAL_NEVER_READ_999";
    await initTempGitRepo(repo);
    await fs.mkdir(path.join(dshHome, "profiles", "default"), { recursive: true });
    await fs.writeFile(path.join(dshHome, ".credentials.yaml"), `deepseek_api_key: "${canary}"\n`, "utf8");
    await fs.writeFile(
      path.join(dshHome, "profiles", "default", "cordis.yml"),
      [
        "plugins:",
        "  '@deepseek-ai/dsh-mcp-client:kb':",
        "    serverName: kb_search",
        "    transport: stdio",
        "    command: npx",
        "    args:",
        "      - -y",
        "      - '@demo/kb-mcp'",
        "      - --token=dshCliSecret",
        "    env:",
        "      KB_API_KEY: dshEnvSecretValue",
        "  '~@deepseek-ai/dsh-mcp-client:legacy':",
        "    serverName: legacy_disabled",
        "    url: https://dsh-local:8080/sse?token=dshUrlSecret",
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(repo, "AGENTS.md"), "# DSH Project Agents\n", "utf8");

    const results = await resolveAgentStartupContexts({
      homeDir: home,
      projectDir: repo,
      env: { DSH_HOME: dshHome },
      agentRefs: ["dsh", "gemini", "lobechat", "nonexistent_tool"],
    });
    const serialized = JSON.stringify(results);
    for (const secret of [canary, "dshCliSecret", "dshEnvSecretValue", "dshUrlSecret"]) {
      assert.equal(serialized.includes(secret), false, `DSH secret leaked: ${secret}`);
    }

    const dshRes = results.find((r) => r.client === "deepseek_harness")!;
    assert.equal(dshRes.resolution_tier, "native");
    assert.equal(dshRes.files_read.some((f) => f.path.endsWith(".credentials.yaml")), false);
    const dshCtx = dshRes.native as DeepSeekHarnessStartupContext;
    assert.equal(dshCtx.credentials_file_present, true);
    assert.equal(dshCtx.profiles.length, 1);
    assert.equal(dshCtx.cordis_layers.length, 1);
    const kb = dshCtx.mcp_servers.find((m) => m.server_id === "kb_search")!;
    assert.equal(kb.status, "effective");
    assert.deepEqual(kb.env_keys, ["KB_API_KEY"]);
    const legacy = dshCtx.mcp_servers.find((m) => m.server_id === "legacy_disabled")!;
    assert.equal(legacy.status, "disabled");
    assert.equal(legacy.disabled_reason, "cordis_disabled_prefix");

    assert.equal(results.find((r) => r.client === "gemini")?.resolution_tier, "basic");
    const lobe = results.find((r) => r.client === "lobechat")!;
    assert.equal(lobe.resolution_tier, "unsupported");
    assert.equal(lobe.diagnostics.length, 0);
    const unknown = results.find((r) => r.client === "nonexistent_tool")!;
    assert.equal(unknown.resolution_tier, "unsupported");
    assert.equal(unknown.diagnostics[0]?.code, "unknown_agent_ref");
    assert.equal(unknown.diagnostics[0]?.client, "nonexistent_tool");
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("Monorepo subdir resolves OpenCode root-relative instructions (including missing) and Claude Code root rules/.mcp.json", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cchistory-startup-subdir-"));
  try {
    const home = path.join(tmp, "home");
    const repo = path.join(tmp, "repo");
    const subApp = path.join(repo, "packages", "app");
    await initTempGitRepo(repo);
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(path.join(repo, "docs"), { recursive: true });
    await fs.mkdir(path.join(repo, ".claude", "rules"), { recursive: true });
    await fs.mkdir(path.join(repo, ".dsh"), { recursive: true });
    await fs.mkdir(subApp, { recursive: true });

    await fs.writeFile(path.join(repo, "docs", "extra.md"), "# Extra guide\n", "utf8");
    await fs.writeFile(
      path.join(repo, "opencode.jsonc"),
      JSON.stringify({ instructions: ["docs/extra.md", "docs/missing-guide.md"] }),
      "utf8",
    );
    await fs.writeFile(path.join(repo, ".claude", "rules", "root-rule.md"), "# Root rule\n", "utf8");
    await fs.writeFile(
      path.join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { root_mcp: { command: "echo", args: ["ok"] } } }),
      "utf8",
    );
    await fs.writeFile(
      path.join(repo, ".dsh", "cordis.yml"),
      "plugins:\n  '@deepseek-ai/dsh-mcp-client:proj':\n    serverName: proj_dsh_srv\n    command: dsh-mcp\n",
      "utf8",
    );

    const results = await resolveAgentStartupContexts({
      homeDir: home,
      projectDir: subApp,
      agentRefs: ["opencode", "claude_code", "deepseek_harness"],
    });
    const oc = results.find((r) => r.client === "opencode")!.native as OpenCodeStartupContext;
    assert.equal(
      oc.instructions.some((i) => i.source === "config_instructions" && i.path.endsWith(path.join("docs", "extra.md")) && i.exists !== false),
      true,
    );
    assert.equal(
      oc.instructions.some((i) => i.source === "config_instructions" && i.path.endsWith(path.join("docs", "missing-guide.md")) && i.exists === false),
      true,
    );

    const cc = results.find((r) => r.client === "claude_code")!.native as ClaudeCodeStartupContext;
    assert.equal(cc.rules.some((r) => r.name === "root-rule"), true);
    assert.equal(cc.mcp_servers.some((m) => m.server_id === "root_mcp" && m.status === "effective"), true);

    const dsh = results.find((r) => r.client === "deepseek_harness")!.native as DeepSeekHarnessStartupContext;
    assert.equal(dsh.cordis_layers.some((l) => l.layer === "project_dsh"), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
