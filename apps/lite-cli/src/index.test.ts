import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LiveHistorySnapshot,
  scanLiteHistory,
  type ScanLiteHistoryOptions,
} from "@cchistory/live-runtime";
import { colorizeHumanText, formatTuiLaunchError, runLiteCli, type LiteCliIo } from "./index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const codexRoot = path.join(repoRoot, "mock_data", ".codex", "sessions");
const openclawRoot = path.join(repoRoot, "mock_data", ".openclaw", "agents");
const fixedNow = Date.parse("2026-08-03T12:00:00.000Z");
let codexSnapshotPromise: Promise<LiveHistorySnapshot> | undefined;

function getCodexSnapshot(): Promise<LiveHistorySnapshot> {
  codexSnapshotPromise ??= scanLiteHistory({
    homeDir: repoRoot,
    hostname: "cchistory-lite-cli-command-test-host",
    sourceRoots: [{ sourceRef: "codex", baseDir: codexRoot }],
    sourceRefs: ["codex"],
    safeMode: true,
    contextMode: "full",
  });
  return codexSnapshotPromise;
}

test("Lite CLI searches, reports stats, and writes one-way export", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-cli-"));
  try {
    const sourceArgs = ["--source-root", `codex=${codexRoot}`, "--safe"];
    const rootArgs = [...sourceArgs, "--json"];
    const search = captureIo(tempHome);
    assert.equal(await runLiteCli(["search", "mock", ...rootArgs], search.io), 0);
    const searchPayload = JSON.parse(search.stdout.join("")) as {
      kind: string;
      total: number;
      results: Array<{ turn: { id: string } }>;
    };
    assert.equal(searchPayload.kind, "search");
    assert.ok(searchPayload.total > 0);

    const sources = captureIo(tempHome);
    assert.equal(await runLiteCli(["sources", ...rootArgs], sources.io), 0);
    const sourcesPayload = JSON.parse(sources.stdout.join("")) as {
      kind: string;
      total: number;
      sources: Array<{ id: string }>;
    };
    assert.equal(sourcesPayload.kind, "sources");
    assert.equal(sourcesPayload.total, 1);

    const sessions = captureIo(tempHome);
    assert.equal(await runLiteCli(["ls", "sessions", ...rootArgs], sessions.io), 0);
    const sessionsPayload = JSON.parse(sessions.stdout.join("")) as {
      kind: string;
      sessions: Array<{ id: string }>;
    };
    assert.equal(sessionsPayload.kind, "sessions");
    assert.ok(sessionsPayload.sessions.length > 0);

    const tree = captureIo(tempHome);
    assert.equal(await runLiteCli(["tree", "projects", ...rootArgs], tree.io), 0);
    assert.equal((JSON.parse(tree.stdout.join("")) as { kind: string }).kind, "project_tree");

    const turnDetail = captureIo(tempHome);
    assert.equal(
      await runLiteCli(["show", "turn", searchPayload.results[0]!.turn.id, ...rootArgs], turnDetail.io),
      0,
    );
    assert.equal((JSON.parse(turnDetail.stdout.join("")) as { kind: string }).kind, "turn_detail");

    const projects = captureIo(tempHome);
    assert.equal(await runLiteCli(["ls", "projects", ...rootArgs], projects.io), 0);
    const projectsPayload = JSON.parse(projects.stdout.join("")) as {
      kind: string;
      projects: Array<{ project_id: string }>;
    };
    assert.equal(projectsPayload.kind, "projects");
    const projectRef = projectsPayload.projects[0]?.project_id;
    assert.ok(projectRef);

    const projectDetail = captureIo(tempHome);
    assert.equal(await runLiteCli(["show", "project", projectRef, ...rootArgs], projectDetail.io), 0);
    assert.equal((JSON.parse(projectDetail.stdout.join("")) as { kind: string }).kind, "project_detail");

    const sourceId = sourcesPayload.sources[0]?.id;
    assert.ok(sourceId);
    const sourceDetail = captureIo(tempHome);
    assert.equal(await runLiteCli(["show", "source", sourceId, ...rootArgs], sourceDetail.io), 0);
    assert.equal((JSON.parse(sourceDetail.stdout.join("")) as { kind: string }).kind, "source_detail");

    const unknownProject = captureIo(tempHome);
    assert.equal(await runLiteCli(["show", "project", "no-such-project", ...rootArgs], unknownProject.io), 2);
    assert.match(unknownProject.stderr.join(""), /Project not found: no-such-project/);

    const invalidShowTarget = captureIo(tempHome);
    assert.equal(await runLiteCli(["show", "blob", projectRef, ...rootArgs], invalidShowTarget.io), 2);
    assert.match(invalidShowTarget.stderr.join(""), /show target must be project, session, turn, or source/);

    const stats = captureIo(tempHome);
    assert.equal(await runLiteCli(["stats", ...rootArgs], stats.io), 0);
    const statsPayload = JSON.parse(stats.stdout.join("")) as { kind: string; overview: { total_turns: number } };
    assert.equal(statsPayload.kind, "stats");
    assert.ok(statsPayload.overview.total_turns > 0);

    const humanStats = captureIo(tempHome);
    assert.equal(await runLiteCli(["stats", ...sourceArgs], humanStats.io), 0);
    assert.match(humanStats.stdout.join(""), /Excluded zero-token turns:/);

    const rollup = captureIo(tempHome);
    assert.equal(await runLiteCli(["stats", "--by", "source", ...rootArgs], rollup.io), 0);
    const rollupPayload = JSON.parse(rollup.stdout.join("")) as { rollup: { dimension: string } };
    assert.equal(rollupPayload.rollup.dimension, "source");

    const outFile = path.join(tempHome, "lite-export.jsonl");
    const exported = captureIo(tempHome);
    assert.equal(
      await runLiteCli(["export", "--format", "jsonl", "--out", outFile, ...rootArgs], exported.io),
      0,
    );
    const firstLine = (await readFile(outFile, "utf8")).split("\n")[0];
    assert.deepEqual(JSON.parse(firstLine ?? "{}"), {
      schema: "cchistory-lite-export/v1",
      kind: "manifest",
      projection_issues: [],
    });

    const jsonExport = captureIo(tempHome);
    assert.equal(
      await runLiteCli(["export", "--format", "json", "--out", "-", ...rootArgs], jsonExport.io),
      0,
    );
    const jsonExportPayload = JSON.parse(jsonExport.stdout.join("")) as {
      schema: string;
      projection_issues: unknown[];
    };
    assert.equal(jsonExportPayload.schema, "cchistory-lite-export/v1");
    assert.deepEqual(jsonExportPayload.projection_issues, []);

    const markdownExport = captureIo(tempHome);
    assert.equal(
      await runLiteCli(["export", "--format", "markdown", "--out", "-", ...rootArgs], markdownExport.io),
      0,
    );
    assert.match(markdownExport.stdout.join(""), /One-way canonical export/);
    assert.match(markdownExport.stdout.join(""), /Projection warnings: 0/);

    const invalid = captureIo(tempHome);
    assert.equal(await runLiteCli(["stats", "--store", path.join(tempHome, ".cchistory")], invalid.io), 2);
    assert.match(invalid.stderr.join(""), /does not accept --store or --db/);

    const forbidden = captureIo(tempHome);
    assert.equal(await runLiteCli(["import", "anything"], forbidden.io), 2);
    assert.match(forbidden.stderr.join(""), /not available in CC History Lite/);

    const missingEquals = captureIo(tempHome);
    assert.equal(await runLiteCli(["sources", "--source-root", "codex"], missingEquals.io), 2);
    assert.match(missingEquals.stderr.join(""), /--source-root must use <slot-or-id>=<path>/);

    const emptySlot = captureIo(tempHome);
    assert.equal(await runLiteCli(["sources", "--source-root", "=/tmp/never-probed"], emptySlot.io), 2);
    assert.match(emptySlot.stderr.join(""), /--source-root must use <slot-or-id>=<path>/);

    const emptyPath = captureIo(tempHome);
    assert.equal(await runLiteCli(["sources", "--source-root", "codex="], emptyPath.io), 2);
    assert.match(emptyPath.stderr.join(""), /--source-root must use <slot-or-id>=<path>/);

    const rejectedFullRoot = captureIo(tempHome);
    assert.equal(
      await runLiteCli(
        ["sources", "--source-root", `codex=${path.join(tempHome, ".cchistory")}`, "--json"],
        rejectedFullRoot.io,
      ),
      1,
    );
    assert.match(rejectedFullRoot.stderr.join(""), /Full store paths are not Lite sources/);

    const rejectedExport = captureIo(tempHome);
    assert.equal(
      await runLiteCli(
        ["export", "--out", path.join(tempHome, ".cchistory", "lite.jsonl"), ...rootArgs],
        rejectedExport.io,
      ),
      2,
    );
    assert.match(rejectedExport.stderr.join(""), /cannot write into a Full store path/);

    const sourceOutput = path.join(codexRoot, "must-not-write-lite-export.jsonl");
    const rejectedSourceOutput = captureIo(tempHome);
    assert.equal(
      await runLiteCli(["export", "--out", sourceOutput, ...rootArgs], rejectedSourceOutput.io),
      2,
    );
    assert.match(rejectedSourceOutput.stderr.join(""), /outside native source roots/);
    await assert.rejects(access(sourceOutput));

    let launchedArgs: string[] | undefined;
    const launched = captureIo(tempHome, async (args) => {
      launchedArgs = args;
      return 0;
    });
    assert.equal(await runLiteCli(["tui", ...rootArgs], launched.io), 0);
    assert.deepEqual(launchedArgs, ["--source-root", `codex=${codexRoot}`, "--safe"]);

    await assert.rejects(access(path.join(tempHome, ".cchistory")));
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite CLI exposes projection diagnostics without corrupting the data stream", async () => {
  const base = await getCodexSnapshot();
  const target = base.data.sessions[0];
  assert.ok(target);
  const broken = new LiveHistorySnapshot({
    ...base.data,
    sessions: base.data.sessions.map((session) =>
      session.id === target.id ? { ...session, turn_count: session.turn_count + 1 } : session,
    ),
  });
  assert.equal(broken.projectionIssues.length, 1);

  const human = captureIo(repoRoot, undefined, { scan: async () => broken });
  assert.equal(await runLiteCli(["ls", "sessions"], human.io), 0);
  assert.match(human.stderr.join(""), /Projection warnings: 1/);
  assert.match(human.stderr.join(""), /session .*declares/);
  assert.doesNotMatch(human.stdout.join(""), /Projection warnings/u);

  const json = captureIo(repoRoot, undefined, { scan: async () => broken });
  assert.equal(await runLiteCli(["ls", "sessions", "--json"], json.io), 0);
  const payload = JSON.parse(json.stdout.join("")) as {
    projection_issues: Array<{ code: string; entity: string; id: string }>;
  };
  assert.deepEqual(payload.projection_issues, [{
    code: "session-turn-count",
    entity: "session",
    id: target.id,
    detail: `declares ${target.turn_count + 1} turns but projects ${target.turn_count}`,
  }]);
  assert.match(json.stderr.join(""), /Projection warnings: 1/);

  const exported = captureIo(repoRoot, undefined, { scan: async () => broken });
  assert.equal(await runLiteCli(["export", "--format", "json", "--out", "-"], exported.io), 0);
  const exportPayload = JSON.parse(exported.stdout.join("")) as {
    projection_issues: Array<{ code: string }>;
  };
  assert.deepEqual(exportPayload.projection_issues.map((issue) => issue.code), ["session-turn-count"]);
});

test("Lite CLI rejects empty inline flag values and non-positive search limits", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-cli-flags-"));
  try {
    const rootArgs = ["--source-root", `codex=${codexRoot}`, "--safe", "--json"];

    const emptyInline = captureIo(tempHome);
    assert.equal(await runLiteCli(["search", "mock", "--project=", ...rootArgs], emptyInline.io), 2);
    assert.match(emptyInline.stderr.join(""), /--project requires a value/);

    const zeroLimit = captureIo(tempHome);
    assert.equal(await runLiteCli(["search", "mock", "--limit", "0", ...rootArgs], zeroLimit.io), 2);
    assert.match(zeroLimit.stderr.join(""), /--limit must be an integer >= 1/);

    const emptyLimitInline = captureIo(tempHome);
    assert.equal(await runLiteCli(["search", "mock", "--limit=", ...rootArgs], emptyLimitInline.io), 2);
    assert.match(emptyLimitInline.stderr.join(""), /--limit requires a value/);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite CLI tree and session detail preserve canonical related work", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-cli-related-work-"));
  const sessionId = "sess:openclaw:44444444-5555-4666-8777-888888888888";
  try {
    const rootArgs = ["--source-root", `openclaw=${openclawRoot}`, "--safe", "--json"];
    const tree = captureIo(tempHome);
    assert.equal(await runLiteCli(["tree", "session", sessionId, ...rootArgs], tree.io), 0);
    const treePayload = JSON.parse(tree.stdout.join("")) as {
      session: { related_work: Array<{ relation_kind: string; direction: string }> };
    };
    assert.deepEqual(
      treePayload.session.related_work.map((entry) => [entry.relation_kind, entry.direction]),
      [["automation_run", "self"]],
    );

    const detail = captureIo(tempHome);
    assert.equal(await runLiteCli(["show", "session", sessionId, ...rootArgs], detail.io), 0);
    const detailPayload = JSON.parse(detail.stdout.join("")) as {
      related_work: Array<{ relation_kind: string; query_session_ref: string }>;
    };
    assert.equal(detailPayload.related_work[0]?.relation_kind, "automation_run");
    assert.equal(detailPayload.related_work[0]?.query_session_ref, sessionId);

    const ownerId = "sess:openclaw:11111111-2222-4333-8444-555555555555";
    const ownerDetail = captureIo(tempHome);
    assert.equal(await runLiteCli(["show", "session", "sess:openclaw:11111111", ...rootArgs], ownerDetail.io), 0);
    const ownerPayload = JSON.parse(ownerDetail.stdout.join("")) as {
      session: { id: string };
      related_work: Array<{ relation_kind: string; direction: string }>;
    };
    assert.equal(ownerPayload.session.id, ownerId);
    assert.ok(ownerPayload.related_work.some((entry) =>
      entry.relation_kind === "automation_run" && entry.direction === "outbound",
    ));
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite CLI resolves export paths before writing through symlinks", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-cli-export-paths-"));
  const nativeSource = path.join(tempHome, "native-source");
  const nativeSourceAlias = path.join(tempHome, "native-source-alias");
  const fullStoreTarget = path.join(tempHome, "full-store-target");
  try {
    await mkdir(nativeSource);
    await symlink(nativeSource, nativeSourceAlias, "dir");
    await mkdir(fullStoreTarget);
    await symlink(fullStoreTarget, path.join(tempHome, ".cchistory"), "dir");

    const rootArgs = ["--source-root", `codex=${nativeSource}`, "--safe"];
    const sourceOutput = path.join(nativeSourceAlias, "must-not-write.jsonl");
    const rejectedSourceOutput = captureIo(tempHome);
    assert.equal(
      await runLiteCli(["export", "--out", sourceOutput, ...rootArgs], rejectedSourceOutput.io),
      2,
    );
    assert.match(rejectedSourceOutput.stderr.join(""), /outside native source roots/);
    await assert.rejects(access(path.join(nativeSource, "must-not-write.jsonl")));

    const fullOutput = path.join(fullStoreTarget, "must-not-write.jsonl");
    const rejectedFullOutput = captureIo(tempHome);
    assert.equal(
      await runLiteCli(["export", "--out", fullOutput, ...rootArgs], rejectedFullOutput.io),
      2,
    );
    assert.match(rejectedFullOutput.stderr.join(""), /cannot write into a Full store path/);
    await assert.rejects(access(fullOutput));

    const existingTarget = path.join(tempHome, "existing-target.jsonl");
    const outputAlias = path.join(tempHome, "output-alias.jsonl");
    await writeFile(existingTarget, "preserve me", "utf8");
    await symlink(existingTarget, outputAlias, "file");
    const rejectedOutputAlias = captureIo(tempHome);
    assert.equal(
      await runLiteCli(["export", "--out", outputAlias, ...rootArgs], rejectedOutputAlias.io),
      2,
    );
    assert.match(rejectedOutputAlias.stderr.join(""), /cannot be a symbolic link/);
    assert.equal(await readFile(existingTarget, "utf8"), "preserve me");
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite CLI export rejects destinations whose parent is a symlink into a Full store or source root", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-cli-export-parents-"));
  const nativeSource = path.join(tempHome, "native-source");
  const exportDir = path.join(tempHome, "exports");
  const sourceAliasDir = path.join(tempHome, "source-alias");
  try {
    await mkdir(nativeSource);
    await mkdir(path.join(tempHome, ".cchistory"));
    // exportDir is a symlink to ~/.cchistory (the Full store). Output paths
    // inside exportDir must be rejected even when the file itself doesn't
    // exist yet — resolvePathForContainment must walk up to detect this.
    await symlink(path.join(tempHome, ".cchistory"), exportDir, "dir");
    await symlink(nativeSource, sourceAliasDir, "dir");

    const rootArgs = ["--source-root", `codex=${nativeSource}`, "--safe"];

    const outputUnderFullStore = path.join(exportDir, "subdir", "lite.jsonl");
    const rejectedFullParent = captureIo(tempHome);
    assert.equal(
      await runLiteCli(["export", "--out", outputUnderFullStore, ...rootArgs], rejectedFullParent.io),
      2,
    );
    assert.match(rejectedFullParent.stderr.join(""), /cannot write into a Full store path/);
    await assert.rejects(access(path.join(tempHome, ".cchistory", "subdir", "lite.jsonl")));

    const outputUnderSource = path.join(sourceAliasDir, "deep", "lite.jsonl");
    const rejectedSourceParent = captureIo(tempHome);
    assert.equal(
      await runLiteCli(["export", "--out", outputUnderSource, ...rootArgs], rejectedSourceParent.io),
      2,
    );
    assert.match(rejectedSourceParent.stderr.join(""), /outside native source roots/);
    await assert.rejects(access(path.join(nativeSource, "deep", "lite.jsonl")));
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite CLI launchTui error formatter hints at lite:tui:link on ENOENT", () => {
  const enoent = Object.assign(new Error("spawn cchistory-lite-tui ENOENT"), { code: "ENOENT" as const });
  const enoentMessage = formatTuiLaunchError(enoent);
  assert.match(enoentMessage, /Unable to launch cchistory-lite-tui:/);
  assert.match(enoentMessage, /pnpm run lite:tui:link/);

  const eacces = Object.assign(new Error("spawn EACCES"), { code: "EACCES" as const });
  const eaccesMessage = formatTuiLaunchError(eacces);
  assert.match(eaccesMessage, /Unable to launch cchistory-lite-tui:/);
  assert.doesNotMatch(eaccesMessage, /lite:tui:link/);

  const plain = new Error("network down");
  assert.match(formatTuiLaunchError(plain), /network down/);
});

test("Lite CLI latest parses defaults, aliases, and positional counts", async () => {
  const snapshot = await getCodexSnapshot();
  const scanner = async () => snapshot;
  const baseSession = snapshot.listResolvedSessions()[0];
  const baseTurn = snapshot.listResolvedTurns()[0];
  assert.ok(baseSession);
  assert.ok(baseTurn);
  const pendingSession = {
    ...baseSession,
    id: "sess:codex:pending-session",
    source_session_id: "pending-session",
    source_platform: "gemini" as const,
    title: "Pending session",
    created_at: "2026-08-03T12:03:00.000Z",
    updated_at: "2026-08-03T12:04:00.000Z",
    turn_count: 1,
  };
  const pendingTurn = {
    ...baseTurn,
    id: "pending-turn-id",
    revision_id: "pending-turn-id:r1",
    turn_id: "pending-turn-id",
    turn_revision_id: "pending-turn-id:r1",
    session_id: pendingSession.id,
    context_summary: {
      assistant_reply_count: 0,
      tool_call_count: 0,
      has_errors: false,
      zero_token_reason: "no_assistant_reply" as const,
    },
  };
  const zeroTurnSnapshot = new LiveHistorySnapshot({
    ...snapshot.data,
    sessions: [
      {
        ...baseSession,
        id: "sess:codex:zero-turn-session",
        source_session_id: "zero-turn-session",
        title: "Zero-turn session",
        created_at: "2026-08-03T12:01:00.000Z",
        updated_at: "2026-08-03T12:02:00.000Z",
        turn_count: 0,
      },
      pendingSession,
      ...snapshot.data.sessions.slice().reverse().map((session) => ({
        ...session,
        updated_at: "2026-08-03T11:59:00.000Z",
      })),
    ],
    turns: [pendingTurn, ...snapshot.data.turns],
  });

  const latestSessions = captureIo(repoRoot, undefined, { scan: async () => zeroTurnSnapshot });
  assert.equal(await runLiteCli(["latest"], latestSessions.io), 0);
  const latestSessionText = latestSessions.stdout.join("");
  const firstSession = snapshot.listResolvedSessions()[0];
  const firstSessionTurn = firstSession ? snapshot.listSessionTurns(firstSession.id)[0] : undefined;
  assert.ok(firstSession && firstSessionTurn);
  const firstSessionModel = firstSessionTurn.context_summary.primary_model ?? firstSession.model;
  const firstSessionTokens = firstSessionTurn.context_summary.token_usage?.total_tokens ?? firstSessionTurn.context_summary.total_tokens;
  assert.ok(firstSessionModel && firstSessionTokens !== undefined);
  assert.match(latestSessionText, /Latest sessions \(4, newest first; one record = one session\)/);
  assert.match(latestSessionText, /LATEST\s+SOURCE\s+SESSION\s+TURNS/);
  assert.match(latestSessionText, /DIR .*MODEL .*TOKENS/);
  assert.doesNotMatch(latestSessionText, /Zero-turn session/);
  assert.doesNotMatch(latestSessionText, /Pending session/);
  assert.ok(latestSessionText.includes(snapshot.getSessionDisplayRef(firstSession.id) ?? firstSession.id));
  assert.ok(latestSessionText.includes(firstSessionModel));
  assert.ok(latestSessionText.includes(new Intl.NumberFormat("en-US").format(firstSessionTokens)));

  const latestTurns = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["latest", "turns", "1"], latestTurns.io), 0);
  const latestTurnText = latestTurns.stdout.join("");
  const firstTurn = snapshot.listResolvedTurns()[0];
  assert.ok(firstTurn);
  const firstTurnSession = snapshot.getSession(firstTurn.session_id);
  const firstTurnModel = firstTurn.context_summary.primary_model ?? firstTurnSession?.model;
  const firstTurnTokens = firstTurn.context_summary.token_usage?.total_tokens ?? firstTurn.context_summary.total_tokens;
  assert.ok(firstTurnModel && firstTurnTokens !== undefined);
  assert.match(latestTurnText, /Latest turns \(1 of 4, newest first; one record = one UserTurn\)/);
  assert.match(latestTurnText, /SESSION\s+TURN\s+MODEL\s+TOKENS\s+PROMPT/);
  assert.ok(latestTurnText.includes(snapshot.getSessionDisplayRef(firstTurn.session_id) ?? firstTurn.session_id));
  assert.ok(latestTurnText.includes(snapshot.getTurnDisplayRef(firstTurn.id) ?? firstTurn.id));
  assert.ok(latestTurnText.includes(firstTurnModel));
  assert.ok(latestTurnText.includes(new Intl.NumberFormat("en-US").format(firstTurnTokens)));

  const narrowTurns = captureIo(repoRoot, undefined, { scan: scanner, columns: 70 });
  assert.equal(await runLiteCli(["latest", "turns", "1"], narrowTurns.io), 0);
  assert.ok(
    narrowTurns.stdout.join("").split("\n").every((line) => displayColumnsForTest(line) <= 70),
    "latest output must stay within a narrow terminal width",
  );

  const defaults = captureIo(repoRoot, undefined, { scan: async () => zeroTurnSnapshot });
  assert.equal(await runLiteCli(["latest", "--json"], defaults.io), 0);
  const defaultPayload = JSON.parse(defaults.stdout.join("")) as {
    kind: string;
    total: number;
    shown: number;
    sessions: Array<{ id: string; turn_count: number; model_summary: string; total_tokens: number | null }>;
  };
  assert.equal(defaultPayload.kind, "sessions");
  assert.equal(
    defaultPayload.total,
    snapshot.listResolvedSessions().filter((session) =>
      session.turn_count > 0 &&
      (session.source_platform !== "gemini" || snapshot.listSessionTurns(session.id).some((turn) => turn.context_summary.assistant_reply_count > 0)),
    ).length,
  );
  assert.equal(defaultPayload.shown, defaultPayload.sessions.length);
  assert.ok(defaultPayload.sessions.every((session) => session.turn_count > 0));
  assert.ok(defaultPayload.sessions.every((session) => session.id !== "sess:codex:zero-turn-session"));
  assert.ok(defaultPayload.sessions.every((session) => session.id !== "sess:codex:pending-session"));
  const expectedLatestSessionId = snapshot.listResolvedTurns()[0]?.session_id;
  assert.ok(expectedLatestSessionId);
  const latestSessionRow = defaultPayload.sessions[0];
  assert.equal(latestSessionRow?.id, expectedLatestSessionId);
  assert.ok(latestSessionRow?.model_summary, "latest session JSON must include a model summary");
  const latestSessionTokenTotals = snapshot.listSessionTurns(expectedLatestSessionId)
    .map((turn) => turn.context_summary.token_usage?.total_tokens ?? turn.context_summary.total_tokens)
    .filter((total): total is number => typeof total === "number" && Number.isFinite(total));
  const latestSessionTokenTotal = latestSessionTokenTotals.length > 0
    ? latestSessionTokenTotals.reduce((total, value) => total + value, 0)
    : null;
  assert.equal(latestSessionRow?.total_tokens, latestSessionTokenTotal);

  const turns = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["latest", "turn", "2", "--json"], turns.io), 0);
  const turnPayload = JSON.parse(turns.stdout.join("")) as { kind: string; shown: number; turns: unknown[] };
  assert.equal(turnPayload.kind, "turns");
  assert.equal(turnPayload.shown, 2);
  assert.equal(turnPayload.turns.length, 2);

  const numeric = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["latest", "1", "--json"], numeric.io), 0);
  assert.equal((JSON.parse(numeric.stdout.join("")) as { shown: number }).shown, 1);

  let rejectedScans = 0;
  const invalid = captureIo(repoRoot, undefined, {
    scan: async () => {
      rejectedScans += 1;
      return snapshot;
    },
  });
  assert.equal(await runLiteCli(["latest", "--limit", "2"], invalid.io), 2);
  assert.match(invalid.stderr.join(""), /--limit is not valid for latest/);
  assert.equal(rejectedScans, 0);
});

test("Lite CLI ls limits human and JSON output and rejects conflicting controls before scanning", async () => {
  const snapshot = await getCodexSnapshot();
  const scanner = async () => snapshot;
  const limited = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["ls", "sessions", "--limit", "1"], limited.io), 0);
  assert.match(limited.stdout.join(""), /Sessions \(1 of 4, newest first; one record = one session\)/);
  assert.match(limited.stdout.join(""), /UPDATED\s+SOURCE\s+SESSION\s+TURNS/);
  assert.match(limited.stdout.join(""), /… and 3 more \(use --limit <n> or --all\)/);
  assert.ok(
    limited.stdout.join("").split("\n").every((line) => displayColumnsForTest(line) <= 100),
    "wide-character table rows must stay within the injected terminal width",
  );

  const all = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["ls", "sessions", "--all", "--json"], all.io), 0);
  const allPayload = JSON.parse(all.stdout.join("")) as {
    total: number;
    shown: number;
    sessions: Array<{ id: string; model_summary: string; total_tokens: number | null }>;
  };
  assert.equal(allPayload.total, snapshot.listResolvedSessions().length);
  assert.equal(allPayload.shown, allPayload.total);
  assert.equal(allPayload.sessions.length, allPayload.total);
  for (const session of allPayload.sessions) {
    assert.ok(session.model_summary, `session ${session.id} is missing a model summary`);
    const tokenTotals = snapshot.listSessionTurns(session.id)
      .map((turn) => turn.context_summary.token_usage?.total_tokens ?? turn.context_summary.total_tokens)
      .filter((total): total is number => typeof total === "number" && Number.isFinite(total));
    const expectedTotal = tokenTotals.length > 0 ? tokenTotals.reduce((total, value) => total + value, 0) : null;
    assert.equal(session.total_tokens, expectedTotal, `session ${session.id} has the wrong aggregate token total`);
  }

  let rejectedScans = 0;
  const conflicting = captureIo(repoRoot, undefined, {
    scan: async () => {
      rejectedScans += 1;
      return snapshot;
    },
  });
  assert.equal(await runLiteCli(["ls", "sessions", "--all", "--limit", "2"], conflicting.io), 2);
  assert.match(conflicting.stderr.join(""), /--all and --limit cannot be used together/);
  assert.equal(rejectedScans, 0);

  const invalidScope = captureIo(repoRoot, undefined, {
    scan: async () => {
      rejectedScans += 1;
      return snapshot;
    },
  });
  assert.equal(await runLiteCli(["ls", "sources", "--dir", "/workspace"], invalidScope.io), 2);
  assert.match(invalidScope.stderr.join(""), /--dir is not valid for ls sources/);
  assert.equal(rejectedScans, 0);
});

test("Lite CLI applies --dir to sessions, search, stats, and project trees", async () => {
  const snapshot = await getCodexSnapshot();
  const scopedSession = snapshot.listResolvedSessions().find((session) => session.working_directory);
  assert.ok(scopedSession?.working_directory);
  const scopeDir = scopedSession.working_directory;
  const scanOptions: ScanLiteHistoryOptions[] = [];
  const scanner = async (options: ScanLiteHistoryOptions) => {
    scanOptions.push(options);
    return snapshot;
  };

  const sessions = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["ls", "sessions", "--dir", scopeDir, "--all", "--json"], sessions.io), 0);
  const sessionPayload = JSON.parse(sessions.stdout.join("")) as {
    sessions: Array<{ working_directory?: string }>;
  };
  assert.ok(sessionPayload.sessions.length > 0);
  assert.ok(sessionPayload.sessions.every((session) => session.working_directory?.startsWith(scopeDir)));

  const scopedTurns = snapshot.listResolvedTurns({ directoryScope: scopeDir });
  const query = scopedTurns[0]?.canonical_text.split(/\s+/u).find((part) => part.length >= 4);
  assert.ok(query);
  const search = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["search", query, "--dir", scopeDir, "--json"], search.io), 0);
  const searchPayload = JSON.parse(search.stdout.join("")) as { results: Array<{ turn: { session_id: string } }> };
  const scopedSessionIds = new Set(snapshot.listResolvedSessions({ directoryScope: scopeDir }).map((session) => session.id));
  assert.ok(searchPayload.results.length > 0);
  assert.ok(searchPayload.results.every((result) => scopedSessionIds.has(result.turn.session_id)));

  const stats = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["stats", "--dir", scopeDir, "--json"], stats.io), 0);
  const statsPayload = JSON.parse(stats.stdout.join("")) as { overview: { total_turns: number } };
  assert.equal(statsPayload.overview.total_turns, scopedTurns.length);

  const tree = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["tree", "projects", "--dir", scopeDir, "--json"], tree.io), 0);
  const treePayload = JSON.parse(tree.stdout.join("")) as {
    projects: Array<{ sessions: Array<{ session: { id: string } }> }>;
    unlinked: Array<{ session: { id: string } }>;
  };
  const treeSessionIds = [
    ...treePayload.projects.flatMap((project) => project.sessions.map((entry) => entry.session.id)),
    ...treePayload.unlinked.map((entry) => entry.session.id),
  ];
  assert.ok(treeSessionIds.length > 0);
  assert.ok(treeSessionIds.every((sessionId) => scopedSessionIds.has(sessionId)));
  assert.ok(scanOptions.length > 0);
  assert.ok(scanOptions.every((options) => options.directoryScope === scopeDir));
});

test("Lite CLI show resolves canonical session refs before a source-wide detail scan", async () => {
  const snapshot = await getCodexSnapshot();
  const session = snapshot.listResolvedSessions().find((entry) => entry.source_session_id);
  const turn = snapshot.listResolvedTurns()[0];
  const project = snapshot.listProjects()[0];
  const source = snapshot.listSources()[0];
  assert.ok(session?.source_session_id && turn && project && source);

  const directCalls: ScanLiteHistoryOptions[] = [];
  const direct = captureIo(repoRoot, undefined, {
    scan: async (options) => {
      directCalls.push(options);
      return snapshot;
    },
  });
  assert.equal(await runLiteCli(["show", "session", session.id, "--limit-files", "1"], direct.io), 0);
  assert.equal(directCalls.length, 2);
  assert.equal(directCalls[0]?.contextMode, "none");
  assert.equal(directCalls[1]?.contextMode, "full");
  assert.deepEqual(directCalls[1]?.sourceRefs, [session.source_id]);
  assert.deepEqual(directCalls[1]?.sessionRefs, [session.id]);
  assert.equal(directCalls[1]?.limitFiles, undefined);
  assert.match(direct.stdout.join(""), /^Session:/);
  assert.match(direct.stdout.join(""), /\nSource\s+/);
  assert.match(direct.stdout.join(""), /\nTurns \(/);
  assert.doesNotMatch(direct.stdout.join(""), /\n\{/);

  const matchingCalls: ScanLiteHistoryOptions[] = [];
  const shortTurnRef = snapshot.getTurnDisplayRef(turn.id);
  assert.ok(shortTurnRef);
  const matching = captureIo(repoRoot, undefined, {
    scan: async (options) => {
      matchingCalls.push(options);
      return snapshot;
    },
  });
  assert.equal(await runLiteCli(["show", "turn", shortTurnRef], matching.io), 0);
  assert.equal(matchingCalls.length, 1);
  assert.equal(matchingCalls[0]?.contextMode, "matching");
  assert.deepEqual(matchingCalls[0]?.contextTarget, { kind: "turn", ref: shortTurnRef });
  assert.match(matching.stdout.join(""), /^Turn:/);
  assert.match(matching.stdout.join(""), /\nPrompt\n/);
  assert.doesNotMatch(matching.stdout.join(""), /\n\{/);

  for (const [kind, ref, heading] of [
    ["project", project.project_id, "Project:"],
    ["source", source.id, "Source:"],
  ] as const) {
    const rendered = captureIo(repoRoot, undefined, { scan: async () => snapshot });
    assert.equal(await runLiteCli(["show", kind, ref], rendered.io), 0);
    assert.ok(rendered.stdout.join("").startsWith(heading));
    assert.doesNotMatch(rendered.stdout.join(""), /\n\{/);
  }
});

test("Lite CLI help documents latest, limits, and directory scope", async () => {
  const captured = captureIo(repoRoot);
  assert.equal(await runLiteCli(["help"], captured.io), 0);
  const help = captured.stdout.join("");
  assert.match(help, /cchistory-lite latest \[sessions\|turns\] \[N\]/);
  assert.match(help, /--limit <n>/);
  assert.match(help, /--all/);
  assert.match(help, /--dir <path>/);
  assert.match(help, /latest sessions is one record per session/);
  assert.match(help, /latest turns is one record per UserTurn/);
  assert.match(help, /sessions with 0 turns are omitted/);
  assert.match(help, /Gemini sessions with no assistant reply are also omitted/);
  assert.match(help, /Sessions without a\nworking directory are excluded/);
});

test("Lite CLI colorizes semantic human-readable fields", () => {
  const colored = colorizeHumanText([
    "Latest sessions (1, newest first; one record = one session)",
    "LATEST     SOURCE        SESSION     TURNS",
    "just now   gemini        550867ae    1",
    "  TITLE agentresearch",
    "  DIR ~/coding/agentresearch · MODEL gemini-2.5-pro · TOKENS 12,345",
  ].join("\n"));
  assert.match(colored, /\u001b\[1m\u001b\[36mLatest sessions/);
  assert.match(colored, /\u001b\[1m\u001b\[2mLATEST/);
  assert.match(colored, /\u001b\[36m~\/coding\/agentresearch\u001b\[0m/);
  assert.match(colored, /\u001b\[35mgemini-2\.5-pro\u001b\[0m/);
  assert.match(colored, /\u001b\[32m12,345\u001b\[0m/);
});

function captureIo(
  cwd: string,
  spawnTui?: (args: string[]) => Promise<number>,
  overrides: Partial<LiteCliIo> = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      cwd,
      homeDir: cwd,
      hostname: "cchistory-lite-test-host",
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      isTTY: false,
      spawnTui,
      now: () => fixedNow,
      columns: 100,
      ...overrides,
    },
  };
}

function displayColumnsForTest(value: string): number {
  let width = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3040 && code <= 0x33bf) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x2fa1f);
    width += wide ? 2 : 1;
  }
  return width;
}
