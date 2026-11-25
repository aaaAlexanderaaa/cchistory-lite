/**
 * Role: Pure domain contracts and canonical remote-URL normalization for opt-in
 * project Git metadata and cross-host project reconciliation.
 * Excludes local git process execution, file I/O, and CLI rendering.
 */

import type { ProjectIdentity } from "./index.js";

export const MERGED_PROJECTS_SCHEMA = "cchistory-lite-merged-projects/v1";

export type ProjectGitStatus = "ok" | "not_git" | "missing_path" | "timeout" | "error";

export interface ProjectGitMetadata {
  status: ProjectGitStatus;
  repo_root: string | null;
  repo_remote: string | null;
  branch: string | null;
  detached?: boolean;
  head_sha: string | null;
  head_committed_at: string | null;
  dirty_files: number | null;
  ahead: number | null;
  behind: number | null;
  upstream?: string | null;
  error?: string;
}

export interface ProjectWithGitMetadata extends ProjectIdentity {
  git?: ProjectGitMetadata;
}

export interface HostProjectEntryInput {
  project_id?: string;
  display_name: string;
  slug?: string;
  primary_workspace_path?: string | null;
  repo_root?: string | null;
  repo_remote?: string | null;
  source_platforms?: string[];
  session_count?: number;
  turn_count?: number;
  last_activity_at?: string | null;
  git?: ProjectGitMetadata | null;
}

export interface HostProjectSnapshotInput {
  host_id: string;
  generated_at?: string | null;
  source_file?: string;
  total_projects?: number | null;
  truncated?: boolean;
  host_id_inferred_from_filename?: boolean;
  projects: HostProjectEntryInput[];
}

export type MergedProjectMatchKind = "repo_remote" | "directory_fallback";
export type MergedProjectSyncState =
  | "aligned"
  | "unpushed"
  | "behind"
  | "ahead_behind"
  | "diverged"
  | "dirty"
  | "non_git"
  | "git_not_collected"
  | "single_host";

export interface MergedProjectHostState {
  host_id: string;
  project_id: string | null;
  workspace_path: string | null;
  repo_root: string | null;
  repo_remote: string | null;
  git_status: ProjectGitStatus | "unavailable";
  branch: string | null;
  detached: boolean;
  head_sha: string | null;
  head_committed_at: string | null;
  dirty_files: number | null;
  ahead: number | null;
  behind: number | null;
  upstream: string | null;
  session_count: number;
  turn_count: number;
  last_activity_at: string | null;
  source_platforms: string[];
}

export interface MergedProjectRecord {
  match_key: string;
  match_kind: MergedProjectMatchKind;
  display_name: string;
  repo_remote: string | null;
  host_ids: string[];
  host_count: number;
  sync_state: MergedProjectSyncState;
  latest_commit_host: string | null;
  latest_commit_hosts?: string[];
  latest_commit_at: string | null;
  latest_activity_host: string | null;
  latest_activity_at: string | null;
  branch_diverged: boolean;
  commit_diverged: boolean;
  dirty_hosts: string[];
  unpushed_hosts: string[];
  behind_hosts: string[];
  no_upstream_hosts?: string[];
  total_session_count: number;
  total_turn_count: number;
  hosts: MergedProjectHostState[];
}

export interface MergedProjectsSummary {
  host_count: number;
  project_count: number;
  repo_remote_matched_count: number;
  directory_fallback_count: number;
  multi_host_project_count: number;
  diverged_project_count: number;
  dirty_project_count: number;
  unpushed_project_count: number;
  behind_project_count: number;
  no_upstream_project_count?: number;
  git_not_collected_project_count?: number;
}

export interface MergedProjectsReport {
  schema: typeof MERGED_PROJECTS_SCHEMA;
  kind: "merged_projects";
  generated_at: string;
  hosts: string[];
  warnings?: string[];
  summary: MergedProjectsSummary;
  projects: MergedProjectRecord[];
}

const STANDARD_REMOTE_PORTS: Record<string, string> = {
  http: "80",
  https: "443",
  ssh: "22",
  git: "9418",
};

/**
 * Normalize a Git remote URL into a canonical lowercase `host/owner/repo` key,
 * stripping protocols, embedded credentials, query/fragment parameters, standard
 * ports, and `.git` suffixes. Local filesystem paths return `undefined`.
 */
export function canonicalizeGitRemote(value: string | undefined | null): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  // Reject local filesystem paths and file:// URLs so they fall back to directory matching.
  if (
    raw.startsWith("/") ||
    raw.startsWith("./") ||
    raw.startsWith("../") ||
    raw.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/u.test(raw) ||
    /^file:\/\//iu.test(raw)
  ) {
    return undefined;
  }

  let candidate = raw.replace(/^git\+(?=https?:\/\/|ssh:\/\/)/iu, "");
  let scheme = "";
  let hostPart = "";
  let pathPart = "";

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      scheme = parsed.protocol.replace(/:$/u, "").toLowerCase();
      const hostname = parsed.hostname.toLowerCase();
      if (!hostname) return undefined;
      const standardPort = STANDARD_REMOTE_PORTS[scheme];
      const port = parsed.port && parsed.port !== standardPort ? `:${parsed.port}` : "";
      hostPart = `${hostname}${port}`;
      pathPart = parsed.pathname;
    } catch {
      return undefined;
    }
  } else {
    // Handle schemeless host:port/owner/repo (idempotence for already-canonicalized custom-port remotes).
    const hostPortMatch = /^(?:[^/@:\s]+@)?([A-Za-z0-9.-]+):(\d+)\/(.+)$/u.exec(candidate);
    if (hostPortMatch) {
      hostPart = `${hostPortMatch[1]!.toLowerCase()}:${hostPortMatch[2]!}`;
      pathPart = hostPortMatch[3]!;
    } else {
      // Handle SCP-like SSH syntax: `[user@]host:owner/repo[.git]`.
      const scpMatch = /^(?:[^/@:\s]+@)?([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):(.+)$/u.exec(candidate);
      if (scpMatch) {
        hostPart = scpMatch[1]!.toLowerCase();
        pathPart = scpMatch[2]!;
      } else {
        // Already-normalized or schemeless `host/owner/repo` (strip any leading `user[:pass]@`).
        const stripped = candidate.replace(/^[^/@\s]+@/u, "");
        const slashIdx = stripped.indexOf("/");
        if (slashIdx <= 0) return undefined;
        const rawHost = stripped.slice(0, slashIdx).toLowerCase();
        if (!rawHost.includes(".") && rawHost !== "localhost" && !rawHost.includes(":")) {
          return undefined;
        }
        hostPart = rawHost;
        pathPart = stripped.slice(slashIdx + 1);
      }
    }
  }

  // Strip query string / fragment if SCP or schemeless input carried them.
  pathPart = pathPart.split(/[?#]/u, 1)[0] ?? "";
  pathPart = pathPart
    .replace(/\\/gu, "/")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/iu, "")
    .replace(/\/+$/u, "")
    .toLowerCase();

  if (!hostPart || !pathPart) return undefined;
  return `${hostPart}/${pathPart}`;
}
