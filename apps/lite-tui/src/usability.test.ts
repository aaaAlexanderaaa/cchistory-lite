import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scanLiteHistory, type ScanLiteHistoryOptions } from "@cchistory/live-runtime";
import { buildOsc52Sequence, copyTextToClipboard } from "./clipboard.js";
import { configureColorPolicy, stripAnsi } from "./colors.js";
import { runLiteTui } from "./index.js";
import { resolveLiteInputEffect } from "./input.js";
import { KeyDecoder } from "./keys.js";
import { LiteBrowserModel } from "./model.js";
import { renderLiteFrame } from "./render.js";
import { createLiteBrowserState, reduceLiteBrowserState, shouldRunSearch, type LiteBrowserState } from "./state.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const codexRoot = path.join(repoRoot, "mock_data", ".codex", "sessions");
const evidenceFixtureRoot = path.join(repoRoot, "mock_data", "fixtures", "agent-evidence");
const emptyHome = path.join(repoRoot, "mock_data", "empty-home");

function pressKeys(model: LiteBrowserModel, initial: LiteBrowserState, raw: string): LiteBrowserState {
  const decoder = new KeyDecoder();
  let state = initial;
  for (const key of decoder.push(raw)) {
    const effect = resolveLiteInputEffect(state, key);
    if (effect.type === "action") state = reduceLiteBrowserState(model, state, effect.action);
  }
  const trailing = decoder.flushPendingEscape();
  if (trailing) {
    const effect = resolveLiteInputEffect(state, trailing);
    if (effect.type === "action") state = reduceLiteBrowserState(model, state, effect.action);
  }
  return state;
}

test("TUI stats S opens Top Sessions, Enter drills into the session, and t auto-switches to hour on today/24h", async () => {
  configureColorPolicy({ color: false });
  const snapshot = await scanLiteHistory({
    homeDir: emptyHome,
    hostname: "cchistory-tui-usability-test",
    sourceRefs: ["codex"],
    sourceRoots: [{ sourceRef: "codex", baseDir: codexRoot }],
    contextMode: "none",
    safeMode: true,
  });
  const model = new LiteBrowserModel(snapshot, { quotaLimitUsd: 100 });
  let state = reduceLiteBrowserState(model, createLiteBrowserState(model), { type: "toggle-stats" });

  // Unpinned t cycles all -> today -> automatically switches bucket to hour
  assert.equal(state.stats.timeBucket, "day");
  state = pressKeys(model, state, "t");
  assert.equal(state.stats.timePreset, "today");
  assert.equal(state.stats.timeBucket, "hour");

  // Reset filters, open Top Sessions with S, and drill into the selected session with Enter
  state = pressKeys(model, state, "cS");
  assert.equal(state.stats.view, "sessions");
  const sessionsFrame = renderLiteFrame(model, state, { width: 120, height: 34 });
  assert.match(sessionsFrame, /▸ Top Sessions/);

  state = pressKeys(model, state, "\r");
  assert.equal(state.overlay, "none");
  assert.equal(state.browseScope, "sessions");
  assert.match(state.status?.text ?? "", /Opened .*press i to return/);

  // Pressing i returns right back to stats with Top Sessions view preserved
  state = pressKeys(model, state, "i");
  assert.equal(state.overlay, "stats");
  assert.equal(state.stats.view, "sessions");
});

test("TUI CJK 2-char queries auto-search without Enter while 2-char ASCII still waits for Enter", async () => {
  const snapshot = await scanLiteHistory({
    homeDir: emptyHome,
    sourceRefs: ["codex"],
    sourceRoots: [{ sourceRef: "codex", baseDir: codexRoot }],
    contextMode: "none",
    safeMode: true,
  });
  const model = new LiteBrowserModel(snapshot);
  const base = createLiteBrowserState(model);

  const latinShort = pressKeys(model, base, "/ab");
  assert.equal(shouldRunSearch(latinShort), false);

  const cjkTwoChar = pressKeys(model, base, "/部署");
  assert.equal(shouldRunSearch(cjkTwoChar), true);

  const cjkOneChar = pressKeys(model, base, "/部");
  assert.equal(shouldRunSearch(cjkOneChar), false);
});

test("TUI Ctrl+F loads assistant replies on demand and finds assistant-only text", async () => {
  const seenScans: ScanLiteHistoryOptions[] = [];
  const fullEvidence = await scanLiteHistory({
    homeDir: emptyHome,
    sourceRefs: ["codex"],
    sourceRoots: [{ sourceRef: "codex", baseDir: evidenceFixtureRoot }],
    contextMode: "none",
    retainConversationEvidence: true,
    safeMode: true,
  });
  const assistantMsg = fullEvidence.data.conversation_evidence?.find((m) => m.role === "assistant");
  assert.ok(assistantMsg);
  const replyOnlyWord = assistantMsg.text
    .split(/\s+/u)
    .map((word) => word.replace(/[^A-Za-z0-9_-]/gu, ""))
    .find(
      (word) =>
        word.length >= 6 &&
        !fullEvidence.data.turns.some((t) => t.canonical_text.toLowerCase().includes(word.toLowerCase())),
    );
  assert.ok(replyOnlyWord);

  const input = new PassThrough();
  const output = new PassThrough();
  const stdout: string[] = [];
  let sentToggle = false;
  let sentQuit = false;

  const exitCode = await runLiteTui(["--search", replyOnlyWord], {
    cwd: repoRoot,
    homeDir: emptyHome,
    isInteractiveTerminal: true,
    input,
    output,
    columns: 110,
    rows: 32,
    stdout: (text) => {
      stdout.push(text);
      const plain = stripAnsi(text);
      if (!sentToggle && plain.includes("[prompts")) {
        sentToggle = true;
        input.push("\x06"); // Ctrl+F to enable +replies search
      } else if (sentToggle && !sentQuit && plain.includes("[+replies") && /[1-9]\d* matches/u.test(plain)) {
        sentQuit = true;
        input.push("\x03"); // Ctrl+C exits cleanly even while search input is focused
      }
    },
    stderr: () => {},
    scan: async (options) => {
      seenScans.push(options);
      return scanLiteHistory({
        ...options,
        sourceRefs: ["codex"],
        sourceRoots: [{ sourceRef: "codex", baseDir: evidenceFixtureRoot }],
        safeMode: true,
      });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(seenScans.length, 2);
  assert.equal(seenScans[0]?.retainConversationEvidence, undefined);
  assert.equal(seenScans[1]?.retainConversationEvidence, true);
  assert.equal(seenScans[1]?.contextMode, "none");
  assert.ok(sentQuit, "Ctrl+F should find the assistant-only match");
});

test("TUI E exports calibrated pricing JSON safely, y copies resume, R exits and prints resume, and --dir scopes snapshot", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cchistory-tui-usability-"));
  try {
    const snapshot = await scanLiteHistory({
      homeDir: emptyHome,
      sourceRefs: ["codex"],
      sourceRoots: [{ sourceRef: "codex", baseDir: codexRoot }],
      contextMode: "none",
      safeMode: true,
    });
    const exportPath = path.join(tempDir, "tui-pricing.json");
    const copied: string[] = [];

    // 1. Export pricing via --stats + E + path + Enter, then reject .cchistory export, then copy with y and exit-print with R
    const input = new PassThrough();
    const output = new PassThrough();
    const stdout: string[] = [];
    let phase = 0;

    const code = await runLiteTui(["--stats", "--since", "24h", "--quota", "80"], {
      cwd: tempDir,
      homeDir: tempDir,
      isInteractiveTerminal: true,
      input,
      output,
      columns: 120,
      rows: 34,
      scan: async () => snapshot,
      copyToClipboard: async (text) => {
        copied.push(text);
        return { ok: true, via: "osc52" };
      },
      stdout: (text) => {
        stdout.push(text);
        const plain = stripAnsi(text);
        if (phase === 0 && plain.includes("▸ Statistics")) {
          phase = 1;
          // Clear default "./cchistory-pricing.json" (24 chars) via backspaces and type explicit exportPath
          input.push(`E${"\x7f".repeat(30)}${exportPath}\r`);
        } else if (phase === 1 && plain.includes("Exported pricing config")) {
          phase = 2;
          // Close stats with i, copy resume command with y, then quit & print resume with R
          input.push("iyR");
        }
      },
      stderr: () => {},
    });

    assert.equal(code, 0);
    const exported = JSON.parse(await readFile(exportPath, "utf8")) as { schema: string; quota?: { custom_usd?: number } };
    assert.equal(exported.schema, "cchistory-lite-pricing/v1");
    assert.equal(exported.quota?.custom_usd, 80);
    assert.equal(copied.length, 1);
    assert.ok(copied[0]!.length > 0);
    const finalOut = stripAnsi(stdout.join(""));
    assert.ok(finalOut.includes(copied[0]!), "R should print the resume command/session ID cleanly on exit");

    // 2. --dir scopes non-interactive frame to 0 sessions when no history ran in tempDir
    const scopedOut: string[] = [];
    assert.equal(
      await runLiteTui(["--dir", tempDir, "--no-color"], {
        cwd: tempDir,
        homeDir: tempDir,
        isInteractiveTerminal: false,
        columns: 100,
        rows: 24,
        stdout: (t) => scopedOut.push(t),
        stderr: () => {},
        scan: async () => snapshot,
      }),
      0,
    );
    const frame = scopedOut.join("");
    assert.match(frame, /0 sessions · 0 turns/);
    assert.match(frame, /dir:/);
    // 3. Pricing export rejects .cchistory and native source roots
    const unsafeInput = new PassThrough();
    const unsafeStdout: string[] = [];
    let unsafePhase = 0;
    const unsafePath = path.join(tempDir, ".cchistory", "pricing.json");
    assert.equal(
      await runLiteTui(["--stats"], {
        cwd: tempDir,
        homeDir: tempDir,
        isInteractiveTerminal: true,
        input: unsafeInput,
        output: new PassThrough(),
        columns: 120,
        rows: 34,
        scan: async () => snapshot,
        stdout: (text) => {
          unsafeStdout.push(text);
          const plain = stripAnsi(text);
          if (unsafePhase === 0 && plain.includes("▸ Statistics")) {
            unsafePhase = 1;
            unsafeInput.push(`E${"\x7f".repeat(30)}${unsafePath}\r`);
          } else if (unsafePhase === 1 && plain.includes("Full store path")) {
            unsafePhase = 2;
            unsafeInput.push("q");
          }
        },
        stderr: () => {},
      }),
      0,
    );
    assert.equal(unsafePhase, 2, "TUI export should reject .cchistory destination");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("clipboard helper builds valid OSC 52 sequence and degrades safely when native tools fail", async () => {
  const seq = buildOsc52Sequence("cd /tmp && codex resume abc");
  assert.ok(seq.startsWith("\x1b]52;c;"));
  assert.ok(seq.endsWith("\x07"));
  const b64 = seq.slice("\x1b]52;c;".length, -1);
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), "cd /tmp && codex resume abc");

  const written: string[] = [];
  const res = await copyTextToClipboard("hello", {
    writeOsc52: (s) => written.push(s),
    runCommand: async () => false,
  });
  assert.equal(res.ok, true);
  assert.equal(res.via, "osc52");
  assert.equal(written.length, 1);

  const noneRes = await copyTextToClipboard("hello", {
    runCommand: async () => false,
  });
  assert.equal(noneRes.ok, false);
  assert.equal(noneRes.via, "none");
});
