/**
 * Role: Integration tests for CLI `inventory`, `ls projects --with-git`, and
 * `merge-projects` covering sanitized mock_data fixtures, adversarial secret redaction,
 * real local Git metadata inspection, and v1 envelope output contracts.
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LiveHistorySnapshot, type ScanLiteHistoryOptions } from "@cchistory/live-runtime";
import { runLiteCli, type LiteCliIo } from "./index.js";

const execFile = promisify(execFileCallback);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_ROOT = path.join(REPO_ROOT, "mock_data", "fixtures", "agent-inventory");
const FIXTURE_HOME = path.join(FIXTURE_ROOT, "home");
const FIXTURE_PROJECT = path.join(FIXTURE_ROOT, "project");

function createCaptureIo(overrides: Partial<LiteCliIo> = {}) {
  let stdout = "";
  let stderr = "";
  const io: LiteCliIo = {
    cwd: REPO_ROOT,
    homeDir: FIXTURE_HOME,
    hostname: "test-host",
    isTTY: false,
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    now: () => Date.parse("2026-11-25T12:00:00.000Z"),
    ...overrides,
  };
  return {
    io,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

function createFixtureActivitySnapshot(): LiveHistorySnapshot {
  return new LiveHistorySnapshot({
    host: {
      id: "test-host",
      hostname: "test-host",
      first_seen: "2026-11-24T09:00:00.000Z",
      last_seen: "2026-11-25T10:00:00.000Z",
    },
    sources: [
      {
        id: "src:codex",
        slot_id: "codex",
        family: "local_coding_agent",
        platform: "codex",
        display_name: "Codex",
        base_dir: path.join(FIXTURE_HOME, ".codex", "sessions"),
        host_id: "test-host",
        last_sync: "2026-11-25T10:00:00.000Z",
        sync_status: "healthy",
        total_blobs: 1,
        total_records: 1,
        total_fragments: 1,
        total_atoms: 1,
        total_sessions: 1,
        total_turns: 1,
      },
      {
        id: "src:claude_code",
        slot_id: "claude_code",
        family: "local_coding_agent",
        platform: "claude_code",
        display_name: "Claude Code",
        base_dir: path.join(FIXTURE_HOME, ".claude", "projects"),
        host_id: "test-host",
        last_sync: "2026-11-25T10:00:00.000Z",
        sync_status: "healthy",
        total_blobs: 1,
        total_records: 1,
        total_fragments: 1,
        total_atoms: 1,
        total_sessions: 1,
        total_turns: 1,
      },
    ],
    projects: [],
    sessions: [
      {
        id: "sess:codex:fixture-1",
        source_id: "src:codex",
        host_id: "test-host",
        source_platform: "codex",
        title: "Check containers",
        canonical_title: "Check containers",
        created_at: "2026-11-24T09:00:00.000Z",
        updated_at: "2026-11-24T09:10:00.000Z",
        turn_count: 1,
        sync_axis: "current",
        working_directory: FIXTURE_PROJECT,
        usage_events: [
          {
            id: "ev-codex-1",
            turn_id: "turn:codex:1",
            created_at: "2026-11-24T09:05:00.000Z",
            token_usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            emitted_tool_calls: [{ tool_name: "mcp__portainer_ro__list_containers", status: "success" }],
          },
        ],
      },
      {
        id: "sess:claude_code:fixture-1",
        source_id: "src:claude_code",
        host_id: "test-host",
        source_platform: "claude_code",
        title: "Read repo",
        canonical_title: "Read repo",
        created_at: "2026-11-24T11:00:00.000Z",
        updated_at: "2026-11-24T11:10:00.000Z",
        turn_count: 1,
        sync_axis: "current",
        working_directory: FIXTURE_PROJECT,
        tool_usage_summary: [
          { tool_name: "mcp__filesystem__read_file", call_count: 4, last_used_at: "2026-11-24T11:08:00.000Z" },
        ],
      },
    ],
    turns: [
      {
        id: "turn:codex:1",
        revision_id: "turn:codex:1:r1",
        turn_id: "turn:codex:1",
        turn_revision_id: "turn:codex:1:r1",
        user_messages: [],
        raw_text: "check containers",
        canonical_text: "check containers",
        display_segments: [],
        created_at: "2026-11-24T09:00:00.000Z",
        submission_started_at: "2026-11-24T09:00:00.000Z",
        last_context_activity_at: "2026-11-24T09:10:00.000Z",
        session_id: "sess:codex:fixture-1",
        source_id: "src:codex",
        link_state: "unlinked",
        sync_axis: "current",
        value_axis: "active",
        retention_axis: "keep_raw_and_derived",
        context_ref: "ctx:1",
        context_summary: { assistant_reply_count: 1, tool_call_count: 1, total_tokens: 150, has_errors: false },
        lineage: { atom_refs: [], candidate_refs: [], fragment_refs: [], record_refs: [], blob_refs: [] },
      },
      {
        id: "turn:claude:1",
        revision_id: "turn:claude:1:r1",
        turn_id: "turn:claude:1",
        turn_revision_id: "turn:claude:1:r1",
        user_messages: [],
        raw_text: "read files",
        canonical_text: "read files",
        display_segments: [],
        created_at: "2026-11-24T11:00:00.000Z",
        submission_started_at: "2026-11-24T11:00:00.000Z",
        last_context_activity_at: "2026-11-24T11:10:00.000Z",
        session_id: "sess:claude_code:fixture-1",
        source_id: "src:claude_code",
        link_state: "unlinked",
        sync_axis: "current",
        value_axis: "active",
        retention_axis: "keep_raw_and_derived",
        context_ref: "ctx:2",
        context_summary: { assistant_reply_count: 1, tool_call_count: 4, has_errors: false },
        lineage: { atom_refs: [], candidate_refs: [], fragment_refs: [], record_refs: [], blob_refs: [] },
      },
    ],
    contexts: [],
    ask_user_question_turns: [],
    loss_audits: [],
  });
}

test("CLI inventory scans mock_data fixtures, correlates 30d activity, emits envelope, and leaks zero secrets", async () => {
  const fixtureSecrets = [
    "mock_cli_arg_secret",
    "mock_env_secret_portainer",
    "mockpass",
    "mock_query_secret",
    "mock_header_secret_kuma",
    "mock_env_secret_fs",
    "mock_db_query_secret",
    "mock_header_secret_db",
    "mock_grok_query_secret",
    "mock_env_secret_grok",
    "agypass",
    "mock_agy_query_secret",
    "mock_header_secret_agy",
    "mock_env_secret_unused",
    "mock_oc_query_secret",
    "mock_header_secret_oc",
    "mock_env_secret_oc",
    "mock_env_secret_dsh",
    "mock_project_cli_secret",
    "mock_env_secret_project",
  ];

  const mockScan = async (_options: ScanLiteHistoryOptions) => createFixtureActivitySnapshot();

  // 1. Standard JSON output
  const jsonRun = createCaptureIo({ scan: mockScan });
  const jsonExit = await runLiteCli(
    ["inventory", "--home", FIXTURE_HOME, "--dir", FIXTURE_PROJECT, "--since", "30d", "--json"],
    jsonRun.io,
  );
  assert.equal(jsonExit, 0, jsonRun.stderr);
  for (const secret of fixtureSecrets) {
    assert.equal(jsonRun.stdout.includes(secret), false, `Secret leaked in --json output: ${secret}`);
  }

  const parsed = JSON.parse(jsonRun.stdout);
  assert.equal(parsed.schema, "cchistory-lite-inventory/v1");
  assert.equal(parsed.summary.configured_agent_count, 6);
  assert.equal(parsed.summary.mcp_server_count, 11);
  assert.equal(parsed.summary.used_mcp_server_count, 2);
  assert.equal(parsed.summary.unused_mcp_server_count, 9);
  assert.ok(parsed.summary.skill_count >= 4);
  assert.ok(parsed.summary.subagent_count >= 4);
  assert.ok(parsed.summary.plugin_count >= 4);
  assert.ok(parsed.summary.hook_count >= 2);
  assert.ok(parsed.summary.rule_count >= 1);

  const byKey = new Map<string, Record<string, unknown>>(
    parsed.mcp_servers.map((s: Record<string, unknown>) => [`${s.client}:${s.server_id}`, s]),
  );
  const codexPortainer = byKey.get("codex:portainer_ro")!;
  assert.equal(codexPortainer.used_in_window, true);
  assert.equal(codexPortainer.call_count, 1);
  assert.deepEqual(codexPortainer.env_keys, ["PORTAINER_TOKEN", "PORTAINER_URL"]);
  assert.equal(String(codexPortainer.command).includes("--token=<redacted>"), true);

  const codexKuma = byKey.get("codex:uptime_kuma")!;
  assert.equal(codexKuma.used_in_window, false);
  assert.equal(codexKuma.url, "https://kuma-local:3001/sse?api_key=<redacted>&mode=<redacted>");
  assert.deepEqual(codexKuma.header_keys, ["Authorization"]);

  // 2. Shared read-only v1 JSON envelope
  const envRun = createCaptureIo({ scan: mockScan });
  const envExit = await runLiteCli(
    ["inventory", "--home", FIXTURE_HOME, "--dir", FIXTURE_PROJECT, "--envelope", "--host-id", "mac-mini-lab"],
    envRun.io,
  );
  assert.equal(envExit, 0, envRun.stderr);
  for (const secret of fixtureSecrets) {
    assert.equal(envRun.stdout.includes(secret), false, `Secret leaked in --envelope output: ${secret}`);
  }
  const envelope = JSON.parse(envRun.stdout);
  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.domain, "ai_agents");
  assert.equal(envelope.owner, "cchistory-lite");
  assert.equal(envelope.host_id, "mac-mini-lab");
  assert.equal(envelope.stale_after_seconds, 86400);
  assert.equal(envelope.status, "ok");
  assert.equal(envelope.error, null);
  assert.equal(envelope.delta, null);
  assert.ok(Array.isArray(envelope.items) && envelope.items.length > 15);

  // 3. Human-readable output with --no-activity (must not invoke scan!)
  let scanCalled = false;
  const textRun = createCaptureIo({
    scan: async () => {
      scanCalled = true;
      return createFixtureActivitySnapshot();
    },
  });
  const textExit = await runLiteCli(
    ["inventory", "--home", FIXTURE_HOME, "--no-activity"],
    textRun.io,
  );
  assert.equal(textExit, 0, textRun.stderr);
  assert.equal(scanCalled, false);
  assert.match(textRun.stdout, /Agent Inventory/u);
  assert.match(textRun.stdout, /MCP Servers/u);
  assert.match(textRun.stdout, /Subagents/u);
  assert.match(textRun.stdout, /Plugins/u);
  for (const secret of fixtureSecrets) {
    assert.equal(textRun.stdout.includes(secret), false, `Secret leaked in human text output: ${secret}`);
  }
});

test("CLI inventory redacts adversarial real-shaped tokens and reports corrupt config diagnostics", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cchistory-inv-redaction-"));
  try {
    const fakeJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signatureVal1234";
    const fakeOpenAiKey = "sk-proj-TestRedactionSecretValue1234567890";
    const fakeGhPat = "ghp_TestRedactionSecretValue1234567890";

    await fs.mkdir(path.join(tmpRoot, ".codex"), { recursive: true });
    await fs.mkdir(path.join(tmpRoot, ".grok"), { recursive: true });
    await fs.writeFile(
      path.join(tmpRoot, ".codex", "config.toml"),
      [
        "[mcp_servers.adv_stdio]",
        'command = "mcp-runner"',
        `args = ["-H", "Authorization: Bearer ${fakeJwt}", "--api-key", "${fakeOpenAiKey}", "SECRET_ENV=${fakeGhPat}", "https://admin:topSecret99@api.example.test/mcp?token=querySecret42"]`,
        `env = { OPENAI_API_KEY = "${fakeOpenAiKey}", GH_TOKEN = "${fakeGhPat}" }`,
      ].join("\n"),
      "utf8",
    );
    await fs.writeFile(path.join(tmpRoot, ".grok", "config.toml"), "[mcp_servers.broken\nnot valid toml", "utf8");

    const run = createCaptureIo({ homeDir: tmpRoot });
    const exit = await runLiteCli(
      ["inventory", "--home", tmpRoot, "--no-activity", "--envelope", "--host-id", "audit-host"],
      run.io,
    );
    assert.equal(exit, 0, run.stderr);
    for (const secret of [fakeJwt, fakeOpenAiKey, fakeGhPat, "topSecret99", "querySecret42"]) {
      assert.equal(run.stdout.includes(secret), false, `Adversarial secret leaked: ${secret}`);
    }
    const env = JSON.parse(run.stdout);
    assert.equal(env.status, "partial");
    assert.equal(env.summary.diagnostic_count, 1);
    const server = env.items.find((i: Record<string, unknown>) => i.item_type === "mcp_server");
    assert.deepEqual(server.env_keys, ["GH_TOKEN", "OPENAI_API_KEY"]);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("CLI ls projects --with-git and merge-projects reconcile real local Git repos and non-Git fallback", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cchistory-git-meta-"));
  try {
    const bareRemote = path.join(tmpRoot, "remote.git");
    const repoHostA = path.join(tmpRoot, "host-a", "demo-app");
    const repoHostB = path.join(tmpRoot, "host-b", "demo-app");
    const nonGitA = path.join(tmpRoot, "host-a", "scratch-notes");
    const nonGitB = path.join(tmpRoot, "host-b", "scratch-notes");
    await fs.mkdir(path.dirname(repoHostA), { recursive: true });
    await fs.mkdir(path.dirname(repoHostB), { recursive: true });
    await fs.mkdir(nonGitA, { recursive: true });
    await fs.mkdir(nonGitB, { recursive: true });

    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "Mock Dev",
      GIT_AUTHOR_EMAIL: "mock@example.test",
      GIT_COMMITTER_NAME: "Mock Dev",
      GIT_COMMITTER_EMAIL: "mock@example.test",
    };

    await execFile("git", ["init", "--bare", bareRemote], { env: gitEnv });
    await execFile("git", ["clone", bareRemote, repoHostA], { env: gitEnv });
    await execFile("git", ["-C", repoHostA, "checkout", "-b", "main"], { env: gitEnv });
    await fs.writeFile(path.join(repoHostA, "README.md"), "# Demo\n", "utf8");
    await execFile("git", ["-C", repoHostA, "add", "README.md"], { env: gitEnv });
    await execFile("git", ["-C", repoHostA, "commit", "-m", "init"], {
      env: { ...gitEnv, GIT_AUTHOR_DATE: "2026-11-20T10:00:00Z", GIT_COMMITTER_DATE: "2026-11-20T10:00:00Z" },
    });
    await execFile("git", ["-C", repoHostA, "push", "-u", "origin", "main"], { env: gitEnv });

    // Clone Host B on main, then switch to feature branch so branches diverge
    await execFile("git", ["clone", bareRemote, repoHostB], { env: gitEnv });
    await execFile("git", ["-C", repoHostB, "checkout", "-b", "feat/remote-branch"], { env: gitEnv });

    // Advance Host A with an unpushed commit and a dirty untracked file
    await fs.writeFile(path.join(repoHostA, "README.md"), "# Demo updated\n", "utf8");
    await execFile("git", ["-C", repoHostA, "commit", "-am", "ahead commit"], {
      env: { ...gitEnv, GIT_AUTHOR_DATE: "2026-11-24T12:00:00Z", GIT_COMMITTER_DATE: "2026-11-24T12:00:00Z" },
    });
    await fs.writeFile(path.join(repoHostA, "dirty.txt"), "uncommitted\n", "utf8");

    // Set distinct URL formats on origin so canonical remote matching is exercised end-to-end
    await execFile("git", ["-C", repoHostA, "remote", "set-url", "origin", "https://tokUser:tokPass@github.com/ExampleOrg/Demo-App.git"], { env: gitEnv });
    await execFile("git", ["-C", repoHostB, "remote", "set-url", "origin", "git@github.com:exampleorg/demo-app.git"], { env: gitEnv });

    const makeSnapshot = (hostId: string, repoPath: string, nonGitPath: string, lastActivity: string) =>
      new LiveHistorySnapshot({
        host: {
          id: hostId,
          hostname: hostId,
          first_seen: "2026-11-20T10:00:00.000Z",
          last_seen: lastActivity,
        },
        sources: [
          {
            id: `src:${hostId}:codex`,
            slot_id: "codex",
            family: "local_coding_agent",
            platform: "codex",
            display_name: "Codex",
            base_dir: path.join(tmpRoot, hostId, ".codex"),
            host_id: hostId,
            last_sync: lastActivity,
            sync_status: "healthy",
            total_blobs: 2,
            total_records: 2,
            total_fragments: 2,
            total_atoms: 2,
            total_sessions: 2,
            total_turns: 2,
          },
        ],
        projects: [
          {
            project_id: `proj:${hostId}:demo`,
            project_revision_id: `proj:${hostId}:demo:r1`,
            display_name: "demo-app",
            slug: "demo-app",
            linkage_state: "committed",
            confidence: 0.9,
            link_reason: "repo_root_match",
            manual_override_status: "none",
            primary_workspace_path: repoPath,
            repo_root: repoPath,
            source_platforms: ["codex"],
            host_ids: [hostId],
            committed_turn_count: 1,
            candidate_turn_count: 0,
            session_count: 1,
            project_last_activity_at: lastActivity,
            created_at: "2026-11-20T10:00:00.000Z",
            updated_at: lastActivity,
          },
          {
            project_id: `proj:${hostId}:scratch`,
            project_revision_id: `proj:${hostId}:scratch:r1`,
            display_name: "scratch-notes",
            slug: "scratch-notes",
            linkage_state: "candidate",
            confidence: 0.6,
            link_reason: "workspace_path_continuity",
            manual_override_status: "none",
            primary_workspace_path: nonGitPath,
            source_platforms: ["codex"],
            host_ids: [hostId],
            committed_turn_count: 0,
            candidate_turn_count: 1,
            session_count: 1,
            project_last_activity_at: "2026-11-22T08:00:00.000Z",
            created_at: "2026-11-20T10:00:00.000Z",
            updated_at: "2026-11-22T08:00:00.000Z",
          },
        ],
        sessions: [
          {
            id: `sess:${hostId}:demo`,
            source_id: `src:${hostId}:codex`,
            host_id: hostId,
            source_platform: "codex",
            title: "Demo work",
            canonical_title: "Demo work",
            created_at: lastActivity,
            updated_at: lastActivity,
            turn_count: 1,
            working_directory: repoPath,
            primary_project_id: `proj:${hostId}:demo`,
            sync_axis: "current",
          },
          {
            id: `sess:${hostId}:scratch`,
            source_id: `src:${hostId}:codex`,
            host_id: hostId,
            source_platform: "codex",
            title: "Scratch notes",
            canonical_title: "Scratch notes",
            created_at: "2026-11-22T08:00:00.000Z",
            updated_at: "2026-11-22T08:00:00.000Z",
            turn_count: 1,
            working_directory: nonGitPath,
            primary_project_id: `proj:${hostId}:scratch`,
            sync_axis: "current",
          },
        ],
        turns: [
          {
            id: `turn:${hostId}:demo`,
            revision_id: `turn:${hostId}:demo:r1`,
            turn_id: `turn:${hostId}:demo`,
            turn_revision_id: `turn:${hostId}:demo:r1`,
            user_messages: [],
            raw_text: "update demo",
            canonical_text: "update demo",
            display_segments: [],
            created_at: lastActivity,
            submission_started_at: lastActivity,
            last_context_activity_at: lastActivity,
            session_id: `sess:${hostId}:demo`,
            source_id: `src:${hostId}:codex`,
            project_id: `proj:${hostId}:demo`,
            link_state: "committed",
            sync_axis: "current",
            value_axis: "active",
            retention_axis: "keep_raw_and_derived",
            context_ref: `ctx:${hostId}:demo`,
            context_summary: { assistant_reply_count: 1, tool_call_count: 0, has_errors: false },
            lineage: { atom_refs: [], candidate_refs: [], fragment_refs: [], record_refs: [], blob_refs: [] },
          },
          {
            id: `turn:${hostId}:scratch`,
            revision_id: `turn:${hostId}:scratch:r1`,
            turn_id: `turn:${hostId}:scratch`,
            turn_revision_id: `turn:${hostId}:scratch:r1`,
            user_messages: [],
            raw_text: "jot note",
            canonical_text: "jot note",
            display_segments: [],
            created_at: "2026-11-22T08:00:00.000Z",
            submission_started_at: "2026-11-22T08:00:00.000Z",
            last_context_activity_at: "2026-11-22T08:00:00.000Z",
            session_id: `sess:${hostId}:scratch`,
            source_id: `src:${hostId}:codex`,
            project_id: `proj:${hostId}:scratch`,
            link_state: "candidate",
            sync_axis: "current",
            value_axis: "active",
            retention_axis: "keep_raw_and_derived",
            context_ref: `ctx:${hostId}:scratch`,
            context_summary: { assistant_reply_count: 1, tool_call_count: 0, has_errors: false },
            lineage: { atom_refs: [], candidate_refs: [], fragment_refs: [], record_refs: [], blob_refs: [] },
          },
        ],
        contexts: [],
        ask_user_question_turns: [],
        loss_audits: [],
      });

    // Without --with-git: must NOT attach git metadata
    const plainRun = createCaptureIo({
      hostname: "host-a",
      scan: async () => makeSnapshot("host-a", repoHostA, nonGitA, "2026-11-25T08:00:00.000Z"),
    });
    assert.equal(await runLiteCli(["ls", "projects", "--no-dir", "--json"], plainRun.io), 0, plainRun.stderr);
    const plainJson = JSON.parse(plainRun.stdout);
    assert.equal(plainJson.projects[0].git, undefined);

    // Host A with --with-git --json
    const runA = createCaptureIo({
      hostname: "host-a",
      scan: async () => makeSnapshot("host-a", repoHostA, nonGitA, "2026-11-25T08:00:00.000Z"),
    });
    assert.equal(
      await runLiteCli(["ls", "projects", "--no-dir", "--with-git", "--host-id", "host-a", "--json"], runA.io),
      0,
      runA.stderr,
    );
    assert.equal(runA.stdout.includes("tokPass"), false, "Embedded git remote password leaked!");
    const jsonA = JSON.parse(runA.stdout);
    assert.equal(jsonA.host_id, "host-a");
    const demoA = jsonA.projects.find((p: Record<string, unknown>) => p.display_name === "demo-app");
    assert.equal(demoA.git.status, "ok");
    assert.equal(demoA.git.repo_remote, "github.com/exampleorg/demo-app");
    assert.equal(demoA.git.branch, "main");
    assert.equal(demoA.git.dirty_files, 1);
    assert.equal(demoA.git.ahead, 1);
    assert.equal(demoA.git.behind, 0);

    // Host B with --with-git --envelope
    const runB = createCaptureIo({
      hostname: "host-b",
      scan: async () => makeSnapshot("host-b", repoHostB, nonGitB, "2026-11-24T09:00:00.000Z"),
    });
    assert.equal(
      await runLiteCli(["ls", "projects", "--no-dir", "--with-git", "--envelope", "--host-id", "host-b"], runB.io),
      0,
      runB.stderr,
    );
    const envB = JSON.parse(runB.stdout);
    assert.equal(envB.schema_version, 1);
    assert.equal(envB.domain, "projects");
    assert.equal(envB.delta, null);

    // Write both files and merge them via `merge-projects` (proving mixed v2 + envelope input compatibility!)
    const fileA = path.join(tmpRoot, "host-a.json");
    const fileB = path.join(tmpRoot, "host-b.json");
    await fs.writeFile(fileA, runA.stdout, "utf8");
    await fs.writeFile(fileB, runB.stdout, "utf8");

    const mergeRun = createCaptureIo({ cwd: tmpRoot });
    assert.equal(await runLiteCli(["merge-projects", "host-a.json", "host-b.json", "--json"], mergeRun.io), 0, mergeRun.stderr);
    const merged = JSON.parse(mergeRun.stdout);
    assert.equal(merged.schema, "cchistory-lite-merged-projects/v1");
    assert.deepEqual(merged.hosts, ["host-a", "host-b"]);
    assert.equal(merged.summary.project_count, 2);
    assert.equal(merged.summary.repo_remote_matched_count, 1);
    assert.equal(merged.summary.directory_fallback_count, 1);
    assert.equal(merged.summary.diverged_project_count, 1);

    const demoMerged = merged.projects.find((p: Record<string, unknown>) => p.match_kind === "repo_remote");
    assert.equal(demoMerged.repo_remote, "github.com/exampleorg/demo-app");
    assert.equal(demoMerged.latest_commit_host, "host-a");
    assert.equal(demoMerged.branch_diverged, true);
    assert.deepEqual(demoMerged.dirty_hosts, ["host-a"]);
    assert.deepEqual(demoMerged.unpushed_hosts, ["host-a"]);

    const scratchMerged = merged.projects.find((p: Record<string, unknown>) => p.match_kind === "directory_fallback");
    assert.deepEqual(scratchMerged.host_ids, ["host-a", "host-b"]);
    assert.equal(scratchMerged.sync_state, "non_git");

    // Human-readable merge-projects output
    const mergeTextRun = createCaptureIo({ cwd: tmpRoot });
    assert.equal(await runLiteCli(["merge-projects", "host-a.json", "host-b.json"], mergeTextRun.io), 0, mergeTextRun.stderr);
    assert.match(mergeTextRun.stdout, /Merged Projects/u);
    assert.match(mergeTextRun.stdout, /branch diverged/u);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("CLI rejects invalid Slice A/B option combinations with exit code 2", async () => {
  const r1 = createCaptureIo();
  assert.equal(await runLiteCli(["ls", "sessions", "--with-git"], r1.io), 2);

  const r2 = createCaptureIo();
  assert.equal(await runLiteCli(["stats", "--no-activity"], r2.io), 2);

  const r3 = createCaptureIo();
  assert.equal(await runLiteCli(["inventory", "--json=canonical"], r3.io), 2);

  const r4 = createCaptureIo();
  assert.equal(await runLiteCli(["merge-projects"], r4.io), 2);

  const r5 = createCaptureIo();
  assert.equal(await runLiteCli(["merge-projects", "a.json", "--safe"], r5.io), 2);

  const r6 = createCaptureIo();
  assert.equal(await runLiteCli(["stats", "--agent", "codex"], r6.io), 2);
});

test("CLI inventory --agent and --dir resolve native per-tool pre-launch startup contexts in JSON and human output", async () => {
  const jsonRun = createCaptureIo();
  const jsonExit = await runLiteCli(
    [
      "inventory",
      "--home",
      FIXTURE_HOME,
      "--dir",
      FIXTURE_PROJECT,
      "--agent",
      "claude_code",
      "--agent",
      "codex",
      "--agent",
      "lobechat",
      "--no-activity",
      "--json",
    ],
    jsonRun.io,
  );
  assert.equal(jsonExit, 0, jsonRun.stderr);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.ok(Array.isArray(parsed.startup_contexts));
  assert.equal(parsed.startup_contexts.length, 3);
  assert.equal(parsed.startup_contexts[0].client, "claude_code");
  assert.equal(parsed.startup_contexts[0].resolution_tier, "native");
  assert.equal(parsed.startup_contexts[1].client, "codex");
  assert.equal(parsed.startup_contexts[1].resolution_tier, "native");
  assert.equal(parsed.startup_contexts[2].client, "lobechat");
  assert.equal(parsed.startup_contexts[2].resolution_tier, "unsupported");

  // Human rendering preserves each tool's native headings & budget/chain labels
  const textRun = createCaptureIo();
  const textExit = await runLiteCli(
    [
      "inventory",
      "--home",
      FIXTURE_HOME,
      "--dir",
      FIXTURE_PROJECT,
      "--agent",
      "claude_code",
      "--agent",
      "codex",
      "--no-activity",
    ],
    textRun.io,
  );
  assert.equal(textExit, 0, textRun.stderr);
  assert.match(textRun.stdout, /Pre-Launch Startup Contexts/u);
  assert.match(textRun.stdout, /Claude Code \[claude_code\]/u);
  assert.match(textRun.stdout, /Codex \[codex\] · doc budget/u);
  // Focused --agent mode must NOT dump unrelated full-machine sections
  assert.equal(textRun.stdout.includes("\nAgents\n"), false);
  assert.equal(textRun.stdout.includes("mock_project_cli_secret"), false);
  assert.equal(textRun.stdout.includes("mock_env_secret_portainer"), false);
});

test("CLI enforces P0/P1 UX invariants: --agent cwd default, unknown --agent exit 2, invariant MCP counts, envelope all-rows & error format, duplicate host_id exit 2", async () => {
  // 1. Unknown --agent and nonexistent --dir must exit 2
  const badAgent = createCaptureIo();
  assert.equal(await runLiteCli(["inventory", "--home", FIXTURE_HOME, "--agent", "definitely_unknown", "--no-activity"], badAgent.io), 2);
  assert.match(badAgent.stderr, /Unknown --agent/u);

  const badDir = createCaptureIo();
  assert.equal(await runLiteCli(["inventory", "--home", FIXTURE_HOME, "--dir", "/tmp/nonexistent-dir-xyz-987654", "--no-activity"], badDir.io), 2);

  // 2. --agent without --dir defaults to io.cwd; --no-dir switches to global scope
  const cwdDefaultRun = createCaptureIo({ cwd: FIXTURE_PROJECT });
  assert.equal(await runLiteCli(["inventory", "--home", FIXTURE_HOME, "--agent", "claude", "--no-activity", "--json"], cwdDefaultRun.io), 0, cwdDefaultRun.stderr);
  const cwdDefaultJson = JSON.parse(cwdDefaultRun.stdout);
  assert.equal(cwdDefaultJson.project_dir, FIXTURE_PROJECT);
  assert.equal(cwdDefaultJson.startup_contexts[0].client, "claude_code");

  const globalOnlyRun = createCaptureIo({ cwd: FIXTURE_PROJECT });
  assert.equal(await runLiteCli(["inventory", "--home", FIXTURE_HOME, "--agent", "codex", "--no-dir", "--no-activity", "--json"], globalOnlyRun.io), 0, globalOnlyRun.stderr);
  const globalOnlyJson = JSON.parse(globalOnlyRun.stdout);
  assert.equal(globalOnlyJson.project_dir, null);

  // 3. Static summary.mcp_server_count must stay invariant regardless of --agent filter
  const allAgentsRun = createCaptureIo();
  assert.equal(await runLiteCli(["inventory", "--home", FIXTURE_HOME, "--dir", FIXTURE_PROJECT, "--no-activity", "--json"], allAgentsRun.io), 0);
  const codexOnlyRun = createCaptureIo();
  assert.equal(await runLiteCli(["inventory", "--home", FIXTURE_HOME, "--dir", FIXTURE_PROJECT, "--agent", "codex", "--no-activity", "--json"], codexOnlyRun.io), 0);
  assert.equal(
    JSON.parse(allAgentsRun.stdout).summary.mcp_server_count,
    JSON.parse(codexOnlyRun.stdout).summary.mcp_server_count,
  );

  // 4. --envelope errors emit v1 ReadOnlyEnvelopeV1 with status="error"
  const envErrRun = createCaptureIo();
  assert.equal(await runLiteCli(["merge-projects", "does-not-exist-file.json", "--envelope", "--host-id", "err-host"], envErrRun.io), 2);
  assert.equal(envErrRun.stdout, "");
  const errEnv = JSON.parse(envErrRun.stderr);
  assert.equal(errEnv.schema_version, 1);
  assert.equal(errEnv.domain, "projects");
  assert.equal(errEnv.host_id, "err-host");
  assert.equal(errEnv.status, "error");
  assert.equal(errEnv.delta, null);
  assert.ok(typeof errEnv.error === "string" && errEnv.error.length > 0);

  // 5. merge-projects rejects duplicate host_id (exit 2) and warns on truncated / non-git snapshots
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cchistory-merge-ux-"));
  try {
    const dupA = path.join(tmp, "dup-a.json");
    const dupB = path.join(tmp, "dup-b.json");
    await fs.writeFile(dupA, JSON.stringify({ host_id: "same-host", projects: [] }), "utf8");
    await fs.writeFile(dupB, JSON.stringify({ host_id: "same-host", projects: [] }), "utf8");
    const dupRun = createCaptureIo({ cwd: tmp });
    assert.equal(await runLiteCli(["merge-projects", "dup-a.json", "dup-b.json"], dupRun.io), 2);
    assert.match(dupRun.stderr, /Duplicate host_id/u);

    const noGitA = path.join(tmp, "nogit-a.json");
    const noGitB = path.join(tmp, "nogit-b.json");
    await fs.writeFile(
      noGitA,
      JSON.stringify({ host_id: "h-a", total: 25, shown: 1, projects: [{ display_name: "beta", primary_workspace_path: "/work/a/beta" }] }),
      "utf8",
    );
    await fs.writeFile(
      noGitB,
      JSON.stringify({ host_id: "h-b", total: 1, shown: 1, projects: [{ display_name: "beta", primary_workspace_path: "/work/b/beta" }] }),
      "utf8",
    );
    const warnRun = createCaptureIo({ cwd: tmp });
    assert.equal(await runLiteCli(["merge-projects", "nogit-a.json", "nogit-b.json"], warnRun.io), 0, warnRun.stderr);
    assert.match(warnRun.stdout, /Warnings \(/u);
    assert.match(warnRun.stdout, /truncated \(1\/25/u);
    assert.match(warnRun.stdout, /git: unavailable/u);
    assert.match(warnRun.stdout, /\[git_not_collected\]/u);
    assert.match(warnRun.stdout, /\/work\/a\/beta/u);

    // 6. ls projects --no-dir --envelope exports ALL 25 projects (not truncated at 20)
    const manyProjects = Array.from({ length: 25 }, (_, i) => ({
      project_id: `proj:many:${i}`,
      project_revision_id: `proj:many:${i}:r1`,
      display_name: `proj-${i}`,
      slug: `proj-${i}`,
      linkage_state: "committed" as const,
      confidence: 0.9,
      link_reason: "repo_root_match" as const,
      manual_override_status: "none" as const,
      primary_workspace_path: path.join(tmp, `p-${i}`),
      source_platforms: ["codex" as const],
      host_ids: ["many-host"],
      committed_turn_count: 1,
      candidate_turn_count: 0,
      session_count: 1,
      project_last_activity_at: `2026-11-${String(1 + (i % 20)).padStart(2, "0")}T10:00:00.000Z`,
      created_at: "2026-11-01T10:00:00.000Z",
      updated_at: "2026-11-20T10:00:00.000Z",
    }));
    const manySessions = manyProjects.map((p, i) => ({
      id: `sess:many:${i}`,
      source_id: "src:many:codex",
      host_id: "many-host",
      source_platform: "codex" as const,
      title: `Session ${i}`,
      canonical_title: `Session ${i}`,
      created_at: p.updated_at,
      updated_at: p.updated_at,
      turn_count: 1,
      working_directory: p.primary_workspace_path,
      primary_project_id: p.project_id,
      sync_axis: "current" as const,
    }));
    const manyTurns = manyProjects.map((p, i) => ({
      id: `turn:many:${i}`,
      revision_id: `turn:many:${i}:r1`,
      turn_id: `turn:many:${i}`,
      turn_revision_id: `turn:many:${i}:r1`,
      user_messages: [],
      raw_text: `work ${i}`,
      canonical_text: `work ${i}`,
      display_segments: [],
      created_at: p.updated_at,
      submission_started_at: p.updated_at,
      last_context_activity_at: p.updated_at,
      session_id: `sess:many:${i}`,
      source_id: "src:many:codex",
      project_id: p.project_id,
      link_state: "committed" as const,
      sync_axis: "current" as const,
      value_axis: "active" as const,
      retention_axis: "keep_raw_and_derived" as const,
      context_ref: `ctx:many:${i}`,
      context_summary: { assistant_reply_count: 1, tool_call_count: 0, has_errors: false },
      lineage: { atom_refs: [], candidate_refs: [], fragment_refs: [], record_refs: [], blob_refs: [] },
    }));
    const manySnapshot = new LiveHistorySnapshot({
      host: { id: "many-host", hostname: "many-host", first_seen: "2026-11-01T10:00:00.000Z", last_seen: "2026-11-20T10:00:00.000Z" },
      sources: [
        {
          id: "src:many:codex",
          slot_id: "codex",
          family: "local_coding_agent",
          platform: "codex",
          display_name: "Codex",
          base_dir: path.join(tmp, ".codex"),
          host_id: "many-host",
          last_sync: "2026-11-20T10:00:00.000Z",
          sync_status: "healthy",
          total_blobs: 25,
          total_records: 25,
          total_fragments: 25,
          total_atoms: 25,
          total_sessions: 25,
          total_turns: 25,
        },
      ],
      projects: manyProjects,
      sessions: manySessions,
      turns: manyTurns,
      contexts: [],
      ask_user_question_turns: [],
      loss_audits: [],
    });
    const envAllRun = createCaptureIo({ scan: async () => manySnapshot });
    assert.equal(await runLiteCli(["ls", "projects", "--no-dir", "--envelope", "--host-id", "many-host"], envAllRun.io), 0, envAllRun.stderr);
    const envAll = JSON.parse(envAllRun.stdout);
    assert.equal(envAll.items.length, 25);
    assert.equal(envAll.summary.total_project_count, 25);
    assert.equal(envAll.summary.truncated, false);
    assert.equal(envAll.summary.git_inspected, false);
    assert.equal(envAll.summary.git_dirty_count, null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
