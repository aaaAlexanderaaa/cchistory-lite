import path from "node:path";
import type { PlatformAdapter } from "./types.js";

export const ampAdapter: PlatformAdapter = {
  platform: "amp",
  supportTier: "stable",
  sessionTargeting: "file",
  projectionBoundary: "source",
  getDefaultBaseDirCandidates: (options) => [path.join(options.homeDir ?? "", ".local", "share", "amp", "threads")],
  matchesSourceFile: (filePath) => filePath.endsWith(".json"),
};
