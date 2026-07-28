/**
 * Pure state machine for the Lite TUI.
 *
 * Mirrors the Full TUI's reducer shape (`apps/tui/src/browser.ts`) so both
 * terminal surfaces navigate identically: same panes, same focus order, same
 * drill/retreat semantics. Nothing here touches the terminal, so every
 * interaction is testable without a TTY.
 */

import type { TurnSearchResult } from "@cchistory/domain";
import {
  LiteBrowserModel,
  type LiteProjectEntry,
  type LiteSessionEntry,
  type LiteTurnEntry,
} from "./model.js";

export type LiteFocusPane = "projects" | "turns" | "detail" | "conversation";
/** What the left pane lists: linked projects, or every raw session. */
export type LiteBrowseScope = "projects" | "sessions";
export type LiteMode = "browse" | "search";
export type LiteOverlay = "none" | "help" | "stats" | "sources";
export type LiteStatsDimension = "source" | "project" | "model" | "day";

export const STATS_DIMENSIONS: readonly LiteStatsDimension[] = ["source", "project", "model", "day"];

/** Queries shorter than this need an explicit Enter before they run. */
const SEARCH_AUTO_COMMIT_LENGTH = 4;
const PAGE_STEP = 15;

export interface LiteStatusMessage {
  kind: "info" | "busy" | "error";
  text: string;
}

export interface LiteBrowserState {
  mode: LiteMode;
  browseScope: LiteBrowseScope;
  focusPane: LiteFocusPane;
  overlay: LiteOverlay;
  statsDimension: LiteStatsDimension;
  selectedProjectIndex: number;
  selectedSessionIndex: number;
  selectedTurnIndex: number;
  selectedSearchGroupIndex: number;
  selectedSearchTurnIndex: number;
  searchQuery: string;
  searchCommitted: boolean;
  detailScrollOffset: number;
  conversationScrollOffset: number;
  overlayScrollOffset: number;
  status?: LiteStatusMessage;
}

export type LiteBrowserAction =
  | { type: "focus-next" }
  | { type: "focus-previous" }
  | { type: "focus-projects" }
  | { type: "focus-turns" }
  | { type: "focus-detail" }
  | { type: "set-browse-scope"; scope: LiteBrowseScope }
  | { type: "move-up" }
  | { type: "move-down" }
  | { type: "page-up" }
  | { type: "page-down" }
  | { type: "jump-first" }
  | { type: "jump-last" }
  | { type: "drill" }
  | { type: "retreat" }
  | { type: "enter-search-mode" }
  | { type: "exit-search-mode" }
  | { type: "append-search-char"; value: string }
  | { type: "backspace-search" }
  | { type: "commit-search" }
  | { type: "toggle-help" }
  | { type: "toggle-stats" }
  | { type: "toggle-sources" }
  | { type: "close-overlay" }
  | { type: "cycle-stats-dimension" }
  | { type: "set-status"; status: LiteStatusMessage }
  | { type: "clear-status" }
  | { type: "open-project-ref"; ref: string }
  | { type: "open-session-ref"; ref: string }
  | { type: "open-turn-ref"; ref: string }
  | { type: "open-search"; query: string };

export interface LiteSearchGroup {
  projectKey: string;
  projectName: string;
  results: TurnSearchResult[];
}

export function createLiteBrowserState(model: LiteBrowserModel): LiteBrowserState {
  return clampState(
    {
      mode: "browse",
      browseScope: "projects",
      focusPane: "projects",
      overlay: "none",
      statsDimension: "source",
      selectedProjectIndex: 0,
      selectedSessionIndex: 0,
      selectedTurnIndex: 0,
      selectedSearchGroupIndex: 0,
      selectedSearchTurnIndex: 0,
      searchQuery: "",
      searchCommitted: false,
      detailScrollOffset: 0,
      conversationScrollOffset: 0,
      overlayScrollOffset: 0,
    },
    model,
  );
}

const FOCUS_ORDER: readonly LiteFocusPane[] = ["projects", "turns", "detail"];

export function reduceLiteBrowserState(
  model: LiteBrowserModel,
  state: LiteBrowserState,
  action: LiteBrowserAction,
): LiteBrowserState {
  switch (action.type) {
    case "focus-next":
    case "focus-previous": {
      if (state.focusPane === "conversation") return state;
      const delta = action.type === "focus-next" ? 1 : FOCUS_ORDER.length - 1;
      const index = (FOCUS_ORDER.indexOf(state.focusPane) + delta) % FOCUS_ORDER.length;
      return { ...state, focusPane: FOCUS_ORDER[index] ?? "projects" };
    }
    case "focus-projects":
      return { ...state, focusPane: "projects" };
    case "set-browse-scope":
      if (state.browseScope === action.scope && state.mode === "browse") {
        return { ...state, focusPane: "projects" };
      }
      return clampState(
        {
          ...state,
          mode: "browse",
          browseScope: action.scope,
          focusPane: "projects",
          overlay: "none",
          selectedTurnIndex: 0,
          detailScrollOffset: 0,
          conversationScrollOffset: 0,
        },
        model,
      );
    case "focus-turns":
      return { ...state, focusPane: "turns" };
    case "focus-detail":
      return { ...state, focusPane: state.focusPane === "conversation" ? "conversation" : "detail" };

    case "move-up":
      return move(model, state, -1);
    case "move-down":
      return move(model, state, 1);
    case "page-up":
      return move(model, state, -PAGE_STEP);
    case "page-down":
      return move(model, state, PAGE_STEP);
    case "jump-first":
      return jump(model, state, "first");
    case "jump-last":
      return jump(model, state, "last");

    case "drill":
      if (state.overlay !== "none") return state;
      if (state.focusPane === "projects") return { ...state, focusPane: "turns" };
      if (state.focusPane === "turns") return { ...state, focusPane: "detail", detailScrollOffset: 0 };
      if (state.focusPane === "detail") return { ...state, focusPane: "conversation", conversationScrollOffset: 0 };
      return state;
    case "retreat":
      if (state.overlay !== "none") return { ...state, overlay: "none", overlayScrollOffset: 0 };
      if (state.focusPane === "conversation") return { ...state, focusPane: "detail" };
      if (state.focusPane === "detail") return { ...state, focusPane: "turns" };
      if (state.focusPane === "turns") return { ...state, focusPane: "projects" };
      if (state.mode === "search") {
        return clampState({ ...state, mode: "browse", focusPane: "projects" }, model);
      }
      return state;

    case "enter-search-mode":
      return clampState(
        { ...state, ...resetSearchSelection(state), mode: "search", focusPane: "projects", overlay: "none", searchCommitted: false },
        model,
      );
    case "exit-search-mode":
      return clampState({ ...state, mode: "browse", focusPane: "projects" }, model);
    case "commit-search":
      return clampState({ ...state, ...resetSearchSelection(state), searchCommitted: true }, model);
    case "append-search-char":
      return applySearchQuery(model, state, `${state.searchQuery}${action.value}`);
    case "backspace-search":
      return applySearchQuery(model, state, state.searchQuery.slice(0, Math.max(state.searchQuery.length - 1, 0)));
    case "open-search":
      return applySearchQuery(model, { ...state, mode: "search", focusPane: "projects" }, action.query, true);

    case "toggle-help":
      return toggleOverlay(state, "help");
    case "toggle-stats":
      return toggleOverlay(state, "stats");
    case "toggle-sources":
      return toggleOverlay(state, "sources");
    case "close-overlay":
      return { ...state, overlay: "none", overlayScrollOffset: 0 };
    case "cycle-stats-dimension": {
      const index = STATS_DIMENSIONS.indexOf(state.statsDimension);
      return {
        ...state,
        statsDimension: STATS_DIMENSIONS[(index + 1) % STATS_DIMENSIONS.length] ?? "source",
        overlayScrollOffset: 0,
      };
    }

    case "set-status":
      return { ...state, status: action.status };
    case "clear-status":
      return { ...state, status: undefined };

    case "open-project-ref":
      return openProjectRef(model, state, action.ref);
    case "open-session-ref":
      return openSessionRef(model, state, action.ref);
    case "open-turn-ref":
      return openTurnRef(model, state, action.ref);
  }
}

function toggleOverlay(state: LiteBrowserState, overlay: Exclude<LiteOverlay, "none">): LiteBrowserState {
  return {
    ...state,
    overlay: state.overlay === overlay ? "none" : overlay,
    overlayScrollOffset: 0,
  };
}

function resetSearchSelection(state: LiteBrowserState): Partial<LiteBrowserState> {
  return {
    selectedSearchGroupIndex: 0,
    selectedSearchTurnIndex: 0,
    detailScrollOffset: 0,
    conversationScrollOffset: 0,
    status: state.status?.kind === "error" ? undefined : state.status,
  };
}

function applySearchQuery(
  model: LiteBrowserModel,
  state: LiteBrowserState,
  query: string,
  forceCommit = false,
): LiteBrowserState {
  return clampState(
    {
      ...state,
      ...resetSearchSelection(state),
      mode: "search",
      focusPane: "projects",
      overlay: "none",
      searchQuery: query,
      // A manual commit (Enter, or --search) is sticky: keep running the search
      // while the user refines a short query, instead of blanking it the moment
      // the length drops back below the auto-commit threshold. The length-based
      // gate lives in `shouldRunSearch`, so this flag only tracks explicit commits.
      searchCommitted: forceCommit || state.searchCommitted,
    },
    model,
  );
}

// ── Derived selectors ──

export function shouldRunSearch(state: LiteBrowserState): boolean {
  if (state.mode !== "search") return false;
  if (state.searchQuery.length === 0) return false;
  return state.searchCommitted || state.searchQuery.length >= SEARCH_AUTO_COMMIT_LENGTH;
}

export function getSearchGroups(model: LiteBrowserModel, state: LiteBrowserState): LiteSearchGroup[] {
  if (!shouldRunSearch(state)) return [];
  const groups: LiteSearchGroup[] = [];
  const byKey = new Map<string, LiteSearchGroup>();
  for (const result of model.searchAll(state.searchQuery).results) {
    const key = result.project?.project_id ?? "__unlinked__";
    let group = byKey.get(key);
    if (!group) {
      group = { projectKey: key, projectName: result.project?.display_name ?? "Unlinked", results: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.results.push(result);
  }
  return groups;
}

export function getSearchTotal(model: LiteBrowserModel, state: LiteBrowserState): number {
  return shouldRunSearch(state) ? model.searchAll(state.searchQuery).total : 0;
}

export function getSelectedProject(
  model: LiteBrowserModel,
  state: LiteBrowserState,
): LiteProjectEntry | undefined {
  return model.projects[state.selectedProjectIndex];
}

export function getSelectedSession(
  model: LiteBrowserModel,
  state: LiteBrowserState,
): LiteSessionEntry | undefined {
  return model.sessions[state.selectedSessionIndex];
}

/** The left pane's current rows, whichever scope is active. */
export function getScopeLength(model: LiteBrowserModel, state: LiteBrowserState): number {
  return state.browseScope === "sessions" ? model.sessions.length : model.projects.length;
}

export function getVisibleTurns(model: LiteBrowserModel, state: LiteBrowserState): LiteTurnEntry[] {
  if (state.mode === "search") {
    const group = getSearchGroups(model, state)[state.selectedSearchGroupIndex];
    if (!group) return [];
    return group.results.map((result) => ({ turn: result.turn, session: result.session }));
  }
  if (state.browseScope === "sessions") return getSelectedSession(model, state)?.turns ?? [];
  return getSelectedProject(model, state)?.turns ?? [];
}

export function getSelectedTurn(
  model: LiteBrowserModel,
  state: LiteBrowserState,
): LiteTurnEntry | undefined {
  const index = state.mode === "search" ? state.selectedSearchTurnIndex : state.selectedTurnIndex;
  return getVisibleTurns(model, state)[index];
}

/** Every turn of the selected turn's session, for the conversation view. */
export function getSelectedSessionTurns(
  model: LiteBrowserModel,
  state: LiteBrowserState,
): LiteTurnEntry[] {
  const selected = getSelectedTurn(model, state);
  if (!selected) return [];
  const sessionTurns = model.listSessionTurns(selected.turn.session_id);
  return sessionTurns.length > 0 ? sessionTurns : [selected];
}

// ── Movement ──

function move(model: LiteBrowserModel, state: LiteBrowserState, delta: number): LiteBrowserState {
  if (state.overlay !== "none") {
    return { ...state, overlayScrollOffset: Math.max(0, state.overlayScrollOffset + delta) };
  }
  if (state.focusPane === "conversation") {
    return { ...state, conversationScrollOffset: Math.max(0, state.conversationScrollOffset + delta) };
  }
  if (state.focusPane === "detail") {
    return { ...state, detailScrollOffset: Math.max(0, state.detailScrollOffset + delta) };
  }
  if (state.focusPane === "projects") {
    if (state.mode === "search") {
      return clampState(
        { ...state, selectedSearchGroupIndex: state.selectedSearchGroupIndex + delta, selectedSearchTurnIndex: 0, detailScrollOffset: 0 },
        model,
      );
    }
    const scopeKey = state.browseScope === "sessions" ? "selectedSessionIndex" : "selectedProjectIndex";
    return clampState(
      { ...state, [scopeKey]: state[scopeKey] + delta, selectedTurnIndex: 0, detailScrollOffset: 0 },
      model,
    );
  }
  const key = state.mode === "search" ? "selectedSearchTurnIndex" : "selectedTurnIndex";
  return clampState({ ...state, [key]: state[key] + delta, detailScrollOffset: 0, conversationScrollOffset: 0 }, model);
}

function jump(model: LiteBrowserModel, state: LiteBrowserState, target: "first" | "last"): LiteBrowserState {
  // A "jump to last" on a scroll pane stores MAX_SAFE_INTEGER as a bottom
  // sentinel: the reducer has no terminal dimensions, so it cannot know the
  // real maximum. The runtime reconciles this against the rendered content
  // height on each paint (see reconcileScrollOffsets in render.ts), which
  // rewrites the stored offset to the true maximum so scrolling back up works.
  const last = Number.MAX_SAFE_INTEGER;
  if (state.overlay !== "none") {
    return { ...state, overlayScrollOffset: target === "first" ? 0 : last };
  }
  if (state.focusPane === "conversation") {
    return { ...state, conversationScrollOffset: target === "first" ? 0 : last };
  }
  if (state.focusPane === "detail") {
    return { ...state, detailScrollOffset: target === "first" ? 0 : last };
  }
  const value = target === "first" ? 0 : last;
  if (state.focusPane === "projects") {
    if (state.mode === "search") {
      return clampState({ ...state, selectedSearchGroupIndex: value, selectedSearchTurnIndex: 0, detailScrollOffset: 0 }, model);
    }
    const scopeKey = state.browseScope === "sessions" ? "selectedSessionIndex" : "selectedProjectIndex";
    return clampState({ ...state, [scopeKey]: value, selectedTurnIndex: 0, detailScrollOffset: 0 }, model);
  }
  const key = state.mode === "search" ? "selectedSearchTurnIndex" : "selectedTurnIndex";
  return clampState({ ...state, [key]: value, detailScrollOffset: 0, conversationScrollOffset: 0 }, model);
}

// ── Entry-point jumps (--project / --session / --turn) ──

function openProjectRef(model: LiteBrowserModel, state: LiteBrowserState, ref: string): LiteBrowserState {
  let project;
  try {
    project = model.snapshot.getProject(ref);
  } catch (error) {
    // A non-unique id prefix throws out of resolveUnique; surface it as an
    // in-app error rather than crashing startup.
    return withError(state, errorMessage(error));
  }
  const index = project
    ? model.projects.findIndex((entry) => entry.key === project.project_id)
    : model.projects.findIndex((entry) => matchesRef(entry.key, ref) || matchesRef(entry.displayName, ref));
  if (index < 0) {
    return withError(state, `Project not found: ${ref}.`);
  }
  return clampState(
    { ...state, mode: "browse", focusPane: "turns", selectedProjectIndex: index, selectedTurnIndex: 0, detailScrollOffset: 0 },
    model,
  );
}

function openSessionRef(model: LiteBrowserModel, state: LiteBrowserState, ref: string): LiteBrowserState {
  let session;
  try {
    session = model.snapshot.getSession(ref);
  } catch (error) {
    return withError(state, errorMessage(error));
  }
  if (!session) return withError(state, `Session not found: ${ref}.`);
  const index = model.sessions.findIndex((entry) => entry.session.id === session.id);
  if (index < 0) return withError(state, `Session is not in this snapshot: ${ref}.`);
  // Sessions scope, not project scope: a delegated session or automation run
  // can carry related work without deriving a single UserTurn.
  return clampState(
    {
      ...state,
      mode: "browse",
      browseScope: "sessions",
      focusPane: model.sessions[index]!.turns.length > 0 ? "turns" : "detail",
      selectedSessionIndex: index,
      selectedTurnIndex: 0,
      detailScrollOffset: 0,
      conversationScrollOffset: 0,
    },
    model,
  );
}

function openTurnRef(model: LiteBrowserModel, state: LiteBrowserState, ref: string): LiteBrowserState {
  let turn;
  try {
    turn = model.snapshot.getTurn(ref);
  } catch (error) {
    return withError(state, errorMessage(error));
  }
  if (!turn) return withError(state, `UserTurn not found: ${ref}.`);
  return focusTurn(model, state, turn.id, "detail");
}

function focusTurn(
  model: LiteBrowserModel,
  state: LiteBrowserState,
  turnId: string,
  focusPane: LiteFocusPane,
): LiteBrowserState {
  for (let projectIndex = 0; projectIndex < model.projects.length; projectIndex += 1) {
    const turnIndex = model.projects[projectIndex]!.turns.findIndex((entry) => entry.turn.id === turnId);
    if (turnIndex >= 0) {
      return clampState(
        {
          ...state,
          mode: "browse",
          focusPane,
          selectedProjectIndex: projectIndex,
          selectedTurnIndex: turnIndex,
          detailScrollOffset: 0,
          conversationScrollOffset: 0,
        },
        model,
      );
    }
  }
  return withError(state, `UserTurn is not reachable from any project: ${turnId}.`);
}

function withError(state: LiteBrowserState, text: string): LiteBrowserState {
  return { ...state, status: { kind: "error", text } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function matchesRef(candidate: string | undefined, ref: string): boolean {
  if (!candidate) return false;
  const left = candidate.toLowerCase();
  const right = ref.toLowerCase();
  if (left === right) return true;
  return ref.length >= 4 && left.startsWith(right);
}

// ── Clamping ──

export function clampState(state: LiteBrowserState, model: LiteBrowserModel): LiteBrowserState {
  const selectedProjectIndex = clampIndex(state.selectedProjectIndex, model.projects.length);
  const selectedSessionIndex = clampIndex(state.selectedSessionIndex, model.sessions.length);
  const turnCount = state.browseScope === "sessions"
    ? model.sessions[selectedSessionIndex]?.turns.length ?? 0
    : model.projects[selectedProjectIndex]?.turns.length ?? 0;

  const groups = getSearchGroups(model, state);
  const selectedSearchGroupIndex = clampIndex(state.selectedSearchGroupIndex, groups.length);
  const searchTurnCount = groups[selectedSearchGroupIndex]?.results.length ?? 0;

  return {
    ...state,
    selectedProjectIndex,
    selectedSessionIndex,
    selectedTurnIndex: clampIndex(state.selectedTurnIndex, turnCount),
    selectedSearchGroupIndex,
    selectedSearchTurnIndex: clampIndex(state.selectedSearchTurnIndex, searchTurnCount),
  };
}

function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(value, length - 1));
}
