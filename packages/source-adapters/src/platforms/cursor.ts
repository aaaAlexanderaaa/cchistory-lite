import path from "node:path";
import { normalizePathSeparators } from "../core/path-utils.js";
import type { PlatformAdapter } from "./types.js";

const CURSOR_PROJECTS_SUFFIX = "/.cursor/projects";
const CURSOR_CHATS_SUFFIX = "/.cursor/chats";
const CURSOR_HOME_SUFFIXES = [
  CURSOR_PROJECTS_SUFFIX,
  CURSOR_CHATS_SUFFIX,
  "/Library/Application Support/Cursor/User",
  "/Library/Application Support/Cursor",
  "/AppData/Roaming/Cursor/User",
  "/AppData/Roaming/Cursor",
  "/.config/Cursor/User",
  "/.config/Cursor",
  "/.config/cursor/User",
  "/.config/cursor",
] as const;

export const cursorAdapter: PlatformAdapter = {
  platform: "cursor",
  supportTier: "stable",
  sessionTargeting: "hybrid",
  projectionBoundary: "source",
  getDefaultBaseDirCandidates: (options) => {
    const homeDir = options.homeDir ?? "";
    const hostPlatform = options.platform ?? process.platform;
    const appDataDir = options.appDataDir ?? process.env.APPDATA ?? path.join(homeDir, "AppData", "Roaming");

    if (hostPlatform === "darwin") {
      return [
        path.join(homeDir, ".cursor", "projects"),
        path.join(homeDir, "Library", "Application Support", "Cursor", "User"),
        path.join(homeDir, "Library", "Application Support", "Cursor"),
      ];
    }
    if (hostPlatform === "win32") {
      return [
        path.join(homeDir, ".cursor", "projects"),
        path.join(appDataDir, "Cursor", "User"),
        path.join(appDataDir, "Cursor"),
      ];
    }
    return [
      path.join(homeDir, ".cursor", "projects"),
      path.join(homeDir, ".config", "Cursor", "User"),
      path.join(homeDir, ".config", "Cursor"),
      path.join(homeDir, ".config", "cursor", "User"),
      path.join(homeDir, ".config", "cursor"),
    ];
  },
  matchesSourceFile: (filePath) =>
    path.basename(filePath) === "state.vscdb" ||
    (path.basename(filePath) === "store.db" && filePath.includes(`${path.sep}chats${path.sep}`)) ||
    (filePath.endsWith(".jsonl") && filePath.includes(`${path.sep}agent-transcripts${path.sep}`)),
  getSourceFilePriority: (filePath) => {
    if (filePath.includes(`${path.sep}agent-transcripts${path.sep}`)) {
      return 0;
    }
    if (filePath.includes(`${path.sep}workspaceStorage${path.sep}`)) {
      return 1;
    }
    if (filePath.includes(`${path.sep}chats${path.sep}`) && path.basename(filePath) === "store.db") {
      return 2;
    }
    if (filePath.includes(`${path.sep}globalStorage${path.sep}`)) {
      return 3;
    }
    return 4;
  },
  getSourceRoots: (baseDir) => resolveCursorSourceRoots(baseDir),
  getSupplementalSourceRoots: (baseDir) => {
    const homeDir = deriveCursorHomeDir(baseDir);
    if (!homeDir) {
      return [];
    }
    const normalized = normalizePathSeparators(baseDir);
    const selected = path.normalize(baseDir);
    const isChatsRoot = normalized.endsWith(CURSOR_CHATS_SUFFIX);
    const isProjectsRoot = normalized.endsWith(CURSOR_PROJECTS_SUFFIX);
    const roots: string[] = [];
    if (!isChatsRoot) {
      roots.push(path.join(homeDir, ".cursor", "chats"));
    }
    if (isProjectsRoot) {
      roots.push(...cursorOfficialUserDirs(homeDir).flatMap(cursorUserStorageRoots));
    } else if (!isChatsRoot) {
      roots.push(path.join(homeDir, ".cursor", "projects"));
    }
    return [...new Set(roots.map((root) => path.normalize(root)))].filter((root) => root !== selected);
  },
};

export function deriveCursorHomeDir(baseDir: string): string | undefined {
  const normalizedBaseDir = normalizePathSeparators(baseDir);
  for (const suffix of CURSOR_HOME_SUFFIXES) {
    if (!normalizedBaseDir.endsWith(suffix)) {
      continue;
    }
    const homeDir = normalizedBaseDir.slice(0, -suffix.length);
    return homeDir || undefined;
  }
  return undefined;
}

const CURSOR_USER_DIR_SUFFIXES = [
  "/Library/Application Support/Cursor/User",
  "/AppData/Roaming/Cursor/User",
  "/.config/Cursor/User",
  "/.config/cursor/User",
] as const;

const CURSOR_APP_DIR_SUFFIXES = [
  "/Library/Application Support/Cursor",
  "/AppData/Roaming/Cursor",
  "/.config/Cursor",
  "/.config/cursor",
] as const;

function resolveCursorSourceRoots(baseDir: string): string[] {
  const normalized = normalizePathSeparators(baseDir);
  if (normalized.endsWith("/globalStorage") || normalized.endsWith("/workspaceStorage")) {
    return [path.normalize(baseDir)];
  }
  const userDir = inferCursorUserDirFromScanRoot(baseDir);
  if (userDir) {
    return cursorUserStorageRoots(userDir);
  }
  return [path.normalize(baseDir)];
}

function inferCursorUserDirFromScanRoot(baseDir: string): string | undefined {
  const normalized = normalizePathSeparators(baseDir);
  for (const suffix of CURSOR_USER_DIR_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      return path.normalize(baseDir);
    }
  }
  for (const suffix of CURSOR_APP_DIR_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      return path.join(path.normalize(baseDir), "User");
    }
  }
  if (/\/[Cc]ursor\/User$/u.test(normalized)) {
    return path.normalize(baseDir);
  }
  return undefined;
}

function cursorOfficialUserDirs(homeDir: string): string[] {
  return [
    path.join(homeDir, "Library", "Application Support", "Cursor", "User"),
    path.join(homeDir, "AppData", "Roaming", "Cursor", "User"),
    path.join(homeDir, ".config", "Cursor", "User"),
    path.join(homeDir, ".config", "cursor", "User"),
  ];
}

function cursorUserStorageRoots(userDir: string): string[] {
  return [path.join(userDir, "globalStorage"), path.join(userDir, "workspaceStorage")];
}
