import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  sanitizeClaudeProjectFolder,
  sourceFileMayMatchDirectoryScope,
} from "./directory-preview.js";

test("sanitizeClaudeProjectFolder matches live Claude project directory names", () => {
  assert.equal(sanitizeClaudeProjectFolder("/root/coding/cchistory-lite"), "-root-coding-cchistory-lite");
  assert.equal(sanitizeClaudeProjectFolder("/root/coding/app_control"), "-root-coding-app-control");
  assert.equal(
    sanitizeClaudeProjectFolder("/root/deep-dive-workspace/.worktrees/frontend-bug-fixes"),
    "-root-deep-dive-workspace--worktrees-frontend-bug-fixes",
  );
});

test("Grok --dir skip uses encoded cwd relative to any base, not a hardcoded home", () => {
  const baseDir = "/opt/custom-grok";
  const matching = path.join(
    baseDir,
    "sessions",
    "%2Fworkspace%2Fkeep",
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "chat_history.jsonl",
  );
  const other = path.join(
    baseDir,
    "sessions",
    "%2Fworkspace%2Fother",
    "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
    "chat_history.jsonl",
  );
  const nested = path.join(
    baseDir,
    "sessions",
    "%2Fworkspace%2Fkeep%2Fpkg",
    "cccccccc-dddd-4eee-8fff-000000000000",
    "chat_history.jsonl",
  );
  assert.equal(
    sourceFileMayMatchDirectoryScope({
      platform: "grok",
      baseDir,
      filePath: matching,
      directoryScope: "/workspace/keep",
    }),
    "yes",
  );
  assert.equal(
    sourceFileMayMatchDirectoryScope({
      platform: "grok",
      baseDir,
      filePath: nested,
      directoryScope: "/workspace/keep",
    }),
    "yes",
  );
  assert.equal(
    sourceFileMayMatchDirectoryScope({
      platform: "grok",
      baseDir,
      filePath: other,
      directoryScope: "/workspace/keep",
    }),
    "no",
  );
});

test("Claude --dir skip uses the project folder under the resolved base_dir", () => {
  const baseDir = "/mnt/history/.claude/projects";
  const matching = path.join(baseDir, "-root-coding-cchistory-lite", "sess.jsonl");
  const other = path.join(baseDir, "-root-coding-reference", "sess.jsonl");
  assert.equal(
    sourceFileMayMatchDirectoryScope({
      platform: "claude_code",
      baseDir,
      filePath: matching,
      directoryScope: "/root/coding/cchistory-lite",
    }),
    "yes",
  );
  assert.equal(
    sourceFileMayMatchDirectoryScope({
      platform: "claude_code",
      baseDir,
      filePath: other,
      directoryScope: "/root/coding/cchistory-lite",
    }),
    "no",
  );
});

test("Factory --dir skip uses the same sanitized project folder as Claude", () => {
  const baseDir = "/mnt/history/.factory/sessions";
  const matching = path.join(baseDir, "-Users-mock-user-workspace-history-lab", "sess.jsonl");
  const other = path.join(baseDir, "-Users-mock-user-workspace-other", "sess.jsonl");
  assert.equal(
    sourceFileMayMatchDirectoryScope({
      platform: "factory_droid",
      baseDir,
      filePath: matching,
      directoryScope: "/Users/mock-user/workspace/history-lab",
    }),
    "yes",
  );
  assert.equal(
    sourceFileMayMatchDirectoryScope({
      platform: "factory_droid",
      baseDir,
      filePath: other,
      directoryScope: "/Users/mock-user/workspace/history-lab",
    }),
    "no",
  );
  assert.equal(
    sourceFileMayMatchDirectoryScope({
      platform: "factory_droid",
      baseDir,
      filePath: path.join(baseDir, "loose.jsonl"),
      directoryScope: "/Users/mock-user/workspace/history-lab",
    }),
    "uncertain",
  );
});

test("Cursor transcript --dir skip uses the project slug, not sqlite paths", () => {
  const matching = "/opt/cursor/projects/Users-test-my-app/agent-transcripts/aaaa/aaaa.jsonl";
  const other = "/opt/cursor/projects/Users-test-other/agent-transcripts/bbbb/bbbb.jsonl";
  const sqlite = "/opt/cursor/User/workspaceStorage/abc/state.vscdb";
  assert.equal(
    sourceFileMayMatchDirectoryScope({
      platform: "cursor_agent",
      baseDir: "/opt/cursor/projects",
      filePath: matching,
      directoryScope: "/Users/test/my-app",
    }),
    "yes",
  );
  assert.equal(
    sourceFileMayMatchDirectoryScope({
      platform: "cursor",
      baseDir: "/opt/cursor/projects",
      filePath: other,
      directoryScope: "/Users/test/my-app",
    }),
    "no",
  );
  assert.equal(
    sourceFileMayMatchDirectoryScope({
      platform: "cursor",
      baseDir: "/opt/cursor",
      filePath: sqlite,
      directoryScope: "/Users/test/my-app",
    }),
    "uncertain",
  );
});
