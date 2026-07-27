import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LiveHistorySnapshot, scanLiteHistory } from "@cchistory/live-runtime";
import { configureColorPolicy, stripAnsi } from "./colors.js";
import { LiteBrowserModel } from "./model.js";
import { BANNER_SUBTITLE, BANNER_TITLE, renderLiteFrame, type LiteScrollReconciliation } from "./render.js";
import {
  createLiteBrowserState,
  reduceLiteBrowserState,
  type LiteBrowserAction,
  type LiteBrowserState,
} from "./state.js";
import { clipLine, displayWidth, padLine, wrapText } from "./text.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const codexRoot = path.join(repoRoot, "mock_data", ".codex", "sessions");
const openclawRoot = path.join(repoRoot, "mock_data", ".openclaw", "agents");
const FIXED_NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

configureColorPolicy({ color: false });

async function buildModel(baseDir = codexRoot, sourceRef = "codex"): Promise<LiteBrowserModel> {
  const snapshot = await scanLiteHistory({
    homeDir: repoRoot,
    hostname: "cchistory-lite-tui-render-test-host",
    sourceRoots: [{ sourceRef, baseDir }],
    sourceRefs: [sourceRef],
    safeMode: true,
    contextMode: "none",
  });
  return new LiteBrowserModel(snapshot);
}

async function buildFullModel(): Promise<LiteBrowserModel> {
  const snapshot = await scanLiteHistory({
    homeDir: repoRoot,
    hostname: "cchistory-lite-tui-render-context-host",
    sourceRoots: [{ sourceRef: "codex", baseDir: codexRoot }],
    sourceRefs: ["codex"],
    safeMode: true,
    contextMode: "full",
  });
  return new LiteBrowserModel(snapshot);
}

function apply(
  model: LiteBrowserModel,
  state: LiteBrowserState,
  ...actions: LiteBrowserAction[]
): LiteBrowserState {
  return actions.reduce((current, action) => reduceLiteBrowserState(model, current, action), state);
}

function frame(model: LiteBrowserModel, state: LiteBrowserState, width = 110, height = 34): string {
  return renderLiteFrame(model, state, { width, height, now: FIXED_NOW });
}

test("a frame is exactly the requested height and never exceeds the width", async () => {
  const model = await buildModel();
  const state = createLiteBrowserState(model);
  for (const [width, height] of [
    [80, 24],
    [110, 34],
    [200, 60],
    [46, 14],
  ] as const) {
    const lines = frame(model, state, width, height).split("\n");
    assert.equal(lines.length, height, `height ${height}`);
    for (const line of lines) {
      assert.ok(displayWidth(line) <= width, `line exceeded ${width} columns: ${JSON.stringify(line)}`);
    }
  }
});

test("every view keeps the frame geometry stable", async () => {
  const model = await buildModel();
  const base = createLiteBrowserState(model);
  const views: Array<[string, LiteBrowserState]> = [
    ["browse", base],
    ["turns", apply(model, base, { type: "focus-turns" })],
    ["detail", apply(model, base, { type: "focus-detail" })],
    ["conversation", apply(model, base, { type: "drill" }, { type: "drill" }, { type: "drill" })],
    ["search", apply(model, base, { type: "open-search", query: "mock" })],
    ["help", apply(model, base, { type: "toggle-help" })],
    ["stats", apply(model, base, { type: "toggle-stats" })],
    ["sources", apply(model, base, { type: "toggle-sources" })],
  ];
  for (const [label, state] of views) {
    const lines = frame(model, state, 100, 30).split("\n");
    assert.equal(lines.length, 30, `${label} view height`);
    for (const line of lines) {
      assert.ok(displayWidth(line) <= 100, `${label} view overflowed: ${JSON.stringify(line)}`);
    }
  }
});

test("the banner lines release verifiers grep for are byte-identical", async () => {
  const model = await buildModel();
  const lines = frame(model, createLiteBrowserState(model)).split("\n");
  assert.equal(lines[0], BANNER_TITLE);
  assert.equal(lines[1], BANNER_SUBTITLE);
  assert.equal(BANNER_TITLE, "CC History Lite TUI 0.3.0");
  assert.equal(BANNER_SUBTITLE, "Ephemeral live snapshot · single machine · no Full store");
});

test("browse shows both panes, the counts line, and the status bar", async () => {
  const model = await buildModel();
  const output = frame(model, createLiteBrowserState(model));
  assert.match(output, /Projects/);
  assert.match(output, /Turns/);
  assert.match(output, /Detail/);
  assert.match(output, /\d+ sources · \d+ projects · \d+ sessions · \d+ turns/);
  assert.match(output, /\? help/);
  assert.match(output, /q quit/);
});

test("the focused pane is marked and the selected row carries a cursor", async () => {
  const model = await buildModel();
  const projects = frame(model, createLiteBrowserState(model));
  assert.match(projects, /▸ Projects/);
  assert.match(projects, /❯ /);
  const turns = frame(model, apply(model, createLiteBrowserState(model), { type: "focus-turns" }));
  assert.match(turns, /▸ Turns/);
  assert.doesNotMatch(turns, /▸ Projects/);
});

test("moving the cursor moves the marker to the next project", async () => {
  const model = await buildModel();
  const first = frame(model, createLiteBrowserState(model)).split("\n");
  const second = frame(model, apply(model, createLiteBrowserState(model), { type: "move-down" })).split("\n");
  const cursorRow = (lines: string[]) => lines.findIndex((line) => line.includes("❯"));
  assert.ok(cursorRow(first) >= 0);
  assert.equal(cursorRow(second), cursorRow(first) + 1);
});

test("search mode renders the query line and groups matches by project", async () => {
  const model = await buildModel();
  const state = apply(model, createLiteBrowserState(model), { type: "open-search", query: "mock" });
  const output = frame(model, state);
  assert.match(output, /\/ mock/);
  assert.match(output, /search "mock"/);
  assert.match(output, /\d+ matches/);
});

test("an uncommitted short query prompts for Enter rather than searching", async () => {
  const model = await buildModel();
  let state = apply(model, createLiteBrowserState(model), { type: "enter-search-mode" });
  state = apply(model, state, { type: "append-search-char", value: "m" });
  assert.match(frame(model, state), /Press Enter to search/);
});

test("the help overlay documents the Full-TUI-compatible keymap", async () => {
  const model = await buildModel();
  const output = frame(model, apply(model, createLiteBrowserState(model), { type: "toggle-help" }));
  for (const fragment of ["Navigation", "Panes", "Actions", "j/k", "PgUp/PgDn", "Enter", "Esc", "refresh"]) {
    assert.ok(output.includes(fragment), `help overlay missing ${fragment}`);
  }
  assert.match(output, /Never opens or creates ~\/\.cchistory/);
});

test("the stats overlay shows the overview and the selected rollup dimension", async () => {
  const model = await buildModel();
  let state = apply(model, createLiteBrowserState(model), { type: "toggle-stats" });
  assert.match(frame(model, state), /Statistics/);
  assert.match(frame(model, state), /By source/);
  state = apply(model, state, { type: "cycle-stats-dimension" });
  assert.match(frame(model, state), /By project/);
});

test("the sources overlay reports health counts and adapter roots", async () => {
  const model = await buildModel();
  const output = frame(model, apply(model, createLiteBrowserState(model), { type: "toggle-sources" }));
  assert.match(output, /Sources/);
  assert.match(output, /Healthy: \d+/);
  assert.match(output, /Stale: \d+/);
  assert.match(output, /Error: \d+/);
  assert.ok(output.includes(".codex"), "expected the adapter base dir");
});

test("the detail pane surfaces canonical turn identity and the prompt", async () => {
  const model = await buildModel();
  const output = frame(model, apply(model, createLiteBrowserState(model), { type: "focus-detail" }));
  assert.match(output, /Ask 1\/\d+ in /);
  assert.match(output, /Model:/);
  assert.match(output, /Turn:/);
  assert.match(output, /Prompt:/);
});

test("session detail surfaces canonical related work for a turn-less session", async () => {
  const model = await buildModel(openclawRoot, "openclaw");
  const sessionId = "sess:openclaw:44444444-5555-4666-8777-888888888888";
  const state = apply(model, createLiteBrowserState(model), { type: "open-session-ref", ref: sessionId });
  const output = frame(model, state, 130, 40);
  assert.match(output, /Sessions/);
  assert.match(output, /Related work \(1\)/);
  assert.match(output, /automation run · self/);
  assert.match(output, /derived no UserTurn/);
});

test("the sessions scope lists every session with turn and related-work counts", async () => {
  const model = await buildModel(openclawRoot, "openclaw");
  const state = apply(model, createLiteBrowserState(model), { type: "set-browse-scope", scope: "sessions" });
  const output = frame(model, state, 130, 40);
  assert.match(output, /▸ Sessions/);
  assert.match(output, /sessions\/projects/);
  for (const entry of model.sessions) {
    const label = entry.session.title ?? entry.session.source_session_id ?? entry.session.id;
    assert.ok(output.includes(label.slice(0, 12)), `session ${label} missing from the pane`);
  }
});

test("the conversation view labels context that the light snapshot has not loaded", async () => {
  const model = await buildModel();
  const state = apply(model, createLiteBrowserState(model), { type: "drill" }, { type: "drill" }, { type: "drill" });
  const output = frame(model, state);
  assert.match(output, /▸ Conversation/);
  assert.match(output, /Ask 1\/\d+/);
  assert.match(output, /context not loaded/);
});

test("the conversation view renders replies and tool calls once context is loaded", async () => {
  const model = await buildFullModel();
  const state = apply(model, createLiteBrowserState(model), { type: "drill" }, { type: "drill" }, { type: "drill" });
  const output = frame(model, state, 120, 44);
  assert.match(output, /Assistant replies: [1-9]/);
  assert.match(output, /Tool calls: \d+/);
  assert.doesNotMatch(output, /context not loaded/);
});

test("the conversation view keeps both scroll indicators inside the frame height", async () => {
  const model = await buildFullModel();
  const drilled = apply(
    model,
    createLiteBrowserState(model),
    { type: "drill" },
    { type: "drill" },
    { type: "drill" },
  );
  // A mid-scroll offset must show both the above and below indicators, and the
  // emitted rows must not exceed contentHeight (which used to slice the "more
  // below" hint and the last content line off the bottom).
  const mid = { ...drilled, conversationScrollOffset: 5 };
  const output = frame(model, mid, 100, 14);
  assert.equal(output.split("\n").length, 14, "conversation frame must stay exactly the requested height");
  assert.match(output, /↑ \d+ more lines above/);
  assert.match(output, /↓ \d+ more lines below/);
});

test("a jump-to-last scroll offset is reconciled to a finite maximum so scrolling up works", async () => {
  const model = await buildFullModel();
  // The reducer stores a bottom sentinel (MAX_SAFE_INTEGER) for jump-last
  // because it has no terminal dimensions; only the renderer can resolve it.
  const jumped = apply(
    model,
    createLiteBrowserState(model),
    { type: "drill" },
    { type: "drill" },
    { type: "drill" },
    { type: "jump-last" },
  );
  assert.equal(jumped.conversationScrollOffset, Number.MAX_SAFE_INTEGER);

  const bottom: LiteScrollReconciliation = {};
  renderLiteFrame(model, jumped, { width: 100, height: 14, now: FIXED_NOW }, bottom);
  assert.ok(bottom.conversationScrollOffset !== undefined, "renderer must report the reconciled offset");
  assert.ok(
    bottom.conversationScrollOffset! < Number.MAX_SAFE_INTEGER,
    "the sentinel must be resolved to a real finite maximum",
  );

  // Scrolling up from the reconciled bottom must move the offset down, which is
  // the behavior the stuck-after-G bug broke.
  const up = { ...jumped, conversationScrollOffset: bottom.conversationScrollOffset! - 1 };
  const afterUp: LiteScrollReconciliation = {};
  renderLiteFrame(model, up, { width: 100, height: 14, now: FIXED_NOW }, afterUp);
  assert.ok(
    afterUp.conversationScrollOffset! < bottom.conversationScrollOffset!,
    "move-up from the bottom must scroll the view",
  );
});

test("a status message renders above the status bar", async () => {
  const model = await buildModel();
  const state = apply(model, createLiteBrowserState(model), {
    type: "set-status",
    status: { kind: "error", text: "Refresh failed; previous snapshot retained: boom" },
  });
  const lines = frame(model, state).split("\n");
  assert.match(lines.at(-2) ?? "", /Refresh failed; previous snapshot retained: boom/);
});

test("an empty snapshot renders guidance instead of a blank frame", async () => {
  const model = new LiteBrowserModel(
    new LiveHistorySnapshot({
      host: { id: "host", hostname: "empty", platform: "darwin", created_at: "2026-01-01T00:00:00.000Z" } as never,
      sources: [],
      projects: [],
      sessions: [],
      turns: [],
      contexts: [],
      ask_user_question_turns: [],
      loss_audits: [],
    }),
  );
  const state = createLiteBrowserState(model);
  const output = frame(model, state);
  assert.match(output, /No projects/);
  assert.match(output, /0 sources · 0 projects · 0 sessions · 0 turns/);
  assert.match(output, /No AI coding history found on this machine/);
  assert.match(output, /--source-root <slot-or-id>=<path>/);
  const sources = frame(model, apply(model, state, { type: "toggle-sources" }));
  assert.match(sources, /No adapter roots were found on this machine/);
  assert.match(sources, /--source-root <slot-or-id>=<path>/);
});

test("frames carry no escape bytes when color is disabled", async () => {
  const model = await buildModel();
  const output = frame(model, apply(model, createLiteBrowserState(model), { type: "toggle-stats" }));
  assert.equal(output, stripAnsi(output));
});

test("text helpers measure and clip by terminal columns, not string length", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("日本語"), 6);
  assert.equal(displayWidth("\x1b[31mabc\x1b[39m"), 3);
  assert.equal(displayWidth(padLine("ab", 6)), 6);
  assert.ok(displayWidth(clipLine("日本語テスト", 6)) <= 6);
  assert.equal(clipLine("abc", 10), "abc");
  assert.deepEqual(wrapText("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapText("supercalifragilistic", 6), ["superc", "alifra", "gilist", "ic"]);
  assert.deepEqual(wrapText("first\n\nsecond", 40), ["first", "", "second"]);
  for (const line of wrapText("日本語のテキストを折り返します", 8)) {
    assert.ok(displayWidth(line) <= 8);
  }
});
