import assert from "node:assert/strict";
import { access, appendFile, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
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
  buildAdaptiveNodeExecArgv,
  calculateAdaptiveOldSpaceMiB,
  isAdaptiveNodeMemoryApplied,
  LiveHistorySnapshot,
  resolveLiteSources,
  scanLiteHistory,
} from "./index.js";

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
} as const;

test("Lite Node heap policy uses half host memory capped at 4 GiB", () => {
  assert.equal(calculateAdaptiveOldSpaceMiB(3 * 1024 ** 3), 1536);
  assert.equal(calculateAdaptiveOldSpaceMiB(8 * 1024 ** 3), 4096);
  assert.equal(calculateAdaptiveOldSpaceMiB(32 * 1024 ** 3), 4096);
  assert.deepEqual(
    buildAdaptiveNodeExecArgv(
      ["--trace-warnings", "--max-old-space-size=1024", "--max_old_space_size", "768"],
      1536,
    ),
    ["--trace-warnings", "--max-old-space-size=1536"],
  );
  assert.equal(isAdaptiveNodeMemoryApplied([], "1536", 1536), false);
  assert.equal(isAdaptiveNodeMemoryApplied(["--max-old-space-size=1536"], "1536", 1536), true);
  assert.equal(isAdaptiveNodeMemoryApplied(["--max-old-space-size=1024"], "1536", 1536), false);
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
    const probe = await runSourceProbe({ safe_mode: true }, sources);
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
    assert.deepEqual(
      targeted.listResolvedSessions().map(targetSessionParityFields),
      full.listResolvedSessions().filter((session) => session.id === target.id).map(targetSessionParityFields),
      `${sourceRef} session parity`,
    );
    assert.deepEqual(
      targeted.listResolvedTurns().map(targetTurnParityFields),
      full.listResolvedTurns().filter((turn) => turn.session_id === target.id).map(targetTurnParityFields),
      `${sourceRef} turn parity`,
    );
    const targetTurnIds = new Set(full.listSessionTurns(target.id).map((turn) => turn.id));
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
    const sourceWide = buildLiveSnapshot(await runSourceProbe({ safe_mode: true }, sources));
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

  const targetedParent = await scanLiteHistory({ ...common, sessionRefs: [parentId] });
  assert.deepEqual(targetedParent.listResolvedSessions().map((session) => session.id), [parentId]);
  assert.ok(targetedParent.listSessionRelatedWork(parentId).some((entry) =>
    entry.direction === "outbound" && entry.child_session_ref === childId
  ));
  assert.deepEqual(targetedParent.projectionIssues, []);

  const targetedChild = await scanLiteHistory({ ...common, sessionRefs: [childId] });
  assert.deepEqual(targetedChild.listResolvedSessions().map((session) => session.id), [childId]);
  assert.deepEqual(targetedChild.listTopLevelSessions(), []);
  assert.equal(targetedChild.getSession(childId)?.title, "Atlas");
  assert.ok(targetedChild.listSessionRelatedWork(childId).some((entry) =>
    entry.direction === "inbound" && entry.parent_session_ref === parentId
  ));
  assert.deepEqual(targetedChild.projectionIssues, []);
});

test("Lite scans explicit roots without creating or reading a Full store", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-no-store-"));
  try {
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
    const expectedProbe = await runSourceProbe({ safe_mode: true }, sources);
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

  assert.deepEqual(detailed.listResolvedSessions().map((session) => session.id), [target.id]);
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

test("Lite resolves cwd changes and conservatively probes cross-file cwd conflicts", async () => {
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

    assert.deepEqual(
      scoped.listResolvedSessions({ directoryScope: "/workspace/app" }),
      full.listResolvedSessions({ directoryScope: "/workspace/app" }),
    );
    assert.deepEqual(fullyParsedFiles.sort(), ["changed.jsonl", "split-a.jsonl", "split-b.jsonl", "target.jsonl"]);
    assert.equal(fullyParsedFiles.includes("outside.jsonl"), false);
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
  assert.deepEqual(targeted.listResolvedSessions().map((session) => session.id), [target.id]);

  const nativeTargeted = await scanLiteHistory({
    ...common,
    contextMode: "full",
    sessionRefs: [target.source_session_id!],
  });
  assert.deepEqual(nativeTargeted.listResolvedSessions().map((session) => session.id), [target.id]);

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
    new Set(codexTargets.map((session) => session.id)),
  );

  await assert.rejects(
    scanLiteHistory({
      ...common,
      contextMode: "full",
      sessionRefs: ["sess:codex:does-not-exist"],
    }),
    /requested session/,
  );
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
    const expectedProbe = await runSourceProbe({ safe_mode: true }, sources);
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
    const expected = buildLiveSnapshot(await runSourceProbe({ safe_mode: true }, sources));
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

    const probe = await runSourceProbe({}, [
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

    const probe = await runSourceProbe({}, [
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
    const probe = await runSourceProbe({ safe_mode: true }, sources);
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
