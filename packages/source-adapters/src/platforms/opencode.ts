import path from "node:path";
import { normalizePathSeparators } from "../core/utils.js";
import type { PlatformAdapter } from "./types.js";

const OPENCODE_STORAGE_SUFFIX = "/.local/share/opencode/storage";
const OPENCODE_PROJECT_SUFFIX = "/.local/share/opencode/project";
const OPENCODE_LEGACY_SESSION_SUFFIX = "/.local/share/opencode/storage/session";

export const opencodeAdapter: PlatformAdapter = {
  platform: "opencode",
  supportTier: "stable",
  // JSON session files are addressable individually; the SQLite store holds
  // every session, so it is filtered as a container.
  sessionTargeting: "hybrid",
  projectionBoundary: "source",
  getDefaultBaseDirCandidates: (options) => {
    const env = options.env ?? process.env;
    const xdgDataHome = env.XDG_DATA_HOME?.trim();
    return [
      ...(xdgDataHome ? [path.join(xdgDataHome, "opencode")] : []),
      path.join(options.homeDir ?? "", ".local", "share", "opencode", "storage"),
      path.join(options.homeDir ?? "", ".local", "share", "opencode", "project"),
      path.join(options.homeDir ?? "", ".local", "share", "opencode", "storage", "session"),
      // OpenCode 1.2+ keeps one SQLite store beside the legacy storage tree.
      path.join(options.homeDir ?? "", ".local", "share", "opencode"),
    ];
  },
  matchesSourceFile: (filePath) => {
    if (path.basename(filePath) === "opencode.db") {
      return true;
    }
    if (!filePath.endsWith(".json")) {
      return false;
    }
    const normalized = normalizePathSeparators(filePath);
    return normalized.includes("/storage/session/");
  },
  getSourceFilePriority: (filePath) => {
    // Parse the SQLite store first: leftover JSON session files are suppressed
    // only after the store proves it covers their native session identity.
    return path.basename(filePath) === "opencode.db" ? 0 : 1;
  },
  getSupplementalSourceRoots: (baseDir) => {
    const homeDir = deriveOpencodeHomeDir(baseDir);
    if (!homeDir) {
      return [];
    }
    const dataRoot = path.join(homeDir, ".local", "share", "opencode");
    if (normalizePathSeparators(baseDir).endsWith(OPENCODE_PROJECT_SUFFIX)) {
      return [path.join(dataRoot, "storage"), dataRoot];
    }
    if (normalizePathSeparators(baseDir).endsWith("/.local/share/opencode/storage")) {
      // Include the data root so the SQLite store is discovered even when the
      // legacy storage tree is selected as the base directory.
      return [dataRoot];
    }
    return [];
  },
};

function deriveOpencodeHomeDir(baseDir: string): string | undefined {
  const normalizedBaseDir = normalizePathSeparators(baseDir);
  for (const suffix of [OPENCODE_STORAGE_SUFFIX, OPENCODE_PROJECT_SUFFIX, OPENCODE_LEGACY_SESSION_SUFFIX]) {
    if (!normalizedBaseDir.endsWith(suffix)) {
      continue;
    }
    const homeDir = normalizedBaseDir.slice(0, -suffix.length);
    return homeDir || undefined;
  }
  return undefined;
}
