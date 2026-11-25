/**
 * Role: Unit tests for TOML parsing, MCP command/URL secret redaction, read-only
 * AI agent config/extension discovery, and local Git metadata inspection.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectLocalProjectGitMetadata } from "../core/git-project.js";
import { readAgentConfigInventory } from "./agent-config-reader.js";
import { extractSecretKeyNames, redactMcpCommand, redactMcpUrl } from "./redaction.js";
import { parseToml, TomlParseError } from "./toml.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "mock_data", "fixtures", "agent-inventory");

test("parseToml parses tables, quoted keys, inline tables, arrays, and multiline values", () => {
  const parsed = parseToml(`
    # Top comment
    model = "gpt-5"

    [mcp_servers."uptime.kuma"]
    url = 'https://kuma.example.test/sse'
    args = [
      "--mode",
      "ro", # inline comment
    ]
    env = { TOKEN = "secret", PORT = 8080, ENABLED = true }
  `);

  assert.equal(parsed.model, "gpt-5");
  const servers = parsed.mcp_servers as Record<string, Record<string, unknown>>;
  const kuma = servers["uptime.kuma"]!;
  assert.equal(kuma.url, "https://kuma.example.test/sse");
  assert.deepEqual(kuma.args, ["--mode", "ro"]);
  assert.deepEqual(kuma.env, { TOKEN: "secret", PORT: 8080, ENABLED: true });

  assert.throws(() => parseToml("[unterminated"), TomlParseError);
});

test("redaction strips basic auth, query tokens, env values, header values, and secret flags", () => {
  assert.equal(
    redactMcpUrl("https://alice:s3cr3t@mcp.example.test/sse?token=abc123&mode=ro#frag"),
    "https://mcp.example.test/sse?token=<redacted>&mode=<redacted>",
  );
  const cmd = redactMcpCommand("node", [
    "server.js",
    "--token",
    "secret_val_1",
    "--api-key=secret_val_2",
    "MY_ENV=secret_val_3",
    "-H",
    "Authorization: Bearer abcdefghijklmnop",
    "https://u:p@host.test/api?key=secret_val_4",
  ]);
  assert.ok(cmd);
  for (const secret of ["secret_val_1", "secret_val_2", "secret_val_3", "secret_val_4", "abcdefghijklmnop", ":p@"]) {
    assert.equal(cmd.includes(secret), false, `Expected secret ${secret} to be stripped from ${cmd}`);
  }
  assert.equal(cmd.includes("MY_ENV=<redacted>"), true);
  assert.equal(cmd.includes("--api-key=<redacted>"), true);

  assert.deepEqual(
    extractSecretKeyNames({ Z_KEY: "v1", A_KEY: "v2" }),
    ["A_KEY", "Z_KEY"],
  );
});

test("readAgentConfigInventory discovers sanitized fixture configs, extensions, and never leaks values", async () => {
  const result = await readAgentConfigInventory({
    homeDir: path.join(FIXTURE_ROOT, "home"),
    projectDir: path.join(FIXTURE_ROOT, "project"),
  });

  assert.equal(result.diagnostics.length, 0);
  const configuredClients = result.agents.filter((a) => a.configured).map((a) => a.client);
  assert.deepEqual(configuredClients, [
    "codex",
    "claude_code",
    "grok",
    "antigravity",
    "opencode",
    "deepseek_harness",
  ]);

  const serialized = JSON.stringify(result);
  for (const secret of ["mock_env_secret_portainer", "mock_query_secret", "mock_header_secret_oc", "mock_project_cli_secret"]) {
    assert.equal(serialized.includes(secret), false, `Fixture secret leaked: ${secret}`);
  }

  // Verify Antigravity ~/.gemini/antigravity/mcp_config.json path variant too
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "cchistory-agy-variant-"));
  try {
    await fs.mkdir(path.join(tmpHome, ".gemini", "antigravity"), { recursive: true });
    await fs.writeFile(
      path.join(tmpHome, ".gemini", "antigravity", "mcp_config.json"),
      JSON.stringify({ mcpServers: { local_kuma: { url: "https://kuma.local/mcp?token=hiddenVal" } } }),
      "utf8",
    );
    const variantResult = await readAgentConfigInventory({ homeDir: tmpHome });
    const srv = variantResult.mcp_servers.find((s) => s.server_id === "local_kuma");
    assert.ok(srv);
    assert.equal(srv.client, "antigravity");
    assert.equal(srv.url, "https://kuma.local/mcp?token=<redacted>");
    assert.equal(JSON.stringify(variantResult).includes("hiddenVal"), false);
  } finally {
    await fs.rm(tmpHome, { recursive: true, force: true });
  }
});

test("inspectLocalProjectGitMetadata reports missing_path and not_git cleanly", async () => {
  const missing = await inspectLocalProjectGitMetadata("/path/that/definitely/does/not/exist-cchistory");
  assert.equal(missing.status, "missing_path");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cchistory-notgit-"));
  try {
    const notGit = await inspectLocalProjectGitMetadata(tmpDir);
    assert.equal(notGit.status, "not_git");
    assert.equal(notGit.repo_remote, null);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
