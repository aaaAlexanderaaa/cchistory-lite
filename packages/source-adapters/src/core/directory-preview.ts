import path from "node:path";
import { normalizeLocalPathIdentity, type SourcePlatform } from "@cchistory/domain";
import { normalizePathSeparators } from "./path-utils.js";

export type DirectoryScopeMatch = "yes" | "no" | "uncertain";

/**
 * Claude Code replaces every non-alphanumeric character in an absolute cwd
 * with `-`. Encoding is lossy (`app_control` vs `app-control`). A "yes" means
 * the file is worth opening, not that the cwd is uniquely known.
 */
export function sanitizeClaudeProjectFolder(workingDirectory: string): string {
  const normalized = normalizePathSeparators(workingDirectory).replace(/\/+$/u, "");
  return normalized.replace(/[^A-Za-z0-9]/gu, "-");
}

export function sourceFileMayMatchDirectoryScope(input: {
  platform: SourcePlatform;
  baseDir: string;
  filePath: string;
  directoryScope: string;
}): DirectoryScopeMatch {
  const scope = normalizeLocalPathIdentity(input.directoryScope);
  if (!scope) return "uncertain";

  if (input.platform === "grok") {
    const cwd = grokWorkingDirectoryFromPath(input.filePath);
    if (!cwd) return "uncertain";
    return cwdMatchesDirectoryScope(cwd, scope) ? "yes" : "no";
  }

  if (input.platform === "claude_code" || input.platform === "factory_droid") {
    const folder = firstSegmentRelativeToBase(input.baseDir, input.filePath);
    if (!folder) return "uncertain";
    const encoded = sanitizeClaudeProjectFolder(scope);
    if (folder === encoded || folder.startsWith(`${encoded}-`)) return "yes";
    return "no";
  }

  if (
    (input.platform === "cursor" || input.platform === "cursor_agent") &&
    input.filePath.replace(/\\/gu, "/").includes("/agent-transcripts/")
  ) {
    const folder = cursorTranscriptProjectFolder(input.filePath);
    if (!folder) return "uncertain";
    const encoded = encodeCursorProjectDirectoryName(scope);
    if (folder === encoded || folder.startsWith(`${encoded}-`)) return "yes";
    return "no";
  }

  return "uncertain";
}

function grokWorkingDirectoryFromPath(filePath: string): string | undefined {
  const normalized = normalizePathSeparators(filePath);
  const match = normalized.match(/\/sessions\/([^/]+)\/([^/]+)\/chat_history\.jsonl$/u);
  if (!match?.[1]) return undefined;
  try {
    const decoded = decodeURIComponent(match[1]);
    return decoded.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function encodeCursorProjectDirectoryName(workspacePath: string): string {
  return workspacePath.replace(/[\\/._:]+/g, "-").replace(/^-+|-+$/gu, "");
}

function firstSegmentRelativeToBase(baseDir: string, filePath: string): string | undefined {
  const relative = path.relative(path.resolve(baseDir), path.resolve(filePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  const [first] = relative.split(/[\\/]/u);
  if (!first || first.endsWith(".jsonl") || first.endsWith(".json")) {
    return undefined;
  }
  return first;
}

function cursorTranscriptProjectFolder(filePath: string): string | undefined {
  const normalized = normalizePathSeparators(filePath);
  const marker = "/agent-transcripts/";
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return undefined;
  const before = normalized.slice(0, index);
  const slash = before.lastIndexOf("/");
  return slash >= 0 ? before.slice(slash + 1) : before;
}

function cwdMatchesDirectoryScope(candidatePath: string, directoryScope: string): boolean {
  const candidate = normalizeLocalPathIdentity(candidatePath);
  const scope = normalizeLocalPathIdentity(directoryScope);
  if (!candidate || !scope) return false;
  if (candidate === scope) return true;
  if (scope === "/") return candidate.startsWith("/");
  if (/^[a-z]:\/$/u.test(scope)) return candidate.startsWith(scope);
  return candidate.startsWith(`${scope}/`);
}
