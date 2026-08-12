import path from "node:path";
import type { PlatformAdapter } from "./types.js";

export const factoryDroidAdapter: PlatformAdapter = {
  platform: "factory_droid",
  supportTier: "stable",
  sessionTargeting: "file",
  projectionBoundary: "source",
  getDefaultBaseDirCandidates: (options) => [path.join(options.homeDir ?? "", ".factory", "sessions")],
  matchesSourceFile: (filePath) => filePath.endsWith(".jsonl"),
};
