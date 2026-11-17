import path from "node:path";
import { existsSync } from "node:fs";
import type { PlatformAdapter } from "./types.js";

export const codexAdapter: PlatformAdapter = {
  platform: "codex",
  supportTier: "stable",
  sessionTargeting: "file",
  projectionBoundary: "logical_session",
  getDefaultBaseDirCandidates: (options) => {
    const home = path.join(options.homeDir ?? "", ".codex");
    return (options.pathExists ?? existsSync)(path.join(home, "archived_sessions"))
      ? [home] : [path.join(home, "sessions")];
  },
  getSourceRoots: (baseDir) => {
    const roots = ["sessions", "archived_sessions"].map(name => path.join(baseDir, name)).filter(existsSync);
    return roots.length ? roots : [baseDir];
  },
  filterSourceFiles: (files, baseDir) => {
    const paths = new Set(files);
    const prefix = `archived_sessions${path.sep}`;
    return files.filter(file => {
      const relative = path.relative(baseDir, file);
      return !relative.startsWith(prefix) || !paths.has(path.join(baseDir, "sessions", relative.slice(prefix.length)));
    });
  },
  matchesSourceFile: (filePath) => {
    const base = path.basename(filePath);
    if (base === "history.jsonl" || base === "session.jsonl") return false;
    return filePath.endsWith(".jsonl") || filePath.endsWith(".json");
  },
};
