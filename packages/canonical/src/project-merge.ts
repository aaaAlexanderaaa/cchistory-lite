/**
 * Role: Pure, zero-I/O cross-host project reconciliation and read-only envelope
 * builders for Slice B (`ls projects --with-git` and `merge-projects`).
 * Excludes filesystem reading, git process execution, and CLI formatting.
 */

import {
  canonicalizeGitRemote,
  DEFAULT_ENVELOPE_STALE_AFTER_SECONDS,
  maxIso,
  MERGED_PROJECTS_SCHEMA,
  type HostProjectEntryInput,
  type HostProjectSnapshotInput,
  type MergedProjectHostState,
  type MergedProjectMatchKind,
  type MergedProjectRecord,
  type MergedProjectSyncState,
  type MergedProjectsReport,
  type MergedProjectsSummary,
  type ProjectGitMetadata,
  type ReadOnlyEnvelopeStatus,
  type ReadOnlyEnvelopeV1,
  type ReadStatus,
} from "@cchistory/domain";

export interface MergeHostProjectsOptions {
  nowIso?: string;
}

export interface BuildProjectsEnvelopeOptions {
  hostId: string;
  generatedAt: string;
  staleAfterSeconds?: number;
  readStatus?: ReadStatus;
  totalProjectCount?: number;
  gitInspected?: boolean;
}

export interface BuildMergedProjectsEnvelopeOptions {
  hostId: string;
  staleAfterSeconds?: number;
}

interface MutableGroup {
  matchKey: string;
  matchKind: MergedProjectMatchKind;
  repoRemote: string | null;
  displayNameCandidates: string[];
  byHost: Map<string, MergedProjectHostState>;
}

/**
 * Normalize a project workspace path or display name into a lowercase directory
 * fallback key for non-Git projects (or Git repos without an origin remote).
 */
export function normalizeDirectoryFallbackKey(
  workspacePath: string | null | undefined,
  repoRoot: string | null | undefined,
  displayName: string | undefined,
): string {
  const candidate = workspacePath?.trim() || repoRoot?.trim() || displayName?.trim() || "unknown";
  const normalized = candidate.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const segments = normalized.split("/").filter(Boolean);
  const leaf = segments.at(-1) ?? normalized;
  return leaf.trim().toLowerCase() || "unknown";
}

export function mergeHostProjectSnapshots(
  inputs: readonly HostProjectSnapshotInput[],
  options: MergeHostProjectsOptions = {},
): MergedProjectsReport {
  const generatedAt = options.nowIso ?? new Date().toISOString();
  const hostSet = new Set<string>();
  const groups = new Map<string, MutableGroup>();
  const warnings: string[] = [];

  for (const snapshot of inputs) {
    const hostId = snapshot.host_id.trim();
    if (!hostId) continue;
    hostSet.add(hostId);
    const label = snapshot.source_file ? `${hostId} (${snapshot.source_file})` : hostId;
    if (snapshot.host_id_inferred_from_filename) {
      warnings.push(
        `Snapshot ${snapshot.source_file ?? hostId} had no host_id; inferred "${hostId}" from filename (pass --host-id when exporting).`,
      );
    }
    if (
      snapshot.truncated === true ||
      (typeof snapshot.total_projects === "number" && snapshot.total_projects > snapshot.projects.length)
    ) {
      const totalLabel =
        typeof snapshot.total_projects === "number"
          ? `${snapshot.projects.length}/${snapshot.total_projects}`
          : `${snapshot.projects.length}/?`;
      warnings.push(
        `Snapshot for ${label} is truncated (${totalLabel} projects); re-export with --all for complete reconciliation.`,
      );
    }
    if (snapshot.projects.length > 0 && snapshot.projects.every((entry) => !entry.git)) {
      warnings.push(
        `Snapshot for ${label} has no Git metadata (re-export with --with-git); Git sync status is unknown and matching fell back to directory names.`,
      );
    }

    for (const entry of snapshot.projects) {
      const canonicalRemote =
        canonicalizeGitRemote(entry.git?.repo_remote) ??
        canonicalizeGitRemote(entry.repo_remote) ??
        null;

      const matchKind: MergedProjectMatchKind = canonicalRemote ? "repo_remote" : "directory_fallback";
      const matchKey = canonicalRemote
        ? `remote:${canonicalRemote}`
        : `dir:${normalizeDirectoryFallbackKey(entry.primary_workspace_path, entry.repo_root, entry.display_name)}`;

      let group = groups.get(matchKey);
      if (!group) {
        group = {
          matchKey,
          matchKind,
          repoRemote: canonicalRemote,
          displayNameCandidates: [],
          byHost: new Map(),
        };
        groups.set(matchKey, group);
      }

      const displayName = entry.display_name?.trim();
      if (displayName) group.displayNameCandidates.push(displayName);

      const nextHostState = toHostState(hostId, entry, canonicalRemote);
      const existing = group.byHost.get(hostId);
      group.byHost.set(hostId, existing ? combineHostStates(existing, nextHostState) : nextHostState);
    }
  }

  const projects: MergedProjectRecord[] = [...groups.values()]
    .map((group) => finalizeMergedProject(group))
    .sort(compareMergedProjects);

  const hosts = [...hostSet].sort((a, b) => a.localeCompare(b));
  const summary: MergedProjectsSummary = {
    host_count: hosts.length,
    project_count: projects.length,
    repo_remote_matched_count: projects.filter((p) => p.match_kind === "repo_remote").length,
    directory_fallback_count: projects.filter((p) => p.match_kind === "directory_fallback").length,
    multi_host_project_count: projects.filter((p) => p.host_count >= 2).length,
    diverged_project_count: projects.filter((p) => p.branch_diverged || p.commit_diverged).length,
    dirty_project_count: projects.filter((p) => p.dirty_hosts.length > 0).length,
    unpushed_project_count: projects.filter((p) => p.unpushed_hosts.length > 0).length,
    behind_project_count: projects.filter((p) => p.behind_hosts.length > 0).length,
    no_upstream_project_count: projects.filter((p) => (p.no_upstream_hosts?.length ?? 0) > 0).length,
    git_not_collected_project_count: projects.filter((p) => p.sync_state === "git_not_collected").length,
  };

  return {
    schema: MERGED_PROJECTS_SCHEMA,
    kind: "merged_projects",
    generated_at: generatedAt,
    hosts,
    ...(warnings.length > 0 ? { warnings } : {}),
    summary,
    projects,
  };
}

export function buildMergedProjectsEnvelope(
  report: MergedProjectsReport,
  options: BuildMergedProjectsEnvelopeOptions,
): ReadOnlyEnvelopeV1<MergedProjectsSummary, MergedProjectRecord> {
  const hasWarnings = (report.warnings?.length ?? 0) > 0;
  return {
    schema_version: 1,
    domain: "projects",
    owner: "cchistory-lite",
    host_id: options.hostId,
    generated_at: report.generated_at,
    stale_after_seconds: options.staleAfterSeconds ?? DEFAULT_ENVELOPE_STALE_AFTER_SECONDS,
    status: hasWarnings ? "partial" : "ok",
    error: null,
    summary: report.summary,
    delta: null,
    items: report.projects,
  };
}

export function buildProjectsEnvelope<TProject extends { git?: ProjectGitMetadata | null }>(
  projects: readonly TProject[],
  options: BuildProjectsEnvelopeOptions,
): ReadOnlyEnvelopeV1<
  {
    project_count: number;
    total_project_count: number;
    truncated: boolean;
    git_inspected: boolean;
    git_ok_count: number | null;
    git_dirty_count: number | null;
    git_unpushed_count: number | null;
    git_behind_count: number | null;
    git_error_count: number | null;
  },
  TProject
> {
  const totalProjectCount = options.totalProjectCount ?? projects.length;
  const truncated = totalProjectCount > projects.length;
  const gitInspected = options.gitInspected ?? projects.some((p) => p.git !== undefined && p.git !== null);

  let gitOk = 0;
  let gitDirty = 0;
  let gitUnpushed = 0;
  let gitBehind = 0;
  let gitError = 0;

  if (gitInspected) {
    for (const project of projects) {
      const git = project.git;
      if (!git) continue;
      if (git.status === "ok") {
        gitOk += 1;
        if ((git.dirty_files ?? 0) > 0) gitDirty += 1;
        if ((git.ahead ?? 0) > 0) gitUnpushed += 1;
        if ((git.behind ?? 0) > 0) gitBehind += 1;
      } else if (git.status === "timeout" || git.status === "error") {
        gitError += 1;
      }
    }
  }

  let status: ReadOnlyEnvelopeStatus = "ok";
  if (truncated || gitError > 0 || (options.readStatus && options.readStatus.status !== "no_known_gaps")) {
    status = "partial";
  }

  return {
    schema_version: 1,
    domain: "projects",
    owner: "cchistory-lite",
    host_id: options.hostId,
    generated_at: options.generatedAt,
    stale_after_seconds: options.staleAfterSeconds ?? DEFAULT_ENVELOPE_STALE_AFTER_SECONDS,
    status,
    error: null,
    summary: {
      project_count: projects.length,
      total_project_count: totalProjectCount,
      truncated,
      git_inspected: gitInspected,
      git_ok_count: gitInspected ? gitOk : null,
      git_dirty_count: gitInspected ? gitDirty : null,
      git_unpushed_count: gitInspected ? gitUnpushed : null,
      git_behind_count: gitInspected ? gitBehind : null,
      git_error_count: gitInspected ? gitError : null,
    },
    delta: null,
    items: [...projects],
  };
}

function toHostState(
  hostId: string,
  entry: HostProjectEntryInput,
  canonicalRemote: string | null,
): MergedProjectHostState {
  const git = entry.git ?? undefined;
  return {
    host_id: hostId,
    project_id: entry.project_id ?? null,
    workspace_path: entry.primary_workspace_path ?? null,
    repo_root: git?.repo_root ?? entry.repo_root ?? null,
    repo_remote: canonicalRemote,
    git_status: git?.status ?? "unavailable",
    branch: git?.branch ?? null,
    detached: Boolean(git?.detached),
    head_sha: git?.head_sha ?? null,
    head_committed_at: git?.head_committed_at ?? null,
    dirty_files: git?.dirty_files ?? null,
    ahead: git?.ahead ?? null,
    behind: git?.behind ?? null,
    upstream: git?.upstream ?? null,
    session_count: entry.session_count ?? 0,
    turn_count: entry.turn_count ?? 0,
    last_activity_at: entry.last_activity_at ?? null,
    source_platforms: uniqueSorted(entry.source_platforms ?? []),
  };
}

function combineHostStates(
  left: MergedProjectHostState,
  right: MergedProjectHostState,
): MergedProjectHostState {
  const preferRightGit = shouldPreferGitState(left, right);
  const gitSource = preferRightGit ? right : left;
  return {
    host_id: left.host_id,
    project_id: left.project_id ?? right.project_id,
    workspace_path: left.workspace_path ?? right.workspace_path,
    repo_root: gitSource.repo_root ?? left.repo_root ?? right.repo_root,
    repo_remote: gitSource.repo_remote ?? left.repo_remote ?? right.repo_remote,
    git_status: gitSource.git_status,
    branch: gitSource.branch,
    detached: gitSource.detached,
    head_sha: gitSource.head_sha,
    head_committed_at: gitSource.head_committed_at,
    dirty_files: gitSource.dirty_files,
    ahead: gitSource.ahead,
    behind: gitSource.behind,
    upstream: gitSource.upstream,
    session_count: left.session_count + right.session_count,
    turn_count: left.turn_count + right.turn_count,
    last_activity_at: maxIso(left.last_activity_at ?? undefined, right.last_activity_at ?? undefined) ?? null,
    source_platforms: uniqueSorted([...left.source_platforms, ...right.source_platforms]),
  };
}

function shouldPreferGitState(left: MergedProjectHostState, right: MergedProjectHostState): boolean {
  if (left.git_status !== "ok" && right.git_status === "ok") return true;
  if (left.git_status === "ok" && right.git_status !== "ok") return false;
  return compareIsoDesc(right.head_committed_at, left.head_committed_at) < 0;
}

function finalizeMergedProject(group: MutableGroup): MergedProjectRecord {
  const hosts = [...group.byHost.values()].sort((a, b) => a.host_id.localeCompare(b.host_id));
  const hostIds = hosts.map((h) => h.host_id);

  let latestCommitHost: string | null = null;
  let latestCommitHosts: string[] = [];
  let latestCommitAt: string | null = null;
  let latestActivityHost: string | null = null;
  let latestActivityAt: string | null = null;
  const branches = new Set<string>();
  const shas = new Set<string>();
  const dirtyHosts: string[] = [];
  const unpushedHosts: string[] = [];
  const behindHosts: string[] = [];
  const noUpstreamHosts: string[] = [];
  let totalSessions = 0;
  let totalTurns = 0;
  let hasAnyGitOk = false;
  let hasAnyInspectedGit = false;

  for (const host of hosts) {
    totalSessions += host.session_count;
    totalTurns += host.turn_count;

    if (host.git_status !== "unavailable") hasAnyInspectedGit = true;
    if (host.git_status === "ok") {
      hasAnyGitOk = true;
      if (host.branch) branches.add(host.branch);
      if (host.head_sha) shas.add(host.head_sha);
      if ((host.dirty_files ?? 0) > 0) dirtyHosts.push(host.host_id);
      if ((host.ahead ?? 0) > 0) unpushedHosts.push(host.host_id);
      if ((host.behind ?? 0) > 0) behindHosts.push(host.host_id);
      if (!host.upstream && host.branch && !host.detached) noUpstreamHosts.push(host.host_id);
    }

    if (host.head_committed_at) {
      if (isNewerIso(host.head_committed_at, latestCommitAt)) {
        latestCommitAt = host.head_committed_at;
        latestCommitHost = host.host_id;
        latestCommitHosts = [host.host_id];
      } else if (latestCommitAt && isSameInstant(host.head_committed_at, latestCommitAt)) {
        latestCommitHosts.push(host.host_id);
      }
    }

    if (host.last_activity_at && isNewerIso(host.last_activity_at, latestActivityAt)) {
      latestActivityAt = host.last_activity_at;
      latestActivityHost = host.host_id;
    }
  }

  const branchDiverged = branches.size >= 2;
  const commitDiverged = shas.size >= 2;

  const aheadBehindState: MergedProjectSyncState | null =
    unpushedHosts.length > 0 && behindHosts.length > 0
      ? "ahead_behind"
      : unpushedHosts.length > 0
        ? "unpushed"
        : behindHosts.length > 0
          ? "behind"
          : null;

  let syncState: MergedProjectSyncState;
  if (!hasAnyGitOk) {
    syncState = hasAnyInspectedGit ? "non_git" : "git_not_collected";
  } else if (hosts.length === 1) {
    if (dirtyHosts.length > 0) syncState = "dirty";
    else if (aheadBehindState) syncState = aheadBehindState;
    else syncState = "single_host";
  } else if (branchDiverged || commitDiverged) {
    syncState = "diverged";
  } else if (dirtyHosts.length > 0) {
    syncState = "dirty";
  } else if (aheadBehindState) {
    syncState = aheadBehindState;
  } else {
    syncState = "aligned";
  }

  const displayName = pickDisplayName(group);

  return {
    match_key: group.matchKey,
    match_kind: group.matchKind,
    display_name: displayName,
    repo_remote: group.repoRemote,
    host_ids: hostIds,
    host_count: hosts.length,
    sync_state: syncState,
    latest_commit_host: latestCommitHost,
    ...(latestCommitHosts.length > 0 ? { latest_commit_hosts: latestCommitHosts } : {}),
    latest_commit_at: latestCommitAt,
    latest_activity_host: latestActivityHost,
    latest_activity_at: latestActivityAt,
    branch_diverged: branchDiverged,
    commit_diverged: commitDiverged,
    dirty_hosts: dirtyHosts,
    unpushed_hosts: unpushedHosts,
    behind_hosts: behindHosts,
    ...(noUpstreamHosts.length > 0 ? { no_upstream_hosts: noUpstreamHosts } : {}),
    total_session_count: totalSessions,
    total_turn_count: totalTurns,
    hosts,
  };
}

function pickDisplayName(group: MutableGroup): string {
  if (group.repoRemote) {
    const repoLeaf = group.repoRemote.split("/").filter(Boolean).at(-1);
    if (repoLeaf) return repoLeaf;
  }
  const counts = new Map<string, number>();
  for (const name of group.displayNameCandidates) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = -1;
  for (const [name, count] of counts.entries()) {
    if (count > bestCount || (count === bestCount && best && name.localeCompare(best) < 0)) {
      best = name;
      bestCount = count;
    }
  }
  return best ?? group.matchKey;
}

function compareMergedProjects(left: MergedProjectRecord, right: MergedProjectRecord): number {
  const activityDiff = compareIsoDesc(left.latest_activity_at, right.latest_activity_at);
  if (activityDiff !== 0) return activityDiff;
  const commitDiff = compareIsoDesc(left.latest_commit_at, right.latest_commit_at);
  if (commitDiff !== 0) return commitDiff;
  return left.display_name.localeCompare(right.display_name) || left.match_key.localeCompare(right.match_key);
}

function isNewerIso(candidate: string, current: string | null): boolean {
  if (!current) return true;
  const candMs = Date.parse(candidate);
  const currMs = Date.parse(current);
  if (Number.isFinite(candMs) && Number.isFinite(currMs)) {
    return candMs > currMs;
  }
  return candidate > current;
}

function isSameInstant(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs === rightMs;
  return left === right;
}

function compareIsoDesc(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return rightMs - leftMs;
  }
  return right.localeCompare(left);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
