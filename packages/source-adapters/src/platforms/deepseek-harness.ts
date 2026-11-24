import path from "node:path";
import type { PlatformAdapter } from "./types.js";

/**
 * DeepSeek Harness keeps one durability log per session under
 * `<root>/<project-dir>/<session-id>/`, named `session[.vN].jsonl` or
 * `session[.vN].jsonl.zstd` (current generation `v4`, Zstandard frames by
 * default). The file name carries the physical format version, so a source
 * root can retain several generations at once.
 */
const SESSION_FILE_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/u;

function readSessionFileVersion(filePath: string): number | undefined {
  const match = SESSION_FILE_NAME.exec(path.basename(filePath));
  if (!match) {
    return undefined;
  }
  return match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
}

function isCompressedSessionFile(filePath: string): boolean {
  return SESSION_FILE_NAME.exec(path.basename(filePath))?.[2] === ".zstd";
}

export const deepSeekHarnessAdapter: PlatformAdapter = {
  platform: "deepseek_harness",
  supportTier: "experimental",
  sessionTargeting: "file",
  // Parent `subagent/catalog` events reference child sessions stored in sibling
  // directories, so one source-wide projection is the conservative boundary.
  projectionBoundary: "source",
  getDefaultBaseDirCandidates: (options) => {
    const candidates: string[] = [];
    const env = options.env ?? process.env;
    const harnessHome = env.DSH_HOME?.trim();
    if (harnessHome) {
      candidates.push(path.join(harnessHome, "sessions"));
    }
    const homeDir = options.homeDir;
    if (homeDir) {
      candidates.push(path.join(homeDir, ".dsh", "sessions"));
    }
    return candidates;
  },
  matchesSourceFile: (filePath) => {
    if (readSessionFileVersion(filePath) === undefined) {
      return false;
    }
    // The layout always nests the log inside a session-owned directory; this
    // keeps unrelated `session*.jsonl` files outside a DSH root out of scope.
    return path.basename(path.dirname(filePath)).length > 0;
  },
  filterSourceFiles: (files) => {
    const bestBySessionDir = new Map<string, string>();
    for (const filePath of files) {
      const version = readSessionFileVersion(filePath);
      if (version === undefined) {
        continue;
      }
      const sessionDir = path.dirname(filePath);
      const existing = bestBySessionDir.get(sessionDir);
      if (!existing) {
        bestBySessionDir.set(sessionDir, filePath);
        continue;
      }
      const existingVersion = readSessionFileVersion(existing) ?? 0;
      // A retained older generation is superseded by the highest version; at
      // equal versions the configured (compressed) encoding wins.
      if (
        version > existingVersion ||
        (version === existingVersion && isCompressedSessionFile(filePath) && !isCompressedSessionFile(existing))
      ) {
        bestBySessionDir.set(sessionDir, filePath);
      }
    }
    return [...bestBySessionDir.values()].sort((left, right) => left.localeCompare(right));
  },
  getSourceFilePriority: (filePath) => {
    // Later generations sort after retained predecessors so the current log is
    // parsed last when an incomplete retained tree is the only evidence.
    return readSessionFileVersion(filePath) ?? 0;
  },
  getSourceRoots: (baseDir) => [baseDir],
};
