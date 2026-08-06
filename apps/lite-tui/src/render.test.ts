import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LiveHistorySnapshot, scanLiteHistory } from "@cchistory/live-runtime";
import { configureColorPolicy, stripAnsi } from "./colors.js";
import { LiteBrowserModel } from "./model.js";
import { BANNER_SUBTITLE, BANNER_TITLE, renderLiteFrame, renderScrollablePane, type LiteScrollReconciliation } from "./render.js";
import {
  createLiteBrowserState,
  getVisibleTurns,
  reduceLiteBrowserState,
  type LiteBrowserAction,
  type LiteBrowserState,
} from "./state.js";
import { clipLine, displayWidth, padLine, wrapText } from "./text.js";
import { buildSessionDisplayLabels, buildTurnDisplayGroups } from "./view-model.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const codexRoot = path.join(repoRoot, "mock_data", ".codex", "sessions");
const claudeRoot = path.join(repoRoot, "mock_data", ".claude", "projects");
const codeBuddyRoot = path.join(repoRoot, "mock_data", ".codebuddy");
const openclawRoot = path.join(repoRoot, "mock_data", ".openclaw", "agents");
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

async function buildMultiSourceModel(): Promise<LiteBrowserModel> {
  const snapshot = await scanLiteHistory({
    homeDir: repoRoot,
    hostname: "cchistory-lite-tui-render-multi-source-host",
    sourceRoots: [
      { sourceRef: "codex", baseDir: codexRoot },
      { sourceRef: "codebuddy", baseDir: codeBuddyRoot },
    ],
    sourceRefs: ["codex", "codebuddy"],
    safeMode: true,
    contextMode: "none",
  });
  return new LiteBrowserModel(snapshot);
}

async function buildFixtureMatrixModel(): Promise<LiteBrowserModel> {
  const snapshot = await scanLiteHistory({
    homeDir: repoRoot,
    hostname: "cchistory-lite-tui-render-fixture-matrix-host",
    sourceRoots: Object.entries(fixtureRoots).map(([sourceRef, relativePath]) => ({
      sourceRef,
      baseDir: path.join(repoRoot, "mock_data", relativePath),
    })),
    sourceRefs: Object.keys(fixtureRoots),
    safeMode: true,
    contextMode: "none",
  });
  return new LiteBrowserModel(snapshot);
}

function buildInterleavedModel(base: LiteBrowserModel): LiteBrowserModel {
  const source = base.snapshot.data.sources[0]!;
  const projectTemplate = base.snapshot.data.projects[0]!;
  const sessionTemplate = base.snapshot.data.sessions[0]!;
  const turnTemplates = base.snapshot.data.turns.slice(0, 4);
  const project = {
    ...projectTemplate,
    project_id: "project:interleaved",
    project_revision_id: "project:interleaved:r1",
    display_name: "Interleaved project",
    slug: "interleaved-project",
    committed_turn_count: 4,
    candidate_turn_count: 0,
    session_count: 2,
    project_last_activity_at: "2026-01-04T00:00:00.000Z",
    updated_at: "2026-01-04T00:00:00.000Z",
  };
  const sessions = [
    {
      ...sessionTemplate,
      id: "sess:codex:interleaved-alpha",
      source_session_id: "interleaved-alpha",
      title: "Alpha session",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-04T00:00:00.000Z",
      turn_count: 2,
      primary_project_id: project.project_id,
    },
    {
      ...sessionTemplate,
      id: "sess:codex:interleaved-beta",
      source_session_id: "interleaved-beta",
      title: "Beta session",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-03T00:00:00.000Z",
      turn_count: 2,
      primary_project_id: project.project_id,
    },
  ];
  const turnSpecs = [
    [0, sessions[0]!, "2026-01-04T00:00:00.000Z", "Alpha first ask"],
    [1, sessions[1]!, "2026-01-03T00:00:00.000Z", "Beta first ask"],
    [2, sessions[0]!, "2026-01-02T00:00:00.000Z", "Alpha second ask"],
    [3, sessions[1]!, "2026-01-01T00:00:00.000Z", "Beta second ask"],
  ] as const;
  const turns = turnSpecs.map(([templateIndex, session, timestamp, prompt], index) => {
    const template = turnTemplates[templateIndex]!;
    return {
      ...template,
      id: `turn:interleaved:${index}`,
      revision_id: `turn:interleaved:${index}:r1`,
      turn_id: `turn:interleaved:${index}`,
      turn_revision_id: `turn:interleaved:${index}:r1`,
      raw_text: prompt,
      canonical_text: prompt,
      created_at: timestamp,
      submission_started_at: timestamp,
      last_context_activity_at: timestamp,
      session_id: session.id,
      source_id: source.id,
      project_id: project.project_id,
      project_ref: project.slug,
      link_state: "committed" as const,
      project_link_state: "committed" as const,
    };
  });
  const snapshot = new LiveHistorySnapshot({
    ...base.snapshot.data,
    sources: [source],
    projects: [project],
    sessions,
    turns,
    contexts: [],
    related_work: [],
    ask_user_question_turns: [],
    loss_audits: [],
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

test("scrollable pane reaches the last row at the bottom of the scroll range", () => {
  // viewport = maxLines - 1. With more rows than fit, scrolling to the bottom
  // (Number.MAX_SAFE_INTEGER is the established jump-to-last sentinel) must show
  // the final row rather than hiding it behind a phantom "more below" line.
  const rows = Array.from({ length: 15 }, (_, index) => `row${index}`);
  const bottom = renderScrollablePane(rows, "TITLE", 10, Number.MAX_SAFE_INTEGER);
  assert.equal(bottom.length, 10, "pane is exactly maxLines tall");
  assert.ok(bottom.some((line) => line.includes("row14")), "last row is reachable at the bottom");
  assert.ok(!bottom.some((line) => line.includes("↓")), "no phantom below-indicator at the bottom");

  // A middle offset still shows both indicators and a contiguous run of rows.
  const middle = renderScrollablePane(rows, "TITLE", 10, 3);
  assert.ok(middle.some((line) => line.includes("↑")), "above-indicator shown mid-scroll");
  assert.ok(middle.some((line) => line.includes("↓")), "below-indicator shown mid-scroll");
  assert.ok(!middle.some((line) => line.includes("row0")), "scrolled past the first row");
});

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

test("the browser preserves canonical session order without a surface-specific sort", async () => {
  const model = await buildModel();
  assert.deepEqual(
    model.sessions.map((entry) => entry.session.id),
    model.snapshot.listResolvedSessions().map((session) => session.id),
  );
});

test("resumable session detail shows one complete green command without a duplicate workspace", async () => {
  const model = await buildModel();
  const resumable = model.sessions.find((entry) => entry.session.resume_command);
  assert.ok(resumable?.session.resume_command);
  const state = apply(
    model,
    createLiteBrowserState(model),
    { type: "open-session-ref", ref: resumable.session.id },
    { type: "focus-detail" },
  );

  const previousForceColor = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "1";
  configureColorPolicy({ color: true });
  try {
    const output = frame(model, state, 150, 46);
    const plain = stripAnsi(output).replace(/\s+/gu, " ");
    assert.ok(plain.includes(resumable.session.resume_command));
    assert.doesNotMatch(plain, /Workspace:/);
    assert.match(output, /\u001b\[32mcd /u);
  } finally {
    if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = previousForceColor;
    configureColorPolicy({ color: false });
  }
});

test("turn headers keep the full visible session count when sessions interleave", async () => {
  const model = buildInterleavedModel(await buildModel());
  const state = apply(model, createLiteBrowserState(model), { type: "focus-turns" });
  const groups = buildTurnDisplayGroups(getVisibleTurns(model, state));
  assert.deepEqual(
    groups.map((group) => [group.title, group.visibleTurnCount, group.turnIndices]),
    [
      ["Alpha session", 2, [0]],
      ["Beta session", 2, [1]],
      ["Alpha session", 2, [2]],
      ["Beta session", 2, [3]],
    ],
  );
  const output = frame(model, state, 130, 40);

  assert.equal((output.match(/Session: Alpha session/g) ?? []).length, 2);
  assert.equal((output.match(/Session: Beta session/g) ?? []).length, 2);
  assert.match(output, /Session: Alpha session 2a/);
  assert.match(output, /Session: Beta session 2a/);
  for (const prompt of ["Alpha first ask", "Beta first ask", "Alpha second ask", "Beta second ask"]) {
    assert.match(output, new RegExp(prompt));
  }

  const searchState = apply(model, createLiteBrowserState(model), { type: "open-search", query: "ask" });
  const searchOutput = frame(model, searchState, 130, 40);
  assert.match(searchOutput, /Session: Alpha session 2a/);
  assert.match(searchOutput, /Session: Beta session 2a/);
});

test("the sessions scope disambiguates duplicate session titles with stable native refs", async () => {
  const model = await buildModel(claudeRoot, "claude_code");
  const byTitle = new Map<string, typeof model.sessions>();
  for (const entry of model.sessions) {
    const title = entry.session.title ?? entry.session.source_session_id ?? entry.session.id;
    const group = byTitle.get(title);
    if (group) group.push(entry);
    else byTitle.set(title, [entry]);
  }
  const duplicate = [...byTitle.values()].find((group) => group.length > 1);
  assert.ok(duplicate, "fixture must contain duplicate session titles");
  const labels = buildSessionDisplayLabels(duplicate.map((entry) => entry.session));
  assert.equal(new Set(duplicate.map((entry) => labels.get(entry.session.id))).size, duplicate.length);

  const state = apply(model, createLiteBrowserState(model), { type: "set-browse-scope", scope: "sessions" });
  const output = frame(model, state, 130, 40);
  for (const entry of duplicate) {
    const nativeRef = entry.session.source_session_id ?? entry.session.id;
    assert.ok(output.includes(nativeRef.slice(0, 8)), `missing stable ref for ${entry.session.id}`);
  }
});

test("session detail resolves the project from the selected turn", async () => {
  const model = await buildMultiSourceModel();
  const selectedProject = model.projects[0];
  assert.ok(selectedProject);
  const targetIndex = model.sessions.findIndex((entry) =>
    entry.turns.some((turn) => turn.turn.project_id && turn.turn.project_id !== selectedProject.key),
  );
  assert.ok(targetIndex >= 0, "fixture must contain a session from another project");
  const target = model.sessions[targetIndex]!;
  const targetTurn = target.turns[0]!;
  const targetProjectName = model.snapshot.getProject(targetTurn.turn.project_id ?? "")?.display_name;
  assert.ok(targetProjectName);

  let state = apply(model, createLiteBrowserState(model), { type: "set-browse-scope", scope: "sessions" });
  for (let index = 0; index < targetIndex; index += 1) {
    state = apply(model, state, { type: "move-down" });
  }
  state = apply(model, state, { type: "focus-detail" });
  const output = frame(model, state, 130, 40);
  const askLine = output.split("\n").find((line) => line.includes("Ask 1/"));
  assert.ok(askLine, "selected session turn detail is missing");
  assert.ok(askLine.includes(`in ${targetProjectName}`), `detail used the wrong project label: ${askLine}`);
});

test("the full adapter matrix preserves identity through every browser scope", async () => {
  const model = await buildFixtureMatrixModel();
  const snapshotTurnIds = new Set(model.snapshot.listResolvedTurns().map((turn) => turn.id));
  const sessionTurnIds = new Set<string>();
  const projectTurnIds = new Set<string>();

  for (const entry of model.sessions) {
    assert.equal(entry.turns.length, entry.session.turn_count, `session count drift for ${entry.session.id}`);
    for (const turn of entry.turns) {
      assert.equal(turn.turn.session_id, entry.session.id);
      assert.equal(turn.session?.id, entry.session.id);
      sessionTurnIds.add(turn.turn.id);
    }
  }
  assert.deepEqual(sessionTurnIds, snapshotTurnIds, "every resolved turn must belong to exactly one session row");

  for (const entry of model.projects) {
    assert.equal(entry.turnCount, entry.turns.length, `project turn count drift for ${entry.key}`);
    assert.equal(
      entry.sessionCount,
      new Set(entry.turns.map((turn) => turn.turn.session_id)).size,
      `project session count drift for ${entry.key}`,
    );
    for (const turn of entry.turns) {
      if (entry.project) assert.equal(turn.turn.project_id, entry.key);
      else assert.equal(turn.turn.project_id, undefined);
      projectTurnIds.add(turn.turn.id);
    }
    const groups = buildTurnDisplayGroups(entry.turns);
    assert.deepEqual(
      groups.flatMap((group) => group.turnIndices).sort((left, right) => left - right),
      Array.from({ length: entry.turns.length }, (_, index) => index),
      `turn display groups dropped or duplicated a turn for ${entry.key}`,
    );
  }
  assert.deepEqual(projectTurnIds, snapshotTurnIds, "every resolved turn must belong to exactly one project bucket");

  let sessionState = apply(model, createLiteBrowserState(model), { type: "set-browse-scope", scope: "sessions" });
  for (const [index, entry] of model.sessions.entries()) {
    if (index > 0) sessionState = apply(model, sessionState, { type: "move-down" });
    assert.deepEqual(
      getVisibleTurns(model, sessionState).map((turn) => turn.turn.id),
      entry.turns.map((turn) => turn.turn.id),
      `session scope selected the wrong turns for ${entry.session.id}`,
    );
  }

  let projectState = createLiteBrowserState(model);
  for (const [index, entry] of model.projects.entries()) {
    if (index > 0) projectState = apply(model, projectState, { type: "move-down" });
    assert.deepEqual(
      getVisibleTurns(model, projectState).map((turn) => turn.turn.id),
      entry.turns.map((turn) => turn.turn.id),
      `project scope selected the wrong turns for ${entry.key}`,
    );
  }
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

test("projection integrity warnings stay visible instead of failing silently", async () => {
  const base = await buildModel();
  assert.deepEqual(base.snapshot.projectionIssues, []);
  const target = base.snapshot.data.sessions[0]!;
  const snapshot = new LiveHistorySnapshot({
    ...base.snapshot.data,
    sessions: base.snapshot.data.sessions.map((session) =>
      session.id === target.id ? { ...session, turn_count: session.turn_count + 1 } : session,
    ),
  });
  const model = new LiteBrowserModel(snapshot);
  assert.equal(model.snapshot.projectionIssues.length, 1);

  const state = apply(model, createLiteBrowserState(model), { type: "toggle-sources" });
  const output = frame(model, state);
  assert.match(output, /1 data warning/);
  assert.match(output, /Projection warnings: 1/);
  assert.match(output, /session sess:codex:/);
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
