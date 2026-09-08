import { interpretSessionEvidence } from "@cchistory/canonical";
import assert from "node:assert/strict";
import { access, appendFile, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildProjectDisplayList } from "@cchistory/canonical";
import type { ProjectIdentity, SessionProjection, UserTurnProjection } from "@cchistory/domain";
import { listPlatformAdapters, runSourceProbe } from "@cchistory/source-adapters";
import {
  assertLiteSourceRoot,
  buildLiveSnapshot,
  LiveHistorySnapshot,
  maskCompactPreview,
  resolveLiteSources,
  scanLiteHistory,
} from "./index.js";
import { SAMPLE_RANK_CONCURRENCY, mapPool } from "./async-pool.js";
import { settleLauncherExit } from "./bootstrap.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const mockDataRoot = path.join(repoRoot, "mock_data");
const fixtureRoots = {
  codex: ".codex/sessions",
  claude_code: ".claude/projects",
  factory_droid: ".factory/sessions",
  amp: ".local/share/amp/threads",
  cursor: ".cursor/chats",
  antigravity: ".gemini/antigravity/brain",
  gemini: ".gemini",
  openclaw: ".openclaw/agents",
  opencode: ".local/share/opencode/storage",
  codebuddy: ".codebuddy",
  accio: "fixtures/accio-multi-agent/agents",
  cursor_agent: "fixtures/cursor-agent",
  grok: "fixtures/grok-cli",
} as const;

test("mapPool never runs more than the requested number of tasks at once", async () => {
  assert.equal(SAMPLE_RANK_CONCURRENCY, 4);
  const releases: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let launched = 0;
  const waitUntil = async (predicate: () => boolean): Promise<void> => {
    while (!predicate()) {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
  };
  const done = mapPool(Array.from({ length: 6 }, (_, index) => index), 2, async (value) => {
    launched += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    inFlight -= 1;
    return value * 2;
  });
  await waitUntil(() => launched === 2);
  assert.equal(maxInFlight, 2);
  assert.equal(inFlight, 2);
  for (const release of releases.splice(0)) release();
  await waitUntil(() => launched === 4);
  assert.equal(maxInFlight, 2);
  for (const release of releases.splice(0)) release();
  await waitUntil(() => launched === 6);
  assert.equal(maxInFlight, 2);
  for (const release of releases.splice(0)) release();
  assert.deepEqual(await done, [0, 2, 4, 6, 8, 10]);
  assert.equal(inFlight, 0);
});


test("settleLauncherExit reports rejected launcher failures to stderr", async () => {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    void rest;
    return true;
  }) as typeof process.stderr.write;
  const previousExitCode = process.exitCode;
  try {
    settleLauncherExit(Promise.reject(new Error("import failed")));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(process.exitCode, 1);
    assert.match(chunks.join(""), /import failed/u);
  } finally {
    process.stderr.write = originalWrite;
    process.exitCode = previousExitCode;
  }
});

test("sample scan promotes a Grok delegated child to its parent", async () => {
  const snapshot = await scanLiteHistory({
    homeDir: path.join(mockDataRoot, "empty-home"),
    hostname: "cchistory-lite-sample-grok-host",
    sourceRefs: ["grok"],
    sourceRoots: [{ sourceRef: "grok", baseDir: path.join(mockDataRoot, fixtureRoots.grok) }],
    safeMode: true,
    contextMode: "none",
    sample: { perSource: 1 },
  });
  const topLevel = snapshot.listTopLevelSessions().filter((session) => session.turn_count > 0);
  assert.equal(topLevel.length, 1);
  assert.equal(topLevel[0]?.source_session_id, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  assert.equal(topLevel.some((session) => session.source_session_id === "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"), false);
});

test("compact family I/O previews mask secrets before the 240-character cut", () => {
  const secret = `sk-${"A".repeat(24)}`;
  const preview = `${"x".repeat(220)} ${secret} trailing task`;
  const masked = maskCompactPreview(preview, "tool_input");
  assert.ok(masked);
  assert.doesNotMatch(masked, new RegExp(secret, "u"));
  assert.ok(masked.length <= 240);
  assert.match(masked, /trailing task/u);
});

test("Lite materializer resolves canonical history across the fixture-backed adapter matrix", async () => {
  const tempStore = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-matrix-"));
  try {
    const sources = await resolveLiteSources({
      homeDir: path.join(tempStore, "empty-home"),
      hostname: "cchistory-lite-matrix-host",
      sourceRefs: Object.keys(fixtureRoots),
      sourceRoots: Object.entries(fixtureRoots).map(([sourceRef, relativePath]) => ({
        sourceRef,
        baseDir: path.join(mockDataRoot, relativePath),
      })),
    });
    const probe = await runSourceProbe(interpretSessionEvidence, { safe_mode: true }, sources);
    const askPayload = probe.sources.find((payload) => payload.source.platform === "codex");
    const askSession = askPayload?.sessions[0];
    const longTurn = askPayload?.turns.find((turn) => turn.session_id === askSession?.id);
    assert.ok(askPayload && askSession && longTurn);
    longTurn.canonical_text = `${"a".repeat(16 * 1024)} lite-full-tail-only-token`;
    const searchObservation = askPayload.candidates.find(
      (candidate) => candidate.candidate_kind === "project_observation" && candidate.session_ref === askSession.id,
    );
    if (searchObservation) {
      searchObservation.evidence = {
        ...searchObservation.evidence,
        repo_remote: "https://example.test/lite-full-search-parity.git",
        repo_fingerprint: "fingerprint-lite-full-search-parity",
      };
    } else {
      askPayload.candidates.push({
        id: "candidate-lite-full-search-parity",
        source_id: askPayload.source.id,
        session_ref: askSession.id,
        candidate_kind: "project_observation",
        input_atom_refs: [],
        started_at: askSession.created_at,
        ended_at: askSession.updated_at,
        rule_version: "test",
        evidence: {
          repo_remote: "https://example.test/lite-full-search-parity.git",
          repo_fingerprint: "fingerprint-lite-full-search-parity",
          confidence: 0.5,
        },
      });
    }
    askPayload.ask_user_question_turns.push({
      id: "ask-user-question-lite-parity",
      source_id: askPayload.source.id,
      session_id: askSession.id,
      source_platform: askPayload.source.platform,
      created_at: askSession.created_at,
      tool_name: "request_user_input",
      call_atom_id: "atom-lite-parity-call",
      result_atom_id: "atom-lite-parity-result",
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "Which parity scope should run?",
          options: [{ label: "All fixtures", description: "Run the complete registered fixture matrix." }],
        },
      ],
      answers: [{ question_index: 0, selected_label: "All fixtures" }],
    });
    const lite = buildLiveSnapshot(probe);

    assert.deepEqual(lite.projectionIssues, [], "the complete adapter matrix must satisfy the canonical projection contract");

    // Every registered adapter in the matrix materializes into the live snapshot.
    assert.deepEqual(
      sortById(lite.listSources()).map((source) => source.platform).sort(),
      Object.keys(fixtureRoots).sort(),
    );
    assert.ok(lite.listResolvedSessions().length > 0);
    assert.ok(lite.listResolvedTurns().length > 0);
    let previousMessageAt: string | undefined;
    let reachedTurnlessSessions = false;
    for (const session of lite.listResolvedSessions()) {
      const hasTurns = lite.listSessionTurns(session.id).length > 0;
      if (!hasTurns) {
        reachedTurnlessSessions = true;
        continue;
      }
      assert.equal(reachedTurnlessSessions, false, "turn-less metadata must not displace sessions with real messages");
      const activityAt = lite.getSessionActivityAt(session.id);
      assert.ok(activityAt);
      if (previousMessageAt) {
        assert.ok(previousMessageAt >= activityAt, `${session.id} is out of last-message recency order`);
      }
      previousMessageAt = activityAt;
    }

    // listProjects() already returns canonical display order, so it is idempotent.
    assert.deepEqual(
      normalizeProjects(lite.listProjects()),
      normalizeProjects(buildProjectDisplayList(lite.listProjects())),
    );

    // Every resolved turn resolves a context, and every session answers related-work lookups.
    for (const turn of lite.listResolvedTurns()) {
      assert.ok(lite.getTurnContext(turn.id), `missing turn context for ${turn.id}`);
    }
    for (const session of lite.listResolvedSessions()) {
      assert.ok(Array.isArray(jsonNormalize(lite.listSessionRelatedWork(session.id))));
    }

    // The injected AskUserQuestion turn survives materialization intact.
    const askTurns = sortById(lite.listAskUserQuestionTurns());
    const injectedAsk = askTurns.find((turn) => turn.id === "ask-user-question-lite-parity");
    assert.ok(injectedAsk, "injected AskUserQuestion turn was dropped");
    assert.equal(injectedAsk.tool_name, "request_user_input");
    assert.deepEqual(injectedAsk.answers, [{ question_index: 0, selected_label: "All fixtures" }]);

    // Search covers the fixture corpus and honours Lite indexing boundaries.
    const liteSearch = lite.search({ query: "mock", limit: 10_000 });
    assert.ok(liteSearch.total > 0);
    assert.equal(liteSearch.results.length, Math.min(liteSearch.total, 10_000));
    assert.ok(liteSearch.results.every((result) => lite.getTurnContext(result.turn.id)));

    for (const [query, expectedTotal] of [
      // A token that only exists past the indexed head of a long turn stays unsearchable.
      ["lite-full-tail-only-token", 0],
      // A project-observation fingerprint stays searchable.
      ["fingerprint-lite-full-search-parity", undefined],
    ] as const) {
      const liteBoundarySearch = lite.search({ query, limit: 10_000 });
      if (expectedTotal !== undefined) {
        assert.equal(liteBoundarySearch.total, expectedTotal, `search total for ${query}`);
      } else {
        assert.ok(liteBoundarySearch.total > 0, `search total for ${query}`);
      }
    }

    // Usage aggregation is deterministic apart from its generation timestamp.
    assert.deepEqual(
      withoutGeneratedAt(lite.getUsageOverview()),
      withoutGeneratedAt(lite.getUsageOverview()),
    );
    for (const dimension of ["source", "project", "model", "day"] as const) {
      assert.deepEqual(
        withoutGeneratedAt(lite.getUsageRollup(dimension)),
        withoutGeneratedAt(lite.getUsageRollup(dimension)),
      );
    }

    // Lite never creates a persistent store while materializing.
    await assert.rejects(access(path.join(tempStore, ".cchistory")));
  } finally {
    await rm(tempStore, { recursive: true, force: true });
  }
});

test("Lite targeted probes preserve one-session parity across the fixture adapter matrix", async () => {
  for (const [sourceRef, relativePath] of Object.entries(fixtureRoots)) {
    const scanOptions = {
      homeDir: path.join(mockDataRoot, "empty-home"),
      hostname: `cchistory-lite-target-matrix-${sourceRef}`,
      sourceRefs: [sourceRef],
      sourceRoots: [{ sourceRef, baseDir: path.join(mockDataRoot, relativePath) }],
      safeMode: true,
    };
    const full = await scanLiteHistory({ ...scanOptions, contextMode: "full" });
    const target = full.listResolvedSessions().find((session) => session.source_session_id);
    if (!target?.source_session_id) continue;

    const targeted = await scanLiteHistory({
      ...scanOptions,
      contextMode: "full",
      sessionRefs: [target.source_session_id],
    });
    const expectedSessionIds = new Set([
      target.id,
      ...full.listDelegatedChildren(target.id)
        .map((child) => child.child_session_ref)
        .filter((id): id is string => id !== undefined),
    ]);
    assert.deepEqual(
      targeted.listResolvedSessions().map(targetSessionParityFields),
      full.listResolvedSessions().filter((session) => expectedSessionIds.has(session.id)).map(targetSessionParityFields),
      `${sourceRef} session parity`,
    );
    assert.equal(
      targeted.listTopLevelSessions().some((session) => session.id !== target.id && expectedSessionIds.has(session.id)),
      false,
      `${sourceRef} delegated children stay out of top-level collections`,
    );
    assert.deepEqual(
      targeted.listResolvedTurns().map(targetTurnParityFields),
      full.listResolvedTurns().filter((turn) => expectedSessionIds.has(turn.session_id)).map(targetTurnParityFields),
      `${sourceRef} turn parity`,
    );
    const targetTurnIds = new Set(
      full.listResolvedTurns()
        .filter((turn) => expectedSessionIds.has(turn.session_id))
        .map((turn) => turn.id),
    );
    assert.deepEqual(
      targeted.data.contexts.map(targetContextParityFields),
      full.data.contexts.filter((context) => targetTurnIds.has(context.turn_id)).map(targetContextParityFields),
      `${sourceRef} context parity`,
    );
  }
});

test("every logical-session projection boundary preserves source-wide canonical parity", async () => {
  const logicalPlatforms = listPlatformAdapters()
    .filter((adapter) => adapter.projectionBoundary === "logical_session")
    .map((adapter) => adapter.platform);

  for (const platform of logicalPlatforms) {
    const relativePath = fixtureRoots[platform as keyof typeof fixtureRoots];
    assert.ok(relativePath, `missing live-runtime fixture root for ${platform}`);
    const scanOptions = {
      homeDir: path.join(mockDataRoot, "empty-home"),
      hostname: `cchistory-lite-projection-boundary-${platform}`,
      sourceRefs: [platform],
      sourceRoots: [{ sourceRef: platform, baseDir: path.join(mockDataRoot, relativePath) }],
      safeMode: true,
    } as const;
    const sources = await resolveLiteSources(scanOptions);
    const sourceWide = buildLiveSnapshot(await runSourceProbe(interpretSessionEvidence, { safe_mode: true }, sources));
    const grouped = await scanLiteHistory({ ...scanOptions, contextMode: "full" });

    assert.deepEqual(grouped.listResolvedSessions(), sourceWide.listResolvedSessions(), `${platform} sessions`);
    assert.deepEqual(grouped.listResolvedTurns(), sourceWide.listResolvedTurns(), `${platform} turns`);
    assert.deepEqual(grouped.data.contexts, sourceWide.data.contexts, `${platform} contexts`);
    assert.deepEqual(normalizeProjects(grouped.listProjects()), normalizeProjects(sourceWide.listProjects()), `${platform} projects`);
    assert.deepEqual(grouped.data.related_work, sourceWide.data.related_work, `${platform} related work`);
    assert.deepEqual(grouped.listAskUserQuestionTurns(), sourceWide.listAskUserQuestionTurns(), `${platform} questions`);
    assert.deepEqual(grouped.projectionIssues, sourceWide.projectionIssues, `${platform} projection issues`);
    assert.deepEqual(
      withoutGeneratedAt(grouped.getUsageOverview({ include_known_zero_token: true })),
      withoutGeneratedAt(sourceWide.getUsageOverview({ include_known_zero_token: true })),
      `${platform} usage`,
    );
    assert.deepEqual(grouped.data.session_contributions, sourceWide.data.session_contributions, `${platform} contributions`);
    assert.deepEqual(grouped.data.delegated_children, sourceWide.data.delegated_children, `${platform} delegated children`);
    assert.deepEqual(grouped.listSessionFamilies(), sourceWide.listSessionFamilies(), `${platform} families`);
  }
});

test("Lite keeps Codex delegated children addressable but out of top-level projections", async () => {
  const common = {
    homeDir: path.join(mockDataRoot, "empty-home"),
    hostname: "cchistory-lite-codex-delegation-host",
    sourceRefs: ["codex"],
    sourceRoots: [{ sourceRef: "codex", baseDir: path.join(mockDataRoot, fixtureRoots.codex) }],
    safeMode: true,
    contextMode: "full" as const,
  };
  const parentId = "sess:codex:codex-delegation-parent";
  const childId = "sess:codex:codex-delegation-child";
  const full = await scanLiteHistory(common);
  const child = full.getSession(childId);

  assert.ok(full.getSession(parentId));
  assert.ok(child);
  assert.equal(child.title, "Atlas");
  assert.equal(child.turn_count, 0);
  assert.equal(child.resume_command, undefined);
  assert.equal(full.listResolvedSessions().some((session) => session.id === childId), true);
  assert.equal(full.listTopLevelSessions().some((session) => session.id === childId), false);
  const treeSessionIds = full.getProjectsTreeProjection().projects
    .flatMap((node) => node.sessions)
    .concat(full.getProjectsTreeProjection().unlinkedSessions)
    .map((session) => session.id);
  assert.equal(treeSessionIds.includes(childId), false);
  assert.equal(full.search({ query: "Keep this delegated instruction as evidence only." }).total, 0);
  assert.equal(full.getUsageOverview({ include_known_zero_token: true }).total_turns, full.listResolvedTurns().length);
  assert.deepEqual(full.projectionIssues, []);

  const parentRelated = full.listSessionRelatedWork(parentId);
  assert.ok(parentRelated.some((entry) =>
    entry.relation_kind === "delegated_session" &&
    entry.direction === "outbound" &&
    entry.child_session_ref === childId
  ));
  const childRelated = full.listSessionRelatedWork(childId);
  assert.ok(childRelated.some((entry) =>
    entry.relation_kind === "delegated_session" &&
    entry.direction === "inbound" &&
    entry.parent_session_ref === parentId
  ));
  const family = full.getSessionFamily(parentId);
  assert.ok(family);
  assert.equal(family.child_count, 1);
  assert.equal(family.children[0]?.child_session_ref, childId);
  assert.ok((family.combined.storage_bytes ?? 0) >= (family.parent.storage_bytes ?? 0));
  assert.equal(full.listSessionFamilies().filter((entry) => entry.parent_session_ref === parentId).length, 1);
  assert.equal(full.getSessionFamily(childId), undefined);

  const targetedParent = await scanLiteHistory({ ...common, sessionRefs: [parentId] });
  assert.deepEqual(
    new Set(targetedParent.listResolvedSessions().map((session) => session.id)),
    new Set([parentId, childId]),
  );
  assert.ok(targetedParent.getSession(childId));
  assert.equal(targetedParent.listTopLevelSessions().some((session) => session.id === childId), false);
  assert.equal(targetedParent.getSessionFamily(parentId)?.children[0]?.child_session_ref, childId);
  assert.equal(targetedParent.getSession(childId)?.title, child.title);
  assert.ok(targetedParent.listSessionRelatedWork(parentId).some((entry) =>
    entry.direction === "outbound" && entry.child_session_ref === childId
  ));
  assert.deepEqual(targetedParent.projectionIssues, []);

  const targetedChild = await scanLiteHistory({ ...common, sessionRefs: [childId] });
  assert.deepEqual(targetedChild.listResolvedSessions().map((session) => session.id), [childId]);
  assert.deepEqual(targetedChild.listTopLevelSessions().map((session) => session.id), [childId]);
  assert.equal(targetedChild.getSession(childId)?.title, "Atlas");
  assert.ok(targetedChild.listSessionRelatedWork(childId).some((entry) =>
    entry.direction === "inbound" && entry.parent_session_ref === parentId
  ));
  assert.deepEqual(targetedChild.projectionIssues, []);
});

test("Lite keeps Grok delegated children addressable but out of top-level projections", async () => {
  const common = {
    homeDir: path.join(mockDataRoot, "empty-home"),
    hostname: "cchistory-lite-grok-delegation-host",
    sourceRefs: ["grok"],
    sourceRoots: [{ sourceRef: "grok", baseDir: path.join(mockDataRoot, fixtureRoots.grok) }],
    safeMode: true,
    contextMode: "full" as const,
  };
  const parentId = "sess:grok:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const childId = "sess:grok:bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const full = await scanLiteHistory(common);
  const child = full.getSession(childId);

  assert.ok(full.getSession(parentId));
  assert.ok(child);
  assert.equal(child.title, "Grok adapter child review");
  assert.equal(child.resume_command, undefined);
  assert.equal(full.listResolvedSessions().some((session) => session.id === childId), true);
  assert.equal(full.listTopLevelSessions().some((session) => session.id === childId), false);
  const tree = full.getProjectsTreeProjection();
  const treeSessionIds = tree.projects
    .flatMap((node) => node.sessions)
    .concat(tree.unlinkedSessions)
    .map((session) => session.id);
  assert.equal(treeSessionIds.includes(childId), false);
  assert.ok(
    tree.projects.some((node) => node.turns.some((turn) => turn.session_id === childId)),
    "delegated child turns stay visible in the parent project bucket",
  );
  assert.equal(full.search({ query: "delegated child" }).total, 1);
  assert.deepEqual(full.projectionIssues, []);

  const parentRelated = full.listSessionRelatedWork(parentId);
  assert.ok(parentRelated.some((entry) =>
    entry.relation_kind === "delegated_session" &&
    entry.direction === "outbound" &&
    entry.child_session_ref === childId
  ));
  const childInbound = full.listSessionRelatedWork(childId).filter((entry) =>
    entry.relation_kind === "delegated_session" &&
    entry.direction === "inbound"
  );
  assert.equal(childInbound.length, 1);
  assert.equal(childInbound[0]?.parent_session_ref, parentId);
  const family = full.getSessionFamily(parentId);
  assert.ok(family);
  assert.equal(family.child_count, 1);
  assert.equal(family.children[0]?.child_session_ref, childId);
  assert.ok(family.combined.storage_bytes > family.parent.storage_bytes);
  assert.equal(family.children.filter((entry) => entry.child_session_ref === childId).length, 1);
  assert.equal(full.getSessionFamily(childId), undefined);

  const targetedParent = await scanLiteHistory({ ...common, sessionRefs: [parentId] });
  assert.ok(targetedParent.getSession(childId));
  assert.equal(targetedParent.listTopLevelSessions().some((session) => session.id === childId), false);
  assert.equal(targetedParent.getSessionFamily(parentId)?.children[0]?.child_session_ref, childId);
  assert.equal(targetedParent.getSession(childId)?.title, child.title);
  assert.deepEqual(targetedParent.projectionIssues, []);
});

test("Lite inventories Claude sidecar subagent files under the parent session", async () => {
  const snapshot = await scanLiteHistory({
    homeDir: path.join(mockDataRoot, "empty-home"),
    hostname: "cchistory-lite-claude-sidecar-host",
    sourceRefs: ["claude_code"],
    sourceRoots: [{
      sourceRef: "claude_code",
      baseDir: path.join(mockDataRoot, ".claude", "projects", "-Users-mock-user-workspace-chat-ui-kit"),
    }],
    safeMode: true,
    contextMode: "full",
  });
  const parentId = "sess:claude_code:cc1df109-4282-4321-8248-8bbcd471da78";
  const family = snapshot.getSessionFamily(parentId);
  assert.ok(family);
  assert.equal(family.child_count, 1);
  assert.equal(family.children[0]?.identity_kind, "sidecar");
  assert.equal(family.children[0]?.child_session_ref, undefined);
  assert.ok(family.combined.storage_bytes > family.parent.storage_bytes);
  assert.equal(snapshot.listTopLevelSessions().some((session) => session.id === parentId), true);
  const families = snapshot.listSessionFamilies();
  assert.equal(families.filter((entry) => entry.parent_session_ref === parentId).length, 1);
  assert.equal(
    families.every((entry) => snapshot.getSession(entry.parent_session_ref) !== undefined),
    true,
  );
  assert.equal(
    families.some((entry) => entry.children.some((child) => child.child_session_ref === parentId)),
    false,
  );
});

test("Lite does not list Claude message parentUuid ancestry as a session family", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-claude-parent-uuid-"));
  try {
    const sourceSessionId = "9d77cfc2-1e2e-4fcb-a0f5-0013bd8cf101";
    const projectDir = path.join(tempRoot, ".claude", "projects", "-workspace-claude-parent-uuid");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, `${sourceSessionId}.jsonl`),
      await readFile(path.join(mockDataRoot, "fixtures", "source-shapes", "claude", "ordinary-parent-uuid.jsonl")),
    );
    const snapshot = await scanLiteHistory({
      homeDir: tempRoot,
      hostname: "cchistory-lite-claude-parent-uuid-host",
      sourceRefs: ["claude_code"],
      sourceRoots: [{ sourceRef: "claude_code", baseDir: projectDir }],
      safeMode: true,
      contextMode: "full",
    });
    const sessionId = `sess:claude_code:${sourceSessionId}`;
    assert.ok(snapshot.getSession(sessionId));
    assert.equal(snapshot.listSessionFamilies().length, 0);
    assert.equal(snapshot.getSessionFamily(sessionId), undefined);
    assert.equal(
      snapshot.data.delegated_children.some((child) => child.child_session_ref === sessionId),
      false,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Lite path-links Cursor nested subagent transcripts out of top-level collections", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-cursor-family-"));
  try {
    const parentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01";
    const childId = "agent-aaaa";
    const transcriptDir = path.join(tempRoot, ".cursor", "projects", "workspace-a", "agent-transcripts", parentId);
    await mkdir(path.join(transcriptDir, "subagents"), { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${parentId}.jsonl`),
      `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "Parent ask." }] } })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(transcriptDir, "subagents", `${childId}.jsonl`),
      `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "Child ask." }] } })}\n`,
      "utf8",
    );
    const snapshot = await scanLiteHistory({
      homeDir: tempRoot,
      hostname: "cchistory-lite-cursor-family-host",
      sourceRefs: ["cursor_agent"],
      sourceRoots: [{ sourceRef: "cursor_agent", baseDir: path.join(tempRoot, ".cursor", "projects") }],
      safeMode: true,
      contextMode: "full",
    });
    const parentRef = `sess:cursor_agent:${parentId}`;
    const childRef = `sess:cursor_agent:${childId}`;
    assert.ok(snapshot.getSession(parentRef));
    assert.ok(snapshot.getSession(childRef));
    const family = snapshot.getSessionFamily(parentRef);
    assert.ok(family);
    assert.equal(family.child_count, 1);
    assert.equal(family.children[0]?.identity_kind, "session");
    assert.equal(family.children[0]?.child_session_ref, childRef);
    assert.equal(snapshot.listTopLevelSessions().some((session) => session.id === childRef), false);
    assert.equal(snapshot.listTopLevelSessions().some((session) => session.id === parentRef), true);
    assert.equal(snapshot.getSessionFamily(childRef), undefined);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Lite scans explicit roots without creating or reading a Full store", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-no-store-"));
  try {
    await assert.rejects(
      resolveLiteSources({
        homeDir: tempHome,
        sourceRefs: ["claude"],
      }),
      /Unknown Lite source adapter: claude\. Registered slots: .*claude_code/,
    );
    await assert.rejects(
      resolveLiteSources({
        homeDir: tempHome,
        sourceRoots: [{ sourceRef: "claude", baseDir: path.join(mockDataRoot, ".codex", "sessions") }],
      }),
      /not a single project folder/,
    );

    const resolved = await resolveLiteSources({
      homeDir: tempHome,
      sourceRoots: [
        { sourceRef: "codex", baseDir: path.join(mockDataRoot, ".codex", "sessions") },
      ],
    });
    assert.deepEqual(resolved.map((source) => source.platform), ["codex"]);

    const snapshot = await scanLiteHistory({
      homeDir: tempHome,
      safeMode: true,
      sourceRoots: [
        { sourceRef: "codex", baseDir: path.join(mockDataRoot, ".codex", "sessions") },
      ],
    });
    assert.ok(snapshot.listResolvedTurns().length > 0);
    await assert.rejects(access(path.join(tempHome, ".cchistory")));

    await assert.rejects(
      scanLiteHistory({
        homeDir: tempHome,
        sourceRoots: [{ sourceRef: "codex", baseDir: path.join(tempHome, ".cchistory") }],
      }),
      /Full store paths are not Lite sources/,
    );

    const fullStoreRoot = path.join(tempHome, "full-store");
    await mkdir(fullStoreRoot);
    await writeFile(path.join(fullStoreRoot, "cchistory.sqlite"), "not opened by Lite");
    await assert.rejects(assertLiteSourceRoot(fullStoreRoot), /Full store paths are not Lite sources/);

    // Case variants resolve to the Full store on case-insensitive filesystems
    // (macOS/Windows), so the guard rejects them everywhere.
    const caseVariantStoreRoot = path.join(tempHome, ".CCHistory");
    await mkdir(caseVariantStoreRoot);
    await assert.rejects(assertLiteSourceRoot(caseVariantStoreRoot), /Full store paths are not Lite sources/);
    const caseVariantStoreFile = path.join(tempHome, "CCHistory.sqlite");
    await writeFile(caseVariantStoreFile, "not opened by Lite");
    await assert.rejects(assertLiteSourceRoot(caseVariantStoreFile), /Full store paths are not Lite sources/);

    const fullBundleRoot = path.join(tempHome, "full-bundle");
    await mkdir(path.join(fullBundleRoot, "payloads"), { recursive: true });
    await writeFile(path.join(fullBundleRoot, "manifest.json"), "{}");
    await assert.rejects(assertLiteSourceRoot(fullBundleRoot), /Full bundle paths are not Lite sources/);

    // `recursive` because the ".CCHistory" probe above already created this exact
    // directory on case-insensitive filesystems (macOS/Windows).
    const canonicalFullRoot = path.join(tempHome, ".cchistory");
    await mkdir(canonicalFullRoot, { recursive: true });
    await writeFile(path.join(canonicalFullRoot, "cchistory.sqlite"), "not opened by Lite");
    await assert.rejects(
      assertLiteSourceRoot(tempHome, { homeDir: tempHome }),
      /overlapping the Full store are not allowed in Lite/,
    );
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite rebuilds native inventory for appended, added, and deleted sessions", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-live-inventory-"));
  const sourceRoot = path.join(tempHome, "sessions");
  const firstPath = path.join(sourceRoot, "rollout-2026-08-12T00-00-00-live-first.jsonl");
  const secondPath = path.join(sourceRoot, "rollout-2026-08-12T00-01-00-live-second.jsonl");
  const common = {
    homeDir: tempHome,
    hostname: "cchistory-lite-live-inventory-host",
    sourceRefs: ["codex"],
    sourceRoots: [{ sourceRef: "codex", baseDir: sourceRoot }],
    safeMode: true,
    contextMode: "none" as const,
  };

  try {
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(firstPath, codexSessionJsonl("live-first", "First live inventory turn.", "00:00"), "utf8");
    const initial = await scanLiteHistory(common);
    assert.deepEqual(initial.listResolvedSessions().map((session) => session.source_session_id), ["live-first"]);
    assert.equal(initial.listResolvedTurns().length, 1);

    await appendFile(
      firstPath,
      `\n${codexTurnJsonl("live-first", "Appended live inventory turn.", "00:02")}`,
      "utf8",
    );
    const advancedMtime = new Date("2030-01-01T00:00:00.000Z");
    await utimes(firstPath, advancedMtime, advancedMtime);
    const appended = await scanLiteHistory(common);
    assert.equal(appended.listResolvedTurns().length, 2);
    assert.equal(appended.search({ query: "Appended live inventory" }).total, 1);

    await writeFile(secondPath, codexSessionJsonl("live-second", "Second live inventory session.", "00:01"), "utf8");
    const added = await scanLiteHistory(common);
    assert.deepEqual(
      added.listResolvedSessions().map((session) => session.source_session_id).sort(),
      ["live-first", "live-second"],
    );

    await rm(firstPath);
    const deleted = await scanLiteHistory(common);
    assert.deepEqual(deleted.listResolvedSessions().map((session) => session.source_session_id), ["live-second"]);
    assert.equal(deleted.search({ query: "Appended live inventory" }).total, 0);
    await assert.rejects(access(path.join(tempHome, ".cchistory")));
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite context-light Codex scanning preserves canonical turns while releasing contexts", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-codex-stream-"));
  try {
    const sourceRoots = [
      { sourceRef: "codex", baseDir: path.join(mockDataRoot, fixtureRoots.codex) },
    ];
    const sources = await resolveLiteSources({
      homeDir: tempHome,
      hostname: "cchistory-lite-codex-stream-host",
      sourceRefs: ["codex"],
      sourceRoots,
    });
    const expectedProbe = await runSourceProbe(interpretSessionEvidence, { safe_mode: true }, sources);
    const expected = buildLiveSnapshot(expectedProbe);
    const actual = await scanLiteHistory({
      homeDir: tempHome,
      hostname: "cchistory-lite-codex-stream-host",
      sourceRefs: ["codex"],
      sourceRoots,
      safeMode: true,
      contextMode: "none",
    });

    assert.deepEqual(actual.listResolvedSessions(), expected.listResolvedSessions());
    assert.deepEqual(actual.listResolvedTurns(), expected.listResolvedTurns());
    assert.deepEqual(normalizeProjects(actual.listProjects()), normalizeProjects(expected.listProjects()));
    assert.deepEqual(actual.listAskUserQuestionTurns(), expected.listAskUserQuestionTurns());
    assert.deepEqual(
      actual.listSources().map(withoutRunTimestamp),
      expected.listSources().map(withoutRunTimestamp),
    );
    assert.equal(actual.data.contexts.length, 0);
    assert.ok(expected.data.contexts.length > 0);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite targeted full-context scan materializes only the requested logical session", async () => {
  const base = await scanLiteHistory({
    homeDir: path.join(mockDataRoot, "empty-home"),
    hostname: "cchistory-lite-targeted-context-host",
    sourceRefs: ["codex"],
    sourceRoots: [{ sourceRef: "codex", baseDir: path.join(mockDataRoot, fixtureRoots.codex) }],
    safeMode: true,
    contextMode: "none",
  });
  const target = base.listResolvedSessions()[0];
  assert.ok(target?.source_session_id);

  const detailed = await scanLiteHistory({
    homeDir: path.join(mockDataRoot, "empty-home"),
    hostname: "cchistory-lite-targeted-context-host",
    sourceRefs: ["codex"],
    sourceRoots: [{ sourceRef: "codex", baseDir: path.join(mockDataRoot, fixtureRoots.codex) }],
    safeMode: true,
    contextMode: "full",
    sessionRefs: [target.source_session_id],
  });

  assert.deepEqual(
    new Set(detailed.listResolvedSessions().map((session) => session.id)),
    new Set([
      target.id,
      ...base.listDelegatedChildren(target.id)
        .map((child) => child.child_session_ref)
        .filter((id): id is string => id !== undefined),
    ]),
  );
  const turn = detailed.listResolvedTurns()[0];
  assert.ok(turn);
  assert.ok(detailed.getTurnContext(turn.id));
});

test("Lite directory scope is consistent across sessions, turns, projects, search, and usage", async () => {
  const snapshot = await scanLiteHistory({
    homeDir: path.join(mockDataRoot, "empty-home"),
    hostname: "cchistory-lite-directory-scope-host",
    sourceRefs: ["codex"],
    sourceRoots: [{ sourceRef: "codex", baseDir: path.join(mockDataRoot, fixtureRoots.codex) }],
    safeMode: true,
    contextMode: "none",
  });
  const targetSession = snapshot.listResolvedSessions().find((session) => session.working_directory);
  assert.ok(targetSession?.working_directory);
  const directoryScope = targetSession.working_directory;
  const sessions = snapshot.listResolvedSessions({ directoryScope });
  const sessionIds = new Set(sessions.map((session) => session.id));
  const turns = snapshot.listResolvedTurns({ directoryScope });

  assert.ok(sessions.length > 0);
  assert.ok(sessions.every((session) => session.working_directory?.startsWith(directoryScope)));
  assert.ok(turns.every((turn) => sessionIds.has(turn.session_id)));
  assert.ok(snapshot.listProjects({ directoryScope }).length > 0);

  const query = turns[0]?.canonical_text.split(/\s+/u).find((part) => part.length >= 4);
  assert.ok(query);
  const search = snapshot.search({ query, directoryScope, limit: 100 });
  assert.ok(search.total > 0);
  assert.ok(search.results.every((result) => sessionIds.has(result.turn.session_id)));
  assert.equal(snapshot.getUsageOverview({ directory_scope: directoryScope }).total_turns, turns.length);
  assert.equal(
    snapshot.getUsageRollup("source", { directory_scope: directoryScope }).rows.reduce(
      (total, row) => total + row.turn_count,
      0,
    ),
    turns.length,
  );
});

test("Lite --dir uses Codex first-line cwd and still probes split-file sessions together", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-directory-pushdown-"));
  const codexRoot = path.join(tempHome, "codex-sessions");
  try {
    await mkdir(codexRoot, { recursive: true });
    const writeSession = async (
      fileName: string,
      sessionId: string,
      initialDirectory: string,
      finalDirectory: string,
      day = "01",
    ): Promise<void> => {
      await writeFile(
        path.join(codexRoot, fileName),
        [
          {
            timestamp: `2026-07-${day}T00:00:00.000Z`,
            type: "session_meta",
            payload: { id: sessionId, cwd: initialDirectory },
          },
          {
            timestamp: `2026-07-${day}T00:00:01.000Z`,
            type: "turn_context",
            payload: { cwd: finalDirectory, model: "gpt-5" },
          },
          {
            timestamp: `2026-07-${day}T00:00:02.000Z`,
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: `Question for ${sessionId}` }],
            },
          },
          {
            timestamp: `2026-07-${day}T00:00:03.000Z`,
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: `Answer for ${sessionId}` }],
            },
          },
        ].map((row) => JSON.stringify(row)).join("\n"),
        "utf8",
      );
    };
    await writeSession("target.jsonl", "directory-target", "/workspace/app/subdir", "/workspace/app/subdir");
    await writeSession("outside.jsonl", "directory-outside", "/workspace/application", "/workspace/application");
    await writeSession("changed.jsonl", "directory-changed", "/workspace/elsewhere", "/workspace/app/moved");
    await writeSession("split-a.jsonl", "directory-split", "/workspace/elsewhere", "/workspace/elsewhere");
    await writeSession("split-b.jsonl", "directory-split", "/workspace/app/resumed", "/workspace/app/resumed", "02");

    const common = {
      homeDir: tempHome,
      hostname: "cchistory-lite-directory-pushdown-host",
      sourceRefs: ["codex"],
      sourceRoots: [{ sourceRef: "codex", baseDir: codexRoot }],
      safeMode: true,
      contextMode: "none" as const,
    };
    const full = await scanLiteHistory(common);
    const fullyParsedFiles: string[] = [];
    const scoped = await scanLiteHistory({
      ...common,
      directoryScope: "/workspace/app",
      onProgress: (event) => {
        if (event.stage === "file_start" && event.file_path) fullyParsedFiles.push(path.basename(event.file_path));
      },
    });

    const scopedIds = scoped.listResolvedSessions({ directoryScope: "/workspace/app" }).map((session) => session.source_session_id);
    assert.ok(scopedIds.includes("directory-target"));
    assert.equal(scopedIds.includes("directory-outside"), false);
    assert.equal(scopedIds.includes("directory-changed"), false);
    assert.ok(fullyParsedFiles.includes("target.jsonl"));
    assert.equal(fullyParsedFiles.includes("outside.jsonl"), false);
    assert.equal(fullyParsedFiles.includes("changed.jsonl"), false);
    assert.ok(full.listResolvedSessions({ directoryScope: "/workspace/app" }).some((session) => session.source_session_id === "directory-changed"));
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite sample --dir keeps older Codex sessions inside the scope instead of the newest files", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-sample-dir-"));
  const codexRoot = path.join(tempHome, "codex-sessions");
  try {
    await mkdir(codexRoot, { recursive: true });
    const writeSession = async (
      fileName: string,
      sessionId: string,
      cwd: string,
      mtime: Date,
    ): Promise<void> => {
      const filePath = path.join(codexRoot, fileName);
      await writeFile(
        filePath,
        [
          {
            timestamp: "2026-07-01T00:00:00.000Z",
            type: "session_meta",
            payload: { id: sessionId, cwd },
          },
          {
            timestamp: "2026-07-01T00:00:02.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: `Question for ${sessionId}` }],
            },
          },
          {
            timestamp: "2026-07-01T00:00:03.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: `Answer for ${sessionId}` }],
            },
          },
        ].map((row) => JSON.stringify(row)).join("\n"),
        "utf8",
      );
      await utimes(filePath, mtime, mtime);
    };
    await writeSession("inside-old.jsonl", "sample-inside", "/workspace/app", new Date("2020-01-01T00:00:00.000Z"));
    await writeSession("outside-new.jsonl", "sample-outside-new", "/workspace/other", new Date("2026-01-01T00:00:00.000Z"));
    await writeSession("outside-newer.jsonl", "sample-outside-newer", "/workspace/other", new Date("2026-06-01T00:00:00.000Z"));

    const parsedFiles: string[] = [];
    const sampled = await scanLiteHistory({
      homeDir: tempHome,
      hostname: "cchistory-lite-sample-dir-host",
      sourceRefs: ["codex"],
      sourceRoots: [{ sourceRef: "codex", baseDir: codexRoot }],
      safeMode: true,
      contextMode: "none",
      directoryScope: "/workspace/app",
      sample: { perSource: 1 },
      onProgress: (event) => {
        if (event.stage === "file_start" && event.file_path) parsedFiles.push(path.basename(event.file_path));
      },
    });

    const sampledIds = sampled.listTopLevelSessions({ directoryScope: "/workspace/app" })
      .filter((session) => session.turn_count > 0)
      .map((session) => session.source_session_id);
    assert.deepEqual(sampledIds, ["sample-inside"]);
    assert.ok(parsedFiles.includes("inside-old.jsonl"));
    assert.equal(parsedFiles.includes("outside-new.jsonl"), false);
    assert.equal(parsedFiles.includes("outside-newer.jsonl"), false);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite sample perSource below 1 selects no files", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-sample-zero-"));
  const codexRoot = path.join(tempHome, "codex-sessions");
  try {
    await mkdir(codexRoot, { recursive: true });
    await writeFile(
      path.join(codexRoot, "keep.jsonl"),
      [
        {
          timestamp: "2026-07-01T00:00:00.000Z",
          type: "session_meta",
          payload: { id: "sample-zero", cwd: "/workspace/app" },
        },
        {
          timestamp: "2026-07-01T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Should not be sampled." }],
          },
        },
      ].map((row) => JSON.stringify(row)).join("\n"),
      "utf8",
    );
    const parsedFiles: string[] = [];
    const sampled = await scanLiteHistory({
      homeDir: tempHome,
      hostname: "cchistory-lite-sample-zero-host",
      sourceRefs: ["codex"],
      sourceRoots: [{ sourceRef: "codex", baseDir: codexRoot }],
      safeMode: true,
      contextMode: "none",
      sample: { perSource: 0 },
      onProgress: (event) => {
        if (event.stage === "file_start" && event.file_path) parsedFiles.push(path.basename(event.file_path));
      },
    });
    assert.equal(sampled.listTopLevelSessions().length, 0);
    assert.deepEqual(parsedFiles, []);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite matching-context scans retain only contexts needed by the requested ref", async () => {
  const scanOptions = {
    homeDir: path.join(mockDataRoot, "empty-home"),
    hostname: "cchistory-lite-matching-context-host",
    sourceRefs: ["codex"],
    sourceRoots: [{ sourceRef: "codex", baseDir: path.join(mockDataRoot, fixtureRoots.codex) }],
    safeMode: true,
  } as const;
  const full = await scanLiteHistory({ ...scanOptions, contextMode: "full" });
  const targetSession = full.listResolvedSessions().find((session) => session.source_session_id);
  assert.ok(targetSession);
  const sessionRef = full.getSessionDisplayRef(targetSession.id);
  assert.ok(sessionRef);

  const bySession = await scanLiteHistory({
    ...scanOptions,
    contextMode: "matching",
    contextTarget: { kind: "session", ref: sessionRef },
  });
  const targetTurnIds = new Set(full.listSessionTurns(targetSession.id).map((turn) => turn.id));
  assert.ok(bySession.data.contexts.length > 0);
  assert.ok(bySession.data.contexts.every((context) => targetTurnIds.has(context.turn_id)));
  assert.deepEqual(bySession.listResolvedSessions(), full.listResolvedSessions());
  assert.deepEqual(bySession.listResolvedTurns(), full.listResolvedTurns());

  const targetTurn = full.listSessionTurns(targetSession.id)[0];
  assert.ok(targetTurn);
  const turnRef = full.getTurnDisplayRef(targetTurn.id);
  assert.ok(turnRef);
  const byTurn = await scanLiteHistory({
    ...scanOptions,
    contextMode: "matching",
    contextTarget: { kind: "turn", ref: turnRef },
  });
  assert.deepEqual(byTurn.data.contexts.map((context) => context.turn_id), [targetTurn.id]);

  const targetTurns = full.listResolvedTurns().slice(0, 2);
  const byTurns = await scanLiteHistory({
    ...scanOptions,
    contextMode: "matching",
    contextTargets: targetTurns.map((turn) => ({ kind: "turn" as const, ref: turn.id.slice(0, 12) })),
  });
  assert.deepEqual(
    new Set(byTurns.data.contexts.map((context) => context.turn_id)),
    new Set(targetTurns.map((turn) => turn.id)),
  );
});

test("context retention preserves query semantics for every registered adapter with nonempty evidence", async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "cchistory-context-matrix-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const roots = await prepareContextFixtureRoots(scratch);
  assert.deepEqual(Object.keys(roots).sort(), listPlatformAdapters().map((adapter) => adapter.platform).sort());
  for (const [sourceRef, baseDir] of Object.entries(roots)) {
    await t.test(sourceRef, async (t) => {
      // Some sanitized formats have no native timestamp. Freeze observation time
      // as well as search recency instead of removing semantic dates from parity.
      t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-05T00:00:00.000Z") });
      const options = {
        homeDir: path.join(mockDataRoot, "empty-home"),
        hostname: `context-retention-${sourceRef}`,
        sourceRefs: [sourceRef],
        sourceRoots: [{ sourceRef, baseDir }],
        safeMode: true,
      };
      const full = await scanLiteHistory({ ...options, contextMode: "full" });
      assert.ok(full.listResolvedTurns().length > 0, `${sourceRef} needs a nonempty turn fixture`);
      assert.ok(full.data.contexts.some((context) => context.assistant_replies.length > 0), `${sourceRef} needs assistant evidence`);
      const compact = await scanLiteHistory({ ...options, contextMode: "none" });
      assertContextIndependentParity(compact, full);
      assert.deepEqual(compact.data.contexts, []);
      for (const turn of compact.listResolvedTurns()) assert.equal(compact.getTurnContext(turn.id), undefined);

      const target = full.listResolvedTurns()[0]!;
      const matching = await scanLiteHistory({
        ...options,
        contextMode: "matching",
        contextTarget: { kind: "turn", ref: target.id },
      });
      assertContextIndependentParity(matching, full);
      assert.deepEqual(matching.data.contexts, full.data.contexts.filter((context) => context.turn_id === target.id));
      assert.equal(full.data.contexts.length, full.listResolvedTurns().length);
    });
  }
});

async function prepareContextFixtureRoots(scratch: string): Promise<Record<string, string>> {
  const fixtures = path.join(mockDataRoot, "fixtures/context-boundary");
  const gemini = path.join(scratch, ".gemini");
  const geminiChats = path.join(gemini, "tmp", "semantic", "chats");
  const kimi = path.join(scratch, ".kimi-code");
  const kimiSession = path.join(kimi, "sessions", "wd_fixture", "session_semantic");
  const kimiMain = path.join(kimiSession, "agents", "main");
  const zcode = path.join(scratch, ".zcode");
  const zcodeDb = path.join(zcode, "cli", "db");
  await mkdir(geminiChats, { recursive: true });
  await mkdir(kimiMain, { recursive: true });
  await mkdir(zcodeDb, { recursive: true });
  await copyFile(path.join(fixtures, "gemini/session.json"), path.join(geminiChats, "session-semantic.json"));
  await copyFile(path.join(fixtures, "kimi/wire.jsonl"), path.join(kimiMain, "wire.jsonl"));
  await copyFile(path.join(fixtures, "kimi/state.json"), path.join(kimiSession, "state.json"));
  const db = new DatabaseSync(path.join(zcodeDb, "db.sqlite"));
  try {
    db.exec(await readFile(path.join(fixtures, "zcode/fixture.sql"), "utf8"));
  } finally {
    db.close();
  }
  return {
    ...Object.fromEntries(Object.entries(fixtureRoots).map(([source, relative]) => [source, path.join(mockDataRoot, relative)])),
    gemini,
    antigravity: path.join(fixtures, "antigravity"),
    openclaw: path.join(fixtures, "openclaw"),
    lobechat: path.join(fixtures, "lobechat"),
    kimi,
    zcode,
  };
}

test("compact queries retain assistant usage and errors without expanding body search", async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "cchistory-context-semantics-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const fixtureRoot = path.join(mockDataRoot, "fixtures/context-boundary/claude");
  const fixture = await readFile(path.join(fixtureRoot, "semantic-boundary.jsonl"), "utf8");
  // Generate a known fake credential only in scratch space, keeping the fixture
  // repository's credential scanner strict.
  await writeFile(path.join(scratch, "semantic-boundary.jsonl"), fixture.replace("<MASKING_TEST_CREDENTIAL>", `sk-${"A".repeat(24)}`));
  await copyFile(path.join(fixtureRoot, "unanswered-boundary.jsonl"), path.join(scratch, "unanswered-boundary.jsonl"));
  const options = {
    homeDir: path.join(mockDataRoot, "empty-home"),
    hostname: "context-semantic-boundary",
    sourceRefs: ["claude_code"],
    sourceRoots: [{ sourceRef: "claude_code", baseDir: scratch }],
    safeMode: true,
  };
  const full = await scanLiteHistory({ ...options, contextMode: "full" });
  const compact = await scanLiteHistory({ ...options, contextMode: "none" });
  assertContextIndependentParity(compact, full);
  const session = compact.listResolvedSessions().find((session) => session.source_session_id === "semantic-boundary");
  assert.ok(session);
  const [answered, toolOnly] = compact.listSessionTurns(session.id);
  const unanswered = compact.listResolvedTurns().find((turn) => turn.session_id !== session.id);
  assert.ok(answered && toolOnly && unanswered);
  assert.equal(answered.context_summary.assistant_reply_count, 2);
  assert.equal(answered.context_summary.tool_call_count, 1);
  assert.equal(answered.context_summary.total_tokens, 32, "deduplicate chunks, retain preceding and trailing orphan usage");
  assert.equal(answered.context_summary.primary_model, "claude-fixture-old");
  assert.equal(answered.context_summary.has_errors, true);
  assert.equal(toolOnly.context_summary.assistant_reply_count, 0);
  assert.equal(toolOnly.context_summary.tool_call_count, 1);
  assert.equal(toolOnly.context_summary.zero_token_reason, "no_assistant_reply");
  // Preserve this known limitation during structural changes. Correcting unanchored
  // token signals is a separate usage-semantics change, not a detail optimization.
  assert.equal(toolOnly.context_summary.total_tokens, undefined);
  assert.equal(unanswered.context_summary.zero_token_reason, "no_assistant_reply");
  assert.equal(unanswered.context_summary.tool_call_count, 0);
  assert.notEqual(unanswered.project_id, answered.project_id);
  assert.equal(compact.getSession(unanswered.session_id)?.title, session.title);
  // The current Claude parser omits the native is_error flag from tool-result
  // atoms. Assistant stop errors must not silently become family tool errors.
  assert.equal(compact.getSessionContribution(session.id)?.stats.tool_error_count, 0);
  assert.equal(compact.getTurnUsage(answered.id)?.total_tokens, 32);
  assert.equal(compact.getTurnContext(unanswered.id), undefined);
  assert.deepEqual(full.getTurnContext(unanswered.id)?.assistant_replies, []);

  for (const target of [answered, unanswered]) {
    const matching = await scanLiteHistory({
      ...options,
      contextMode: "matching",
      contextTarget: { kind: "turn", ref: target.id },
    });
    assertContextIndependentParity(matching, full);
    assert.deepEqual(matching.data.contexts, [full.getTurnContext(target.id)]);
  }

  const context = full.getTurnContext(answered.id);
  assert.ok(context);
  assert.deepEqual(context.assistant_replies.map((reply) => reply.model), ["claude-fixture-old", "claude-fixture-new"]);
  assert.ok(context.assistant_replies[0]?.display_segments.some((segment) => segment.type === "masked"));
  assert.doesNotMatch(context.assistant_replies[0]?.canonical_text ?? "", /sk-AAAAAAAA/u);
  assert.ok(compact.search({ query: "/workspace/semantic-boundary" }).total > 0);
  for (const query of ["assistant-only-reference.ts", "tool-input-only.ts", "tool-output-only.ts", "sk-AAAAAAAAAAAAAAAAAAAAAAAA"]) {
    assert.equal(compact.search({ query }).total, 0, `${query} is not part of the current searchable projection`);
    assert.equal(full.search({ query }).total, 0);
  }
});

function assertContextIndependentParity(actual: LiveHistorySnapshot, expected: LiveHistorySnapshot): void {
  assert.deepEqual(actual.projectionIssues, []);
  assert.deepEqual(expected.projectionIssues, []);
  assert.deepEqual(actual.listSources().map(withoutRunTimestamp), expected.listSources().map(withoutRunTimestamp));
  assert.deepEqual(actual.listResolvedSessions(), expected.listResolvedSessions());
  assert.deepEqual(actual.listTopLevelSessions(), expected.listTopLevelSessions());
  assert.deepEqual(actual.listResolvedTurns(), expected.listResolvedTurns());
  assert.deepEqual(actual.listProjects().map((project) => project.project_id), expected.listProjects().map((project) => project.project_id));
  assert.deepEqual(normalizeProjects(actual.listProjects()), normalizeProjects(expected.listProjects()));
  assert.deepEqual(actual.data.related_work, expected.data.related_work);
  assert.deepEqual(actual.data.session_contributions, expected.data.session_contributions);
  assert.deepEqual(actual.data.delegated_children, expected.data.delegated_children);
  assert.deepEqual(actual.listSessionFamilies(), expected.listSessionFamilies());
  assert.deepEqual(actual.listAskUserQuestionTurns(), expected.listAskUserQuestionTurns());
  assert.deepEqual(actual.listLossAudits(), expected.listLossAudits());
  assert.deepEqual(withoutGeneratedAt(actual.getUsageOverview({ include_known_zero_token: true })), withoutGeneratedAt(expected.getUsageOverview({ include_known_zero_token: true })));
  for (const dimension of ["source", "project", "model", "day"] as const) {
    assert.deepEqual(withoutGeneratedAt(actual.getUsageRollup(dimension)), withoutGeneratedAt(expected.getUsageRollup(dimension)));
  }
  // Compare ordered hits and highlights; relevance scores depend on query time.
  for (const query of ["", "fixture", "review", "workspace", "definitely-absent-fixture-token"]) {
    const result = actual.search({ query, limit: 10 });
    const reference = expected.search({ query, limit: 10 });
    assert.equal(result.total, reference.total);
    assert.deepEqual(result.results.map((hit) => [hit.turn.id, hit.match_field, hit.highlights]), reference.results.map((hit) => [hit.turn.id, hit.match_field, hit.highlights]));
    const sessions = actual.searchSessions({ query, limit: 10 });
    const referenceSessions = expected.searchSessions({ query, limit: 10 });
    assert.equal(sessions.total, referenceSessions.total);
    assert.deepEqual(sessions.results.map((hit) => hit.session.id), referenceSessions.results.map((hit) => hit.session.id));
  }
}

test("Lite display refs extend through collisions and remain actionable", () => {
  const host = {
    id: "host-display-ref",
    hostname: "display-ref",
    first_seen: "2026-01-01T00:00:00.000Z",
    last_seen: "2026-01-01T00:00:00.000Z",
  };
  const baseSession: SessionProjection = {
    id: "sess:codex:abcdefgh-one",
    source_id: "source-display-ref",
    source_platform: "codex",
    source_session_id: "abcdefgh-one",
    host_id: host.id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    turn_count: 1,
    sync_axis: "current",
  };
  const sessions = [
    baseSession,
    { ...baseSession, id: "sess:codex:abcdefgh-two", source_session_id: "abcdefgh-two" },
  ];
  const turns = [
    { ...createBlankRefTurn(sessions[0]!), id: "12345678aaaa", turn_id: "12345678aaaa" },
    { ...createBlankRefTurn(sessions[1]!), id: "12345678bbbb", turn_id: "12345678bbbb" },
  ];
  const snapshot = new LiveHistorySnapshot({
    host,
    sources: [],
    projects: [],
    sessions,
    turns,
    contexts: [],
    ask_user_question_turns: [],
    loss_audits: [],
  });

  const sessionRef = snapshot.getSessionDisplayRef(sessions[0]!.id);
  const turnRef = snapshot.getTurnDisplayRef(turns[0]!.id);
  assert.equal(sessionRef, "abcdefgh-o");
  assert.equal(turnRef, "12345678a");
  assert.equal(snapshot.getSession(sessionRef)?.id, sessions[0]!.id);
  assert.equal(snapshot.getTurn(turnRef)?.id, turns[0]!.id);
});

test("Lite direct canonical targeting narrows the source platform and fails loudly on misses", async () => {
  const common = {
    homeDir: path.join(mockDataRoot, "empty-home"),
    hostname: "cchistory-lite-canonical-target-host",
    sourceRefs: ["codex", "claude_code"],
    sourceRoots: [
      { sourceRef: "codex", baseDir: path.join(mockDataRoot, fixtureRoots.codex) },
      { sourceRef: "claude_code", baseDir: path.join(mockDataRoot, fixtureRoots.claude_code) },
    ],
    safeMode: true,
  } as const;
  const base = await scanLiteHistory({ ...common, contextMode: "none" });
  const target = base.listResolvedSessions().find((session) => session.source_platform === "codex");
  assert.ok(target);
  const targeted = await scanLiteHistory({
    ...common,
    contextMode: "full",
    sessionRefs: [target.id],
  });
  assert.deepEqual(targeted.listSources().map((source) => source.platform), ["codex"]);
  assert.deepEqual(
    new Set(targeted.listResolvedSessions().map((session) => session.id)),
    new Set([
      target.id,
      ...base.listDelegatedChildren(target.id)
        .map((child) => child.child_session_ref)
        .filter((id): id is string => id !== undefined),
    ]),
  );

  const nativeTargeted = await scanLiteHistory({
    ...common,
    contextMode: "full",
    sessionRefs: [target.source_session_id!],
  });
  assert.deepEqual(
    new Set(nativeTargeted.listResolvedSessions().map((session) => session.id)),
    new Set([
      target.id,
      ...base.listDelegatedChildren(target.id)
        .map((child) => child.child_session_ref)
        .filter((id): id is string => id !== undefined),
    ]),
  );

  const codexTargets = base.listResolvedSessions()
    .filter((session) => session.source_platform === "codex" && session.source_session_id)
    .slice(0, 2);
  assert.equal(codexTargets.length, 2);
  const multiTargeted = await scanLiteHistory({
    ...common,
    contextMode: "full",
    sessionRefs: codexTargets.map((session) => session.source_session_id!),
  });
  assert.deepEqual(
    new Set(multiTargeted.listResolvedSessions().map((session) => session.id)),
    new Set([
      ...codexTargets.map((session) => session.id),
      ...codexTargets.flatMap((session) =>
        base.listDelegatedChildren(session.id)
          .map((child) => child.child_session_ref)
          .filter((id): id is string => id !== undefined)
      ),
    ]),
  );

  await assert.rejects(
    scanLiteHistory({
      ...common,
      contextMode: "full",
      sessionRefs: ["sess:codex:does-not-exist"],
    }),
    /requested session/,
  );

  const uniquePrefix = uniqueCanonicalSessionPrefix(target.id, base.listResolvedSessions().map((session) => session.id));
  const prefixTargeted = await scanLiteHistory({
    ...common,
    contextMode: "full",
    sessionRefs: [uniquePrefix],
  });
  assert.equal(prefixTargeted.getSession(uniquePrefix)?.id, target.id);
  assert.deepEqual(
    new Set(prefixTargeted.listResolvedSessions().map((session) => session.id)),
    new Set(targeted.listResolvedSessions().map((session) => session.id)),
  );
});

test("Lite targeted scans resolve unique OpenClaw prefixes with related work", async () => {
  const common = {
    homeDir: path.join(mockDataRoot, "empty-home"),
    hostname: "cchistory-lite-openclaw-prefix-host",
    sourceRefs: ["openclaw"],
    sourceRoots: [{ sourceRef: "openclaw", baseDir: path.join(mockDataRoot, fixtureRoots.openclaw) }],
    safeMode: true,
    contextMode: "full" as const,
  };
  const ownerId = "sess:openclaw:11111111-2222-4333-8444-555555555555";
  const prefix = "sess:openclaw:11111111";
  const targeted = await scanLiteHistory({ ...common, sessionRefs: [prefix] });
  assert.equal(targeted.getSession(prefix)?.id, ownerId);
  assert.ok(targeted.listSessionRelatedWork(ownerId).some((entry) =>
    entry.relation_kind === "automation_run" && entry.direction === "outbound",
  ));
  assert.deepEqual(targeted.projectionIssues, []);
});

test("Lite context-light Claude scanning assembles parent and subagent files before projection", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-claude-stream-"));
  try {
    const sourceRoots = [
      { sourceRef: "claude_code", baseDir: path.join(mockDataRoot, fixtureRoots.claude_code) },
    ];
    const sources = await resolveLiteSources({
      homeDir: tempHome,
      hostname: "cchistory-lite-claude-stream-host",
      sourceRefs: ["claude_code"],
      sourceRoots,
    });
    const expectedProbe = await runSourceProbe(interpretSessionEvidence, { safe_mode: true }, sources);
    const expected = buildLiveSnapshot(expectedProbe);
    const actual = await scanLiteHistory({
      homeDir: tempHome,
      hostname: "cchistory-lite-claude-stream-host",
      sourceRefs: ["claude_code"],
      sourceRoots,
      safeMode: true,
      contextMode: "none",
    });

    assert.deepEqual(actual.listResolvedSessions(), expected.listResolvedSessions());
    assert.deepEqual(actual.listResolvedTurns(), expected.listResolvedTurns());
    assert.deepEqual(normalizeProjects(actual.listProjects()), normalizeProjects(expected.listProjects()));
    assert.deepEqual(actual.listAskUserQuestionTurns(), expected.listAskUserQuestionTurns());
    assert.deepEqual(
      actual.listSources().map(withoutRunTimestamp),
      expected.listSources().map(withoutRunTimestamp),
    );
    assert.equal(actual.data.contexts.length, 0);
    assert.ok(expected.data.contexts.length > 0);
    assert.ok(actual.listResolvedSessions().some((session) => session.source_session_id === "cc1df109-4282-4321-8248-8bbcd471da78"));
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite groups Claude files by content session id across different project paths", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-claude-cross-path-"));
  const claudeRoot = path.join(tempHome, "claude-projects");
  try {
    const sharedSessionId = "shared-claude-session";
    const firstDir = path.join(claudeRoot, "project-a");
    const secondDir = path.join(claudeRoot, "project-b");
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    await writeFile(
      path.join(firstDir, "first-file.jsonl"),
      [
        JSON.stringify({
          type: "user",
          sessionId: sharedSessionId,
          cwd: "/workspace/shared",
          timestamp: "2026-07-01T00:00:00.000Z",
          message: { role: "user", content: "First cross-path question" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: sharedSessionId,
          cwd: "/workspace/shared",
          timestamp: "2026-07-01T00:00:01.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "First answer" }] },
        }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(secondDir, "second-file.jsonl"),
      [
        JSON.stringify({
          type: "user",
          sessionId: sharedSessionId,
          cwd: "/workspace/shared",
          timestamp: "2026-07-01T00:01:00.000Z",
          message: { role: "user", content: "Second cross-path question" },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: sharedSessionId,
          cwd: "/workspace/shared",
          timestamp: "2026-07-01T00:01:01.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "Second answer" }] },
        }),
      ].join("\n"),
      "utf8",
    );

    const sourceRoots = [{ sourceRef: "claude_code", baseDir: claudeRoot }];
    const sources = await resolveLiteSources({
      homeDir: tempHome,
      hostname: "cchistory-lite-claude-cross-path-host",
      sourceRefs: ["claude_code"],
      sourceRoots,
    });
    const expected = buildLiveSnapshot(await runSourceProbe(interpretSessionEvidence, { safe_mode: true }, sources));
    let sourceStarts = 0;
    const actual = await scanLiteHistory({
      homeDir: tempHome,
      hostname: "cchistory-lite-claude-cross-path-host",
      sourceRefs: ["claude_code"],
      sourceRoots,
      safeMode: true,
      contextMode: "none",
      onProgress: (event) => {
        if (event.stage === "source_start") sourceStarts += 1;
      },
    });

    assert.equal(sourceStarts, 1);
    assert.equal(actual.listResolvedSessions().length, 1);
    assert.deepEqual(actual.listResolvedSessions(), expected.listResolvedSessions());
    assert.deepEqual(actual.listResolvedTurns(), expected.listResolvedTurns());
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite rejects ancestors and descendants of a symlink-relocated Full store", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-symlink-home-"));
  const relocatedParent = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-relocated-store-"));
  try {
    const fullStoreRoot = path.join(relocatedParent, "full-store");
    const fullStoreChild = path.join(fullStoreRoot, "source-shaped-child");
    await mkdir(fullStoreChild, { recursive: true });
    await writeFile(path.join(fullStoreRoot, "cchistory.sqlite"), "not opened by Lite");
    await symlink(fullStoreRoot, path.join(tempHome, ".cchistory"), "dir");

    for (const sourceRoot of [tempHome, relocatedParent, fullStoreChild]) {
      await assert.rejects(
        assertLiteSourceRoot(sourceRoot, { homeDir: tempHome }),
        /overlapping the Full store are not allowed in Lite/,
      );
    }
  } finally {
    await rm(tempHome, { recursive: true, force: true });
    await rm(relocatedParent, { recursive: true, force: true });
  }
});

test("Lite exposes the shared project visibility and display order", () => {
  const projects = [
    createProject("empty", 0, 3),
    createProject("small", 1, 1),
    createProject("large", 5, 2),
  ];
  const snapshot = new LiveHistorySnapshot({
    host: {
      id: "host-lite-project-list",
      hostname: "lite-project-list",
      first_seen: "2026-01-01T00:00:00.000Z",
      last_seen: "2026-01-01T00:00:00.000Z",
    },
    sources: [],
    projects,
    sessions: [],
    turns: [],
    contexts: [],
    ask_user_question_turns: [],
    loss_audits: [],
  });

  assert.deepEqual(
    snapshot.listProjects().map((project) => project.project_id),
    ["project-large", "project-small"],
  );
  assert.equal(snapshot.getProject("project-empty")?.project_id, "project-empty");
});

test("explicit roots replace one adapter without adding the missing adapter roster", async () => {
  const codexRoot = path.join(mockDataRoot, fixtureRoots.codex);
  const resolved = await resolveLiteSources({
    homeDir: mockDataRoot,
    hostname: "cchistory-lite-roster-host",
    sourceRoots: [{ sourceRef: "codex", baseDir: codexRoot }],
  });
  const platforms = resolved.map((source) => source.platform);
  assert.ok(platforms.includes("codex"));
  assert.ok(platforms.includes("claude_code"));
  assert.equal(platforms.includes("lobechat"), false);
  assert.equal(platforms.includes("zcode"), false);
  assert.equal(platforms.includes("accio"), false);
  assert.equal(platforms.includes("cursor_agent"), false);
  assert.equal(platforms.includes("grok"), false);
  assert.equal(resolved.find((source) => source.platform === "codex")?.base_dir, codexRoot);
});

test("Lite opens upstream native SQLite fixture data read-only", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-native-sqlite-"));
  const cursorRoot = path.join(mockDataRoot, fixtureRoots.cursor);
  const cursorDb = path.join(cursorRoot, "7ff8eb6283576301c3822ea828f4a8f4", "975b36d6-f001-4ce9-b64f-5ccd19e111a6", "store.db");
  const walPath = `${cursorDb}-wal`;
  const shmPath = `${cursorDb}-shm`;
  const before = await stat(cursorDb);
  await assert.rejects(access(walPath));
  await assert.rejects(access(shmPath));
  try {
    const snapshot = await scanLiteHistory({
      homeDir: tempHome,
      hostname: "cchistory-lite-native-sqlite-host",
      sourceRefs: ["cursor"],
      sourceRoots: [{ sourceRef: "cursor", baseDir: cursorRoot }],
      safeMode: true,
    });
    assert.ok(snapshot.listResolvedTurns().length > 0);
    const after = await stat(cursorDb);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    await assert.rejects(access(walPath));
    await assert.rejects(access(shmPath));
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite Cursor composer-plus-transcript merge satisfies the projection contract", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-cursor-overlap-"));
  try {
    const composerId = "composer-lite-overlap";
    const projectsRoot = path.join(tempRoot, ".cursor", "projects");
    const transcriptDir = path.join(projectsRoot, "Users-test-my-app", "agent-transcripts", composerId);
    const userDir = path.join(tempRoot, "Library", "Application Support", "Cursor", "User");
    await mkdir(transcriptDir, { recursive: true });
    await mkdir(path.join(userDir, "globalStorage"), { recursive: true });
    await mkdir(path.join(userDir, "workspaceStorage", "ws-overlap"), { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${composerId}.jsonl`),
      [
        {
          role: "user",
          message: { content: [{ type: "text", text: "Inspect from transcript." }] },
          createdAt: "2026-03-10T03:30:00.000Z",
        },
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "Transcript reply." }] },
          createdAt: "2026-03-10T03:30:01.000Z",
        },
        {
          role: "user",
          message: { content: [{ type: "text", text: "Follow up from transcript." }] },
          createdAt: "2026-03-10T03:31:00.000Z",
        },
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "Second transcript reply." }] },
          createdAt: "2026-03-10T03:31:01.000Z",
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(userDir, "workspaceStorage", "ws-overlap", "workspace.json"),
      JSON.stringify({ folder: "file:///Users/test/my_app" }),
      "utf8",
    );
    seedCursorComposerDb(path.join(userDir, "globalStorage", "state.vscdb"), composerId);

    const probe = await runSourceProbe(interpretSessionEvidence, {}, [
      {
        id: "src-cursor-lite-overlap",
        slot_id: "cursor",
        family: "local_coding_agent",
        platform: "cursor",
        display_name: "Cursor",
        base_dir: projectsRoot,
      },
    ]);
    const lite = buildLiveSnapshot(probe);
    assert.deepEqual(lite.projectionIssues, []);
    assert.equal(lite.listResolvedSessions().length, 1);
    assert.equal(lite.listResolvedTurns().length, 2);
    assert.equal(lite.listResolvedSessions()[0]?.working_directory, "/Users/test/my_app");
    assert.equal(
      lite.listResolvedTurns().some((turn) => turn.canonical_text === "Follow up from transcript."),
      true,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Lite Cursor composer key-format and storage-root overlap satisfies the projection contract", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-cursor-composer-overlap-"));
  try {
    const composerId = "composer-lite-both-stores";
    const userDir = path.join(tempRoot, "Cursor", "User");
    const workspaceDir = path.join(userDir, "workspaceStorage", "ws-both-stores");
    await mkdir(path.join(userDir, "globalStorage"), { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    seedCursorComposerDb(path.join(userDir, "globalStorage", "state.vscdb"), composerId, {
      title: "Cursor global composer",
      userText: "Inspect from global composer.",
      includeAllComposers: true,
    });
    seedCursorComposerDb(path.join(workspaceDir, "state.vscdb"), composerId, {
      title: "Cursor workspace composer",
      userText: "Inspect from workspace composer.",
      workspacePath: "/Users/test/workspace_app",
    });
    await writeFile(
      path.join(workspaceDir, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/test/workspace_app" }),
      "utf8",
    );

    const probe = await runSourceProbe(interpretSessionEvidence, {}, [
      {
        id: "src-cursor-lite-composer-overlap",
        slot_id: "cursor",
        family: "local_coding_agent",
        platform: "cursor",
        display_name: "Cursor",
        base_dir: userDir,
      },
    ]);
    const lite = buildLiveSnapshot(probe);
    assert.deepEqual(lite.projectionIssues, []);
    assert.equal(lite.listResolvedSessions().length, 1);
    assert.equal(lite.listResolvedTurns().length, 1);
    assert.equal(lite.listResolvedTurns()[0]?.canonical_text, "Inspect from workspace composer.");
    assert.equal(lite.listResolvedSessions()[0]?.working_directory, "/Users/test/workspace_app");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Lite and Full agree on a synthetic Kimi source through the shared probe pipeline", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-kimi-parity-"));
  try {
    const kimiRoot = path.join(tempRoot, ".kimi-code");
    const sessionId = "session_lite-parity";
    const sessionDir = path.join(kimiRoot, "sessions", "wd_lite-parity", sessionId);
    const mainAgentDir = path.join(sessionDir, "agents", "main");
    await mkdir(mainAgentDir, { recursive: true });

    const wireLines = [
      { type: "metadata", protocol_version: "1", created_at: 1_773_000_000_000 },
      { type: "config.update", modelAlias: "kimi-code/k3", time: 1_773_000_000_100 },
      {
        type: "turn.prompt",
        input: [{ type: "text", text: "Review the Kimi parity boundary." }],
        origin: { kind: "user" },
        time: 1_773_000_001_000,
      },
      {
        type: "context.append_loop_event",
        event: { type: "content.part", uuid: "text-1", part: { type: "text", text: "The shared pipeline answered." } },
        time: 1_773_000_002_000,
      },
      {
        type: "usage.record",
        model: "kimi-code/k3",
        usageScope: "turn",
        usage: { inputOther: 100, inputCacheRead: 20, inputCacheCreation: 5, output: 30 },
        time: 1_773_000_003_000,
      },
      {
        type: "turn.prompt",
        input: [{ type: "text", text: "Now confirm the Lite parity coverage." }],
        origin: { kind: "user" },
        time: 1_773_000_004_000,
      },
      {
        type: "context.append_loop_event",
        event: { type: "content.part", uuid: "text-2", part: { type: "text", text: "Parity coverage confirmed." } },
        time: 1_773_000_005_000,
      },
    ];
    await writeFile(
      path.join(mainAgentDir, "wire.jsonl"),
      wireLines.map((line) => JSON.stringify(line)).join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(sessionDir, "state.json"),
      JSON.stringify({
        createdAt: "2026-03-09T06:00:00.000Z",
        updatedAt: "2026-03-09T06:10:00.000Z",
        title: "Kimi Lite parity",
        workDir: "/workspace/kimi-lite-parity",
        lastPrompt: "Now confirm the Lite parity coverage.",
        agents: { main: { type: "main", parentAgentId: null, homedir: "/tmp/main" } },
        custom: {},
      }),
      "utf8",
    );
    await writeFile(
      path.join(kimiRoot, "session_index.jsonl"),
      JSON.stringify({ sessionId, sessionDir, workDir: "/workspace/kimi-lite-parity" }),
      "utf8",
    );
    await writeFile(path.join(kimiRoot, "workspaces.json"), JSON.stringify({}), "utf8");

    // End-to-end Lite: discovery, source-root guard, probe, and snapshot.
    const lite = await scanLiteHistory({
      homeDir: tempRoot,
      hostname: "cchistory-lite-kimi-parity-host",
      sourceRefs: ["kimi"],
      sourceRoots: [{ sourceRef: "kimi", baseDir: kimiRoot }],
      safeMode: true,
    });
    assert.deepEqual(lite.listSources().map((source) => source.platform), ["kimi"]);
    assert.equal(lite.listResolvedSessions().length, 1);
    assert.equal(lite.listResolvedSessions()[0]?.source_session_id, sessionId);
    assert.equal(lite.listResolvedTurns().length, 2);
    await assert.rejects(access(path.join(tempRoot, ".cchistory")));

    // The two Lite entry points agree: scanLiteHistory() and buildLiveSnapshot(probe).
    const sources = await resolveLiteSources({
      homeDir: tempRoot,
      hostname: "cchistory-lite-kimi-parity-host",
      sourceRefs: ["kimi"],
      sourceRoots: [{ sourceRef: "kimi", baseDir: kimiRoot }],
    });
    const probe = await runSourceProbe(interpretSessionEvidence, { safe_mode: true }, sources);
    const liteFromProbe = buildLiveSnapshot(probe);
    assert.deepEqual(
      jsonNormalize(liteFromProbe.listResolvedSessions()),
      jsonNormalize(lite.listResolvedSessions()),
    );
    assert.deepEqual(
      jsonNormalize(liteFromProbe.listResolvedTurns()),
      jsonNormalize(lite.listResolvedTurns()),
    );
    for (const turn of liteFromProbe.listResolvedTurns()) {
      assert.deepEqual(
        jsonNormalize(liteFromProbe.getTurnContext(turn.id)),
        jsonNormalize(lite.getTurnContext(turn.id)),
      );
    }
    const liteSearch = liteFromProbe.search({ query: "parity", limit: 100 });
    assert.equal(liteSearch.total, 2);
    assert.deepEqual(
      liteSearch.results.map((result) => result.turn.id),
      lite.search({ query: "parity", limit: 100 }).results.map((result) => result.turn.id),
    );
    assert.deepEqual(
      withoutGeneratedAt(liteFromProbe.getUsageOverview()),
      withoutGeneratedAt(lite.getUsageOverview()),
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Lite and Full agree on a synthetic Grok source through the shared probe pipeline", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-grok-parity-"));
  try {
    const grokRoot = path.join(tempRoot, ".grok");
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02";
    const sessionDir = path.join(grokRoot, "sessions", "%2Fworkspace%2Fgrok-lite-parity", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "chat_history.jsonl"),
      [
        { type: "user", content: [{ type: "text", text: "Review the Grok parity boundary." }], timestamp: "2026-03-09T06:01:00.000Z" },
        { type: "assistant", content: "The shared pipeline answered.", model_id: "grok-4.6", timestamp: "2026-03-09T06:02:00.000Z" },
        { type: "user", content: [{ type: "text", text: "Now confirm the Lite parity coverage." }], timestamp: "2026-03-09T06:03:00.000Z" },
        { type: "assistant", content: "Parity coverage confirmed.", model_id: "grok-4.6", timestamp: "2026-03-09T06:04:00.000Z" },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: sessionId, cwd: "/workspace/grok-lite-parity" },
        generated_title: "Grok Lite parity",
        created_at: "2026-03-09T06:00:00.000Z",
        updated_at: "2026-03-09T06:10:00.000Z",
        current_model_id: "grok-4.6",
      }),
      "utf8",
    );

    const lite = await scanLiteHistory({
      homeDir: tempRoot,
      hostname: "cchistory-lite-grok-parity-host",
      sourceRefs: ["grok"],
      sourceRoots: [{ sourceRef: "grok", baseDir: grokRoot }],
      safeMode: true,
    });
    assert.deepEqual(lite.listSources().map((source) => source.platform), ["grok"]);
    assert.equal(lite.listResolvedSessions().length, 1);
    assert.equal(lite.listResolvedSessions()[0]?.source_session_id, sessionId);
    assert.equal(lite.listResolvedTurns().length, 2);
    await assert.rejects(access(path.join(tempRoot, ".cchistory")));

    const sources = await resolveLiteSources({
      homeDir: tempRoot,
      hostname: "cchistory-lite-grok-parity-host",
      sourceRefs: ["grok"],
      sourceRoots: [{ sourceRef: "grok", baseDir: grokRoot }],
    });
    const probe = await runSourceProbe(interpretSessionEvidence, { safe_mode: true }, sources);
    const liteFromProbe = buildLiveSnapshot(probe);
    assert.deepEqual(
      jsonNormalize(liteFromProbe.listResolvedSessions()),
      jsonNormalize(lite.listResolvedSessions()),
    );
    assert.deepEqual(
      jsonNormalize(liteFromProbe.listResolvedTurns()),
      jsonNormalize(lite.listResolvedTurns()),
    );
    const liteSearch = liteFromProbe.search({ query: "parity", limit: 100 });
    assert.equal(liteSearch.total, 2);
    const sessionSearch = lite.searchSessions({ query: "Grok Lite parity", limit: 10 });
    assert.equal(sessionSearch.total, 1);
    assert.equal(sessionSearch.results[0]?.session.source_session_id, sessionId);
    assert.equal(sessionSearch.results[0]?.match_field, "title");
    assert.deepEqual(lite.projectionIssues, []);
    assert.deepEqual(liteFromProbe.projectionIssues, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Lite directory scope skips Grok sessions whose encoded cwd is known not to match", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-grok-dir-"));
  try {
    const grokRoot = path.join(tempRoot, ".grok");
    const keepId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee10";
    const skipId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee11";
    const keepDir = path.join(grokRoot, "sessions", "%2Fworkspace%2Fkeep", keepId);
    const skipDir = path.join(grokRoot, "sessions", "%2Fworkspace%2Fskip", skipId);
    await mkdir(keepDir, { recursive: true });
    await mkdir(skipDir, { recursive: true });
    for (const [sessionDir, sessionId, cwd, prompt] of [
      [keepDir, keepId, "/workspace/keep", "Keep this Grok session visible."],
      [skipDir, skipId, "/workspace/skip", "Skip this Grok session entirely."],
    ] as const) {
      await writeFile(
        path.join(sessionDir, "chat_history.jsonl"),
        `${JSON.stringify({ type: "user", content: [{ type: "text", text: prompt }], timestamp: "2026-03-09T06:01:00.000Z" })}\n`,
        "utf8",
      );
      await writeFile(
        path.join(sessionDir, "summary.json"),
        JSON.stringify({
          info: { id: sessionId, cwd },
          generated_title: prompt,
          created_at: "2026-03-09T06:00:00.000Z",
          updated_at: "2026-03-09T06:10:00.000Z",
        }),
        "utf8",
      );
    }

    const scoped = await scanLiteHistory({
      homeDir: tempRoot,
      hostname: "cchistory-lite-grok-dir-host",
      sourceRefs: ["grok"],
      sourceRoots: [{ sourceRef: "grok", baseDir: grokRoot }],
      directoryScope: "/workspace/keep",
      safeMode: true,
    });
    assert.deepEqual(scoped.listResolvedSessions().map((session) => session.source_session_id), [keepId]);
    assert.equal(scoped.search({ query: "Skip this Grok" }).total, 0);
    assert.equal(scoped.searchSessions({ query: "Keep this Grok" }).total, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Lite targeted Grok show probes only the matching session file", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-grok-show-"));
  try {
    const grokRoot = path.join(tempRoot, ".grok");
    const keepId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee20";
    const skipId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee21";
    const keepDir = path.join(grokRoot, "sessions", "%2Fworkspace%2Fkeep", keepId);
    const skipDir = path.join(grokRoot, "sessions", "%2Fworkspace%2Fskip", skipId);
    await mkdir(keepDir, { recursive: true });
    await mkdir(skipDir, { recursive: true });
    for (const [sessionDir, sessionId, cwd, prompt] of [
      [keepDir, keepId, "/workspace/keep", "Keep this Grok session for show."],
      [skipDir, skipId, "/workspace/skip", "Do not open this Grok session."],
    ] as const) {
      await writeFile(
        path.join(sessionDir, "chat_history.jsonl"),
        `${JSON.stringify({ type: "user", content: [{ type: "text", text: prompt }], timestamp: "2026-03-09T06:01:00.000Z" })}\n`,
        "utf8",
      );
      await writeFile(
        path.join(sessionDir, "summary.json"),
        JSON.stringify({
          info: { id: sessionId, cwd },
          generated_title: prompt,
          created_at: "2026-03-09T06:00:00.000Z",
          updated_at: "2026-03-09T06:10:00.000Z",
        }),
        "utf8",
      );
    }

    const parsedFiles: string[] = [];
    const targeted = await scanLiteHistory({
      homeDir: tempRoot,
      hostname: "cchistory-lite-grok-show-host",
      sourceRefs: ["grok"],
      sourceRoots: [{ sourceRef: "grok", baseDir: grokRoot }],
      safeMode: true,
      contextMode: "full",
      sessionRefs: [`sess:grok:${keepId}`],
      onProgress: (event) => {
        if (event.stage === "file_start" && event.file_path) parsedFiles.push(event.file_path);
      },
    });

    assert.equal(targeted.getSession(`sess:grok:${keepId}`)?.source_session_id, keepId);
    assert.equal(
      targeted.listResolvedSessions().some((session) => session.source_session_id === skipId),
      false,
    );
    assert.ok(parsedFiles.some((filePath) => filePath.includes(keepId) && filePath.endsWith("chat_history.jsonl")));
    assert.equal(parsedFiles.some((filePath) => filePath.includes(skipId)), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("LiveHistorySnapshot treats blank lookup refs as not found instead of matching everything", () => {
  const host = {
    id: "host-blank-ref",
    hostname: "blank-ref",
    first_seen: "2026-01-01T00:00:00.000Z",
    last_seen: "2026-01-01T00:00:00.000Z",
  };
  const session: SessionProjection = {
    id: "session-blank-ref",
    source_id: "source-blank-ref",
    source_platform: "codex",
    host_id: host.id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    turn_count: 1,
    sync_axis: "current",
  };
  const snapshot = new LiveHistorySnapshot({
    host,
    sources: [],
    projects: [],
    sessions: [session],
    turns: [createBlankRefTurn(session)],
    contexts: [],
    ask_user_question_turns: [],
    loss_audits: [],
  });

  assert.equal(snapshot.getSession(""), undefined);
  assert.equal(snapshot.getSession("   "), undefined);
  assert.equal(snapshot.getTurn(""), undefined);
  assert.equal(snapshot.getTurn("  "), undefined);
  assert.equal(snapshot.getSource(""), undefined);
  assert.equal(snapshot.getProject(""), undefined);
  assert.equal(snapshot.getSession("session-blank-ref")?.id, "session-blank-ref");
});

function createBlankRefTurn(session: SessionProjection): UserTurnProjection {
  return {
    id: "turn-blank-ref",
    revision_id: "turn-blank-ref:r1",
    turn_id: "turn-blank-ref",
    turn_revision_id: "turn-blank-ref:r1",
    user_messages: [
      {
        id: "message-blank-ref",
        raw_text: "Blank ref fixture",
        canonical_text: "Blank ref fixture",
        display_segments: [{ type: "text", content: "Blank ref fixture" }],
        sequence: 0,
        is_injected: false,
        created_at: "2026-01-01T00:00:00.000Z",
        atom_refs: ["atom-blank-ref"],
      },
    ],
    raw_text: "Blank ref fixture",
    canonical_text: "Blank ref fixture",
    display_segments: [{ type: "text", content: "Blank ref fixture" }],
    created_at: "2026-01-01T00:00:00.000Z",
    submission_started_at: "2026-01-01T00:00:00.000Z",
    last_context_activity_at: "2026-01-01T00:01:00.000Z",
    session_id: session.id,
    source_id: session.source_id,
    link_state: "unlinked",
    sync_axis: "current",
    value_axis: "active",
    retention_axis: "keep_raw_and_derived",
    context_ref: "context-blank-ref",
    context_summary: {
      assistant_reply_count: 1,
      tool_call_count: 0,
      token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      total_tokens: 2,
      primary_model: "gpt-5",
      has_errors: false,
    },
    lineage: {
      atom_refs: ["atom-blank-ref"],
      candidate_refs: [],
      fragment_refs: [],
      record_refs: [],
      blob_refs: [],
    },
  };
}

function uniqueCanonicalSessionPrefix(sessionId: string, allIds: readonly string[]): string {
  const platformPrefix = sessionId.match(/^sess:[^:]+:/u)?.[0];
  assert.ok(platformPrefix);
  const native = sessionId.slice(platformPrefix.length);
  for (let length = Math.min(8, native.length); length <= native.length; length += 1) {
    const candidate = `${platformPrefix}${native.slice(0, length)}`;
    if (allIds.filter((id) => id.startsWith(candidate)).length === 1) return candidate;
  }
  return sessionId;
}

function sortById<T extends { id: string }>(values: T[]): T[] {
  return jsonNormalize(values).sort((left, right) => left.id.localeCompare(right.id));
}

function targetTurnParityFields(turn: UserTurnProjection) {
  return {
    id: turn.id,
    session_id: turn.session_id,
    raw_text: turn.raw_text,
    canonical_text: turn.canonical_text,
    context_ref: turn.context_ref,
    context_summary: turn.context_summary,
  };
}

function targetContextParityFields(context: LiveHistorySnapshot["data"]["contexts"][number]) {
  return {
    turn_id: context.turn_id,
    system_messages: context.system_messages.map((message) => ({
      id: message.id,
      content: message.content,
      position: message.position,
      sequence: message.sequence,
    })),
    assistant_replies: context.assistant_replies.map((reply) => ({
      id: reply.id,
      content: reply.content,
      content_preview: reply.content_preview,
      token_usage: reply.token_usage,
      token_count: reply.token_count,
      model: reply.model,
      tool_call_ids: reply.tool_call_ids,
      stop_reason: reply.stop_reason,
    })),
    tool_calls: context.tool_calls.map((tool) => ({
      id: tool.id,
      tool_name: tool.tool_name,
      input: tool.input,
      input_summary: tool.input_summary,
      output: tool.output,
      output_preview: tool.output_preview,
      status: tool.status,
      error_message: tool.error_message,
      reply_id: tool.reply_id,
      sequence: tool.sequence,
    })),
  };
}

function targetSessionParityFields(session: SessionProjection) {
  return {
    id: session.id,
    source_id: session.source_id,
    source_platform: session.source_platform,
    host_id: session.host_id,
    title: session.title,
    turn_count: session.turn_count,
    model: session.model,
    working_directory: session.working_directory,
    source_session_id: session.source_session_id,
    primary_project_id: session.primary_project_id,
    sync_axis: session.sync_axis,
  };
}

function createProject(name: string, turns: number, sessions: number): ProjectIdentity {
  return {
    project_id: `project-${name}`,
    project_revision_id: `project-${name}:r1`,
    display_name: name,
    slug: name,
    linkage_state: "committed",
    confidence: 1,
    link_reason: "manual_override",
    manual_override_status: "applied",
    source_platforms: ["codex"],
    host_ids: ["host-lite-project-list"],
    committed_turn_count: turns,
    candidate_turn_count: 0,
    session_count: sessions,
    project_last_activity_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function normalizeProjects(values: ReturnType<LiveHistorySnapshot["listProjects"]>) {
  return jsonNormalize(values)
    .map(({ project_revision_id: _revisionId, created_at: _createdAt, ...project }) => project)
    .sort((left, right) => left.project_id.localeCompare(right.project_id));
}

function withoutGeneratedAt<T extends { generated_at: string }>(value: T): Omit<T, "generated_at"> {
  const normalized = jsonNormalize(value);
  const { generated_at: _generatedAt, ...rest } = normalized;
  return rest;
}

function withoutRunTimestamp<T extends { last_sync?: string | null }>(value: T): Omit<T, "last_sync"> {
  const { last_sync: _lastSync, ...rest } = value;
  return rest;
}

function codexSessionJsonl(sessionId: string, userText: string, minute: string): string {
  return [
    JSON.stringify({
      timestamp: `2026-08-12T${minute}:00.000Z`,
      type: "session_meta",
      payload: { id: sessionId, cwd: "/workspace/live-inventory", model: "gpt-5" },
    }),
    codexTurnJsonl(sessionId, userText, minute),
  ].join("\n");
}

function codexTurnJsonl(_sessionId: string, userText: string, minute: string): string {
  return [
    JSON.stringify({
      timestamp: `2026-08-12T${minute}:01.000Z`,
      type: "turn_context",
      payload: { cwd: "/workspace/live-inventory", model: "gpt-5" },
    }),
    JSON.stringify({
      timestamp: `2026-08-12T${minute}:02.000Z`,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: userText }],
      },
    }),
    JSON.stringify({
      timestamp: `2026-08-12T${minute}:03.000Z`,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `Acknowledged: ${userText}` }],
      },
    }),
  ].join("\n");
}

function seedCursorComposerDb(
  dbPath: string,
  composerId: string,
  options: {
    title?: string;
    userText?: string;
    workspacePath?: string;
    includeAllComposers?: boolean;
  } = {},
): void {
  const title = options.title ?? "Cursor shared composer";
  const userText = options.userText ?? "Inspect from composer.";
  const workspacePath = options.workspacePath ?? "/Users/test/my_app";
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB NOT NULL)");
    const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    const composer = {
      composerId,
      name: title,
      modelConfig: { maxMode: false, modelName: "composer-2" },
      workspaceIdentifier: {
        id: "ws-overlap",
        uri: { fsPath: workspacePath, path: workspacePath, scheme: "file" },
      },
      fullConversationHeadersOnly: [
        { bubbleId: "bubble-user", type: 1 },
        { bubbleId: "bubble-assistant", type: 2 },
      ],
    };
    insert.run(`composerData:${composerId}`, JSON.stringify(composer));
    if (options.includeAllComposers) {
      insert.run("composer.composerData", JSON.stringify({ allComposers: [composer] }));
    }
    insert.run(
      `bubbleId:${composerId}:bubble-user`,
      JSON.stringify({
        bubbleId: "bubble-user",
        type: 1,
        createdAt: "2026-03-10T03:30:00.000Z",
        text: userText,
      }),
    );
    insert.run(
      `bubbleId:${composerId}:bubble-assistant`,
      JSON.stringify({
        bubbleId: "bubble-assistant",
        type: 2,
        createdAt: "2026-03-10T03:30:01.000Z",
        text: "Composer reply.",
      }),
    );
  } finally {
    db.close();
  }
}

function jsonNormalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
