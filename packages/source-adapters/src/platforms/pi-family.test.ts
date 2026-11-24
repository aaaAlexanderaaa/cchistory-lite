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
  const piDefault = "/Users/tester/.pi/agent";
  assert.deepEqual(
    pi.getDefaultBaseDirCandidates({
      homeDir: "/Users/tester",
      env: { PI_CODING_AGENT_DIR: "/opt/pi-agent" },
      pathExists: (targetPath) => targetPath === piDefault,
    }),
    ["/opt/pi-agent/sessions", "/Users/tester/.pi/agent/sessions"],
    "a marker-less override is accepted when only Pi's own root exists",
  );
  assert.deepEqual(
    pi.getDefaultBaseDirCandidates({
      homeDir: "/Users/tester",
      env: { PI_CODING_AGENT_DIR: "/opt/pi-agent" },
      pathExists: (targetPath) => targetPath === piDefault || targetPath === "/Users/tester/.omp/agent",
    }),
    ["/Users/tester/.pi/agent/sessions"],
    "a dual install requires explicit source selection for marker-less overrides",
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
  assert.equal(usage.length, 5);
  assert.equal(usage.every((fragment) => typeof fragment.payload.independent_usage_event_id === "string"), true);
  assert.equal(usage.every((fragment) => fragment.payload.scope === "call"), true);
  assert.equal(
    usage.reduce((sum, fragment) => sum + ((fragment.payload.token_usage as Record<string, number>).total_tokens ?? 0), 0),
    4_466,
    "native totals include the abandoned branch while its text stays out of the conversation",
  );
  assert.ok(usage.some((fragment) => fragment.payload.call_kind === "inactive_assistant"));
  assert.ok(usage.some((fragment) => fragment.payload.stop_reason === "tool_use"));
  assert.ok(texts.some((text) => text.includes("Extension note for the retry review.")));
  assert.ok(texts.some((text) => text.includes("[file] src/retry.ts")));
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

test("[oh_my_pi] a late off-branch usage entry keeps the activeLeafId conversation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-omp-leaflate-"));
  try {
    const dir = path.join(root, "agent", "sessions", "--w--");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "2026-01-02T00-00-00_omp-leaflate.jsonl");
    const base = Date.UTC(2026, 0, 2, 0, 0, 0);
    const iso = (ms: number) => new Date(ms).toISOString();
    const rows = [
      { type: "session", version: 3, id: "omp-leaflate", timestamp: iso(base), cwd: "/workspace/omp" },
      { type: "message", id: "u1", parentId: null, timestamp: iso(base + 1000), message: { role: "user", content: "First prompt.", timestamp: base + 1000 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: iso(base + 2000), message: { role: "assistant", model: "gpt-5", content: [{ type: "text", text: "First reply." }], usage: { input: 10, output: 2, totalTokens: 12 }, stopReason: "stop", timestamp: base + 2000 } },
      { type: "message", id: "u2", parentId: "a1", timestamp: iso(base + 3000), message: { role: "user", content: "Second prompt.", timestamp: base + 3000 } },
      { type: "message", id: "a2", parentId: "u2", timestamp: iso(base + 4000), message: { role: "assistant", model: "gpt-5", content: [{ type: "text", text: "Second reply." }], usage: { input: 20, output: 3, totalTokens: 23 }, stopReason: "stop", timestamp: base + 4000 } },
      { type: "model_usage", id: "late", parentId: "a1", activeLeafId: "a2", timestamp: iso(base + 5000), purpose: "title", model: "gpt-5", usage: { input: 5, output: 1, totalTokens: 6 } },
    ];
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

    const { seed } = extractPiFamilySessionSeed("oh_my_pi", file, Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"));
    assert.ok(seed);
    const pointers = seed.records.map((record) => record.pointer);
    assert.ok(pointers.includes("entry:4") && pointers.includes("entry:5"), "the active leaf follows activeLeafId, not the last physical row");

    const source = createSourceDefinition("src-omp-leaflate", "oh_my_pi", root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.deepEqual(payload.turns.map((turn) => turn.canonical_text), ["First prompt.", "Second prompt."]);
    assert.ok(payload.fragments.some((fragment) => fragment.fragment_kind === "token_usage_signal"
      && (fragment.payload.token_usage as Record<string, number>).total_tokens === 6));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[pi] a copied fork drops inherited entries and usage but keeps the fork's own turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-pi-fork-"));
  try {
    const dir = path.join(root, "agent", "sessions", "--w--");
    await mkdir(dir, { recursive: true });
    const base = Date.UTC(2026, 2, 1, 0, 0, 0);
    const iso = (ms: number) => new Date(ms).toISOString();
    const parentFile = path.join(dir, "2026-03-01T00-00-00_pi-parent.jsonl");
    const parentRows = [
      { type: "session", version: 3, id: "pi-parent", timestamp: iso(base), cwd: "/workspace/pi" },
      { type: "message", id: "u1", parentId: null, timestamp: iso(base + 1000), message: { role: "user", content: "Parent prompt.", timestamp: base + 1000 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: iso(base + 2000), message: { role: "assistant", model: "gpt-5", content: [{ type: "text", text: "Parent reply." }], usage: { input: 90, output: 10, totalTokens: 100 }, stopReason: "stop", timestamp: base + 2000 } },
    ];
    await writeFile(parentFile, parentRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const forkRows = [
      { type: "session", version: 3, id: "pi-fork", timestamp: iso(base + 1000), cwd: "/workspace/pi", parentSession: parentFile },
      ...parentRows.slice(1),
      { type: "message", id: "u2", parentId: "a1", timestamp: iso(base + 3000), message: { role: "user", content: "Fork-only prompt.", timestamp: base + 3000 } },
      { type: "message", id: "a2", parentId: "u2", timestamp: iso(base + 4000), message: { role: "assistant", model: "gpt-5", content: [{ type: "text", text: "Fork-only reply." }], usage: { input: 18, output: 2, totalTokens: 20 }, stopReason: "stop", timestamp: base + 4000 } },
    ];
    const forkFile = path.join(dir, "2026-03-01T01-00-00_pi-fork.jsonl");
    await writeFile(forkFile, forkRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

    const source = createSourceDefinition("src-pi-fork", "pi", root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    const fork = payload.sessions.find((session) => session.id === "sess:pi:pi-fork");
    assert.ok(fork);
    assert.equal(fork.turn_count, 1, "the copied parent turn is inherited, not a new fork turn");
    const forkTurns = payload.turns.filter((turn) => turn.session_id === fork.id);
    assert.deepEqual(forkTurns.map((turn) => turn.canonical_text), ["Fork-only prompt."]);
    assert.ok(payload.loss_audits.some((audit) => audit.diagnostic_code === "pi_family_inherited_fork_prefix"));
    assert.equal(payload.fragments.some((fragment) => fragment.session_ref === fork.id
      && String(fragment.payload.text ?? "").includes("Parent reply.")), false);
    // Parent 100 + fork's own 20; the copied 100 is not billed twice.
    const forkUsage = payload.fragments.filter((fragment) => fragment.fragment_kind === "token_usage_signal"
      && fragment.session_ref === fork.id);
    assert.equal(forkUsage.reduce((sum, fragment) => sum + ((fragment.payload.token_usage as Record<string, number>).total_tokens ?? 0), 0), 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[pi/oh_my_pi] an over-budget session file keeps only its header and reports a diagnostic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-pi-budget-"));
  try {
    const dir = path.join(root, "agent", "sessions", "--w--");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "2026-04-01T00-00-00_pi-budget.jsonl");
    const content = [
      JSON.stringify({ type: "session", version: 3, id: "pi-budget", timestamp: "2026-04-01T00:00:00.000Z", cwd: "/workspace/pi" }),
      JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-04-01T00:00:01.000Z", message: { role: "user", content: "Too large for this budget.", timestamp: Date.UTC(2026, 3, 1, 0, 0, 1) } }),
    ].join("\n") + "\n";
    await writeFile(file, content, "utf8");
    const { seed, diagnostics } = extractPiFamilySessionSeed("pi", file, Buffer.from(content), { maxBytes: 10 });
    assert.ok(seed);
    assert.equal(seed.records.length, 1);
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "pi_family_file_too_large"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
