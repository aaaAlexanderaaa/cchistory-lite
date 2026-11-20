/**
 * Key press → intent mapping for the Lite TUI.
 *
 * Deliberately the same keymap as the Full TUI (`apps/tui/src/input.ts`) so
 * muscle memory transfers between the two terminal surfaces. `r` (refresh) is
 * the only Lite-specific binding, because only Lite can rescan from disk.
 */

import type { LiteKey } from "./keys.js";
import type { LiteBrowserAction, LiteBrowserState } from "./state.js";

export type LiteInputEffect =
  | { type: "action"; action: LiteBrowserAction }
  | { type: "refresh" }
  | { type: "load-context" }
  | { type: "export-pricing"; destination: string }
  | { type: "copy-resume" }
  | { type: "copy-content" }
  | { type: "exit-print-resume" }
  | { type: "toggle-search-scope" }
  | { type: "exit" }
  | { type: "none" };

export function resolveLiteInputEffect(state: LiteBrowserState, key: LiteKey): LiteInputEffect {
  if (key.ctrl && (key.input === "c" || key.input === "d")) return { type: "exit" };

  if (state.overlay === "stats") {
    return resolveStatsInputEffect(state, key);
  }

  if (key.name === "escape") {
    if (state.overlay !== "none") return action({ type: "close-overlay" });
    return action({ type: "retreat" });
  }

  if (state.mode === "search" && state.overlay === "none" && key.ctrl && key.input === "f") {
    return { type: "toggle-search-scope" };
  }

  const editingSearch = state.mode === "search" && state.focusPane === "projects" && state.overlay === "none";
  if (editingSearch) {
    if (key.name === "backspace" || key.name === "delete") return action({ type: "backspace-search" });
    if (key.name === "return") return action({ type: "commit-search" });
    if (isPrintable(key)) return action({ type: "append-search-char", value: key.input });
    // Navigation keys fall through so the search list stays keyboard-drivable.
  }

  if (!editingSearch) {
    switch (key.input) {
      case "q":
        return { type: "exit" };
      case "?":
        return action({ type: "toggle-help" });
      case "/":
        return action({ type: "enter-search-mode" });
      case "s":
        return action({ type: "toggle-sources" });
      case "i":
        return action({ type: "toggle-stats" });
      case "r":
        return { type: "refresh" };
      case "y":
        return state.overlay === "none" ? { type: "copy-resume" } : { type: "none" };
      case "Y":
        return state.overlay === "none" ? { type: "copy-content" } : { type: "none" };
      case "R":
        return state.overlay === "none" ? { type: "exit-print-resume" } : { type: "none" };
      case "p":
        return action({ type: "set-browse-scope", scope: "projects" });
      case "S":
        return action({ type: "set-browse-scope", scope: "sessions" });
      case "t":
        return action({ type: "focus-turns" });
      case "d":
        return action({ type: "focus-detail" });
      case "g":
        return action({ type: key.shift ? "jump-last" : "jump-first" });
      case "G":
        return action({ type: "jump-last" });
      default:
        break;
    }
  }

  if (key.name === "tab") {
    return action({ type: key.shift ? "focus-previous" : "focus-next" });
  }
  if (key.name === "right" && !editingSearch) return action({ type: "focus-next" });
  if (key.name === "left" && !editingSearch) return action({ type: "focus-previous" });
  if (key.name === "pageup") return action({ type: "page-up" });
  if (key.name === "pagedown") return action({ type: "page-down" });
  if (key.name === "home") return action({ type: "jump-first" });
  if (key.name === "end") return action({ type: "jump-last" });
  if (key.name === "down" || key.input === "j") return action({ type: "move-down" });
  if (key.name === "up" || key.input === "k") return action({ type: "move-up" });
  if (key.name === "return") {
    // Entering the conversation view needs the session's full context, which a
    // context-light snapshot does not carry yet.
    if (state.focusPane === "detail" && state.overlay === "none") return { type: "load-context" };
    return action({ type: "drill" });
  }

  return { type: "none" };
}

function resolveStatsInputEffect(state: LiteBrowserState, key: LiteKey): LiteInputEffect {
  const stats = state.stats;
  if (stats.editing) {
    if (key.name === "escape") return action({ type: "stats-edit-cancel" });
    if (key.name === "return") {
      if (stats.editing.target === "export_path") {
        const destination = stats.editing.value.trim() || stats.editing.placeholder || "./cchistory-pricing.json";
        return { type: "export-pricing", destination };
      }
      return action({ type: "stats-edit-commit" });
    }
    if (key.name === "backspace" || key.name === "delete") return action({ type: "stats-edit-backspace" });
    if (isPrintable(key)) return action({ type: "stats-edit-char", char: key.input });
    return { type: "none" };
  }

  if (key.name === "escape") {
    if (stats.view !== "quad") return action({ type: "stats-set-view", view: "quad" });
    return action({ type: "close-overlay" });
  }
  if (key.name === "tab") {
    if (stats.view === "quad") {
      return action(key.shift ? { type: "stats-cycle-quadrant", reverse: true } : { type: "cycle-stats-dimension" });
    }
    if (stats.view === "multipliers") {
      return action({ type: "stats-multiplier-col", delta: key.shift ? -1 : 1 });
    }
    return action({ type: "stats-cycle-sort" });
  }
  if (key.name === "up" || key.input === "k") return action({ type: "stats-move", delta: -1 });
  if (key.name === "down" || key.input === "j") return action({ type: "stats-move", delta: 1 });
  if (key.name === "pageup") return action({ type: "stats-move", delta: -10 });
  if (key.name === "pagedown") return action({ type: "stats-move", delta: 10 });
  if (key.name === "home" || (key.input === "g" && stats.view !== "matrix")) {
    return action({ type: "stats-jump", edge: "first" });
  }
  if (key.name === "end" || key.input === "G") return action({ type: "stats-jump", edge: "last" });

  if (stats.view === "matrix") {
    if (key.input === "g") return action({ type: "stats-cycle-matrix-group" });
    if (key.name === "left" || key.input === "h") return action({ type: "stats-matrix-col-page", delta: -1 });
    if (key.name === "right" || key.input === "l") return action({ type: "stats-matrix-col-page", delta: 1 });
  }

  if (stats.view === "multipliers") {
    if (key.name === "left" || key.input === "h") return action({ type: "stats-multiplier-col", delta: -1 });
    if (key.name === "right" || key.input === "l") return action({ type: "stats-multiplier-col", delta: 1 });
    switch (key.input) {
      case "+":
      case "=":
      case "]":
        return action({ type: "stats-multiplier-step", delta: 0.1 });
      case "-":
      case "_":
      case "[":
        return action({ type: "stats-multiplier-step", delta: -0.1 });
      case "0":
        return action({ type: "stats-multiplier-set", value: 0 });
      case "1":
        return action({ type: "stats-multiplier-set", value: 1 });
      case "u":
        return action({ type: "stats-multiplier-toggle-zero" });
      case "a":
        return action({ type: "stats-start-edit", target: "alias" });
      case "e":
        return action({ type: "stats-start-edit", target: "multiplier" });
      case "R":
        return action({ type: "stats-reset-overrides" });
      default:
        break;
    }
  } else if (stats.view !== "matrix") {
    if (key.name === "left" || key.input === "h") return action({ type: "stats-cycle-quadrant", reverse: true });
    if (key.name === "right" || key.input === "l") return action({ type: "cycle-stats-dimension" });
    if ((key.input === " " || key.name === "return") && stats.view === "quad") {
      return action({ type: "stats-toggle-selection" });
    }
    if (key.name === "return" && stats.view === "sessions") {
      return action({ type: "open-stats-session" });
    }
    switch (key.input) {
      case "1":
        return action({ type: "stats-focus-quadrant", quadrant: "project" });
      case "2":
        return action({ type: "stats-focus-quadrant", quadrant: "model" });
      case "3":
        return action({ type: "stats-focus-quadrant", quadrant: "source" });
      case "4":
        return action({ type: "stats-focus-quadrant", quadrant: "day" });
      default:
        break;
    }
  }

  switch (key.input) {
    case "q":
      return { type: "exit" };
    case "i":
      return action({ type: "toggle-stats" });
    case "s":
      return action({ type: "toggle-sources" });
    case "?":
      return action({ type: "toggle-help" });
    case "r":
      return { type: "refresh" };
    case "v":
      return action({ type: "stats-toggle-view", view: "matrix" });
    case "S":
      return action({ type: "stats-toggle-view", view: "sessions" });
    case "m":
      return action({ type: "stats-toggle-view", view: "multipliers" });
    case "E":
      return action({ type: "stats-start-edit", target: "export_path" });
    case "t":
      return action({ type: "stats-cycle-time-preset" });
    case "b":
      return action({ type: "stats-cycle-time-bucket" });
    case "w":
      return action({ type: "stats-cycle-week-mode" });
    case "o":
      return action({ type: "stats-cycle-sort" });
    case "c":
      return action({ type: "stats-clear-filters" });
    case "$":
      return action({ type: "stats-start-edit", target: "quota" });
    default:
      return { type: "none" };
  }
}

function action(value: LiteBrowserAction): LiteInputEffect {
  return { type: "action", action: value };
}

function isPrintable(key: LiteKey): boolean {
  if (key.input.length === 0 || key.ctrl || key.name !== undefined) return false;
  // Multi-byte input from a CJK IME arrives as one composed string. A control
  // byte (a stray ESC, etc.) is never text to type into the query.
  return !CONTROL_CHARACTER.test(key.input);
}

const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/u;
