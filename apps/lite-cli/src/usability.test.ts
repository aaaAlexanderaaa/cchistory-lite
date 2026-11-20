import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scanLiteHistory, type ScanLiteHistoryOptions } from "@cchistory/live-runtime";
import { runLiteCli, type LiteCliIo } from "./index.js";
import { renderFractionalBar } from "./stats-visuals.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const codexRoot = path.join(repoRoot, "mock_data", ".codex", "sessions");
const evidenceFixtureRoot = path.join(repoRoot, "mock_data", "fixtures", "agent-evidence");
const emptyHome = path.join(repoRoot, "mock_data", "empty-home");

function captureIo(cwd: string, extra: Partial<LiteCliIo> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: LiteCliIo = {
    cwd,
    homeDir: emptyHome,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    isTTY: false,
    columns: 110,
    ...extra,
  };
  return { io, stdout, stderr };
}

test("CLI search defaults to full conversation (including assistant replies) and supports --prompts-only and --group-by message", async () => {
  const seenOptions: ScanLiteHistoryOptions[] = [];
  const baseArgs = ["--source-root", `codex=${evidenceFixtureRoot}`, "--source", "codex", "--no-dir"];
  const scanWrapper = async (options: ScanLiteHistoryOptions) => {
    seenOptions.push(options);
    return scanLiteHistory(options);
  };

  // Look up a phrase that appears ONLY in an assistant reply in agent-evidence fixture
  const fullSnapshot = await scanLiteHistory({
    homeDir: emptyHome,
    sourceRoots: [{ sourceRef: "codex", baseDir: evidenceFixtureRoot }],
    sourceRefs: ["codex"],
    contextMode: "none",
    retainConversationEvidence: true,
    safeMode: true,
  });
  const assistantOnlyMsg = fullSnapshot.data.conversation_evidence?.find((m) => m.role === "assistant");
  assert.ok(assistantOnlyMsg, "fixture should contain an assistant reply");
  const uniqueToken = assistantOnlyMsg.text
    .split(/\s+/u)
    .map((word) => word.replace(/[^A-Za-z0-9_-]/gu, ""))
    .find(
      (word) =>
        word.length >= 6 &&
        !fullSnapshot.data.turns.some((t) => t.canonical_text.toLowerCase().includes(word.toLowerCase())),
    );
  assert.ok(uniqueToken, "fixture should have a token unique to an assistant reply");

  // Default search finds the assistant reply and retains conversation evidence without full contexts
  const defaultSearch = captureIo(repoRoot, { scan: scanWrapper });
  assert.equal(await runLiteCli(["search", uniqueToken, ...baseArgs, "--json"], defaultSearch.io), 0);
  assert.equal(seenOptions.at(-1)?.contextMode, "none");
  assert.equal(seenOptions.at(-1)?.retainConversationEvidence, true);
  const defaultPayload = JSON.parse(defaultSearch.stdout.join("")) as {
    content?: string;
    searched_roles?: string[];
    total: number;
    results: Array<{ matched_role?: string; snippet?: string; message_id?: string }>;
  };
  assert.equal(defaultPayload.content, "conversation");
  assert.deepEqual(defaultPayload.searched_roles, ["user", "assistant"]);
  assert.ok(defaultPayload.total >= 1);
  assert.equal(defaultPayload.results[0]?.matched_role, "assistant");
  assert.ok(defaultPayload.results[0]?.snippet?.toLowerCase().includes(uniqueToken.toLowerCase()));

  // Human output displays the [assistant] badge and snippet
  const humanSearch = captureIo(repoRoot, { scan: scanWrapper });
  assert.equal(await runLiteCli(["search", uniqueToken, ...baseArgs], humanSearch.io), 0);
  assert.match(humanSearch.stdout.join(""), /\[assistant\]/);

  // --prompts-only skips assistant-only text and does not request conversation_evidence
  const promptsOnly = captureIo(repoRoot, { scan: scanWrapper });
  assert.equal(await runLiteCli(["search", uniqueToken, "--prompts-only", ...baseArgs, "--json"], promptsOnly.io), 0);
  assert.equal(seenOptions.at(-1)?.retainConversationEvidence, undefined);
  const promptsPayload = JSON.parse(promptsOnly.stdout.join("")) as { total: number; content?: string };
  assert.equal(promptsPayload.content, "prompts");
  assert.equal(promptsPayload.total, 0);

  // --group-by message returns individual matching messages
  const byMessage = captureIo(repoRoot, { scan: scanWrapper });
  assert.equal(await runLiteCli(["search", "fixture", "--group-by", "message", ...baseArgs, "--json"], byMessage.io), 0);
  const messagePayload = JSON.parse(byMessage.stdout.join("")) as { unit: string; group_by?: string; total: number };
  assert.equal(messagePayload.unit, "message");
  assert.equal(messagePayload.group_by, "message");
  assert.ok(messagePayload.total >= 2);

  // Invalid flag combination fails before scanning
  const conflict = captureIo(repoRoot, {
    scan: async () => {
      throw new Error("should not scan on invalid flag combination");
    },
  });
  assert.equal(await runLiteCli(["search", "fixture", "--prompts-only", "--group-by", "message", ...baseArgs], conflict.io), 2);
});

test("CLI show turn prints full assistant replies by default, show session --full prints replies, and markdown export includes replies", async () => {
  const baseArgs = ["--source-root", `codex=${evidenceFixtureRoot}`, "--source", "codex"];
  const fullSnapshot = await scanLiteHistory({
    homeDir: emptyHome,
    sourceRoots: [{ sourceRef: "codex", baseDir: evidenceFixtureRoot }],
    sourceRefs: ["codex"],
    contextMode: "full",
    retainConversationEvidence: true,
    safeMode: true,
  });
  const turn = fullSnapshot.listResolvedTurns().find((t) => {
    const ctx = fullSnapshot.getTurnContext(t.id);
    return ctx && ctx.assistant_replies.length > 0;
  });
  assert.ok(turn);
  const ctx = fullSnapshot.getTurnContext(turn.id)!;
  const replyText = ctx.assistant_replies[0]!.canonical_text || ctx.assistant_replies[0]!.content;
  assert.ok(replyText.length > 10);

  // show turn prints full reply text without single-line truncation
  const showTurn = captureIo(repoRoot, { columns: 80 });
  assert.equal(await runLiteCli(["show", "turn", turn.id, ...baseArgs], showTurn.io), 0);
  const turnOut = showTurn.stdout.join("");
  const replyExcerpt = replyText.trim().split(/\s+/u).slice(0, 6).join(" ");
  assert.ok(turnOut.includes(replyExcerpt), "show turn should include full reply body");

  // show session --full prints assistant replies
  const showSessionFull = captureIo(repoRoot, { columns: 90 });
  assert.equal(await runLiteCli(["show", "session", turn.session_id, "--full", ...baseArgs], showSessionFull.io), 0);
  const sessionFullOut = showSessionFull.stdout.join("");
  assert.match(sessionFullOut, /full conversation/);
  assert.ok(sessionFullOut.includes(replyExcerpt), "show session --full should include assistant reply");

  // export --format markdown keeps light scan profile while retaining and writing assistant replies
  const exportScans: ScanLiteHistoryOptions[] = [];
  const mdExport = captureIo(repoRoot, {
    scan: async (options) => {
      exportScans.push(options);
      return scanLiteHistory(options);
    },
  });
  assert.equal(await runLiteCli(["export", "--format", "markdown", "--out", "-", ...baseArgs], mdExport.io), 0);
  assert.equal(exportScans[0]?.contextMode, "none");
  assert.equal(exportScans[0]?.retainConversationEvidence, true);
  assert.equal(exportScans[0]?.scanGuard?.profile, "light");
  const mdText = mdExport.stdout.join("");
  assert.match(mdText, /## Conversations/);
  assert.match(mdText, /\*\*User\*\*/);
  assert.match(mdText, /\*\*Assistant\*\*/);
  assert.ok(mdText.includes(replyExcerpt), "markdown export should include assistant reply text");
});

test("CLI tui forwards --dir, --stats, --since, --project, --search, --pricing, and --quota", async () => {
  const capturedArgs: string[][] = [];
  const run = captureIo(repoRoot, {
    spawnTui: async (args) => {
      capturedArgs.push(args);
      return 0;
    },
  });
  assert.equal(
    await runLiteCli(
      ["tui", "--dir", ".", "--stats", "--since", "24h", "--search", "retry", "--quota", "150"],
      run.io,
    ),
    0,
  );
  assert.deepEqual(capturedArgs, [
    ["--dir", repoRoot, "--stats", "--since", "24h", "--search", "retry", "--quota", "150"],
  ]);
});

test("CLI stats renders 1/8th fractional bars, 00-23 Hour of day chart, --by hour_of_day, and Matrix CacheW/Mult columns", async () => {
  assert.equal(renderFractionalBar(1, 10), "██████████");
  assert.equal(renderFractionalBar(3 / 200, 10), "▏         ");
  assert.equal(renderFractionalBar(0, 10), "          ");

  const defaultRun = captureIo(repoRoot);
  assert.equal(
    await runLiteCli(
      ["stats", "--source", "codex", "--source-root", `codex=${codexRoot}`, "--safe"],
      defaultRun.io,
    ),
    0,
  );
  const defaultOut = defaultRun.stdout.join("");
  assert.match(defaultOut, /Hour of day \(00-23,/);
  assert.match(defaultOut, /00\s+06\s+12\s+18\s+23/);

  const hodRun = captureIo(repoRoot);
  assert.equal(
    await runLiteCli(
      ["stats", "--by", "hour_of_day", "--source", "codex", "--source-root", `codex=${codexRoot}`, "--safe"],
      hodRun.io,
    ),
    0,
  );
  const hodOut = hodRun.stdout.join("");
  assert.match(hodOut, /By hour_of_day/);
  assert.match(hodOut, /00:00/);
  assert.match(hodOut, /23:00/);

  const matrixRun = captureIo(repoRoot);
  assert.equal(
    await runLiteCli(
      ["stats", "--by", "project,model,hour", "--source", "codex", "--source-root", `codex=${codexRoot}`, "--safe"],
      matrixRun.io,
    ),
    0,
  );
  const matrixOut = matrixRun.stdout.join("");
  assert.match(matrixOut, /CacheW/);
  assert.match(matrixOut, /Mult/);
  assert.match(matrixOut, /\d{4}-\d{2}-\d{2} \d{2}:00/);
});
