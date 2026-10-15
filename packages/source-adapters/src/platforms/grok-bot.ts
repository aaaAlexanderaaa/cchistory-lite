import path from "node:path";
import { normalizePathSeparators } from "../core/path-utils.js";
import type { PlatformAdapter } from "./types.js";

const STORE_BASENAME = "store.db";
const BLOBS_BASENAME = "conversation-blobs.db";
const AGENTS_DIR = "agents";
const TRANSCRIPTS_DIR = "agent-transcripts";

export function isGrokBotStorePath(filePath: string): boolean {
  const normalized = normalizePathSeparators(filePath);
  return (
    path.basename(normalized) === STORE_BASENAME &&
    /\/agents\/[^/]+\/store\.db$/u.test(normalized)
  );
}

export function isGrokBotTranscriptPath(filePath: string): boolean {
  const normalized = normalizePathSeparators(filePath);
  return normalized.includes(`/${TRANSCRIPTS_DIR}/`) && normalized.endsWith(".jsonl");
}

export function isGrokBotConversationBlobsPath(filePath: string): boolean {
  const normalized = normalizePathSeparators(filePath);
  return (
    path.basename(normalized) === BLOBS_BASENAME &&
    /\/agents\/[^/]+\/conversation-blobs\.db$/u.test(normalized)
  );
}

export function parseGrokBotAgentIdFromPath(filePath: string): string | undefined {
  const normalized = normalizePathSeparators(filePath);
  const storeMatch = normalized.match(/\/agents\/([^/]+)\/store\.db$/u);
  if (storeMatch?.[1]) {
    return storeMatch[1];
  }
  const blobsMatch = normalized.match(/\/agents\/([^/]+)\/conversation-blobs\.db$/u);
  if (blobsMatch?.[1]) {
    return blobsMatch[1];
  }
  const transcriptMatch = normalized.match(/\/agent-transcripts\/([^/]+)\/[^/]+\.jsonl$/u);
  if (transcriptMatch?.[1]) {
    return transcriptMatch[1];
  }
  return undefined;
}

export function resolveGrokBotDataRoot(baseDir: string): string {
  const normalized = normalizePathSeparators(baseDir);
  if (normalized.endsWith(`/${AGENTS_DIR}`) || path.basename(normalized) === AGENTS_DIR) {
    return path.dirname(path.normalize(baseDir));
  }
  if (normalized.endsWith(`/${TRANSCRIPTS_DIR}`) || path.basename(normalized) === TRANSCRIPTS_DIR) {
    return path.dirname(path.normalize(baseDir));
  }
  return path.normalize(baseDir);
}

export function listGrokBotSourceRoots(baseDir: string): string[] {
  const normalized = normalizePathSeparators(baseDir);
  if (normalized.endsWith(`/${AGENTS_DIR}`) || path.basename(normalized) === AGENTS_DIR) {
    return [path.normalize(baseDir)];
  }
  if (normalized.endsWith(`/${TRANSCRIPTS_DIR}`) || path.basename(normalized) === TRANSCRIPTS_DIR) {
    return [path.normalize(baseDir)];
  }
  const root = path.normalize(baseDir);
  return [path.join(root, AGENTS_DIR), path.join(root, TRANSCRIPTS_DIR)];
}

export function uniqueExistingPaths(candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function resolveGrokBotDataRootFromTranscript(filePath: string): string | undefined {
  const normalized = normalizePathSeparators(filePath);
  const marker = `/${TRANSCRIPTS_DIR}/`;
  const index = normalized.lastIndexOf(marker);
  if (index < 0) {
    return undefined;
  }
  return normalized.slice(0, index);
}

/**
 * Companion evidence for identity + SQLite WAL. conversation-blobs.db is an
 * opaque LLM payload cache (often tens of MB) not referenced by store message
 * rows; listing it for full-byte capture caused memory pressure and empty
 * parse diagnostics without improving projection. Keep store.db as truth.
 */
export function listGrokBotCompanionEvidencePaths(_baseDir: string, filePath: string): string[] {
  const companions: string[] = [];
  if (isGrokBotStorePath(filePath)) {
    const agentDir = path.dirname(filePath);
    companions.push(
      path.join(agentDir, "profile.json"),
      `${filePath}-wal`,
      `${filePath}-shm`,
    );
  }
  if (isGrokBotTranscriptPath(filePath)) {
    const agentId = parseGrokBotAgentIdFromPath(filePath);
    const dataRoot = resolveGrokBotDataRootFromTranscript(filePath);
    if (agentId && dataRoot) {
      const agentDir = path.join(dataRoot, AGENTS_DIR, agentId);
      companions.push(path.join(agentDir, "profile.json"));
    }
  }
  return companions;
}

export const grokBotAdapter: PlatformAdapter = {
  platform: "grok_bot",
  supportTier: "experimental",
  sessionTargeting: "hybrid",
  projectionBoundary: "source",
  getDefaultBaseDirCandidates: (options) => {
    const homeDir = options.homeDir ?? "";
    const envRoots = [
      process.env.GROK_BOT_HOME,
      process.env.AGENT_DATA,
      process.env.SAND_DATA,
    ]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
      .map((value) => path.normalize(value));
    return uniqueExistingPaths([
      ...envRoots,
      path.join(homeDir, "agent-data"),
      path.join(homeDir, "sand-data"),
      path.join(homeDir, ".agent-data"),
      path.join(homeDir, ".sand-data"),
    ]);
  },
  getSourceRoots: (baseDir) => listGrokBotSourceRoots(baseDir),
  matchesSourceFile: (filePath) => {
    if (isGrokBotStorePath(filePath)) {
      return true;
    }
    // Inventory stays path-only. The probe selects a preferred store only after
    // its budgeted parse succeeds, using attempt-local evidence rather than mtime.
    return isGrokBotTranscriptPath(filePath);
  },
  getSourceFilePriority: (filePath) => {
    if (isGrokBotStorePath(filePath)) {
      return 0;
    }
    if (isGrokBotTranscriptPath(filePath)) {
      return 1;
    }
    return 2;
  },
  getCompanionEvidencePaths: (baseDir, filePath) => listGrokBotCompanionEvidencePaths(baseDir, filePath),
};
