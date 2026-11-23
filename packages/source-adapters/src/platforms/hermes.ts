import path from "node:path";
import type { PlatformAdapter } from "./types.js";

/**
 * Hermes Agent keeps one SQLite store per profile: `$HERMES_HOME/state.db`
 * (default `~/.hermes/state.db` on macOS/Linux, `%LOCALAPPDATA%/hermes` on
 * Windows). Named profiles live under `<root>/profiles/<name>/state.db`, which
 * the directory walk reaches from the root.
 */
export const hermesAdapter: PlatformAdapter = {
  platform: "hermes",
  supportTier: "experimental",
  // One store holds every session, so a targeted read filters rows rather than
  // selecting a single native file.
  sessionTargeting: "container",
  projectionBoundary: "source",
  getDefaultBaseDirCandidates: (options) => {
    const env = options.env ?? process.env;
    const candidates: string[] = [];
    const hermesHome = env.HERMES_HOME?.trim();
    if (hermesHome) {
      candidates.push(hermesHome);
    }
    if (options.homeDir) {
      candidates.push(path.join(options.homeDir, ".hermes"));
    }
    const appDataDir = options.appDataDir ?? env.LOCALAPPDATA ?? env.APPDATA;
    if (appDataDir) {
      candidates.push(path.join(appDataDir, "hermes"));
    }
    return candidates;
  },
  matchesSourceFile: (filePath) => path.basename(filePath) === "state.db",
  getSourceRoots: (baseDir) => {
    if (path.basename(baseDir) === "state.db") {
      return [path.dirname(baseDir)];
    }
    return [baseDir];
  },
  filterSourceFiles: (files) => {
    const unique = new Set(files.filter((filePath) => path.basename(filePath) === "state.db"));
    return [...unique].sort((left, right) => left.localeCompare(right));
  },
  getSourceFilePriority: (filePath) => {
    // A profile store is a narrower scope than the default profile; scanning
    // the default store first keeps stable ordering for fixtures and reports.
    return path.dirname(filePath).includes(`${path.sep}profiles${path.sep}`) ? 1 : 0;
  },
};
