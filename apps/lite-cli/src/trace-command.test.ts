import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scanLiteHistory, type ScanLiteHistoryOptions } from "@cchistory/live-runtime";
import { runLiteCli, type LiteCliIo } from "./index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const emptyHome = path.join(repoRoot, "mock_data", "empty-home");
const antigravityRoot = path.join(repoRoot, "mock_data", "fixtures", "antigravity-sqlite");

function captureIo(cwd: string, extra: Partial<LiteCliIo> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: LiteCliIo = {
    cwd,
    homeDir: emptyHome,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    isTTY: false,
    columns: 120,
    ...extra,
  };
  return { io, stdout, stderr };
}

async function createClaudeDiagnosticFixture(root: string): Promise<string> {
  const projDir = path.join(root, "proj-a");
  const subDir = path.join(projDir, "diag-main-1", "subagents");
  await mkdir(subDir, { recursive: true });

  const mainLines = [
    {
      type: "user",
      sessionId: "diag-main-1",
      cwd: "/workspace/prod-api",
      timestamp: "2026-11-20T14:00:00.000Z",
      message: { role: "user", content: "Check pod crashloop and logs." },
    },
    // Call 1: cold start -> runs big log command
    {
      type: "assistant",
      sessionId: "diag-main-1",
      cwd: "/workspace/prod-api",
      timestamp: "2026-11-20T14:00:01.000Z",
      requestId: "req-1",
      message: {
        id: "msg-1",
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "tool_use",
        usage: { input_tokens: 100, cache_creation_input_tokens: 20_000, cache_read_input_tokens: 0, output_tokens: 300 },
        content: [{ type: "tool_use", id: "t-log", name: "Bash", input: { command: "kubectl logs api-7f8a9b-xk2pq" } }],
      },
    },
    {
      type: "user",
      sessionId: "diag-main-1",
      cwd: "/workspace/prod-api",
      timestamp: "2026-11-20T14:00:03.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t-log", is_error: false, content: "L".repeat(70_000) }],
      },
    },
    // Call 2: context bloat (+28K) -> runs slow test
    {
      type: "assistant",
      sessionId: "diag-main-1",
      cwd: "/workspace/prod-api",
      timestamp: "2026-11-20T14:00:05.000Z",
      requestId: "req-2",
      message: {
        id: "msg-2",
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "tool_use",
        usage: { input_tokens: 100, cache_creation_input_tokens: 28_000, cache_read_input_tokens: 20_000, output_tokens: 200 },
        content: [{ type: "tool_use", id: "t-slow", name: "Bash", input: { command: "npm test" } }],
      },
    },
    {
      type: "user",
      sessionId: "diag-main-1",
      cwd: "/workspace/prod-api",
      timestamp: "2026-11-20T14:06:15.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t-slow", is_error: true, content: "Error: test failed" }],
      },
    },
    // Call 3: idle TTL cache miss (6m12s later) -> enters polling loop
    {
      type: "assistant",
      sessionId: "diag-main-1",
      cwd: "/workspace/prod-api",
      timestamp: "2026-11-20T14:06:17.000Z",
      requestId: "req-3",
      message: {
        id: "msg-3",
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "tool_use",
        usage: { input_tokens: 100, cache_creation_input_tokens: 49_000, cache_read_input_tokens: 0, output_tokens: 200 },
        content: [{ type: "tool_use", id: "t-p1", name: "Bash", input: { command: "kubectl get pod api-7f8a9b-xk2pq -n prod" } }],
      },
    },
    // Polling loop: 4 repeats
    ...[1, 2, 3, 4].flatMap((n) => [
      {
        type: "user",
        sessionId: "diag-main-1",
        cwd: "/workspace/prod-api",
        timestamp: new Date(Date.parse("2026-11-20T14:06:18.000Z") + n * 10_000).toISOString(),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `t-p${n}`, is_error: false, content: "Pending" }],
        },
      },
      {
        type: "assistant",
        sessionId: "diag-main-1",
        cwd: "/workspace/prod-api",
        timestamp: new Date(Date.parse("2026-11-20T14:06:20.000Z") + n * 10_000).toISOString(),
        requestId: `req-p${n}`,
        message: {
          id: `msg-p${n}`,
          role: "assistant",
          model: "claude-sonnet-4-5",
          stop_reason: n < 4 ? "tool_use" : "end_turn",
          usage: { input_tokens: 80, cache_creation_input_tokens: 400, cache_read_input_tokens: 49_000, output_tokens: 150 },
          content:
            n < 4
              ? [{ type: "tool_use", id: `t-p${n + 1}`, name: "Bash", input: { command: `kubectl get pod api-9e1d4c-mn${n}rt -n prod` } }]
              : [{ type: "text", text: "Pod is finally ready." }],
        },
      },
    ]),
  ];
  await writeFile(path.join(projDir, "diag-main-1.jsonl"), mainLines.map((l) => JSON.stringify(l)).join("\n"), "utf8");

  // Sidecar subagent file under subagents/
  const subLines = [
    {
      type: "assistant",
      sessionId: "diag-main-1",
      isSidechain: true,
      agentId: "agent-explore-1",
      cwd: "/workspace/prod-api",
      timestamp: "2026-11-20T14:01:00.000Z",
      requestId: "req-sub-1",
      message: {
        id: "msg-sub-1",
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        usage: { input_tokens: 100, cache_creation_input_tokens: 16_000, cache_read_input_tokens: 0, output_tokens: 300 },
        content: [{ type: "text", text: "Subagent summary." }],
      },
    },
  ];
  await writeFile(path.join(subDir, "agent-explore-1.jsonl"), subLines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return root;
}

test("CLI stats, trace, query, and shell expose per-call cache misses, loops, bloat, and subagent breakdown end-to-end", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-trace-cli-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  await createClaudeDiagnosticFixture(tempRoot);

  const sourceArgs = ["--source", "claude_code", "--source-root", `claude_code=${tempRoot}`];
  const snapshot = await scanLiteHistory({
    homeDir: emptyHome,
    sourceRefs: ["claude_code"],
    sourceRoots: [{ sourceRef: "claude_code", baseDir: tempRoot }],
    contextMode: "none",
    safeMode: true,
  });
  assert.deepEqual(snapshot.projectionIssues, []);

  // 1. Default stats automatically displays Cache dist, Role split, and Anomalies
  const defaultStats = captureIo(tempRoot);
  assert.equal(await runLiteCli(["stats", ...sourceArgs, "--tz", "UTC"], defaultStats.io), 0);
  const statsText = defaultStats.stdout.join("");
  assert.match(statsText, /Cache dist:/u);
  assert.match(statsText, /Role split:/u);
  assert.match(statsText, /Anomalies/u);
  assert.match(statsText, /cache_miss_cliff/u);
  assert.match(statsText, /polling_loop/u);

  // 2. stats --by family / --by tool / --by turn / --anomalies / --session <exact_id>
  const seenScans: ScanLiteHistoryOptions[] = [];
  const wrappedScan = async (opts: ScanLiteHistoryOptions) => {
    seenScans.push(opts);
    return scanLiteHistory(opts);
  };
  const byFamily = captureIo(tempRoot, { scan: wrappedScan });
  assert.equal(
    await runLiteCli(["stats", ...sourceArgs, "--session", "sess:claude_code:diag-main-1", "--by", "family", "--json"], byFamily.io),
    0,
  );
  assert.deepEqual(seenScans.at(-1)?.sessionRefs, ["sess:claude_code:diag-main-1"]);
  const famPayload = JSON.parse(byFamily.stdout.join("")) as {
    families?: Array<{ subagent_count: number; self_calls: number; subagent_calls: number }>;
  };
  assert.equal(famPayload.families?.[0]?.subagent_count, 1);
  assert.equal(famPayload.families?.[0]?.subagent_calls, 1);
  assert.equal(famPayload.families?.[0]?.self_calls, 7);

  const byTool = captureIo(tempRoot);
  assert.equal(await runLiteCli(["stats", ...sourceArgs, "--by", "tool", "--tz", "UTC"], byTool.io), 0);
  assert.match(byTool.stdout.join(""), /kubectl get pod api-<id>/u);
  assert.match(byTool.stdout.join(""), /loop/u);
  assert.match(byTool.stdout.join(""), /bloat/u);

  // 3. Dedicated `trace <exact_session_id>` (human + JSON + --only-anomalies)
  const traceHuman = captureIo(tempRoot, { scan: wrappedScan });
  assert.equal(await runLiteCli(["trace", "sess:claude_code:diag-main-1", ...sourceArgs, "--tz", "UTC"], traceHuman.io), 0);
  assert.deepEqual(seenScans.at(-1)?.sessionRefs, ["sess:claude_code:diag-main-1"]);
  const traceOut = traceHuman.stdout.join("");
  assert.match(traceOut, /granularity=call/u);
  assert.match(traceOut, /Family \(self \+ 1 subagent\)/u);
  assert.match(traceOut, /Loops & Top Tools/u);
  assert.match(traceOut, /Call Waterfall/u);
  assert.match(traceOut, /idle_ttl_gap/u);

  const traceJson = captureIo(tempRoot);
  assert.equal(await runLiteCli(["trace", "sess:claude_code:diag-main-1", ...sourceArgs, "--only-anomalies", "--json"], traceJson.io), 0);
  const tracePayload = JSON.parse(traceJson.stdout.join("")) as {
    kind: string;
    trace: {
      usage_granularity: string;
      calls: Array<{ cache_status: string; miss_cause?: string; anomaly_kinds: string[] }>;
      loops: Array<{ exec_count: number; target_signature: string }>;
      family: Array<{ role: string }>;
    };
  };
  assert.equal(tracePayload.kind, "trace");
  assert.equal(tracePayload.trace.usage_granularity, "call");
  assert.equal(tracePayload.trace.family.length, 2);
  assert.equal(tracePayload.trace.loops[0]?.exec_count, 4);
  assert.ok(tracePayload.trace.calls.some((c) => c.miss_cause === "idle_ttl_gap"));

  // 4. `show turn <id> --json` exposes compact masked tool_summaries with real status & duration_ms
  const turnId = snapshot.listResolvedTurns()[0]!.id;
  const showTurn = captureIo(tempRoot);
  assert.equal(await runLiteCli(["show", "turn", turnId, ...sourceArgs, "--json"], showTurn.io), 0);
  const turnPayload = JSON.parse(showTurn.stdout.join("")) as {
    context?: { tool_summaries?: Array<{ tool_name: string; status: string; duration_ms: number | null; output_bytes: number | null }> };
  };
  const slowTool = turnPayload.context?.tool_summaries?.find((tc) => tc.status === "error");
  assert.ok(slowTool, "show turn --json should expose native Claude tool_result is_error");
  assert.equal(slowTool.duration_ms, 370_000);

  // 5. `query --sql` over the `calls` table exposes per-call cache misses, subagents, tools, and anomalies
  const sqlMiss = captureIo(tempRoot);
  assert.equal(
    await runLiteCli(
      [
        "query",
        "--sql",
        "SELECT session_id, seq, role, subagent_key, cache_status, miss_cause, primary_tool, anomaly_kinds, adjusted_cost_usd FROM calls WHERE anomaly_kinds IS NOT NULL ORDER BY adjusted_cost_usd DESC LIMIT 10",
        ...sourceArgs,
        "--no-dir",
      ],
      sqlMiss.io,
    ),
    0,
  );
  const sqlMissPayload = JSON.parse(sqlMiss.stdout.join("")) as {
    schema: string;
    operations: Array<{
      status: string;
      result: {
        rows: Array<{
          session_id: string;
          seq: number;
          role: string;
          miss_cause: string | null;
          primary_tool: string | null;
          anomaly_kinds: string | null;
        }>;
      };
    }>;
  };
  assert.equal(sqlMissPayload.schema, "cchistory-lite-query-result/v3");
  const sqlRows = sqlMissPayload.operations[0]?.result.rows ?? [];
  assert.ok(sqlRows.some((r) => r.miss_cause === "idle_ttl_gap" && r.primary_tool === "Bash:npm test"));
  assert.ok(sqlRows.some((r) => r.anomaly_kinds?.includes("polling_loop")));

  const sqlSub = captureIo(tempRoot);
  assert.equal(
    await runLiteCli(
      [
        "query",
        "--sql",
        "SELECT parent_session_id, subagent_key, role, cache_hit_ratio FROM calls WHERE role = $1 LIMIT 10",
        "--params",
        '["subagent"]',
        ...sourceArgs,
        "--no-dir",
      ],
      sqlSub.io,
    ),
    0,
  );
  const sqlSubRows = (JSON.parse(sqlSub.stdout.join("")) as {
    operations: Array<{ result: { rows: Array<{ parent_session_id: string | null; subagent_key: string | null; role: string }> } }>;
  }).operations[0]?.result.rows ?? [];
  assert.equal(sqlSubRows.length, 1);
  assert.equal(sqlSubRows[0]?.parent_session_id, "sess:claude_code:diag-main-1");
  assert.equal(sqlSubRows[0]?.subagent_key, "agent-explore-1");

  // 6. `shell --no-dir --json` executes `diagnose` + `trace` in one process
  const shellLines = [
    JSON.stringify({ id: "d1", kind: "diagnose", anomaly_limit: 10 }),
    JSON.stringify({ id: "t1", kind: "trace", session_ref: "sess:claude_code:diag-main-1", only_anomalies: true, limit: 20 }),
    JSON.stringify({ kind: "exit" }),
  ];
  let idx = 0;
  const shellIo = captureIo(tempRoot, {
    stdinIsTTY: false,
    readLine: async () => (idx < shellLines.length ? shellLines[idx++]! : null),
  });
  assert.equal(await runLiteCli(["shell", "--no-dir", "--json", ...sourceArgs], shellIo.io), 0);
  const responses = shellIo.stdout.join("").trim().split("\n").map((line) => JSON.parse(line) as {
    operations: Array<{ id: string; kind: string; status: string; result: Record<string, unknown> }>;
  });
  assert.equal(responses.length, 2);
  assert.equal(responses[0]?.operations[0]?.kind, "diagnose");
  assert.equal(responses[0]?.operations[0]?.status, "ok");
  assert.ok((responses[0]?.operations[0]?.result.total_anomalies as number) >= 3);
  assert.equal(responses[1]?.operations[0]?.kind, "trace");
  assert.equal(responses[1]?.operations[0]?.status, "ok");
  assert.equal((responses[1]?.operations[0]?.result as { usage_granularity: string }).usage_granularity, "call");
});

test("CLI trace works on Antigravity SQLite fixtures with call-level granularity and family hierarchy", async () => {
  const snapshot = await scanLiteHistory({
    homeDir: emptyHome,
    sourceRefs: ["antigravity"],
    sourceRoots: [{ sourceRef: "antigravity", baseDir: antigravityRoot }],
    contextMode: "none",
    safeMode: true,
  });
  assert.deepEqual(snapshot.projectionIssues, []);
  const parent = snapshot.listSessionFamilies()[0]?.parent_session_ref;
  assert.ok(parent, "antigravity fixture should have a parent session family");

  const io = captureIo(repoRoot, { scan: async () => snapshot });
  assert.equal(await runLiteCli(["trace", parent, "--json"], io.io), 0);
  const payload = JSON.parse(io.stdout.join("")) as {
    kind: string;
    trace: { usage_granularity: string; family: Array<{ role: string }>; calls: Array<{ emitted_tools: Array<{ tool_name: string }> }> };
  };
  assert.equal(payload.kind, "trace");
  assert.equal(payload.trace.usage_granularity, "call");
  assert.ok(payload.trace.family.some((m) => m.role === "subagent"));
  assert.ok(payload.trace.calls.some((c) => c.emitted_tools.length > 0), "Antigravity gen_metadata should bind step tool calls");
});

test("CLI trace and stats detect Codex tool exit-code errors, compaction cache drops, and delegated subagents", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-codex-trace-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const sessionsDir = path.join(tempRoot, "sessions");
  await mkdir(sessionsDir, { recursive: true });

  const parentId = "codex-parent-diag";
  const childId = "codex-child-diag";
  const parentLines = [
    { timestamp: "2026-11-20T15:00:00.000Z", type: "session_meta", payload: { id: parentId, cwd: "/workspace/codex-app", model: "gpt-5" } },
    { timestamp: "2026-11-20T15:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Run build and fix failing tests" } },
    { timestamp: "2026-11-20T15:00:02.000Z", type: "response_item", payload: { type: "function_call", call_id: "fc-1", name: "shell_command", arguments: JSON.stringify({ command: "pnpm test" }) } },
    {
      timestamp: "2026-11-20T15:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        model: "gpt-5",
        info: {
          last_token_usage: { input_tokens: 25_000, cached_input_tokens: 20_000, output_tokens: 200, total_tokens: 25_200 },
          total_token_usage: { input_tokens: 25_000, cached_input_tokens: 20_000, output_tokens: 200, total_tokens: 25_200 },
        },
      },
    },
    { timestamp: "2026-11-20T15:00:06.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "fc-1", output: "Process exited with code 1\nAssertionError: broken" } },
    { timestamp: "2026-11-20T15:00:07.000Z", type: "compacted", payload: { type: "compacted" } },
    {
      timestamp: "2026-11-20T15:00:10.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        model: "gpt-5",
        info: {
          last_token_usage: { input_tokens: 14_000, cached_input_tokens: 0, output_tokens: 300, total_tokens: 14_300 },
          total_token_usage: { input_tokens: 39_000, cached_input_tokens: 20_000, output_tokens: 500, total_tokens: 39_500 },
        },
      },
    },
    { timestamp: "2026-11-20T15:00:11.000Z", type: "event_msg", payload: { type: "agent_message", message: "Fixed after compaction." } },
  ];
  await writeFile(path.join(sessionsDir, "rollout-parent.jsonl"), parentLines.map((l) => JSON.stringify(l)).join("\n"), "utf8");

  const childLines = [
    {
      timestamp: "2026-11-20T15:00:04.000Z",
      type: "session_meta",
      payload: {
        id: childId,
        cwd: "/workspace/codex-app",
        model: "gpt-5",
        source: { subagent: { thread_spawn: { parent_thread_id: parentId, agent_nickname: "verifier" } } },
      },
    },
    {
      timestamp: "2026-11-20T15:00:05.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        model: "gpt-5",
        info: {
          last_token_usage: { input_tokens: 18_000, cached_input_tokens: 0, output_tokens: 250, total_tokens: 18_250 },
          total_token_usage: { input_tokens: 18_000, cached_input_tokens: 0, output_tokens: 250, total_tokens: 18_250 },
        },
      },
    },
  ];
  await writeFile(path.join(sessionsDir, "rollout-child.jsonl"), childLines.map((l) => JSON.stringify(l)).join("\n"), "utf8");

  const sourceArgs = ["--source", "codex", "--source-root", `codex=${tempRoot}`];
  const io = captureIo(tempRoot);
  assert.equal(await runLiteCli(["trace", `sess:codex:${parentId}`, ...sourceArgs, "--json"], io.io), 0);
  const payload = JSON.parse(io.stdout.join("")) as {
    trace: {
      usage_granularity: string;
      family: Array<{ role: string; agent_key?: string }>;
      calls: Array<{
        seq: number;
        miss_cause?: string;
        compaction_before?: boolean;
        preceding_tools: Array<{ tool_name: string; status: string; duration_ms?: number }>;
      }>;
    };
  };
  assert.equal(payload.trace.usage_granularity, "call");
  assert.equal(payload.trace.family.length, 2);
  assert.ok(payload.trace.family.some((m) => m.role === "subagent" && m.agent_key === "verifier"));
  const secondCall = payload.trace.calls[1];
  assert.ok(secondCall);
  assert.equal(secondCall.compaction_before, true);
  assert.equal(secondCall.miss_cause, "compaction");
  assert.equal(secondCall.preceding_tools[0]?.status, "error");
  assert.equal(secondCall.preceding_tools[0]?.duration_ms, 4000);
});
