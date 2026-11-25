/**
 * Role: Unit tests for pure zero-I/O cross-host project reconciliation and
 * projects v1 envelope builders.
 * Excludes local Git process execution (tested in source-adapters and lite-cli).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { HostProjectSnapshotInput } from "@cchistory/domain";
import {
  buildMergedProjectsEnvelope,
  buildProjectsEnvelope,
  mergeHostProjectSnapshots,
} from "./project-merge.js";
import { normalizeDirectoryScopePath } from "./directory-scope.js";

test("mergeHostProjectSnapshots reconciles by canonical remote and directory_fallback across sync states", () => {
  const inputs: HostProjectSnapshotInput[] = [
    {
      host_id: "mac-studio",
      projects: [
        // 1. Diverged & dirty repo (HTTPS remote with embedded creds & uppercase)
        {
          project_id: "proj-a1",
          display_name: "cchistory-lite",
          primary_workspace_path: "/Users/mock_user/workspace/cchistory-lite",
          repo_root: "/Users/mock_user/workspace/cchistory-lite",
          repo_remote: "https://user:token@github.com/ExampleOrg/CCHistory-Lite.git",
          source_platforms: ["codex", "claude_code"],
          session_count: 8,
          turn_count: 40,
          last_activity_at: "2026-11-25T09:00:00.000Z",
          git: {
            status: "ok",
            repo_root: "/Users/mock_user/workspace/cchistory-lite",
            repo_remote: "github.com/exampleorg/cchistory-lite",
            branch: "feat/inventory",
            head_sha: "aaaaaaa111111111111111111111111111111111",
            head_committed_at: "2026-11-25T08:30:00.000Z",
            dirty_files: 3,
            ahead: 2,
            behind: 0,
            upstream: "origin/feat/inventory",
          },
        },
        // 2. Ahead/behind aligned branch
        {
          project_id: "proj-b1",
          display_name: "infra-notes",
          primary_workspace_path: "/Users/mock_user/workspace/infra-notes",
          repo_remote: "git@github.com:ExampleOrg/infra-notes.git",
          session_count: 2,
          turn_count: 5,
          last_activity_at: "2026-11-24T10:00:00.000Z",
          git: {
            status: "ok",
            repo_root: "/Users/mock_user/workspace/infra-notes",
            repo_remote: "github.com/exampleorg/infra-notes",
            branch: "main",
            head_sha: "bbbbbbb111111111111111111111111111111111",
            head_committed_at: "2026-11-24T09:00:00.000Z",
            dirty_files: 0,
            ahead: 1,
            behind: 0,
            upstream: "origin/main",
          },
        },
        // 3. Non-Git project matched by directory_fallback
        {
          project_id: "proj-c1",
          display_name: "ScratchPad",
          primary_workspace_path: "/Users/mock_user/notes/ScratchPad/",
          session_count: 3,
          turn_count: 7,
          last_activity_at: "2026-11-23T15:00:00.000Z",
          git: {
            status: "not_git",
            repo_root: null,
            repo_remote: null,
            branch: null,
            head_sha: null,
            head_committed_at: null,
            dirty_files: null,
            ahead: null,
            behind: null,
          },
        },
      ],
    },
    {
      host_id: "homelab-linux",
      projects: [
        // Matches #1 via SSH SCP remote
        {
          project_id: "proj-a2",
          display_name: "cchistory-lite-clone",
          primary_workspace_path: "/srv/code/cchistory-lite",
          repo_remote: "git@github.com:exampleorg/cchistory-lite.git",
          source_platforms: ["opencode"],
          session_count: 4,
          turn_count: 15,
          last_activity_at: "2026-11-24T22:00:00.000Z",
          git: {
            status: "ok",
            repo_root: "/srv/code/cchistory-lite",
            repo_remote: "github.com/exampleorg/cchistory-lite",
            branch: "main",
            head_sha: "ccccccc222222222222222222222222222222222",
            head_committed_at: "2026-11-24T20:00:00.000Z",
            dirty_files: 0,
            ahead: 0,
            behind: 1,
            upstream: "origin/main",
          },
        },
        // Matches #2 same SHA, clean, behind=0 (tests ahead_behind from mac-studio)
        {
          project_id: "proj-b2",
          display_name: "infra-notes",
          primary_workspace_path: "/srv/code/infra-notes",
          repo_remote: "https://github.com/exampleorg/infra-notes",
          session_count: 1,
          turn_count: 2,
          last_activity_at: "2026-11-24T12:00:00.000Z",
          git: {
            status: "ok",
            repo_root: "/srv/code/infra-notes",
            repo_remote: "github.com/exampleorg/infra-notes",
            branch: "main",
            head_sha: "bbbbbbb111111111111111111111111111111111",
            head_committed_at: "2026-11-24T09:00:00.000Z",
            dirty_files: 0,
            ahead: 0,
            behind: 2,
            upstream: "origin/main",
          },
        },
        // Matches #3 by directory_fallback (case-insensitive basename)
        {
          project_id: "proj-c2",
          display_name: "scratchpad",
          primary_workspace_path: "/home/ops/scratchpad",
          session_count: 1,
          turn_count: 2,
          last_activity_at: "2026-11-22T09:00:00.000Z",
        },
        // 4. Single-host aligned repo
        {
          project_id: "proj-d2",
          display_name: "solo-service",
          primary_workspace_path: "/srv/code/solo-service",
          repo_remote: "ssh://git@git.internal.lan:2222/team/solo-service.git",
          session_count: 1,
          turn_count: 3,
          last_activity_at: "2026-11-20T08:00:00.000Z",
          git: {
            status: "ok",
            repo_root: "/srv/code/solo-service",
            repo_remote: "git.internal.lan:2222/team/solo-service",
            branch: "main",
            head_sha: "ddddddd333333333333333333333333333333333",
            head_committed_at: "2026-11-20T07:00:00.000Z",
            dirty_files: 0,
            ahead: 0,
            behind: 0,
            upstream: "origin/main",
          },
        },
      ],
    },
  ];

  const report = mergeHostProjectSnapshots(inputs, { nowIso: "2026-11-25T10:00:00.000Z" });
  assert.equal(report.summary.host_count, 2);
  assert.equal(report.summary.project_count, 4);
  assert.equal(report.summary.repo_remote_matched_count, 3);
  assert.equal(report.summary.directory_fallback_count, 1);
  assert.equal(report.summary.multi_host_project_count, 3);
  assert.equal(report.summary.diverged_project_count, 1);
  assert.equal(report.summary.dirty_project_count, 1);
  assert.equal(report.summary.unpushed_project_count, 2);
  assert.equal(report.summary.behind_project_count, 2);

  const byKey = new Map(report.projects.map((p) => [p.match_key, p]));
  const lite = byKey.get("remote:github.com/exampleorg/cchistory-lite")!;
  assert.equal(lite.match_kind, "repo_remote");
  assert.equal(lite.sync_state, "diverged");
  assert.equal(lite.branch_diverged, true);
  assert.equal(lite.commit_diverged, true);
  assert.equal(lite.latest_commit_host, "mac-studio");
  assert.equal(lite.latest_activity_host, "mac-studio");
  assert.deepEqual(lite.dirty_hosts, ["mac-studio"]);
  assert.deepEqual(lite.unpushed_hosts, ["mac-studio"]);
  assert.deepEqual(lite.behind_hosts, ["homelab-linux"]);
  assert.equal(lite.total_session_count, 12);
  assert.equal(lite.total_turn_count, 55);

  const infra = byKey.get("remote:github.com/exampleorg/infra-notes")!;
  assert.equal(infra.sync_state, "ahead_behind");
  assert.deepEqual(infra.unpushed_hosts, ["mac-studio"]);
  assert.deepEqual(infra.behind_hosts, ["homelab-linux"]);

  const scratch = byKey.get("dir:scratchpad")!;
  assert.equal(scratch.match_kind, "directory_fallback");
  assert.equal(scratch.sync_state, "non_git");
  assert.deepEqual(scratch.host_ids, ["homelab-linux", "mac-studio"]);

  const solo = byKey.get("remote:git.internal.lan:2222/team/solo-service")!;
  assert.equal(solo.sync_state, "single_host");

  const mergedEnvelope = buildMergedProjectsEnvelope(report, { hostId: "aggregator" });
  assert.equal(mergedEnvelope.schema_version, 1);
  assert.equal(mergedEnvelope.domain, "projects");
  assert.equal(mergedEnvelope.owner, "cchistory-lite");
  assert.equal(mergedEnvelope.delta, null);
  assert.equal(mergedEnvelope.items.length, 4);

  const localEnvelope = buildProjectsEnvelope(inputs[0]!.projects, {
    hostId: "mac-studio",
    generatedAt: "2026-11-25T10:00:00.000Z",
    totalProjectCount: 10,
  });
  assert.equal(localEnvelope.domain, "projects");
  assert.equal(localEnvelope.status, "partial");
  assert.equal(localEnvelope.summary.total_project_count, 10);
  assert.equal(localEnvelope.summary.truncated, true);
  assert.equal(localEnvelope.summary.git_inspected, true);
  assert.equal(localEnvelope.summary.git_dirty_count, 1);
  assert.equal(localEnvelope.summary.git_unpushed_count, 2);
  assert.equal(localEnvelope.delta, null);

  // Uninspected Git envelope must report null git counts rather than 0
  const plainProjects = [{ display_name: "plain", primary_workspace_path: "/tmp/plain", git: undefined }];
  const noGitEnvelope = buildProjectsEnvelope(plainProjects, {
    hostId: "mac-studio",
    generatedAt: "2026-11-25T10:00:00.000Z",
    gitInspected: false,
  });
  assert.equal(noGitEnvelope.summary.git_inspected, false);
  assert.equal(noGitEnvelope.summary.git_dirty_count, null);
  assert.equal(noGitEnvelope.summary.git_unpushed_count, null);
  assert.equal(noGitEnvelope.summary.git_behind_count, null);
});

test("mergeHostProjectSnapshots distinguishes git_not_collected, unpushed, behind, no_upstream, warnings, and darwin /private/tmp scope", () => {
  const noGitReport = mergeHostProjectSnapshots(
    [
      {
        host_id: "host-a",
        source_file: "host-a.json",
        total_projects: 25,
        truncated: true,
        host_id_inferred_from_filename: true,
        projects: [{ display_name: "beta", primary_workspace_path: "/work/a/beta" }],
      },
      {
        host_id: "host-b",
        source_file: "host-b.json",
        projects: [{ display_name: "beta", primary_workspace_path: "/work/b/beta" }],
      },
    ],
    { nowIso: "2026-11-25T10:00:00.000Z" },
  );
  assert.equal(noGitReport.projects[0]?.sync_state, "git_not_collected");
  assert.equal(noGitReport.summary.git_not_collected_project_count, 1);
  assert.ok((noGitReport.warnings?.length ?? 0) >= 3);
  const partialEnv = buildMergedProjectsEnvelope(noGitReport, { hostId: "agg" });
  assert.equal(partialEnv.status, "partial");

  const fineStateReport = mergeHostProjectSnapshots([
    {
      host_id: "h1",
      projects: [
        {
          display_name: "behind-only",
          repo_remote: "github.com/acme/behind-only",
          git: {
            status: "ok",
            repo_root: "/r/behind-only",
            repo_remote: "github.com/acme/behind-only",
            branch: "main",
            head_sha: "1111111",
            head_committed_at: "2026-11-20T00:00:00.000Z",
            dirty_files: 0,
            ahead: 0,
            behind: 1,
            upstream: "origin/main",
          },
        },
        {
          display_name: "local-branch",
          repo_remote: "github.com/acme/local-branch",
          git: {
            status: "ok",
            repo_root: "/r/local-branch",
            repo_remote: "github.com/acme/local-branch",
            branch: "feat/new",
            head_sha: "2222222",
            head_committed_at: "2026-11-21T00:00:00.000Z",
            dirty_files: 0,
            ahead: null,
            behind: null,
            upstream: null,
          },
        },
      ],
    },
    {
      host_id: "h2",
      projects: [
        {
          display_name: "behind-only",
          repo_remote: "github.com/acme/behind-only",
          git: {
            status: "ok",
            repo_root: "/r/behind-only",
            repo_remote: "github.com/acme/behind-only",
            branch: "main",
            head_sha: "1111111",
            head_committed_at: "2026-11-20T00:00:00.000Z",
            dirty_files: 0,
            ahead: 0,
            behind: 1,
            upstream: "origin/main",
          },
        },
      ],
    },
  ]);
  const behindProj = fineStateReport.projects.find((p) => p.display_name === "behind-only")!;
  assert.equal(behindProj.sync_state, "behind");
  assert.deepEqual(behindProj.latest_commit_hosts, ["h1", "h2"]);
  const localBranchProj = fineStateReport.projects.find((p) => p.display_name === "local-branch")!;
  assert.deepEqual(localBranchProj.no_upstream_hosts, ["h1"]);
  assert.equal(fineStateReport.summary.no_upstream_project_count, 1);

  assert.equal(
    normalizeDirectoryScopePath("/private/tmp/demo/repo", { platform: "darwin" }),
    normalizeDirectoryScopePath("/tmp/demo/repo", { platform: "darwin" }),
  );
  assert.equal(
    normalizeDirectoryScopePath("/private/var/folders/x", { platform: "darwin" }),
    normalizeDirectoryScopePath("/var/folders/x", { platform: "darwin" }),
  );
});
