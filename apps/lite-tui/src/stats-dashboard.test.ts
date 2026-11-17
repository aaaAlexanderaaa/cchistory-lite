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

test("v switches to Matrix view, t/b/w/o cycle windows and buckets, Esc steps out cleanly", async () => {
  configureColorPolicy({ color: false });
  const model = await getMultiModel();
  let state = applyAll(model, createLiteBrowserState(model), { type: "toggle-stats" });

  state = pressKeys(model, state, "v");
  assert.equal(state.stats.view, "matrix");
  const matrixFrame = renderLiteFrame(model, state, { width: 120, height: 36 });
  assert.match(matrixFrame, /▸ Matrix \(project × model × source × day\)/);

  state = pressKeys(model, state, "bwot");
  assert.equal(state.stats.timeBucket, "week");
  assert.equal(state.stats.weekMode, "iso_week");
  assert.equal(state.stats.sortBy, "list_cost");
  assert.equal(state.stats.timePreset, "today");

  // Esc inside matrix returns to quad view; second Esc closes stats overlay
  state = pressKeys(model, state, "\x1b");
  assert.equal(state.overlay, "stats");
  assert.equal(state.stats.view, "quad");
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
