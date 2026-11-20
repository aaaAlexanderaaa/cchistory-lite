import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scanLiteHistory, type LiveHistorySnapshot } from "@cchistory/live-runtime";
import { configureColorPolicy, stripAnsi } from "./colors.js";
import { resolveLiteInputEffect } from "./input.js";
import { KeyDecoder } from "./keys.js";
import { LiteBrowserModel } from "./model.js";
import { renderLiteFrame } from "./render.js";
import { createLiteBrowserState, reduceLiteBrowserState, type LiteBrowserAction, type LiteBrowserState } from "./state.js";
import { displayWidth } from "./text.js";
import { renderTuiFractionalBar } from "./stats-visuals.js";
import { runLiteTui } from "./index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const codexRoot = path.join(repoRoot, "mock_data", ".codex", "sessions");
const antigravityRoot = path.join(repoRoot, "mock_data", "fixtures", "antigravity-sqlite");

let multiModelPromise: Promise<LiteBrowserModel> | undefined;
function getMultiModel(): Promise<LiteBrowserModel> {
  multiModelPromise ??= scanLiteHistory({
    homeDir: path.join(repoRoot, "mock_data", "empty-home"),
    hostname: "cchistory-lite-tui-stats-test",
    sourceRefs: ["codex", "antigravity"],
    sourceRoots: [
      { sourceRef: "codex", baseDir: codexRoot },
      { sourceRef: "antigravity", baseDir: antigravityRoot },
    ],
    contextMode: "none",
    safeMode: true,
  }).then((snapshot) => new LiteBrowserModel(snapshot, { quotaLimitUsd: 100 }));
  return multiModelPromise;
}

function applyAll(model: LiteBrowserModel, initial: LiteBrowserState, ...actions: LiteBrowserAction[]): LiteBrowserState {
  let current = initial;
  for (const action of actions) {
    current = reduceLiteBrowserState(model, current, action);
  }
  return current;
}

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

test("Plan A 2x2 dashboard displays all four dimensions and cross-filters via Space", async () => {
  configureColorPolicy({ color: false });
  const model = await getMultiModel();
  let state = applyAll(model, createLiteBrowserState(model), { type: "toggle-stats" });

  const initialFrame = renderLiteFrame(model, state, { width: 120, height: 36 });
  assert.match(initialFrame, /▸ By source/);
  assert.match(initialFrame, /By project/);
  assert.match(initialFrame, /By model/);
  assert.match(initialFrame, /By day/);
  assert.match(initialFrame, /List \$/);
  assert.match(initialFrame, /Adj \$/);

  // Tab advances active quadrant focus through all 4 boxes
  state = pressKeys(model, state, "\t");
  assert.match(renderLiteFrame(model, state, { width: 120, height: 36 }), /▸ By project/);
  state = pressKeys(model, state, "\t");
  assert.match(renderLiteFrame(model, state, { width: 120, height: 36 }), /▸ By model/);
  state = pressKeys(model, state, "\t");
  assert.match(renderLiteFrame(model, state, { width: 120, height: 36 }), /▸ By day/);

  // Focus source with "3", toggle first source row with Space, verify active filter chip & clear with "c"
  state = pressKeys(model, state, "3 ");
  assert.equal(state.stats.filters.sourceIds.length, 1);
  const filteredFrame = renderLiteFrame(model, state, { width: 120, height: 36 });
  assert.match(filteredFrame, /Filters: S:1/);
  assert.match(filteredFrame, /\[x\]/);

  state = pressKeys(model, state, "c");
  assert.equal(state.stats.filters.sourceIds.length, 0);
  assert.doesNotMatch(renderLiteFrame(model, state, { width: 120, height: 36 }), /Filters:/);
});

test("v switches to Matrix view with g grouping, ←/→ narrow columns, full time/Hit/Mult, and Selected inspector", async () => {
  configureColorPolicy({ color: false });
  const model = await getMultiModel();
  let state = applyAll(model, createLiteBrowserState(model), { type: "toggle-stats" });

  state = pressKeys(model, state, "v");
  assert.equal(state.stats.view, "matrix");
  assert.equal(state.stats.matrixGroup, "project_model");
  const matrixFrame = renderLiteFrame(model, state, { width: 120, height: 36 });
  assert.match(matrixFrame, /▸ Matrix \[g: Project × Model\]/);
  assert.match(matrixFrame, /\bIn\s+CR\s+CW\s+Out\s+Hit\s+Mult\s+List\$\s+Adj\$/);
  assert.match(matrixFrame, /Selected:/);

  // Cycle g through Model × Day -> Project × Day -> All 4
  state = pressKeys(model, state, "g");
  assert.equal(state.stats.matrixGroup, "model_time");
  assert.match(renderLiteFrame(model, state, { width: 120, height: 36 }), /▸ Matrix \[g: Model × Day\]/);

  state = pressKeys(model, state, "g");
  assert.equal(state.stats.matrixGroup, "project_time");

  state = pressKeys(model, state, "g");
  assert.equal(state.stats.matrixGroup, "all_4");
  const all4Frame = renderLiteFrame(model, state, { width: 120, height: 36 });
  assert.match(all4Frame, /▸ Matrix \[g: All 4 · Day\]/);

  // Narrow terminal toggles between [Tokens] and [Cost] pages with right arrow
  const narrowTok = renderLiteFrame(model, state, { width: 90, height: 28 });
  assert.match(narrowTok, /←\/→ \[Tokens\]\|Cost/);
  assert.match(narrowTok, /Selected:/);
  state = pressKeys(model, state, "\x1b[C");
  const narrowCost = renderLiteFrame(model, state, { width: 90, height: 28 });
  assert.match(narrowCost, /←\/→ Tokens\|\[Cost\]/);
  assert.match(narrowCost, /\bHit\s+Mult\s+List\$\s+Adj\$/);

  state = pressKeys(model, state, "bwot");
  assert.equal(state.stats.timeBucket, "week");
  assert.equal(state.stats.weekMode, "iso_week");
  assert.equal(state.stats.sortBy, "list_cost");
  assert.equal(state.stats.timePreset, "today");

  // Clear time filter back to all, cycle b to hour and hour_of_day, and verify hour time label is NOT truncated to YYYY-MM
  state = pressKeys(model, state, "cbbb"); // day -> week -> month -> hour
  assert.equal(state.stats.timeBucket, "hour");
  const hourMatrix = renderLiteFrame(model, state, { width: 120, height: 36 });
  assert.match(hourMatrix, /\d{2}-\d{2} \d{2}:00/);

  state = pressKeys(model, state, "b"); // hour -> hour_of_day
  assert.equal(state.stats.timeBucket, "hour_of_day");

  // Esc inside matrix returns to quad view; second Esc closes stats overlay
  state = pressKeys(model, state, "\x1b");
  assert.equal(state.overlay, "stats");
  assert.equal(state.stats.view, "quad");
  const hodQuad = renderLiteFrame(model, state, { width: 120, height: 36 });
  assert.match(hodQuad, /By hour \(00-23\)/);
  state = pressKeys(model, state, "\x1b");
  assert.equal(state.overlay, "none");
});

test("m calibration view edits multipliers, aliases, and quota USD live in memory", async () => {
  configureColorPolicy({ color: false });
  const model = await getMultiModel();
  let state = applyAll(model, createLiteBrowserState(model), { type: "toggle-stats" });
  const beforeAdj = model.getUsageBreakdown().overview.cost?.adjusted_cost_usd ?? 0;

  state = pressKeys(model, state, "m");
  assert.equal(state.stats.view, "multipliers");
  assert.match(renderLiteFrame(model, state, { width: 120, height: 36 }), /▸ Calibrate Multipliers & Aliases/);

  // Increase overall model multiplier (+), verify cell updates and reset with 0/1/R
  state = pressKeys(model, state, "+");
  const modifiedModels = Object.keys(state.stats.multiplierOverrides);
  assert.equal(modifiedModels.length, 1);
  const afterBoost = model.getUsageBreakdown({ multiplierOverrides: state.stats.multiplierOverrides }).overview.cost?.adjusted_cost_usd ?? 0;
  assert.ok(afterBoost >= beforeAdj);

  // Move right to input column, set 0, then inline quota "$50\r", inline alias "a"
  state = pressKeys(model, state, "\x1b[C0");
  assert.equal(state.stats.multiplierColIndex, 1);
  state = pressKeys(model, state, "$50\r");
  assert.equal(state.stats.quotaUsdOverride, 50);

  state = pressKeys(model, state, "agemini-4-carbon\r");
  assert.ok(Object.values(state.stats.customAliases).includes("gemini-4-carbon"));

  // R resets all in-memory overrides
  state = pressKeys(model, state, "R");
  assert.deepEqual(state.stats.multiplierOverrides, {});
  assert.deepEqual(state.stats.customAliases, {});
  assert.equal(state.stats.quotaUsdOverride, undefined);
});

test("stats dashboard clips safely on narrow terminals and emits no ANSI when color disabled", async () => {
  configureColorPolicy({ color: false });
  const model = await getMultiModel();
  const base = applyAll(model, createLiteBrowserState(model), { type: "toggle-stats" });

  for (const action of [
    undefined,
    { type: "stats-set-view" as const, view: "matrix" as const },
    { type: "stats-set-view" as const, view: "multipliers" as const },
  ]) {
    const viewState = action ? reduceLiteBrowserState(model, base, action) : base;
    const output = renderLiteFrame(model, viewState, { width: 62, height: 22 });
    assert.equal(output, stripAnsi(output));
    const lines = output.split("\n");
    assert.equal(lines.length, 22);
    for (const line of lines) {
      assert.ok(displayWidth(line) <= 62, `line overflowed 62 cols: ${line}`);
    }
  }
});

test("runLiteTui accepts --pricing and --quota options cleanly", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cchistory-tui-pricing-"));
  try {
    const pricingPath = path.join(tempDir, "pricing.json");
    await writeFile(
      pricingPath,
      JSON.stringify({
        schema: "cchistory-lite-pricing/v1",
        multipliers: { "gpt-5": { model: 2 } },
      }),
      "utf8",
    );
    const snapshot: LiveHistorySnapshot = (await getMultiModel()).snapshot;
    const input = new PassThrough();
    const output = new PassThrough();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const runPromise = runLiteTui(
      ["--pricing", pricingPath, "--quota", "75"],
      {
        cwd: tempDir,
        homeDir: tempDir,
        stdout: (text) => {
          stdout.push(text);
          if (text.includes("▸ Projects")) input.push("iq");
        },
        stderr: (text) => stderr.push(text),
        isInteractiveTerminal: true,
        input,
        output,
        columns: 120,
        rows: 36,
        scan: async () => snapshot,
      },
    );

    const exitCode = await runPromise;
    assert.equal(exitCode, 0, stderr.join(""));
    const joined = stripAnsi(stdout.join(""));
    assert.match(joined, /▸ Statistics/);
    assert.match(joined, /of \$75\.00/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("fractional bars separate $200 vs $3 cleanly and quad columns align every row to identical column offsets", async () => {
  configureColorPolicy({ color: false });
  const bar200 = renderTuiFractionalBar(1, 10);
  const bar3 = renderTuiFractionalBar(3 / 200, 10);
  const bar0 = renderTuiFractionalBar(0, 10);
  assert.equal(displayWidth(bar200), 10);
  assert.equal(displayWidth(bar3), 10);
  assert.equal(displayWidth(bar0), 10);
  assert.equal(bar200, "██████████");
  assert.equal(bar3, "▏         ");
  assert.equal(bar0, "          ");

  const model = await getMultiModel();
  const state = applyAll(model, createLiteBrowserState(model), { type: "toggle-stats" });
  const frame = renderLiteFrame(model, state, { width: 130, height: 34 });
  const lines = frame.split("\n");
  // Every data row in the top-right By model quadrant shares identical column width before │ and aligned Adj$ / Hit columns
  const modelHeaderLine = lines.find((line) => line.includes("Name") && line.includes("Bar (max)"));
  assert.ok(modelHeaderLine, "Quad panels should display aligned column headers");
  const rightDividerIdx = modelHeaderLine.indexOf("│");
  assert.ok(rightDividerIdx > 0);
  const topQuadLines = lines.filter((line) => line.includes("│") && line.includes("$") && !line.includes("Tot "));
  assert.ok(topQuadLines.length >= 2);
  for (const line of topQuadLines) {
    assert.equal(displayWidth(line.slice(0, line.indexOf("│"))), displayWidth(modelHeaderLine.slice(0, rightDividerIdx)));
  }
});
