import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { listSourceFiles } from "../index.js";
import { getPlatformAdapter, listPlatformAdapters, listPlatformAdaptersBySupportTier } from "../platforms/registry.js";
import { extractPiFamilySessionSeed } from "./pi-family/reader.js";
import { getRepoMockDataRoot, createSourceDefinition } from "../test-helpers.js";
import { runSourceProbe } from "../probe-reference.test.js";

const mockDataRoot = getRepoMockDataRoot();
const piRoot = path.join(mockDataRoot, ".pi/agent/sessions");
const ompRoot = path.join(mockDataRoot, ".omp/agent/sessions");

test("[pi/oh_my_pi] register as experimental Pi-family JSONL sources", () => {
  const pi = getPlatformAdapter("pi");
  const omp = getPlatformAdapter("oh_my_pi");
  assert.ok(pi && omp);
  assert.equal(pi.supportTier, "experimental");
  assert.equal(omp.supportTier, "experimental");
  assert.equal(pi.sessionTargeting, "file");
  assert.equal(omp.sessionTargeting, "file");
  assert.ok(listPlatformAdapters().some((entry) => entry.platform === "pi"));
  assert.ok(listPlatformAdapters().some((entry) => entry.platform === "oh_my_pi"));
  const experimental = listPlatformAdaptersBySupportTier("experimental").map((entry) => entry.platform);
  assert.ok(experimental.includes("pi"));
  assert.ok(experimental.includes("oh_my_pi"));
  assert.ok(pi.matchesSourceFile("/home/u/.pi/agent/sessions/--w--/2026-01-01T00-00-00_id.jsonl"));
  assert.equal(pi.matchesSourceFile("/home/u/.pi/agent/sessions/--w--/notes.md"), false);

  assert.deepEqual(pi.getDefaultBaseDirCandidates({ homeDir: "/Users/tester", env: {} }), [
    "/Users/tester/.pi/agent/sessions",
  ]);
  assert.deepEqual(
    pi.getDefaultBaseDirCandidates({ homeDir: "/Users/tester", env: { PI_CODING_AGENT_DIR: "/opt/pi-agent" } }),
    ["/opt/pi-agent/sessions", "/Users/tester/.pi/agent/sessions"],
  );
  assert.deepEqual(omp.getDefaultBaseDirCandidates({ homeDir: "/Users/tester", env: {} }), [
    "/Users/tester/.omp/agent/sessions",
  ]);
  assert.deepEqual(
    omp.getDefaultBaseDirCandidates({ homeDir: "/Users/tester", env: { PI_CONFIG_DIR: ".omp-dev" } }),
    ["/Users/tester/.omp-dev/agent/sessions"],
  );
});

test("[oh_my_pi] named profile stores are discovered beside the default profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-omp-profiles-"));
  try {
    const files = [
      path.join(root, "agent", "sessions", "--w--", "2026-01-01T00-00-00_a.jsonl"),
      path.join(root, "profiles", "work", "agent", "sessions", "--w--", "2026-01-01T00-00-00_b.jsonl"),
    ];
    for (const file of files) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "{}\n", "utf8");
    }
    assert.deepEqual(
      await listSourceFiles("oh_my_pi", path.join(root, "agent", "sessions")),
      [files[0], files[1]],
      "profile stores under profiles/*/agent/sessions are discovered",
    );
    const roots = getPlatformAdapter("oh_my_pi")?.getSourceRoots?.(path.join(root, "agent", "sessions")) ?? [];
    assert.equal(roots.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[pi] active-branch messages project turns, per-call usage, tools, thinking, and exclude abandoned branches", async () => {
  const source = createSourceDefinition("src-pi", "pi", piRoot);
  const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
  assert.ok(payload);
  assert.equal(payload.sessions.length, 1);
  const session = payload.sessions[0]!;
  assert.equal(session.id, "sess:pi:pi-fixture-main");
  assert.equal(session.title, "Retry backoff review");
  assert.equal(session.working_directory, "/Users/mock_user/workspace/pi-lab");
  assert.equal(session.model, "gpt-5");
  assert.equal(payload.turns.length, 2);
  assert.deepEqual(payload.turns.map((turn) => turn.canonical_text), [
    "Find the retry helper.",
    "Now check the timeout constant.",
  ]);

  const texts = payload.fragments
    .filter((fragment) => fragment.fragment_kind === "text")
    .map((fragment) => String(fragment.payload.text ?? ""));
  assert.equal(texts.some((text) => text.includes("Abandoned branch")), false, "only the active branch is projected");
  const thinking = payload.fragments.filter(
    (fragment) => fragment.fragment_kind === "text" && fragment.payload.source_content_type === "reasoning",
  );
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0]?.payload.display_policy, "collapse");

  const toolCalls = payload.fragments.filter((fragment) => fragment.fragment_kind === "tool_call");
  assert.equal(toolCalls.length, 2);
  assert.deepEqual(toolCalls[0]?.payload.input, { path: "src/retry.ts" });
  const toolResults = payload.fragments.filter((fragment) => fragment.fragment_kind === "tool_result");
  assert.equal(toolResults.length, 2);
  assert.equal(toolResults.some((fragment) => fragment.payload.is_error === true), true);

  const usage = payload.fragments.filter((fragment) => fragment.fragment_kind === "token_usage_signal");
  assert.equal(usage.length, 4);
  assert.equal(usage.every((fragment) => typeof fragment.payload.independent_usage_event_id === "string"), true);
  assert.equal(usage.every((fragment) => fragment.payload.scope === "call"), true);
  assert.equal(
    usage.reduce((sum, fragment) => sum + ((fragment.payload.token_usage as Record<string, number>).total_tokens ?? 0), 0),
    3_373,
  );
  assert.ok(payload.fragments.some((fragment) => fragment.fragment_kind === "model_signal" && fragment.payload.model === "gpt-5"));
});

test("[oh_my_pi] title slot, model_usage, compaction, reset boundary, and task/fork lineage are separated", async () => {
  const source = createSourceDefinition("src-omp", "oh_my_pi", ompRoot);
  const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
  assert.ok(payload);
  assert.equal(payload.sessions.length, 3);
  const main = payload.sessions.find((session) => session.id === "sess:oh_my_pi:omp-fixture-main");
  assert.ok(main);
  assert.equal(main.title, "OMP retry audit");
  assert.equal(main.turn_count, 3);

  const task = payload.sessions.find((session) => session.id === "sess:oh_my_pi:omp-fixture-task");
  const fork = payload.sessions.find((session) => session.id === "sess:oh_my_pi:omp-fixture-fork");
  assert.ok(task && fork);
  const relations = payload.fragments.filter((fragment) => fragment.fragment_kind === "session_relation");
  assert.equal(relations.length, 1, "only taskPromptCacheKey lineage is delegated work");
  assert.equal(relations[0]?.session_ref, "sess:oh_my_pi:omp-fixture-task");
  assert.equal(relations[0]?.payload.relation_source, "pi_task_parent_session");
  assert.ok(payload.loss_audits.some((audit) => audit.diagnostic_code === "pi_family_fork_lineage_not_delegated"));
  assert.ok(payload.loss_audits.some((audit) => audit.diagnostic_code === "pi_family_reset_boundary_evidence"));

  const mainUsage = payload.fragments.filter(
    (fragment) => fragment.fragment_kind === "token_usage_signal" && fragment.session_ref === main.id,
  );
  assert.equal(mainUsage.length, 5);
  assert.equal(
    mainUsage.reduce((sum, fragment) => sum + ((fragment.payload.token_usage as Record<string, number>).total_tokens ?? 0), 0),
    1_498,
  );
  assert.ok(
    payload.fragments.some(
      (fragment) => fragment.fragment_kind === "text"
        && fragment.payload.source_content_type === "reasoning"
        && fragment.payload.display_policy === "collapse",
    ),
  );
});

test("[pi/oh_my_pi] version 1 linear files and truncated tails degrade with diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-pi-linear-"));
  try {
    const dir = path.join(root, ".pi", "agent", "sessions", "--w--");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "2026-01-01T00-00-00_pi-linear.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 1, id: "pi-linear", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace/pi" }),
      JSON.stringify({ type: "message", id: "m1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Legacy linear prompt.", timestamp: Date.UTC(2026, 0, 1, 0, 0, 1) } }),
      JSON.stringify({ type: "message", id: "m2", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "Legacy linear reply." }], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 }, stopReason: "stop", timestamp: Date.UTC(2026, 0, 1, 0, 0, 2) } }),
      "{\"type\":\"message\",\"id\":\"m3\",\"timestamp\":\"2026-01-01T00:00:03.000Z\",\"message\":{\"role\":\"assistant\"",
    ];
    await writeFile(file, lines.join("\n"), "utf8");

    const { seed, diagnostics } = extractPiFamilySessionSeed("pi", file, Buffer.from(lines.join("\n")));
    assert.ok(seed);
    assert.equal(seed.sessionId, "sess:pi:pi-linear");
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "pi_family_truncated_tail"));

    const source = createSourceDefinition("src-pi-linear", "pi", root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.deepEqual(payload.turns.map((turn) => turn.canonical_text), ["Legacy linear prompt."]);
    assert.ok(payload.loss_audits.some((audit) => audit.diagnostic_code === "pi_family_truncated_tail"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[pi] targeted reads resolve one session and reject unknown refs", async () => {
  const source = createSourceDefinition("src-pi-target", "pi", piRoot);
  const [payload] = (
    await runSourceProbe({ source_ids: [source.id], target_session_refs: ["sess:pi:pi-fixture-main"] }, [source])
  ).sources;
  assert.ok(payload);
  assert.deepEqual(payload.sessions.map((session) => session.id), ["sess:pi:pi-fixture-main"]);
  await assert.rejects(
    runSourceProbe({ source_ids: [source.id], target_session_refs: ["pi-missing"] }, [source]),
    /requested session/u,
  );
});
