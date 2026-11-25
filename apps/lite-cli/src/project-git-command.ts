/**
 * Role: CLI handlers for Slice B — formatting opt-in `ls projects --with-git` lines
 * and executing `merge-projects <file1.json> <file2.json> [...]` pure multi-host
 * project reconciliation over exported JSON snapshots.
 * Excludes local Git execution (source-adapters) and merge semantics (canonical).
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatRelativeTime,
  type HostProjectEntryInput,
  type HostProjectSnapshotInput,
  type MergedProjectsReport,
  type ProjectGitMetadata,
} from "@cchistory/domain";
import {
  buildMergedProjectsEnvelope,
  mergeHostProjectSnapshots,
} from "@cchistory/live-runtime";
import type { JsonOutputMode } from "./json-v2.js";

export interface ProjectGitCliIo {
  cwd: string;
  hostname?: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now?: () => number;
}

export interface ParsedMergeProjectsArgs {
  positionals: string[];
  values: Map<string, string[]>;
  booleans: Set<string>;
}

export interface MergeProjectsDeps {
  UsageError: new (message: string, code?: string) => Error;
}

export function formatProjectGitLine(git: ProjectGitMetadata | undefined): string | undefined {
  if (!git) return undefined;
  if (git.status === "missing_path") return "git: local path missing";
  if (git.status === "not_git") return "git: not a git repository";
  if (git.status === "timeout") return "git: inspection timed out";
  if (git.status === "error") return `git: error (${git.error ?? "unknown"})`;

  const branchLabel = git.branch ? (git.detached ? `${git.branch} (detached)` : git.branch) : "unborn";
  const shaShort = git.head_sha ? git.head_sha.slice(0, 7) : "-";
  const dirtyPart =
    git.dirty_files === null
      ? "dirty ?"
      : git.dirty_files === 0
        ? "clean"
        : `${git.dirty_files} dirty`;
  const parts = [`${branchLabel} @ ${shaShort}`, dirtyPart];
  if (git.ahead !== null || git.behind !== null) {
    parts.push(`↑${git.ahead ?? 0}/↓${git.behind ?? 0}`);
  } else if (!git.upstream && git.branch && !git.detached) {
    parts.push("no upstream");
  }
  if (git.repo_remote) {
    parts.push(git.repo_remote);
  }
  return `git: ${parts.join(" · ")}`;
}

export async function runMergeProjectsCommand(
  parsed: ParsedMergeProjectsArgs,
  io: ProjectGitCliIo,
  jsonMode: JsonOutputMode,
  deps: MergeProjectsDeps,
): Promise<void> {
  if (parsed.positionals.length === 0) {
    throw new deps.UsageError(
      "merge-projects requires at least one project snapshot JSON file (for example: cchistory-lite merge-projects host-a.json host-b.json --json).",
    );
  }

  const nowMs = io.now?.() ?? Date.now();
  const useEnvelope = parsed.booleans.has("envelope");
  const hostIdEntries = parsed.values.get("host-id") ?? [];
  if (hostIdEntries.length > 1) {
    throw new deps.UsageError("--host-id may only be specified once.");
  }
  const envelopeHostId = hostIdEntries.at(-1) ?? io.hostname ?? os.hostname();

  const snapshots: HostProjectSnapshotInput[] = [];
  const seenHosts = new Map<string, string>();
  for (const rawFilePath of parsed.positionals) {
    const resolvedPath = path.resolve(io.cwd, rawFilePath);
    let rawText: string;
    try {
      rawText = await readFile(resolvedPath, "utf8");
    } catch (error) {
      throw new deps.UsageError(
        `Could not read snapshot file ${rawFilePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch (error) {
      throw new deps.UsageError(
        `Invalid JSON in ${rawFilePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const snapshot = parseHostProjectSnapshot(parsedJson, resolvedPath, deps.UsageError);
    const hostKey = snapshot.host_id.trim().toLowerCase();
    const existingFile = seenHosts.get(hostKey);
    if (existingFile) {
      throw new deps.UsageError(
        `Duplicate host_id ${JSON.stringify(snapshot.host_id)} in ${rawFilePath} and ${existingFile}. ` +
          `Re-export each host snapshot with a distinct --host-id <name> (for example: cchistory-lite ls projects --no-dir --all --with-git --host-id <name> --json).`,
      );
    }
    seenHosts.set(hostKey, rawFilePath);
    snapshots.push(snapshot);
  }

  const report = mergeHostProjectSnapshots(snapshots, {
    nowIso: new Date(nowMs).toISOString(),
  });

  if (useEnvelope) {
    const envelope = buildMergedProjectsEnvelope(report, { hostId: envelopeHostId });
    io.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }

  if (jsonMode !== "none") {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  io.stdout(renderMergedProjectsReport(report, nowMs));
}

export function parseHostProjectSnapshot(
  raw: unknown,
  filePath: string,
  UsageError: MergeProjectsDeps["UsageError"],
): HostProjectSnapshotInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError(`Snapshot ${filePath} must be a JSON object.`);
  }
  const obj = raw as Record<string, unknown>;
  const fallbackHostId = path.basename(filePath, path.extname(filePath)) || "host";

  // 1. ReadOnlyEnvelopeV1 (`schema_version: 1, domain: "projects", items: [...]`)
  if (obj.schema_version === 1 && obj.domain === "projects" && Array.isArray(obj.items)) {
    const explicitHost = asNonEmptyString(obj.host_id);
    const summaryObj = obj.summary && typeof obj.summary === "object" && !Array.isArray(obj.summary)
      ? (obj.summary as Record<string, unknown>)
      : undefined;
    const totalProjects = typeof summaryObj?.total_project_count === "number" ? summaryObj.total_project_count : null;
    const truncated = summaryObj?.truncated === true || (totalProjects !== null && totalProjects > obj.items.length);
    return {
      host_id: explicitHost ?? fallbackHostId,
      ...(explicitHost ? {} : { host_id_inferred_from_filename: true }),
      generated_at: asNonEmptyString(obj.generated_at) ?? null,
      source_file: filePath,
      ...(totalProjects !== null ? { total_projects: totalProjects } : {}),
      ...(truncated ? { truncated: true } : {}),
      projects: obj.items.map((item, idx) => normalizeProjectEntry(item, filePath, idx, UsageError)),
    };
  }

  // 2. Standard `ls projects --json` (`cchistory-lite/v2`), canonical JSON, or raw `{ host_id, projects }`
  if (Array.isArray(obj.projects)) {
    const projects = obj.projects.map((item, idx) => normalizeProjectEntry(item, filePath, idx, UsageError));
    const explicitHost = asNonEmptyString(obj.host_id);
    const inferredHost = explicitHost ?? inferHostIdFromRawProjects(obj.projects);
    const totalProjects = typeof obj.total === "number" ? obj.total : null;
    const truncated = totalProjects !== null && totalProjects > projects.length;
    return {
      host_id: inferredHost ?? fallbackHostId,
      ...(inferredHost ? {} : { host_id_inferred_from_filename: true }),
      generated_at:
        asNonEmptyString(obj.generated_at) ??
        asNonEmptyString((obj.read as Record<string, unknown> | undefined)?.prepared_at) ??
        null,
      source_file: filePath,
      ...(totalProjects !== null ? { total_projects: totalProjects } : {}),
      ...(truncated ? { truncated: true } : {}),
      projects,
    };
  }

  throw new UsageError(
    `Snapshot ${filePath} does not look like a projects list (expected a top-level "projects" array or a v1 "projects" envelope).`,
  );
}

function normalizeProjectEntry(
  raw: unknown,
  filePath: string,
  index: number,
  UsageError: MergeProjectsDeps["UsageError"],
): HostProjectEntryInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError(`Snapshot ${filePath} project entry #${index} must be an object.`);
  }
  const rec = raw as Record<string, unknown>;
  const displayName =
    asNonEmptyString(rec.display_name) ??
    asNonEmptyString(rec.repo_remote) ??
    asNonEmptyString(rec.primary_workspace_path) ??
    asNonEmptyString(rec.repo_root) ??
    `project-${index}`;

  const committedTurns = typeof rec.committed_turn_count === "number" ? rec.committed_turn_count : 0;
  const candidateTurns = typeof rec.candidate_turn_count === "number" ? rec.candidate_turn_count : 0;
  const turnCount = typeof rec.turn_count === "number" ? rec.turn_count : committedTurns + candidateTurns;

  const gitRaw = rec.git && typeof rec.git === "object" && !Array.isArray(rec.git)
    ? (rec.git as ProjectGitMetadata)
    : null;

  return {
    project_id: asNonEmptyString(rec.project_id),
    display_name: displayName,
    slug: asNonEmptyString(rec.slug),
    primary_workspace_path: asNonEmptyString(rec.primary_workspace_path) ?? null,
    repo_root: asNonEmptyString(rec.repo_root) ?? null,
    repo_remote: asNonEmptyString(rec.repo_remote) ?? null,
    source_platforms: Array.isArray(rec.source_platforms)
      ? rec.source_platforms.filter((item): item is string => typeof item === "string")
      : [],
    session_count: typeof rec.session_count === "number" ? rec.session_count : 0,
    turn_count: turnCount,
    last_activity_at:
      asNonEmptyString(rec.last_activity_at) ??
      asNonEmptyString(rec.project_last_activity_at) ??
      null,
    git: gitRaw,
  };
}

function inferHostIdFromRawProjects(rawProjects: unknown[]): string | undefined {
  for (const item of rawProjects) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (Array.isArray(rec.host_ids)) {
      const first = rec.host_ids.find((v): v is string => typeof v === "string" && v.trim().length > 0);
      if (first) return first.trim();
    }
  }
  return undefined;
}

export function renderMergedProjectsReport(report: MergedProjectsReport, nowMs = Date.now()): string {
  const { summary } = report;
  const allWithoutGit =
    report.projects.length > 0 && report.projects.every((project) => project.sync_state === "git_not_collected");
  const gitSummaryTail = allWithoutGit
    ? " · git: unavailable (re-export with --with-git)"
    : ` · ${summary.diverged_project_count} diverged` +
      ` · ${summary.dirty_project_count} dirty` +
      ` · ${summary.unpushed_project_count} unpushed` +
      ` · ${summary.behind_project_count} behind`;
  const lines: string[] = [
    `Merged Projects · ${summary.project_count} projects across ${summary.host_count} hosts` +
      ` · ${summary.multi_host_project_count} multi-host` +
      gitSummaryTail,
    `Hosts: ${report.hosts.join(", ") || "-"}`,
  ];

  if (report.warnings && report.warnings.length > 0) {
    lines.push("", `Warnings (${report.warnings.length})`);
    for (const warning of report.warnings) {
      lines.push(`  [warning] ${warning}`);
    }
  }
  lines.push("");

  if (report.projects.length === 0) {
    lines.push("  (no projects in input snapshots)");
    return `${lines.join("\n")}\n`;
  }

  for (const project of report.projects) {
    const matchTag = project.repo_remote ? project.repo_remote : "directory_fallback";
    lines.push(`● ${project.display_name} [${project.sync_state}] · ${matchTag}`);

    const alerts: string[] = [];
    const latestHosts = project.latest_commit_hosts?.length
      ? project.latest_commit_hosts
      : project.latest_commit_host
        ? [project.latest_commit_host]
        : [];
    if (latestHosts.length > 0) {
      const commitRel = project.latest_commit_at ? ` (${formatRelativeTime(project.latest_commit_at, nowMs)})` : "";
      const sharedSha = !project.commit_diverged ? project.hosts.find((h) => h.head_sha)?.head_sha?.slice(0, 7) : undefined;
      if (latestHosts.length > 1 && sharedSha) {
        alerts.push(`aligned @ ${sharedSha}${commitRel}`);
      } else {
        alerts.push(`latest commit: ${latestHosts.join(", ")}${commitRel}`);
      }
    }
    if (project.branch_diverged) alerts.push("branch diverged");
    else if (project.commit_diverged) alerts.push("commit diverged");
    if (project.dirty_hosts.length > 0) alerts.push(`dirty: ${project.dirty_hosts.join(",")}`);
    if (project.unpushed_hosts.length > 0) alerts.push(`unpushed: ${project.unpushed_hosts.join(",")}`);
    if (project.behind_hosts.length > 0) alerts.push(`behind: ${project.behind_hosts.join(",")}`);
    if (project.no_upstream_hosts && project.no_upstream_hosts.length > 0) {
      alerts.push(`no upstream: ${project.no_upstream_hosts.join(",")}`);
    }
    if (alerts.length > 0) {
      lines.push(`  ${alerts.join(" · ")}`);
    }

    for (const host of project.hosts) {
      const gitParts: string[] = [];
      if (host.git_status === "ok") {
        gitParts.push(`${host.branch ?? "unborn"}@${host.head_sha ? host.head_sha.slice(0, 7) : "-"}`);
        gitParts.push(host.dirty_files && host.dirty_files > 0 ? `dirty:${host.dirty_files}` : "clean");
        if (host.ahead !== null || host.behind !== null) {
          gitParts.push(`↑${host.ahead ?? 0}/↓${host.behind ?? 0}`);
        } else if (!host.upstream && host.branch && !host.detached) {
          gitParts.push("no upstream");
        }
      } else {
        gitParts.push(`git:${host.git_status}`);
      }
      const commitPart =
        host.git_status === "ok" && host.head_committed_at
          ? `commit ${formatRelativeTime(host.head_committed_at, nowMs)}`
          : null;
      const activityPart = host.last_activity_at
        ? `active ${formatRelativeTime(host.last_activity_at, nowMs)}`
        : "no activity";
      const pathPart =
        project.match_kind === "directory_fallback"
          ? host.workspace_path ?? host.repo_root ?? "(path unknown)"
          : null;
      const tail = [
        commitPart,
        activityPart,
        `${host.session_count} sessions / ${host.turn_count} turns`,
        pathPart,
      ]
        .filter(Boolean)
        .join(" · ");
      lines.push(`  ${host.host_id}: ${gitParts.join(" ")} · ${tail}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
