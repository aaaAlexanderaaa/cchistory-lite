import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  FULL_SCAN_MEMORY_MULTIPLIER,
  LIGHT_SCAN_MEMORY_MULTIPLIER,
  LiveHistorySnapshot,
  MAX_OLD_SPACE_MIB,
  MIN_OLD_SPACE_MIB,
  SCAN_GUARD_REFUSE_AVAILABLE_FRACTION,
  SCAN_GUARD_WARN_AVAILABLE_FRACTION,
  SCAN_LOCK_WAIT_MS,
  SCAN_WATCHDOG_MIN_FLOOR_BYTES,
  SCAN_WATCHDOG_TOTAL_FLOOR_FRACTION,
  scanLiteHistory,
  ScanGuardAbortedError,
  ScanGuardRefusedError,
  type ScanLiteHistoryOptions,
} from "@cchistory/live-runtime";
import { formatTuiLaunchError, runLiteCli, VERSION, type LiteCliIo } from "./index.js";
import { buildAgentContract } from "./agent-contract.js";
import { compactPayload } from "./json-v2.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const codexRoot = path.join(repoRoot, "mock_data", ".codex", "sessions");
const grokRoot = path.join(repoRoot, "mock_data", "fixtures", "grok-cli");
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
    const unscopedArgs = [...rootArgs, "--no-dir"];
    const search = captureIo(tempHome);
    assert.equal(await runLiteCli(["search", "mock", ...unscopedArgs], search.io), 0);
    const searchPayload = JSON.parse(search.stdout.join("")) as {
      kind: string;
      total: number;
      results: Array<{ session: { id: string }; best_turn: { id: string } | null }>;
      unit: string;
      shown: number;
    };
    assert.equal(searchPayload.kind, "search");
    assert.equal(searchPayload.unit, "session");
    assert.ok(searchPayload.total > 0);
    assert.equal(searchPayload.shown, searchPayload.results.length);
    assert.ok(searchPayload.shown <= searchPayload.total);
    assert.equal((searchPayload as { schema?: string }).schema, "cchistory-lite/v2");

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
    assert.equal(await runLiteCli(["ls", "sessions", ...unscopedArgs], sessions.io), 0);
    const sessionsPayload = JSON.parse(sessions.stdout.join("")) as {
      kind: string;
      sessions: Array<{ id: string }>;
    };
    assert.equal(sessionsPayload.kind, "sessions");
    assert.ok(sessionsPayload.sessions.length > 0);

    const tree = captureIo(tempHome);
    assert.equal(await runLiteCli(["tree", "projects", ...unscopedArgs], tree.io), 0);
    assert.equal((JSON.parse(tree.stdout.join("")) as { kind: string }).kind, "project_tree");

    const turnDetail = captureIo(tempHome);
    assert.equal(
      await runLiteCli(["show", "turn", searchPayload.results[0]!.best_turn!.id, ...rootArgs], turnDetail.io),
      0,
    );
    assert.equal((JSON.parse(turnDetail.stdout.join("")) as { kind: string }).kind, "turn_detail");

    const projects = captureIo(tempHome);
    assert.equal(await runLiteCli(["ls", "projects", ...unscopedArgs], projects.io), 0);
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
    assert.equal(await runLiteCli(["stats", ...unscopedArgs], stats.io), 0);
    const statsPayload = JSON.parse(stats.stdout.join("")) as { kind: string; overview: { total_turns: number } };
    assert.equal(statsPayload.kind, "stats");
    assert.ok(statsPayload.overview.total_turns > 0);

    const humanStats = captureIo(tempHome);
    assert.equal(await runLiteCli(["stats", ...sourceArgs], humanStats.io), 0);
    assert.match(humanStats.stdout.join(""), /Excluded zero-token turns:/);

    const rollup = captureIo(tempHome);
    assert.equal(await runLiteCli(["stats", "--by", "source", ...unscopedArgs], rollup.io), 0);
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
  assert.equal(await runLiteCli(["ls", "sessions", "--json", "--no-dir"], json.io), 0);
  const payload = JSON.parse(json.stdout.join("")) as {
    projection_issues: Array<{ code: string; entity: string; id: string }>;
  };
  assert.deepEqual(payload.projection_issues, [{
    code: "session-turn-count",
    entity: "session",
    id: target.id,
    detail: `declares ${target.turn_count + 1} turns but projects ${target.turn_count}`,
  }]);
  assert.equal(json.stderr.join(""), "");

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
    assert.equal("query_session_ref" in (detailPayload.related_work[0] ?? {}), false);

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

test("Lite CLI inventories delegated families with storage and I/O without mutating sources", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-cli-families-"));
  const parentId = "sess:grok:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const childId = "sess:grok:bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  try {
    const scanArgs = ["--source-root", `grok=${grokRoot}`, "--source", "grok", "--safe", "--json"];
    const listed = captureIo(tempHome);
    assert.equal(await runLiteCli(["ls", "families", ...scanArgs, "--no-dir"], listed.io), 0);
    const listPayload = JSON.parse(listed.stdout.join("")) as {
      kind: string;
      total: number;
      families: Array<{
        parent_session_ref: string;
        child_count: number;
        combined: { storage_bytes: number };
        children: Array<{ child_session_ref: string | null; stats: { storage_bytes: number } }>;
      }>;
    };
    assert.equal(listPayload.kind, "families");
    assert.ok(listPayload.total >= 1);
    const family = listPayload.families.find((entry) => entry.parent_session_ref === parentId);
    assert.ok(family);
    assert.equal(family.child_count, 1);
    assert.equal(family.children[0]?.child_session_ref, childId);
    assert.ok(family.combined.storage_bytes > 0);

    const detail = captureIo(tempHome);
    assert.equal(await runLiteCli(["show", "session", parentId, ...scanArgs], detail.io), 0);
    const detailPayload = JSON.parse(detail.stdout.join("")) as {
      session: { id: string; delegated_child_count: number; family_storage_bytes: number };
      family: {
        child_count: number;
        children: Array<{
          child_session_ref: string | null;
          title: string | null;
          input_preview: string | null;
          output_preview: string | null;
        }>;
      };
    };
    assert.equal(detailPayload.session.id, parentId);
    assert.ok(detailPayload.session.delegated_child_count >= 1);
    assert.ok(detailPayload.session.family_storage_bytes > 0);
    assert.equal(detailPayload.family.child_count, family.child_count);
    assert.equal(detailPayload.family.children[0]?.child_session_ref, childId);
    assert.ok(detailPayload.family.children[0]?.title);
    assert.ok(detailPayload.family.children.some((child) => child.input_preview || child.output_preview));
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite CLI compact JSON excludes raw evidence while canonical JSON retains it", async () => {
  const snapshot = await getCodexSnapshot();
  const target = snapshot.listResolvedTurns().find((turn) => snapshot.getTurnContext(turn.id)?.assistant_replies.length);
  assert.ok(target);

  const compact = captureIo(repoRoot, undefined, { scan: async () => snapshot });
  assert.equal(await runLiteCli(["show", "turn", target.id, "--json"], compact.io), 0);
  const compactPayload = JSON.parse(compact.stdout.join("")) as Record<string, unknown>;
  assert.equal(compactPayload.schema, "cchistory-lite/v2");
  assert.equal(compactPayload.content_trust, "untrusted_history");
  assertNoKeysDeep(compactPayload, new Set([
    "raw_text",
    "display_segments",
    "original_content",
    "lineage",
    "system_messages",
    "tool_calls",
  ]));
  const compactContext = compactPayload.context as { assistant_replies: Array<{ canonical_text: string }> };
  assert.ok(compactContext.assistant_replies.some((reply) => reply.canonical_text.length > 0));

  const canonical = captureIo(repoRoot, undefined, { scan: async () => snapshot });
  assert.equal(await runLiteCli(["show", "turn", target.id, "--json=canonical"], canonical.io), 0);
  const canonicalPayload = JSON.parse(canonical.stdout.join("")) as {
    schema: string;
    turn: { raw_text: string; lineage: unknown };
  };
  assert.equal(canonicalPayload.schema, "cchistory-lite-canonical/v1");
  assert.equal(typeof canonicalPayload.turn.raw_text, "string");
  assert.ok(canonicalPayload.turn.lineage);
});

test("Lite CLI compact session titles cannot reintroduce text removed by canonical masks", async () => {
  const snapshot = await getCodexSnapshot();
  const baseSession = snapshot.listResolvedSessions().find((session) => snapshot.listSessionTurns(session.id).length > 0);
  assert.ok(baseSession);
  const turn = snapshot.listSessionTurns(baseSession.id)[0];
  assert.ok(turn);
  const secret = `sk-${"A".repeat(24)}`;
  const rawTitle = `${secret} Rotate the credential.`;
  const canonicalTitle = "Rotate the credential.";
  const sessions = snapshot.data.sessions.map((session) => session.id === baseSession.id
    ? { ...session, title: rawTitle, canonical_title: canonicalTitle }
    : session);
  const maskedSnapshot = new LiveHistorySnapshot({ ...snapshot.data, sessions });
  const session = maskedSnapshot.getSession(baseSession.id);
  assert.ok(session);
  const relatedWork = {
    id: "related-masked-title",
    relation_kind: "delegated_session",
    target_kind: "session",
    direction: "outbound",
    target_session_ref: "sess:codex:related-masked-title",
    title: rawTitle,
    canonical_title: canonicalTitle,
    created_at: session.created_at,
    updated_at: session.updated_at,
    evidence_confidence: 1,
  };
  const family = {
    parent_session_ref: session.id,
    source_id: session.source_id,
    source_platform: session.source_platform,
    child_count: 1,
    parent: {
      storage_bytes: 1,
      blob_count: 1,
      turn_count: 1,
      assistant_reply_count: 0,
      tool_call_count: 0,
      tool_success_count: 0,
      tool_error_count: 0,
      tool_pending_count: 0,
    },
    combined: {
      storage_bytes: 1,
      blob_count: 1,
      turn_count: 1,
      assistant_reply_count: 0,
      tool_call_count: 0,
      tool_success_count: 0,
      tool_error_count: 0,
      tool_pending_count: 0,
    },
    children: [{
      id: "delegated-child-masked",
      identity_kind: "session" as const,
      parent_session_ref: session.id,
      child_session_ref: session.id,
      source_id: session.source_id,
      source_platform: session.source_platform,
      title: rawTitle,
      created_at: session.created_at,
      updated_at: session.updated_at,
      input_preview: `${"x".repeat(220)} ${secret} spawn the helper`,
      output_preview: `${"x".repeat(220)} ${secret} helper done`,
      origin_paths: [],
      stats: {
        storage_bytes: 0,
        blob_count: 0,
        turn_count: 0,
        assistant_reply_count: 0,
        tool_call_count: 0,
        tool_success_count: 0,
        tool_error_count: 0,
        tool_pending_count: 0,
      },
    }],
  };
  const compactPayloads = [
    compactPayload({ kind: "sessions", sessions: [session] }, maskedSnapshot),
    compactPayload({
      kind: "search",
      query: "Rotate",
      total: 1,
      results: [{ turn, session, highlights: [], relevance_score: 1 }],
    }, maskedSnapshot),
    compactPayload({ kind: "session_detail", session, family, related_work: [relatedWork], turns: [] }, maskedSnapshot),
    compactPayload({ kind: "families", families: [family] }, maskedSnapshot),
    compactPayload({ kind: "turn_detail", turn, session, context: undefined }, maskedSnapshot),
  ];

  for (const payload of compactPayloads) {
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, new RegExp(secret, "u"));
    assert.match(serialized, /Rotate the credential\./u);
  }

  const missingCanonicalTitle = compactPayload({
    kind: "sessions",
    sessions: [{ ...session, canonical_title: undefined }],
  }, maskedSnapshot) as { sessions: Array<{ title: string | null }> };
  assert.equal(missingCanonicalTitle.sessions[0]?.title, null);

  const query = captureIo(repoRoot, undefined, {
    readStdin: async () => JSON.stringify({
      schema: "cchistory-lite-query/v2",
      operations: [{ id: "session", kind: "session", refs: [session.id] }],
    }),
    scan: async () => maskedSnapshot,
  });
  assert.equal(await runLiteCli(["query", "--request", "-", "--no-dir"], query.io), 0);
  assert.doesNotMatch(query.stdout.join(""), new RegExp(secret, "u"));
  assert.match(query.stdout.join(""), /Rotate the credential\./u);

  const canonical = captureIo(repoRoot, undefined, { scan: async () => maskedSnapshot });
  assert.equal(await runLiteCli(["show", "session", session.id, "--json=canonical"], canonical.io), 0);
  const canonicalOutput = JSON.parse(canonical.stdout.join("")) as { session: { title?: string } };
  assert.equal(canonicalOutput.session.title, rawTitle);
});

test("Lite CLI compact turn and session usage consume the canonical runtime projection", async () => {
  const snapshot = await getCodexSnapshot();
  const target = snapshot.listResolvedTurns()[0];
  assert.ok(target);
  const turns = snapshot.data.turns.map((turn) => turn.id === target.id
    ? {
        ...turn,
        context_summary: {
          ...turn.context_summary,
          token_usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 3,
            output_tokens: 4,
            total_tokens: 41,
          },
          total_tokens: 999,
        },
      }
    : turn);
  const inconsistent = new LiveHistorySnapshot({ ...snapshot.data, turns });
  assert.ok(inconsistent.projectionIssues.some((issue) => issue.code === "turn-usage-total-mismatch"));

  const turnPayload = compactPayload({ kind: "turns", turns: [inconsistent.getTurn(target.id)] }, inconsistent) as {
    turns: Array<{ total_tokens: number }>;
  };
  assert.equal(turnPayload.turns[0]?.total_tokens, 41);

  const session = inconsistent.getSession(target.session_id);
  assert.ok(session);
  const sessionPayload = compactPayload({ kind: "sessions", sessions: [session] }, inconsistent) as {
    sessions: Array<{ total_tokens: number }>;
  };
  assert.equal(sessionPayload.sessions[0]?.total_tokens, inconsistent.getSessionUsage(session.id)?.total_tokens);
});

test("Lite CLI query executes one scan and returns operation-level errors", async () => {
  const snapshot = await getCodexSnapshot();
  const session = snapshot.listResolvedSessions()[0];
  const turn = snapshot.listResolvedTurns().find((entry) => snapshot.getTurnContext(entry.id)?.assistant_replies.length);
  assert.ok(session);
  assert.ok(turn);
  const calls: ScanLiteHistoryOptions[] = [];
  const request = JSON.stringify({
    schema: "cchistory-lite-query/v2",
    operations: [
      { id: "find", kind: "search", query: turn.canonical_text.split(/\s+/u)[0], limit: 2 },
      { id: "session", kind: "session", refs: [session.id] },
      { id: "replies", kind: "replies", turn_refs: [turn.id] },
      { id: "missing", kind: "session", refs: ["sess:codex:not-present"] },
      { id: "missing-reply", kind: "replies", turn_refs: ["turn-not-present"] },
    ],
  });
  const captured = captureIo(repoRoot, undefined, {
    readStdin: async () => request,
    scan: async (options) => {
      calls.push(options);
      return snapshot;
    },
  });
  assert.equal(await runLiteCli(["query", "--request", "-", "--no-dir"], captured.io), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.contextMode, "matching");
  assert.deepEqual(calls[0]?.contextTargets, [
    { kind: "turn", ref: turn.id },
    { kind: "turn", ref: "turn-not-present" },
  ]);
  const payload = JSON.parse(captured.stdout.join("")) as {
    schema: string;
    operations: Array<{ id: string; status: string; result?: unknown; error?: { code: string } }>;
  };
  assert.equal(payload.schema, "cchistory-lite-query-result/v2");
  assert.deepEqual(payload.operations.map((operation) => operation.status), ["ok", "ok", "ok", "error", "error"]);
  assert.deepEqual(
    payload.operations.slice(-2).map((operation) => operation.error?.code),
    ["reference_not_found", "reference_not_found"],
  );
  assert.equal(captured.stderr.join(""), "");
});

test("Lite CLI query validates request JSON before scanning", async () => {
  let scans = 0;
  const captured = captureIo(repoRoot, undefined, {
    readStdin: async () => JSON.stringify({ schema: "wrong/v1", operations: [] }),
    scan: async () => {
      scans += 1;
      return getCodexSnapshot();
    },
  });
  assert.equal(await runLiteCli(["--safe", "query", "--request", "-"], captured.io), 2);
  assert.equal(scans, 0);
  assert.equal(captured.stdout.join(""), "");
  const error = JSON.parse(captured.stderr.join("")) as { schema: string; error: { code: string } };
  assert.equal(error.schema, "cchistory-lite-error/v1");
  assert.equal(error.error.code, "invalid_query_request");
});

test("Lite CLI keeps structured query errors after global options and during parsing or scanning", async () => {
  const request = JSON.stringify({
    schema: "cchistory-lite-query/v2",
    operations: [{ id: "find", kind: "search", query: "anything" }],
  });
  const scanFailure = captureIo(repoRoot, undefined, {
    readStdin: async () => request,
    scan: async () => {
      throw new Error("synthetic scan failure");
    },
  });
  assert.equal(await runLiteCli(["--safe", "query", "--request", "-"], scanFailure.io), 1);
  assert.equal(scanFailure.stdout.join(""), "");
  const scanError = JSON.parse(scanFailure.stderr.join("")) as { schema: string; error: { code: string } };
  assert.equal(scanError.schema, "cchistory-lite-error/v1");
  assert.equal(scanError.error.code, "scan_failed");

  const parseFailure = captureIo(repoRoot);
  assert.equal(await runLiteCli(["--safe", "query", "--request"], parseFailure.io), 2);
  const parseError = JSON.parse(parseFailure.stderr.join("")) as { schema: string; error: { code: string } };
  assert.equal(parseError.schema, "cchistory-lite-error/v1");
  assert.equal(parseError.error.code, "invalid_usage");

  const shapeFailure = captureIo(repoRoot);
  assert.equal(await runLiteCli(["--safe", "query", "unexpected", "--request", "-"], shapeFailure.io), 2);
  const shapeError = JSON.parse(shapeFailure.stderr.join("")) as { schema: string; error: { code: string } };
  assert.equal(shapeError.schema, "cchistory-lite-error/v1");
  assert.equal(shapeError.error.code, "invalid_usage");
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
    id: "sess:gemini:pending-session-12345678",
    source_session_id: "pending-session-12345678",
    source_platform: "gemini" as const,
    title: "Pending session",
    created_at: "2026-08-03T12:03:00.000Z",
    updated_at: "2026-12-31T23:59:59.000Z",
    turn_count: 1,
    working_directory: "/workspace/gemini-pending",
    resume_command: undefined,
    resume_working_directory: undefined,
    resume_command_confidence: undefined,
  };
  const pendingTurn = {
    ...baseTurn,
    id: "pending-turn-id",
    revision_id: "pending-turn-id:r1",
    turn_id: "pending-turn-id",
    turn_revision_id: "pending-turn-id:r1",
    session_id: pendingSession.id,
    created_at: "2026-08-03T12:03:00.000Z",
    submission_started_at: "2026-08-03T12:03:00.000Z",
    last_context_activity_at: "2026-08-03T12:03:00.000Z",
    project_id: undefined,
    project_ref: undefined,
    link_state: "unlinked" as const,
    project_link_state: undefined,
    project_confidence: undefined,
    candidate_project_ids: undefined,
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
      pendingSession,
      ...snapshot.data.sessions,
      {
        ...baseSession,
        id: "sess:codex:zero-turn-session",
        source_session_id: "zero-turn-session",
        title: "Zero-turn session",
        created_at: "2026-08-03T12:01:00.000Z",
        updated_at: "2026-08-03T12:02:00.000Z",
        turn_count: 0,
      },
    ],
    turns: [pendingTurn, ...snapshot.data.turns],
  });

  const latestSessions = captureIo(repoRoot, undefined, { scan: async () => zeroTurnSnapshot });
  assert.equal(await runLiteCli(["latest"], latestSessions.io), 0);
  const latestSessionText = latestSessions.stdout.join("");
  assert.match(latestSessionText, /Latest sessions \(6, newest first; one record = one session\)/);
  assert.match(latestSessionText, /● just now ·/);
  assert.match(latestSessionText, /Pending session/);
  assert.doesNotMatch(latestSessionText, /Zero-turn session/);
  assert.doesNotMatch(latestSessionText, /LATEST\s+SOURCE\s+SESSION\s+TURNS/);
  assert.doesNotMatch(latestSessionText, /\bDIR\b/);
  const pendingSessionRef = zeroTurnSnapshot.getSessionDisplayRef(pendingSession.id) ?? pendingSession.id;
  assert.ok(latestSessionText.includes(`session ${pendingSessionRef}`));
  const resumableSession = snapshot.listResolvedSessions().find((session) => session.resume_command);
  assert.ok(resumableSession?.resume_command);
  assert.ok(latestSessionText.replace(/\s+/gu, " ").includes(resumableSession.resume_command));
  const resumableSessionRef = snapshot.getSessionDisplayRef(resumableSession.id) ?? resumableSession.id;
  assert.equal(
    latestSessionText.includes(`session ${resumableSessionRef}`),
    false,
    "latest must not repeat a session id when a resume command already identifies the session",
  );

  const narrowSessions = captureIo(repoRoot, undefined, { scan: scanner, columns: 40 });
  assert.equal(await runLiteCli(["ls", "sessions", "--all"], narrowSessions.io), 0);
  const narrowSessionText = narrowSessions.stdout.join("");
  assert.ok(
    narrowSessionText.split("\n").slice(1).every((line) => displayColumnsForTest(line) <= 40),
    "session rows must stay within the injected terminal width",
  );
  assert.ok(
    narrowSessionText.replace(/\s+/gu, "").includes(resumableSession.resume_command.replace(/\s+/gu, "")),
    "wrapped resume commands must retain every non-whitespace character",
  );

  const latestTurns = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["latest", "turns", "1"], latestTurns.io), 0);
  const latestTurnText = latestTurns.stdout.join("");
  const firstTurn = snapshot.listResolvedTurns()[0];
  assert.ok(firstTurn);
  const firstTurnSession = snapshot.getSession(firstTurn.session_id);
  const firstTurnModel = firstTurn.context_summary.primary_model ?? firstTurnSession?.model;
  const firstTurnTokens = firstTurn.context_summary.token_usage?.total_tokens ?? firstTurn.context_summary.total_tokens;
  assert.ok(firstTurnModel);
  assert.match(latestTurnText, /Latest turns \(1 of 5, newest first; one record = one UserTurn\)/);
  assert.match(latestTurnText, /● .* · Codex/);
  assert.doesNotMatch(latestTurnText, /SESSION\s+TURN\s+MODEL\s+TOKENS\s+PROMPT/);
  assert.ok(latestTurnText.includes(snapshot.getTurnDisplayRef(firstTurn.id) ?? firstTurn.id));
  assert.ok(latestTurnText.includes(firstTurnModel));
  if (firstTurnTokens === undefined) {
    assert.match(latestTurnText, /tokens n\/a/);
  } else {
    assert.ok(latestTurnText.includes(new Intl.NumberFormat("en-US").format(firstTurnTokens)));
  }

  const narrowTurns = captureIo(repoRoot, undefined, { scan: scanner, columns: 70 });
  assert.equal(await runLiteCli(["latest", "turns", "1"], narrowTurns.io), 0);
  assert.ok(
    narrowTurns.stdout.join("").split("\n").every((line) => displayColumnsForTest(line) <= 70),
    "latest output must stay within a narrow terminal width",
  );

  const defaults = captureIo(repoRoot, undefined, { scan: async () => zeroTurnSnapshot });
  assert.equal(await runLiteCli(["latest", "--json", "--no-dir"], defaults.io), 0);
  const defaultPayload = JSON.parse(defaults.stdout.join("")) as {
    kind: string;
    total: number;
    shown: number;
    sessions: Array<{ id: string; turn_count: number; model_summary: string; total_tokens: number | null }>;
  };
  assert.equal(defaultPayload.kind, "sessions");
  assert.equal(
    defaultPayload.total,
    zeroTurnSnapshot.listTopLevelSessions().filter((session) => session.turn_count > 0).length,
  );
  assert.equal(defaultPayload.shown, defaultPayload.sessions.length);
  assert.ok(defaultPayload.sessions.every((session) => session.turn_count > 0));
  assert.ok(defaultPayload.sessions.every((session) => session.id !== "sess:codex:zero-turn-session"));
  assert.ok(defaultPayload.sessions.some((session) => session.id === pendingSession.id));
  const expectedLatestSessionId = pendingSession.id;
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
  assert.equal(await runLiteCli(["latest", "turn", "2", "--json", "--no-dir"], turns.io), 0);
  const turnPayload = JSON.parse(turns.stdout.join("")) as { kind: string; shown: number; turns: unknown[] };
  assert.equal(turnPayload.kind, "turns");
  assert.equal(turnPayload.shown, 2);
  assert.equal(turnPayload.turns.length, 2);

  const numeric = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["latest", "1", "--json", "--no-dir"], numeric.io), 0);
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
  const projects = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["ls", "projects", "--limit", "1"], projects.io), 0);
  assert.match(projects.stdout.join(""), /Projects \(1 of \d+, most active first; one record = one project\)/);
  assert.match(projects.stdout.join(""), /● /);
  assert.doesNotMatch(projects.stdout.join(""), /ACTIVITY\s+LINKAGE\s+SESS\s+TURNS\s+DIRECTORY/);

  const limited = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["ls", "sessions", "--limit", "1"], limited.io), 0);
  assert.match(limited.stdout.join(""), /Sessions \(1 of 5, newest first; one record = one session\)/);
  assert.match(limited.stdout.join(""), /● .* · Codex/);
  assert.doesNotMatch(limited.stdout.join(""), /UPDATED\s+SOURCE\s+SESSION\s+TURNS/);
  assert.match(limited.stdout.join(""), /… and 4 more \(use --limit <n> or --all\)/);
  assert.ok(
    limited.stdout.join("").split("\n").every((line) => displayColumnsForTest(line) <= 100),
    "timeline rows must stay within the injected terminal width",
  );

  const all = captureIo(repoRoot, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["ls", "sessions", "--all", "--json", "--no-dir"], all.io), 0);
  const allPayload = JSON.parse(all.stdout.join("")) as {
    total: number;
    shown: number;
    sessions: Array<{ id: string; model_summary: string; total_tokens: number | null }>;
  };
  assert.equal(allPayload.total, snapshot.listTopLevelSessions().length);
  assert.equal(allPayload.sessions.some((session) => session.id === "sess:codex:codex-delegation-child"), false);
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
  const searchPayload = JSON.parse(search.stdout.join("")) as {
    unit: string;
    total: number;
    shown: number;
    results: Array<{ session: { id: string } }>;
  };
  const scopedSessionIds = new Set(snapshot.listResolvedSessions({ directoryScope: scopeDir }).map((session) => session.id));
  assert.equal(searchPayload.unit, "session");
  assert.equal(searchPayload.shown, searchPayload.results.length);
  assert.ok(searchPayload.results.length > 0);
  assert.ok(searchPayload.results.every((result) => scopedSessionIds.has(result.session.id)));

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
  assert.equal(directCalls.length, 1);
  assert.equal(directCalls[0]?.contextMode, "full");
  assert.deepEqual(directCalls[0]?.sessionRefs, [session.id]);
  assert.equal(directCalls[0]?.limitFiles, undefined);
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

test("Lite CLI markdown export uses the light scan-guard profile; JSON export stays full", async () => {
  const snapshot = await getCodexSnapshot();
  const scanFor = async (args: string[]) => {
    const calls: ScanLiteHistoryOptions[] = [];
    const captured = captureIo(repoRoot, undefined, {
      scan: async (options) => {
        calls.push(options);
        return snapshot;
      },
    });
    assert.equal(await runLiteCli(args, captured.io), 0, captured.stderr.join(""));
    return calls[0];
  };

  const markdown = await scanFor(["export", "--format", "markdown", "--out", "-"]);
  assert.equal(markdown?.contextMode, "none");
  assert.equal(markdown?.scanGuard?.profile, "light");

  const json = await scanFor(["export", "--format", "json", "--out", "-"]);
  assert.equal(json?.contextMode, "full");
  assert.equal(json?.scanGuard?.profile, "full");

  const jsonl = await scanFor(["export", "--format", "jsonl", "--out", "-"]);
  assert.equal(jsonl?.contextMode, "full");
  assert.equal(jsonl?.scanGuard?.profile, "full");
});

test("Lite CLI sample is a bounded latest-shaped preview", async () => {
  const snapshot = await getCodexSnapshot();
  const scanOptions: ScanLiteHistoryOptions[] = [];
  const captured = captureIo(repoRoot, undefined, {
    scan: async (options) => {
      scanOptions.push(options);
      return snapshot;
    },
  });
  assert.equal(await runLiteCli(["sample", "3", "--json"], captured.io), 0);
  assert.equal(scanOptions[0]?.sample?.perSource, 3);
  assert.equal(scanOptions[0]?.directoryScope, undefined);
  const payload = JSON.parse(captured.stdout.join("")) as {
    sampled?: boolean;
    sample_per_source?: number;
    kind?: string;
  };
  assert.equal(payload.kind, "sessions");
  assert.equal(payload.sampled, true);
  assert.equal(payload.sample_per_source, 3);
});

test("the CLI version matches the package manifest", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  ) as { version: string };
  assert.equal(VERSION, manifest.version);
  const captured = captureIo(repoRoot);
  assert.equal(await runLiteCli(["--version"], captured.io), 0);
  assert.equal(captured.stdout.join(""), `${VERSION}\n`);
});

test("Lite CLI help documents latest, limits, and directory scope", async () => {
  const captured = captureIo(repoRoot);
  assert.equal(await runLiteCli(["help"], captured.io), 0);
  const help = captured.stdout.join("");
  assert.match(help, /cchistory-lite latest \[sessions\|turns\] \[N\]/);
  assert.match(help, /cchistory-lite sample \[N\]/);
  assert.match(help, /--limit <n>/);
  assert.match(help, /--all/);
  assert.match(help, /--dir <path>/);
  assert.match(help, /latest sessions is one record per session/);
  assert.match(help, /latest turns is one record per UserTurn/);
  assert.match(help, /sessions with 0 turns are omitted/);
  assert.match(help, /last real message activity/);
  assert.match(help, /Sessions without a\nworking directory are excluded/);
  assert.match(help, /does not open parent project folders or later Codex cwd lines/);
  assert.match(help, /--offset <n>/);
  assert.match(help, /--project <ref>/);
  assert.match(help, /--by <dimension>/);
  assert.match(help, /--format jsonl\|json\|markdown/);
  assert.match(help, /--out <file\|->/);
  assert.match(help, /cchistory-lite help \[command\]/);
  // store/db appear only in the closing line that documents their absence.
  const knownFlags = new Set([
    "source-root",
    "source",
    "limit-files",
    "limit",
    "offset",
    "project",
    "by",
    "format",
    "out",
    "dir",
    "request",
    "safe",
    "json",
    "help",
    "version",
    "all",
    "no-dir",
    "store",
    "db",
  ]);
  const documentedFlags = new Set([...help.matchAll(/--([a-z][a-z-]*)/gu)].map((match) => match[1]!));
  for (const flag of documentedFlags) {
    assert.ok(knownFlags.has(flag), `help documents unknown option --${flag}`);
  }
  for (const flag of knownFlags) {
    if (flag === "store" || flag === "db") continue;
    assert.ok(documentedFlags.has(flag), `help omits accepted option --${flag}`);
  }
});


test("Lite CLI colorizes collection cards semantically on a TTY", async () => {
  const snapshot = await getCodexSnapshot();
  const scanner = async () => snapshot;
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const E = String.fromCharCode(27);
  const savedNoColor = process.env.NO_COLOR;
  const savedTerm = process.env.TERM;
  delete process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
  try {
    const tty = captureIo(repoRoot, undefined, { scan: scanner, isTTY: true });
    assert.equal(await runLiteCli(["ls", "sessions", "--all"], tty.io), 0);
    const text = tty.stdout.join("");

    // Gray tier: heading, timestamps, counts, session ids, resume command body.
    assert.ok(text.includes(`${E}[2mSessions (`));
    assert.ok(text.includes(`${E}[2m● `));
    // The stats line is one unbroken gray run: counts, tokens, storage.
    assert.match(text, new RegExp(`${E}\\[2m {2}\\d+ turns · [^${E}]*tokens[^${E}]*${E}\\[0m`));
    const resumable = snapshot.listTopLevelSessions().find((session) => session.resume_command);
    assert.ok(resumable?.resume_command);
    const resumeMatch = /^(cd )(.+?)( && )(.+)$/u.exec(resumable.resume_command);
    assert.ok(resumeMatch);
    assert.ok(text.includes(`${E}[2m  cd ${E}[0m${E}[37m${resumeMatch[2]}`));
    assert.ok(text.includes(`${E}[37m${resumeMatch[2]}${E}[0m${E}[2m && `));
    assert.ok(!text.includes(`${E}[32m  ${resumeMatch[1]}`));
    const withoutResume = snapshot.listTopLevelSessions().find((session) => !session.resume_command);
    if (withoutResume) {
      const ref = snapshot.getSessionDisplayRef(withoutResume.id) ?? withoutResume.id;
      assert.ok(text.includes(`${E}[2m  session ${ref}${E}[0m`));
      assert.ok(!text.includes(`${E}[1m${E}[32m  session `));
    }

    // Identity line: source tool blue, model magenta, title green on the same line.
    assert.ok(text.includes(`${E}[34mCodex${E}[0m`));
    const sessionWithModel = snapshot.listTopLevelSessions().find((session) =>
      session.model?.trim() || snapshot.listSessionTurns(session.id).some((turn) => turn.context_summary.primary_model?.trim()));
    assert.ok(sessionWithModel);
    const model = sessionWithModel.model?.trim()
      || snapshot.listSessionTurns(sessionWithModel.id).map((turn) => turn.context_summary.primary_model?.trim()).find(Boolean);
    assert.ok(model);
    assert.ok(text.includes(`${E}[34mCodex${E}[0m${E}[2m · ${E}[0m${E}[35m`));
    assert.match(text, new RegExp(`${E}\\[35m[^${E}]*${escapeRegExp(model)}`));
    const hasDirectoryCard = snapshot.listTopLevelSessions().some((session) => !session.resume_command && session.working_directory);
    if (hasDirectoryCard) {
      assert.ok(text.includes(`${E}[37m  ~/`) || text.includes(`${E}[37m  /`));
    }

    // The title is the only bold line in a card and carries green; no underline anywhere.
    const titled = snapshot.listTopLevelSessions().find((session) => session.title);
    assert.ok(titled?.title);
    const titleStart = titled.title.replace(/\s+/gu, " ").trim().slice(0, 24);
    assert.ok(text.includes(`${E}[1m${E}[32m${titleStart}`));
    assert.ok(text.includes(`${E}[35m`) && text.includes(`${E}[0m  ${E}[1m${E}[32m`));
    assert.ok(!text.includes(`${E}[4m`));

    const ttyTurns = captureIo(repoRoot, undefined, { scan: scanner, isTTY: true });
    assert.equal(await runLiteCli(["latest", "turns", "2"], ttyTurns.io), 0);
    const turnsText = ttyTurns.stdout.join("");
    assert.ok(turnsText.includes(`${E}[34mCodex${E}[0m`));
    assert.ok(turnsText.includes(`${E}[1m${E}[32m  `));
    assert.ok(turnsText.includes(`${E}[35m`));

    const ttyProjects = captureIo(repoRoot, undefined, { scan: scanner, isTTY: true });
    assert.equal(await runLiteCli(["ls", "projects", "--all"], ttyProjects.io), 0);
    assert.ok(ttyProjects.stdout.join("").includes(`${E}[2m● ${E}[0m${E}[1m${E}[32m`));

    const ttySearch = captureIo(repoRoot, undefined, { scan: scanner, isTTY: true });
    assert.equal(await runLiteCli(["search", "mock"], ttySearch.io), 0);
    const searchText = ttySearch.stdout.join("");
    assert.ok(searchText.includes(`${E}[2m- sess:`));
    assert.ok(searchText.includes(`${E}[1m${E}[32m  `));

    // Non-TTY output stays pure text.
    const plain = captureIo(repoRoot, undefined, { scan: scanner });
    assert.equal(await runLiteCli(["ls", "sessions", "--all"], plain.io), 0);
    assert.ok(!plain.stdout.join("").includes(E));
  } finally {
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
    if (savedTerm === undefined) delete process.env.TERM;
    else process.env.TERM = savedTerm;
  }
});

test("Lite CLI renders container storage as an estimated share and omits zero bytes", async () => {
  const snapshot = await getCodexSnapshot();
  const target = snapshot.listTopLevelSessions().find((session) => {
    const family = snapshot.getSessionFamily(session.id);
    return session.turn_count > 0 && (!family || family.child_count === 0 || family.parent_session_ref !== session.id);
  });
  assert.ok(target);
  const sharedSnapshot = new LiveHistorySnapshot({
    ...snapshot.data,
    session_contributions: [
      {
        session_ref: target.id,
        source_id: target.source_id,
        source_platform: target.source_platform,
        stats: {
          storage_bytes: 12_000,
          blob_count: 1,
          turn_count: target.turn_count,
          assistant_reply_count: 0,
          tool_call_count: 0,
          tool_success_count: 0,
          tool_error_count: 0,
          tool_pending_count: 0,
        },
        shared_storage: { estimated_bytes: 12_000, container_bytes: 10_485_760 },
      },
    ],
  });
  const captured = captureIo(repoRoot, undefined, { scan: async () => sharedSnapshot });
  assert.equal(await runLiteCli(["ls", "sessions", "--all"], captured.io), 0);
  const text = captured.stdout.join("");
  assert.ok(text.includes("≈12KB of 10.0MB db"));
  assert.ok(!text.includes("· 0B"));
});

test("Lite CLI puts the session title after the model and omits prompt-history ids", async () => {
  const snapshot = await getCodexSnapshot();
  const target = snapshot.listTopLevelSessions().find((session) => session.turn_count > 0 && session.title && session.model);
  const source = snapshot.listSources()[0];
  assert.ok(target);
  assert.ok(source);
  const promptHistory = {
    ...target,
    id: "sess:cursor:prompt-history:aaaaaaaa",
    source_id: "src-cursor-prompt-history",
    source_session_id: "prompt-history:aaaaaaaa",
    source_platform: "cursor" as const,
    title: "Cursor prompt history",
    model: undefined,
    resume_command: undefined,
    resume_working_directory: undefined,
    resume_command_confidence: undefined,
    working_directory: "/workspace/cursor-prompt-history",
    turn_count: 2,
    created_at: "2026-08-03T12:04:00.000Z",
    updated_at: "2026-08-03T12:05:00.000Z",
  };
  const mixedSnapshot = new LiveHistorySnapshot({
    ...snapshot.data,
    sources: [
      ...snapshot.data.sources,
      {
        ...source,
        id: "src-cursor-prompt-history",
        slot_id: "cursor",
        platform: "cursor",
        display_name: "Cursor",
      },
    ],
    sessions: [promptHistory, ...snapshot.data.sessions],
  });
  const captured = captureIo(repoRoot, undefined, { scan: async () => mixedSnapshot });
  assert.equal(await runLiteCli(["ls", "sessions", "--all"], captured.io), 0);
  const text = captured.stdout.join("");
  const model = target.model?.trim();
  assert.ok(model);
  assert.match(text, new RegExp(`${model.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} {2}${target.title}`));
  assert.match(text, /● .* · Cursor {2}Cursor prompt history/);
  const cardStart = text.indexOf("Cursor prompt history");
  assert.ok(cardStart >= 0);
  const nextBullet = text.indexOf("\n● ", cardStart);
  const card = text.slice(cardStart, nextBullet === -1 ? undefined : nextBullet);
  assert.doesNotMatch(card, /session prompt-h/);
  assert.doesNotMatch(card, /tokens n\/a/);
});

test("Lite CLI JSON search defaults to cwd and --no-dir restores the unscoped snapshot", async () => {
  const snapshot = await getCodexSnapshot();
  const scoped = snapshot.listResolvedSessions().find((session) => session.working_directory);
  assert.ok(scoped?.working_directory);
  const scanOptions: ScanLiteHistoryOptions[] = [];
  const scanner = async (options: ScanLiteHistoryOptions) => {
    scanOptions.push(options);
    return snapshot;
  };

  const jsonDefault = captureIo(scoped.working_directory, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["search", "Review", "--json"], jsonDefault.io), 0);
  assert.equal(scanOptions.at(-1)?.directoryScope, scoped.working_directory);
  const defaultPayload = JSON.parse(jsonDefault.stdout.join("")) as {
    unit: string;
    total: number;
    shown: number;
    results: unknown[];
  };
  assert.equal(defaultPayload.unit, "session");
  assert.equal(defaultPayload.shown, defaultPayload.results.length);
  assert.equal(defaultPayload.total, defaultPayload.shown);

  const unscoped = captureIo(scoped.working_directory, undefined, { scan: scanner });
  assert.equal(await runLiteCli(["search", "Review", "--json", "--no-dir"], unscoped.io), 0);
  assert.equal(scanOptions.at(-1)?.directoryScope, undefined);

  const conflict = captureIo(scoped.working_directory);
  assert.equal(await runLiteCli(["search", "Review", "--json", "--dir", scoped.working_directory, "--no-dir"], conflict.io), 2);
  assert.match(conflict.stderr.join(""), /--no-dir and --dir cannot be used together/);
});

test("Lite CLI query latest and list count the same unit they return", async () => {
  const snapshot = await getCodexSnapshot();
  const request = JSON.stringify({
    schema: "cchistory-lite-query/v2",
    operations: [
      { id: "recent", kind: "latest", target: "sessions", limit: 2 },
      { id: "sessions", kind: "list", collection: "sessions", limit: 1 },
    ],
  });
  const captured = captureIo(repoRoot, undefined, {
    readStdin: async () => request,
    scan: async () => snapshot,
  });
  assert.equal(await runLiteCli(["query", "--request", "-", "--no-dir"], captured.io), 0);
  const payload = JSON.parse(captured.stdout.join("")) as {
    operations: Array<{ id: string; result: { total: number; shown: number; sessions?: unknown[] } }>;
  };
  const recent = payload.operations[0]?.result;
  const listed = payload.operations[1]?.result;
  assert.equal(recent?.shown, recent?.sessions?.length);
  assert.ok((recent?.total ?? 0) >= (recent?.shown ?? 1));
  assert.equal(listed?.shown, listed?.sessions?.length);
  assert.equal(listed?.shown, 1);
});

test("Lite shell JSON-lines searches sessions against one snapshot and refreshes on request", async () => {
  const snapshot = await getCodexSnapshot();
  const turn = snapshot.listResolvedTurns()[0];
  assert.ok(turn);
  const queryWord = turn.canonical_text.split(/\s+/u).find((part) => part.length >= 4);
  assert.ok(queryWord);
  let scans = 0;
  const lines = [
    JSON.stringify({ id: "find", kind: "search", query: queryWord, limit: 3 }),
    JSON.stringify({ kind: "refresh" }),
    JSON.stringify({ id: "again", kind: "search", query: queryWord, limit: 1 }),
    JSON.stringify({ kind: "exit" }),
  ];
  const captured = captureIo(repoRoot, undefined, {
    isTTY: false,
    readLine: async () => lines.shift() ?? null,
    scan: async () => {
      scans += 1;
      return snapshot;
    },
  });
  assert.equal(await runLiteCli(["shell", "--json", "--no-dir"], captured.io), 0);
  assert.equal(scans, 2);
  const payloads = captured.stdout.join("").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(payloads[0]?.kind, "query_result");
  assert.equal((payloads[1] as { kind?: string }).kind, "refreshed");
  const first = payloads[0] as { operations: Array<{ result: { unit: string; shown: number; total: number; results: unknown[] } }> };
  const search = first.operations[0]?.result;
  assert.equal(search?.unit, "session");
  assert.equal(search?.shown, search?.results.length);
  assert.ok((search?.total ?? 0) >= (search?.shown ?? 0));
});

test("Lite shell JSON-lines replies from a line before stdin closes and loads matching context", async () => {
  const snapshot = await getCodexSnapshot();
  const turn = snapshot.listResolvedTurns().find((entry) => snapshot.getTurnContext(entry.id)?.assistant_replies.length);
  assert.ok(turn);
  const light = new LiveHistorySnapshot({ ...snapshot.data, contexts: [] });
  const scans: ScanLiteHistoryOptions[] = [];
  const stdin = new PassThrough();
  const captured = captureIo(repoRoot, undefined, {
    stdin,
    isTTY: true,
    stdinIsTTY: false,
    scan: async (options) => {
      scans.push(options);
      return options.contextMode === "matching" ? snapshot : light;
    },
  });
  const running = runLiteCli(["shell", "--no-dir"], captured.io);
  const queryWord = turn.canonical_text.split(/\s+/u).find((part) => part.length >= 4);
  assert.ok(queryWord);
  stdin.write(`${JSON.stringify({ id: "find", kind: "search", query: queryWord, limit: 1 })}\n`);
  const started = Date.now();
  while (!captured.stdout.join("").includes("query_result") && Date.now() - started < 2000) {
    await delay(10);
  }
  assert.match(captured.stdout.join(""), /"kind":"query_result"/);
  stdin.write(`${JSON.stringify({ kind: "replies", turn_refs: [turn.id] })}\n`);
  stdin.write(`${JSON.stringify({ kind: "exit" })}\n`);
  stdin.end();
  assert.equal(await running, 0);
  assert.ok(scans.some((options) => options.contextMode === "none"));
  assert.ok(scans.some((options) =>
    options.contextMode === "matching"
    && options.contextTargets?.some((target) => target.kind === "turn" && target.ref === turn.id),
  ));
  const payloads = captured.stdout.join("").trim().split("\n").map((line) => JSON.parse(line) as {
    kind?: string;
    operations?: Array<{ result?: { turns?: Array<{ assistant_replies?: unknown[] }> } }>;
  });
  const replies = payloads.find((payload) => payload.operations?.[0]?.result?.turns);
  assert.ok((replies?.operations?.[0]?.result?.turns?.[0]?.assistant_replies?.length ?? 0) > 0);
});

test("Lite shell latest sessions N uses the count and JSON-lines follows stdin TTY not stdout", async () => {
  const snapshot = await getCodexSnapshot();
  const eligible = snapshot.listTopLevelSessions().filter((session) => session.turn_count > 0);
  assert.ok(eligible.length > 2);
  const humanLines = ["latest sessions 2", "latest 2 extra", "exit"];
  const human = captureIo(repoRoot, undefined, {
    isTTY: true,
    stdinIsTTY: true,
    readLine: async () => humanLines.shift() ?? null,
    scan: async () => snapshot,
  });
  assert.equal(await runLiteCli(["shell", "--no-dir"], human.io), 0);
  const sessionRows = human.stdout.join("").trim().split("\n").filter((line) => line.startsWith("sess:"));
  assert.equal(sessionRows.length, 2);
  assert.match(human.stderr.join(""), /latest <N> does not accept a second positional argument/);

  const jsonAsHuman = ['{"kind":"search","query":"x"}', "exit"];
  const jsonOnTtyStdout = captureIo(repoRoot, undefined, {
    isTTY: true,
    stdinIsTTY: true,
    readLine: async () => jsonAsHuman.shift() ?? null,
    scan: async () => snapshot,
  });
  assert.equal(await runLiteCli(["shell", "--no-dir"], jsonOnTtyStdout.io), 0);
  assert.match(jsonOnTtyStdout.stderr.join(""), /Unknown shell command/);
});

test("Lite shell JSON-lines keeps the snapshot when refresh fails and uses structured startup errors", async () => {
  const snapshot = await getCodexSnapshot();
  let scans = 0;
  const refreshLines = [
    JSON.stringify({ kind: "refresh" }),
    JSON.stringify({ id: "find", kind: "search", query: "Review", limit: 1 }),
    JSON.stringify({ kind: "exit" }),
  ];
  const refresh = captureIo(repoRoot, undefined, {
    isTTY: true,
    stdinIsTTY: false,
    readLine: async () => refreshLines.shift() ?? null,
    scan: async () => {
      scans += 1;
      if (scans === 2) throw new Error("synthetic refresh failure");
      return snapshot;
    },
  });
  assert.equal(await runLiteCli(["shell", "--json", "--no-dir"], refresh.io), 1);
  const refreshPayloads = refresh.stdout.join("").trim().split("\n").map((line) => JSON.parse(line) as {
    kind?: string;
    error?: { code?: string };
    operations?: Array<{ status?: string }>;
  });
  assert.equal(refreshPayloads[0]?.kind, "error");
  assert.equal(refreshPayloads[0]?.error?.code, "scan_failed");
  assert.equal(refreshPayloads[1]?.kind, "query_result");
  assert.equal(refreshPayloads[1]?.operations?.[0]?.status, "ok");
  assert.equal(refresh.stderr.join(""), "");

  const startup = captureIo(repoRoot, undefined, {
    isTTY: true,
    stdinIsTTY: false,
    scan: async () => {
      throw new Error("synthetic startup scan failure");
    },
  });
  assert.equal(await runLiteCli(["shell", "--no-dir"], startup.io), 1);
  assert.equal(startup.stdout.join(""), "");
  const startupError = JSON.parse(startup.stderr.join("")) as { schema: string; error: { code: string } };
  assert.equal(startupError.schema, "cchistory-lite-error/v1");
  assert.equal(startupError.error.code, "scan_failed");
});

test("Lite CLI scan guard refuses a scan whose estimate risks the machine, teaches the bounds, and bends to the kill-switch", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-guard-cli-"));
  const hugeRoot = path.join(tempHome, "huge-codex");
  try {
    await cp(codexRoot, hugeRoot, { recursive: true });
    // Sparse: reports 256 GiB without allocating real bytes.
    const hugeFile = path.join(hugeRoot, "huge.bin");
    await writeFile(hugeFile, "");
    await truncate(hugeFile, 256 * 1024 ** 3);
    const sourceArgs = ["--source-root", `codex=${hugeRoot}`, "--source", "codex", "--safe"];

    const refused = captureIo(tempHome);
    assert.equal(await runLiteCli(["sources", ...sourceArgs], refused.io), 1);
    assert.equal(refused.stdout.join(""), "");
    const message = refused.stderr.join("");
    assert.match(message, /Refusing to scan/);
    assert.match(message, /--source/);
    assert.match(message, /--dir/);
    assert.match(message, /--limit-files/);
    assert.match(message, /sample/);
    assert.match(message, /shell/);
    assert.match(message, /query/);
    assert.match(message, /CCHISTORY_SCAN_GUARD=0/);

    const refusedJson = captureIo(tempHome);
    assert.equal(await runLiteCli(["sources", "--json", ...sourceArgs], refusedJson.io), 1);
    assert.equal(refusedJson.stdout.join(""), "");
    const errorPayload = JSON.parse(refusedJson.stderr.join("")) as {
      schema: string;
      error: { code: string; message: string };
    };
    assert.equal(errorPayload.schema, "cchistory-lite-error/v1");
    assert.equal(errorPayload.error.code, "scan_guard_refused");
    assert.match(errorPayload.error.message, /Refusing to scan/);

    // Bounded probes bypass the lock and the estimate even on the same root.
    const sampled = captureIo(tempHome);
    assert.equal(await runLiteCli(["sample", "1", ...sourceArgs], sampled.io), 0, sampled.stderr.join(""));
    const shown = captureIo(tempHome);
    assert.equal(
      await runLiteCli(
        ["show", "session", "sess:codex:019ce4fd-8290-7501-afc4-0e9486733614", ...sourceArgs],
        shown.io,
      ),
      0,
      shown.stderr.join(""),
    );

    process.env.CCHISTORY_SCAN_GUARD = "0";
    try {
      const allowed = captureIo(tempHome);
      assert.equal(await runLiteCli(["sources", ...sourceArgs], allowed.io), 0, allowed.stderr.join(""));
    } finally {
      delete process.env.CCHISTORY_SCAN_GUARD;
    }
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite CLI maps scan guard refusals and aborts to exit 1 with distinct structured codes", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-guard-errors-"));
  try {
    const aborted = captureIo(tempHome, undefined, {
      scan: async () => {
        throw new ScanGuardAbortedError({ availableBytes: 300 * 1024 ** 2, floorBytes: 512 * 1024 ** 2 });
      },
    });
    assert.equal(await runLiteCli(["sources", "--json"], aborted.io), 1);
    assert.equal(aborted.stdout.join(""), "");
    const abortPayload = JSON.parse(aborted.stderr.join("")) as { schema: string; error: { code: string } };
    assert.equal(abortPayload.schema, "cchistory-lite-error/v1");
    assert.equal(abortPayload.error.code, "scan_guard_aborted");

    const refused = captureIo(tempHome, undefined, {
      scan: async () => {
        throw new ScanGuardRefusedError({
          reason: "scan_in_progress",
          holder: { pid: 4321, startedAt: "2026-08-30T00:00:00.000Z" },
          waitedMs: 30_000,
        });
      },
    });
    assert.equal(await runLiteCli(["latest", "--json"], refused.io), 1);
    assert.equal(refused.stdout.join(""), "");
    const refusalPayload = JSON.parse(refused.stderr.join("")) as { error: { code: string; message: string } };
    assert.equal(refusalPayload.error.code, "scan_guard_refused");
    assert.match(refusalPayload.error.message, /another cchistory-lite scan/);

    // Human mode prints the plain message, not the JSON envelope.
    const human = captureIo(tempHome, undefined, {
      scan: async () => {
        throw new ScanGuardRefusedError({ reason: "scan_in_progress", holder: { pid: 4321 }, waitedMs: 30_000 });
      },
    });
    assert.equal(await runLiteCli(["sources"], human.io), 1);
    assert.match(human.stderr.join(""), /Refusing to scan/);
    assert.throws(() => JSON.parse(human.stderr.join("")));
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite CLI prints a one-line scan guard warning on stderr and proceeds", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-guard-warn-"));
  try {
    const warned = captureIo(tempHome, undefined, {
      scan: async (options: ScanLiteHistoryOptions) => {
        options.onScanGuardEvent?.({
          type: "warn",
          assessment: {
            status: "warn",
            profile: "light",
            estimatedBytes: 600,
            availableBytes: 1000,
            scannedBytes: 150,
            detail: "synthetic",
          },
        });
        return getCodexSnapshot();
      },
    });
    assert.equal(await runLiteCli(["sources", "--json"], warned.io), 0);
    assert.match(warned.stderr.join(""), /Scan guard warning/);
    assert.match(warned.stderr.join(""), /CCHISTORY_SCAN_GUARD=0/);
    assert.equal((JSON.parse(warned.stdout.join("")) as { kind: string }).kind, "sources");
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Lite CLI agent prints the machine-readable contract without scanning", async () => {
  const captured = captureIo(repoRoot, undefined, {
    scan: async () => {
      throw new Error("agent must not scan");
    },
  });
  assert.equal(await runLiteCli(["agent"], captured.io), 0);
  assert.equal(captured.stderr.join(""), "");
  const contract = JSON.parse(captured.stdout.join("")) as {
    schema: string;
    kind: string;
    cli: { name: string; version: string };
    commands: Record<string, { name: string; summary: string; usage: string; flags: unknown[] }>;
    global_flags: Array<{ name: string }>;
    exit_codes: Array<{ code: number; meaning: string }>;
    env: Array<{ name: string }>;
    output_schemas: Array<{ id: string; file: string | null }>;
    trust_model: { content_trust: string };
    guardrails: string[];
    cost_model: {
      heap_ceiling: { min_old_space_mib: number; max_old_space_mib: number };
      scan_guard: {
        kill_switch: { env: string; value: string };
        light_scan_memory_multiplier: number;
        full_scan_memory_multiplier: number;
        warn_available_fraction: number;
        refuse_available_fraction: number;
        lock_wait_ms: number;
        watchdog_floor: { min_floor_bytes: number; total_floor_fraction: number };
        error_codes: string[];
      };
    };
    docs: { agent_guide: string; cli_guide: string; skill: string };
  };
  assert.equal(contract.schema, "cchistory-lite-agent/v1");
  assert.equal(contract.kind, "agent_contract");
  assert.equal(contract.cli.name, "cchistory-lite");
  assert.match(contract.cli.version, /^\d+\.\d+\.\d+/u);

  const commandNames = ["sources", "ls", "latest", "sample", "tree", "search", "show", "stats", "query", "shell", "export", "tui", "help", "agent"];
  assert.deepEqual(Object.keys(contract.commands).sort(), [...commandNames].sort());
  for (const name of commandNames) {
    const command = contract.commands[name]!;
    assert.equal(command.name, name);
    assert.ok(command.summary.length > 0, `${name} is missing a summary`);
    assert.ok(command.usage.startsWith(`cchistory-lite ${name}`), `${name} usage must start with the command line`);
    assert.ok(Array.isArray(command.flags), `${name} flags must be an array`);
  }

  assert.deepEqual(contract.exit_codes.map((entry) => entry.code).sort(), [0, 1, 2]);
  const envNames = contract.env.map((entry) => entry.name);
  for (const name of ["NO_COLOR", "FORCE_COLOR", "CCHISTORY_SHOW_RUNTIME_WARNINGS", "CCHISTORY_SCAN_GUARD"]) {
    assert.ok(envNames.includes(name), `contract env omits ${name}`);
  }

  // The documented guard numbers are the runtime constants, not copies.
  const guard = contract.cost_model.scan_guard;
  assert.equal(guard.light_scan_memory_multiplier, LIGHT_SCAN_MEMORY_MULTIPLIER);
  assert.equal(guard.full_scan_memory_multiplier, FULL_SCAN_MEMORY_MULTIPLIER);
  assert.equal(guard.warn_available_fraction, SCAN_GUARD_WARN_AVAILABLE_FRACTION);
  assert.equal(guard.refuse_available_fraction, SCAN_GUARD_REFUSE_AVAILABLE_FRACTION);
  assert.equal(guard.lock_wait_ms, SCAN_LOCK_WAIT_MS);
  assert.equal(guard.watchdog_floor.min_floor_bytes, SCAN_WATCHDOG_MIN_FLOOR_BYTES);
  assert.equal(guard.watchdog_floor.total_floor_fraction, SCAN_WATCHDOG_TOTAL_FLOOR_FRACTION);
  assert.deepEqual(guard.kill_switch, { env: "CCHISTORY_SCAN_GUARD", value: "0" });
  assert.deepEqual([...guard.error_codes].sort(), ["scan_guard_aborted", "scan_guard_refused"]);
  assert.equal(contract.cost_model.heap_ceiling.min_old_space_mib, MIN_OLD_SPACE_MIB);
  assert.equal(contract.cost_model.heap_ceiling.max_old_space_mib, MAX_OLD_SPACE_MIB);

  assert.equal(contract.trust_model.content_trust, "untrusted_history");
  const schemaIds = contract.output_schemas.map((entry) => entry.id);
  for (const id of [
    "cchistory-lite/v2",
    "cchistory-lite-canonical/v1",
    "cchistory-lite-query/v2",
    "cchistory-lite-query-result/v2",
    "cchistory-lite-error/v1",
    "cchistory-lite-export/v1",
    "cchistory-lite-agent/v1",
  ]) {
    assert.ok(schemaIds.includes(id), `contract output_schemas omits ${id}`);
  }
  assert.equal(contract.docs.agent_guide, "docs/guide/for-agents.md");
  assert.equal(contract.docs.cli_guide, "docs/guide/lite.md");
  assert.equal(contract.docs.skill, "skills/using-cchistory-lite/SKILL.md");
});

test("Lite CLI agent contract satisfies its shipped JSON schema structurally", async () => {
  const captured = captureIo(repoRoot, undefined, {
    scan: async () => {
      throw new Error("agent must not scan");
    },
  });
  assert.equal(await runLiteCli(["agent"], captured.io), 0);
  const contract = JSON.parse(captured.stdout.join("")) as Record<string, unknown>;
  const schema = JSON.parse(
    await readFile(path.join(repoRoot, "schemas", "cchistory-lite-agent-v1.schema.json"), "utf8"),
  ) as {
    required: string[];
    properties: Record<string, any>;
    $defs: { command: { required: string[] }; flag: { properties: { kind: { enum: string[] } } } };
  };
  for (const key of schema.required) {
    assert.ok(key in contract, `contract is missing required key ${key}`);
  }
  assert.equal(contract.schema, schema.properties.schema.const);
  assert.equal(contract.kind, schema.properties.kind.const);
  const commands = contract.commands as Record<string, Record<string, unknown> & { flags: Array<{ kind: string }> }>;
  assert.deepEqual(
    Object.keys(commands).sort(),
    [...(schema.properties.commands.required as string[])].sort(),
  );
  for (const [name, command] of Object.entries(commands)) {
    for (const key of schema.$defs.command.required) {
      assert.ok(key in command, `command ${name} is missing ${key}`);
    }
    for (const flag of command.flags) {
      assert.ok(
        schema.$defs.flag.properties.kind.enum.includes(flag.kind),
        `command ${name} has a flag with unknown kind ${flag.kind}`,
      );
    }
  }
  const exitCodes = (contract.exit_codes as Array<{ code: number }>).map((entry) => entry.code);
  const allowedCodes = schema.properties.exit_codes.items.properties.code.enum as number[];
  assert.deepEqual(exitCodes.sort(), [...allowedCodes].sort());
  assert.equal(
    (contract.trust_model as { content_trust: string }).content_trust,
    schema.properties.trust_model.properties.content_trust.const,
  );
  const docs = contract.docs as Record<string, string>;
  assert.equal(docs.agent_guide, schema.properties.docs.properties.agent_guide.const);
  assert.equal(docs.cli_guide, schema.properties.docs.properties.cli_guide.const);
  assert.equal(docs.skill, schema.properties.docs.properties.skill.const);
});

test("Lite CLI agent contract flags match the parser in both directions", async () => {
  const snapshot = await getCodexSnapshot();
  const project = snapshot.listProjects()[0];
  const session = snapshot.listResolvedSessions()[0];
  assert.ok(project && session);
  const contract = buildAgentContract("0.0.0-test");
  const globalFlags = new Set(contract.global_flags.map((flag) => flag.name));
  const universe = new Set<string>(globalFlags);
  for (const command of Object.values(contract.commands)) {
    for (const flag of command.flags) universe.add(flag.name);
  }
  // The parser's full flag vocabulary; like the help test's knownFlags, drift
  // here must be reflected in the contract before this audit can pass.
  const parserFlags = [
    "--source-root", "--source", "--limit-files", "--limit", "--offset", "--project", "--by",
    "--format", "--out", "--dir", "--request", "--safe", "--json", "--all", "--no-dir",
    "--help", "--version",
  ];
  assert.deepEqual([...universe].sort(), [...parserFlags].sort());

  const tails: Record<string, string[]> = {
    sources: [],
    ls: ["sessions"],
    latest: ["sessions", "1"],
    sample: ["1"],
    tree: ["projects"],
    search: ["mock"],
    show: ["session", session.id],
    stats: [],
    query: ["--request", "-"],
    shell: [],
    export: ["--format", "jsonl", "--out", "-"],
    tui: [],
    help: [],
    agent: [],
  };
  const flagArgs = (name: string): string[] => {
    switch (name) {
      case "--source-root": return [name, `codex=${codexRoot}`];
      case "--source": return [name, "codex"];
      case "--limit-files": return [name, "4"];
      case "--limit": return [name, "1"];
      case "--offset": return [name, "0"];
      case "--project": return [name, project.project_id];
      case "--by": return [name, "source"];
      case "--format": return [name, "jsonl"];
      case "--out": return [name, "-"];
      case "--dir": return [name, repoRoot];
      case "--request": return [name, "-"];
      default: return [name];
    }
  };
  const run = async (argv: string[]): Promise<number> => {
    const captured = captureIo(repoRoot, async () => 0, {
      scan: async () => snapshot,
      readStdin: async () => `${JSON.stringify({
        schema: "cchistory-lite-query/v2",
        operations: [{ id: "s", kind: "list", collection: "sessions", limit: 1 }],
      })}\n`,
      readLine: async () => null,
    });
    return runLiteCli(argv, captured.io);
  };

  for (const [name, command] of Object.entries(contract.commands)) {
    const tail = tails[name]!;
    if (name === "help") {
      // help renders before option validation, so every known flag is accepted
      // and ignored; the rejection direction does not apply to it.
      for (const flag of universe) {
        assert.equal(await run([name, ...tail, ...flagArgs(flag)]), 0, `help must accept ${flag}`);
      }
      assert.equal(await run([name, ...tail, "--json=canonical"]), 0, "help must accept --json=canonical");
      continue;
    }
    const accepted = new Set([...globalFlags, ...command.flags.map((flag) => flag.name)]);
    for (const flag of universe) {
      const argv = tail.includes(flag) ? [name, ...tail] : [name, ...tail, ...flagArgs(flag)];
      const code = await run(argv);
      if (accepted.has(flag)) {
        assert.equal(code, 0, `${name} must accept ${flag} (argv: ${argv.join(" ")})`);
      } else {
        assert.equal(code, 2, `${name} must reject ${flag} (argv: ${argv.join(" ")})`);
      }
    }
    const canonicalAccepted = command.flags.some((flag) => flag.name === "--json" && flag.values?.includes("canonical"));
    const canonicalArgv = [name, ...tail, "--json=canonical"];
    assert.equal(
      await run(canonicalArgv),
      canonicalAccepted ? 0 : 2,
      `${name} ${canonicalAccepted ? "must accept" : "must reject"} --json=canonical`,
    );
  }
});

test("Lite CLI agent skill and guide print the shipped docs", async () => {
  const noScan: Partial<LiteCliIo> = {
    scan: async () => {
      throw new Error("agent must not scan");
    },
  };
  const skill = captureIo(repoRoot, undefined, noScan);
  assert.equal(await runLiteCli(["agent", "skill"], skill.io), 0);
  const skillDoc = await readFile(path.join(repoRoot, "skills", "using-cchistory-lite", "SKILL.md"), "utf8");
  assert.equal(skill.stdout.join(""), skillDoc);

  const guide = captureIo(repoRoot, undefined, noScan);
  assert.equal(await runLiteCli(["agent", "guide"], guide.io), 0);
  const guideDoc = await readFile(path.join(repoRoot, "docs", "guide", "for-agents.md"), "utf8");
  assert.equal(guide.stdout.join(""), guideDoc);

  const unknown = captureIo(repoRoot, undefined, noScan);
  assert.equal(await runLiteCli(["agent", "bogus"], unknown.io), 2);
  const unknownError = JSON.parse(unknown.stderr.join("")) as { schema: string; error: { code: string } };
  assert.equal(unknownError.schema, "cchistory-lite-error/v1");
  assert.equal(unknownError.error.code, "invalid_usage");

  const extra = captureIo(repoRoot, undefined, noScan);
  assert.equal(await runLiteCli(["agent", "skill", "extra"], extra.io), 2);
});

test("Lite CLI help points agents at the agent contract and docs", async () => {
  const captured = captureIo(repoRoot);
  assert.equal(await runLiteCli(["help"], captured.io), 0);
  const help = captured.stdout.join("");
  assert.match(help, /cchistory-lite agent/);
  assert.match(help, /agent skill/);
  assert.match(help, /agent guide/);
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

function assertNoKeysDeep(value: unknown, forbidden: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertNoKeysDeep(entry, forbidden);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.equal(forbidden.has(key), false, `compact payload must not contain ${key}`);
    assertNoKeysDeep(child, forbidden);
  }
}
