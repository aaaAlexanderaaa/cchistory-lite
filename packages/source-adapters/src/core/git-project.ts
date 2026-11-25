import { canonicalizeGitRemote, normalizeGitRemote, type ProjectGitMetadata } from "@cchistory/domain";
export { normalizeGitRemote } from "@cchistory/domain";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitProjectEvidence } from "./types.js";
import { normalizeWorkspacePath, pathExists } from "./path-utils.js";
import { sha1 } from "./type-guards.js";

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_METADATA_TIMEOUT_MS = 1_500;
const GIT_METADATA_MAX_BUFFER = 128 * 1024;

class TtlCache<K, V> {
  private entries = new Map<K, { value: V; expiresAt: number }>();
  constructor(private maxSize: number, private ttlMs: number) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.entries.size >= this.maxSize) {
      // Evict oldest (first inserted — Map preserves insertion order)
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) this.entries.delete(firstKey);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

const gitProjectEvidenceCache = new TtlCache<string, Promise<GitProjectEvidence | undefined>>(200, 5 * 60 * 1000);

export async function readGitProjectEvidence(workingDirectory?: string): Promise<GitProjectEvidence | undefined> {
  const workspacePath = normalizeWorkspacePath(workingDirectory ?? "");
  if (!workspacePath) {
    return undefined;
  }

  let cached = gitProjectEvidenceCache.get(workspacePath);
  if (!cached) {
    cached = loadGitProjectEvidence(workspacePath);
    gitProjectEvidenceCache.set(workspacePath, cached);
  }

  return cached;
}

export async function loadGitProjectEvidence(workspacePath: string): Promise<GitProjectEvidence | undefined> {
  if (!(await pathExists(workspacePath))) {
    return undefined;
  }

  const repoRoot = normalizeWorkspacePath(
    (await runGitCommand(["-C", workspacePath, "rev-parse", "--show-toplevel"])) ?? "",
  );
  if (!repoRoot) {
    return undefined;
  }

  const repoRemote = normalizeGitRemote(await runGitCommand(["-C", repoRoot, "config", "--get", "remote.origin.url"]));

  return {
    repoRoot,
    repoRemote,
    repoFingerprint: repoRemote ? sha1(Buffer.from(`repo-remote:${repoRemote}`)) : undefined,
  };
}

async function runGitCommand(args: string[]): Promise<string | undefined> {
  const result = await runGitCommandDetailed(args, 2_000, 64 * 1024);
  return result.ok ? result.stdout : undefined;
}

interface DetailedGitResult {
  ok: boolean;
  stdout?: string;
  timedOut?: boolean;
  error?: string;
}

async function runGitCommandDetailed(
  args: string[],
  timeoutMs: number,
  maxBuffer: number,
): Promise<DetailedGitResult> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      timeout: timeoutMs,
      maxBuffer,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    const output = stdout.trimEnd();
    return { ok: true, stdout: output || undefined };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
    const timedOut = Boolean(err?.killed || err?.code === "ETIMEDOUT");
    return {
      ok: false,
      timedOut,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface InspectLocalProjectGitOptions {
  timeoutMs?: number;
}

/**
 * Offline-only, read-only, bounded local Git metadata inspection for one project path.
 * Never touches the network or mutates the repository (`GIT_OPTIONAL_LOCKS=0`).
 */
export async function inspectLocalProjectGitMetadata(
  repoPath: string | undefined,
  options: InspectLocalProjectGitOptions = {},
): Promise<ProjectGitMetadata> {
  const normalizedPath = normalizeWorkspacePath(repoPath ?? "");
  if (!normalizedPath || !(await pathExists(normalizedPath))) {
    return emptyGitMetadata("missing_path", null);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_METADATA_TIMEOUT_MS;
  const topLevel = await runGitCommandDetailed(
    ["-C", normalizedPath, "rev-parse", "--show-toplevel"],
    timeoutMs,
    GIT_METADATA_MAX_BUFFER,
  );
  if (topLevel.timedOut) {
    return emptyGitMetadata("timeout", null, "git rev-parse timed out");
  }
  if (!topLevel.ok || !topLevel.stdout) {
    return emptyGitMetadata("not_git", null);
  }
  const repoRoot = normalizeWorkspacePath(topLevel.stdout) ?? topLevel.stdout;

  const [statusRes, logRes, remoteRes] = await Promise.all([
    runGitCommandDetailed(["-C", repoRoot, "status", "--porcelain=v2", "--branch"], timeoutMs, GIT_METADATA_MAX_BUFFER),
    runGitCommandDetailed(["-C", repoRoot, "log", "-1", "--format=%H%x00%cI"], timeoutMs, GIT_METADATA_MAX_BUFFER),
    runGitCommandDetailed(["-C", repoRoot, "config", "--get", "remote.origin.url"], timeoutMs, GIT_METADATA_MAX_BUFFER),
  ]);

  if (statusRes.timedOut || logRes.timedOut || remoteRes.timedOut) {
    return emptyGitMetadata("timeout", repoRoot, "git metadata command timed out");
  }
  if (!statusRes.ok) {
    return emptyGitMetadata("error", repoRoot, statusRes.error ?? "git status failed");
  }

  const parsedStatus = parsePorcelainV2Status(statusRes.stdout ?? "");
  let headSha = parsedStatus.oid;
  let headCommittedAt: string | null = null;
  if (logRes.ok && logRes.stdout) {
    const [sha, committedAt] = logRes.stdout.split("\0");
    if (sha?.trim()) headSha = sha.trim();
    if (committedAt?.trim()) headCommittedAt = committedAt.trim();
  }

  const canonicalRemote = canonicalizeGitRemote(remoteRes.ok ? remoteRes.stdout : undefined) ?? null;

  return {
    status: "ok",
    repo_root: repoRoot,
    repo_remote: canonicalRemote,
    branch: parsedStatus.branch,
    ...(parsedStatus.detached ? { detached: true } : {}),
    head_sha: headSha,
    head_committed_at: headCommittedAt,
    dirty_files: parsedStatus.dirtyFiles,
    ahead: parsedStatus.ahead,
    behind: parsedStatus.behind,
    ...(parsedStatus.upstream !== null ? { upstream: parsedStatus.upstream } : { upstream: null }),
  };
}

function emptyGitMetadata(
  status: ProjectGitMetadata["status"],
  repoRoot: string | null,
  error?: string,
): ProjectGitMetadata {
  return {
    status,
    repo_root: repoRoot,
    repo_remote: null,
    branch: null,
    head_sha: null,
    head_committed_at: null,
    dirty_files: null,
    ahead: null,
    behind: null,
    upstream: null,
    ...(error ? { error } : {}),
  };
}

function parsePorcelainV2Status(stdout: string): {
  oid: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirtyFiles: number;
} {
  let oid: string | null = null;
  let branch: string | null = null;
  let detached = false;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let dirtyFiles = 0;

  for (const line of stdout.split(/\r?\n/u)) {
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const value = line.slice("# branch.oid ".length).trim();
      oid = value && value !== "(initial)" ? value : null;
    } else if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      if (value === "(detached)") {
        detached = true;
        branch = "HEAD";
      } else if (value) {
        branch = value;
      }
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null;
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+)\s+-(\d+)/u.exec(line.slice("# branch.ab ".length));
      if (match) {
        ahead = Number.parseInt(match[1]!, 10);
        behind = Number.parseInt(match[2]!, 10);
      }
    } else if (!line.startsWith("# ")) {
      dirtyFiles += 1;
    }
  }

  return { oid, branch, detached, upstream, ahead, behind, dirtyFiles };
}
