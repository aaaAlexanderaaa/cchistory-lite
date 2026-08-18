import path from "node:path";
import type { PlatformAdapter } from "./types.js";

export function isCursorAgentTranscriptPath(filePath: string): boolean {
  return filePath.endsWith(".jsonl") && filePath.includes(`${path.sep}agent-transcripts${path.sep}`);
}

export const cursorAgentAdapter: PlatformAdapter = {
  platform: "cursor_agent",
  supportTier: "experimental",
  sessionTargeting: "file",
  projectionBoundary: "source",
  getDefaultBaseDirCandidates: (options) => [path.join(options.homeDir ?? "", ".cursor", "projects")],
  matchesSourceFile: (filePath) => isCursorAgentTranscriptPath(filePath),
  getSourceFilePriority: () => 0,
};
