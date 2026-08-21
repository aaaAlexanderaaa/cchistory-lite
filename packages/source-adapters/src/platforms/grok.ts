import fs from "node:fs/promises";
import path from "node:path";
import { normalizePathSeparators } from "../core/path-utils.js";
import type { PlatformAdapter } from "./types.js";

const CHAT_HISTORY_FILE = "chat_history.jsonl";
const SESSION_COMPANION_FILES = [
  "summary.json",
  "signals.json",
  "prompt_context.json",
  "updates.jsonl",
  "plan.json",
] as const;

export const GROK_DELEGATED_SESSION_KINDS = new Set([
  "subagent",
  "subagent_resume",
  "subagent_fork",
]);

export interface GrokSessionLayout {
  sessionId: string;
  sessionDir: string;
  encodedCwd?: string;
  workingDirectory?: string;
}

export function resolveGrokRoot(baseDir: string): string {
  const normalized = normalizePathSeparators(baseDir);
  if (normalized.endsWith("/sessions")) {
    return path.dirname(baseDir);
  }
  return path.normalize(baseDir);
}

export function listGrokSourceRoots(baseDir: string): string[] {
  const normalized = normalizePathSeparators(baseDir);
  if (path.basename(normalized) === CHAT_HISTORY_FILE) {
    return [path.dirname(baseDir)];
  }
  if (normalized.endsWith("/sessions")) {
    return [path.normalize(baseDir)];
  }
  const parentName = path.basename(path.dirname(normalized));
  const grandName = path.basename(path.dirname(path.dirname(normalized)));
  if (grandName === "sessions") {
    return [path.normalize(baseDir)];
  }
  if (parentName === "sessions") {
    return [path.normalize(baseDir)];
  }
  return [path.join(path.normalize(baseDir), "sessions")];
}

export function parseGrokSessionLayout(filePath: string): GrokSessionLayout | undefined {
  const normalized = normalizePathSeparators(filePath);
  const match = normalized.match(/\/sessions\/([^/]+)\/([^/]+)\/chat_history\.jsonl$/u);
  if (!match?.[1] || !match[2]) {
    if (path.basename(normalized) === CHAT_HISTORY_FILE) {
      const sessionDir = path.dirname(filePath);
      return {
        sessionId: path.basename(sessionDir),
        sessionDir,
      };
    }
    return undefined;
  }

  const encodedCwd = match[1];
  const sessionId = match[2];
  return {
    sessionId,
    encodedCwd,
    workingDirectory: decodeGrokEncodedCwd(encodedCwd),
    sessionDir: path.normalize(path.dirname(filePath)),
  };
}

export function resolveGrokSessionDir(filePath: string): string | undefined {
  return parseGrokSessionLayout(filePath)?.sessionDir;
}

export function applyGrokWorkspaceFromPath(
  filePath: string,
  draft: { working_directory?: string; source_session_id?: string },
  normalizeWorkspacePath: (value: string) => string | undefined,
): void {
  const layout = parseGrokSessionLayout(filePath);
  if (!layout) {
    return;
  }
  if (!draft.source_session_id) {
    draft.source_session_id = layout.sessionId;
  }
  if (draft.working_directory || !layout.workingDirectory) {
    return;
  }
  draft.working_directory = normalizeWorkspacePath(layout.workingDirectory) ?? layout.workingDirectory;
}

export function decodeGrokEncodedCwd(encodedCwd: string): string | undefined {
  try {
    const decoded = decodeURIComponent(encodedCwd);
    return decoded.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function previewSourceFileWorkingDirectory(
  platform: string,
  filePath: string,
): { state: "known" | "absent" | "uncertain"; workingDirectory?: string } {
  if (platform !== "grok") {
    return { state: "absent" };
  }
  const layout = parseGrokSessionLayout(filePath);
  if (!layout) {
    return { state: "uncertain" };
  }
  if (!layout.workingDirectory) {
    return { state: "absent" };
  }
  return { state: "known", workingDirectory: layout.workingDirectory };
}

export async function listGrokCompanionEvidencePaths(_baseDir: string, filePath: string): Promise<string[]> {
  const sessionDir = resolveGrokSessionDir(filePath);
  if (!sessionDir) {
    return [];
  }

  const companions = new Set<string>(
    SESSION_COMPANION_FILES.map((name) => path.join(sessionDir, name)),
  );

  for (const sidecar of await listGrokRecordSidecarPaths(filePath)) {
    companions.add(sidecar.filePath);
  }

  const subagentsDir = path.join(sessionDir, "subagents");
  try {
    for (const entry of await fs.readdir(subagentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      companions.add(path.join(subagentsDir, entry.name, "output.json"));
    }
  } catch {}

  return [...companions];
}

export async function listGrokRecordSidecarPaths(
  filePath: string,
): Promise<Array<{ filePath: string; pointer: string }>> {
  const sessionDir = resolveGrokSessionDir(filePath);
  if (!sessionDir) {
    return [];
  }

  const sidecars: Array<{ filePath: string; pointer: string }> = [
    { filePath: path.join(sessionDir, "summary.json"), pointer: "summary" },
  ];
  const sessionId = path.basename(sessionDir);
  const seen = new Set<string>([sidecars[0]!.filePath]);

  const subagentsDir = path.join(sessionDir, "subagents");
  try {
    for (const entry of await fs.readdir(subagentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const metaPath = path.join(subagentsDir, entry.name, "meta.json");
      sidecars.push({ filePath: metaPath, pointer: `subagent_meta:${entry.name}` });
      seen.add(metaPath);
    }
  } catch {}

  if (await grokSessionMayBeDelegatedChild(sessionDir)) {
    const cwdDir = path.dirname(sessionDir);
    try {
      for (const entry of await fs.readdir(cwdDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === sessionId) {
          continue;
        }
        const parentMetaPath = path.join(cwdDir, entry.name, "subagents", sessionId, "meta.json");
        if (seen.has(parentMetaPath)) {
          continue;
        }
        try {
          await fs.access(parentMetaPath);
        } catch {
          continue;
        }
        sidecars.push({ filePath: parentMetaPath, pointer: `subagent_meta:${sessionId}` });
        seen.add(parentMetaPath);
      }
    } catch {}
  }

  return sidecars;
}

async function grokSessionMayBeDelegatedChild(sessionDir: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(sessionDir, "summary.json"), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return true;
    }
    const sessionKind = (parsed as { session_kind?: unknown }).session_kind;
    if (typeof sessionKind !== "string") {
      return false;
    }
    return GROK_DELEGATED_SESSION_KINDS.has(sessionKind);
  } catch {
    return true;
  }
}

export const grokAdapter: PlatformAdapter = {
  platform: "grok",
  supportTier: "experimental",
  sessionTargeting: "file",
  projectionBoundary: "source",
  getDefaultBaseDirCandidates: (options) => {
    const homeDir = options.homeDir ?? "";
    const candidates = [path.join(homeDir, ".grok")];
    const grokHome = process.env.GROK_HOME?.trim();
    if (grokHome) {
      candidates.unshift(path.normalize(grokHome));
    }
    return candidates;
  },
  getSourceRoots: (baseDir) => listGrokSourceRoots(baseDir),
  matchesSourceFile: (filePath) => path.basename(filePath) === CHAT_HISTORY_FILE,
  getCompanionEvidencePaths: (baseDir, filePath) => listGrokCompanionEvidencePaths(baseDir, filePath),
};
