import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveSourceFileLogicalSessionKey,
  inspectSourceFileLogicalSessionMetadata,
  inspectSourceFilesLogicalSessionMetadata,
} from "./session-grouping.js";
import { deriveSessionId } from "./source-identity.js";
import { getRepoMockDataRoot } from "../test-helpers.js";
import { runSourceProbe } from "../index.js";

test("Codex delegated child metadata exposes its parent as a related session", async () => {
  const filePath = path.join(
    getRepoMockDataRoot(),
    ".codex",
    "sessions",
    "2026",
    "04",
    "12",
    "rollout-2026-04-12T09-01-00-codex-delegation-child.jsonl",
  );
  const metadata = await inspectSourceFileLogicalSessionMetadata("codex", filePath);

  assert.equal(metadata.sessionKey, "sess:codex:codex-delegation-child");
  assert.deepEqual(metadata.relatedSessionRefs, [
    "codex-delegation-parent",
    "sess:codex:codex-delegation-parent",
  ]);
});

test("Codex ordinary fork metadata does not expose its origin as a delegated parent", async () => {
  const filePath = path.join(
    getRepoMockDataRoot(),
    "fixtures",
    "source-shapes",
    "codex",
    "ordinary-fork.jsonl",
  );
  const metadata = await inspectSourceFileLogicalSessionMetadata("codex", filePath);

  assert.equal(metadata.sessionKey, "sess:codex:codex-ordinary-fork");
  assert.equal(metadata.relatedSessionRefs, undefined);
});

test("deriveSourceFileLogicalSessionKey keys on the first non-empty record", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cchistory-grouping-first-line-"));
  try {
    const filePath = path.join(dir, "session-file.jsonl");
    const firstRecord = JSON.stringify({
      type: "user",
      sessionId: "grouping-session-1",
      cwd: "/workspace/grouping",
      timestamp: "2026-07-01T00:00:00.000Z",
      message: { role: "user", content: "hello" },
    });
    await writeFile(filePath, `\n${firstRecord}\n`, "utf8");
    const key = await deriveSourceFileLogicalSessionKey("claude_code", filePath);
    assert.equal(key, deriveSessionId("claude_code", filePath, Buffer.from(firstRecord, "utf8")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deriveSourceFileLogicalSessionKey degrades to the path-based key when the file cannot be read", async () => {
  const missing = path.join(os.tmpdir(), `cchistory-grouping-missing-${process.pid}-${Date.now()}.jsonl`);
  const key = await deriveSourceFileLogicalSessionKey("claude_code", missing);
  assert.equal(key, deriveSessionId("claude_code", missing, Buffer.alloc(0)));
});

test("logical-session metadata follows canonical ordering across cwd changes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cchistory-grouping-directory-"));
  try {
    const claudePath = path.join(dir, "claude-stable.jsonl");
    await writeFile(
      claudePath,
      [
        { type: "file-history-snapshot", sessionId: "claude-stable" },
        {
          type: "user",
          sessionId: "claude-stable",
          cwd: "/workspace/stable",
          timestamp: "2026-07-01T00:00:00.000Z",
        },
        {
          type: "assistant",
          sessionId: "claude-stable",
          cwd: "/workspace/stable",
          timestamp: "2026-07-01T00:00:01.000Z",
          message: { content: [{ input: { cwd: "/workspace/tool-call" } }] },
        },
      ].map((row) => JSON.stringify(row)).join("\n"),
      "utf8",
    );
    assert.deepEqual(await inspectSourceFileLogicalSessionMetadata("claude_code", claudePath), {
      sessionKey: "sess:claude_code:claude-stable",
      sessionKeyState: "known",
      workingDirectoryState: "known",
      workingDirectory: "/workspace/stable",
    });

    const codexPath = path.join(dir, "codex-changed.jsonl");
    await writeFile(
      codexPath,
      [
        {
          type: "session_meta",
          timestamp: "2026-07-01T00:00:00.000Z",
          payload: { id: "codex-changed", cwd: "/workspace/first" },
        },
        {
          type: "turn_context",
          timestamp: "2026-07-01T00:00:01.000Z",
          payload: { cwd: "/workspace/final" },
        },
      ].map((row) => JSON.stringify(row)).join("\n"),
      "utf8",
    );
    assert.deepEqual(await inspectSourceFileLogicalSessionMetadata("codex", codexPath), {
      sessionKey: "sess:codex:codex-changed",
      sessionKeyState: "known",
      workingDirectoryState: "known",
      workingDirectory: "/workspace/final",
    });

    const nonmonotonicPath = path.join(dir, "codex-nonmonotonic.jsonl");
    await writeFile(
      nonmonotonicPath,
      [
        {
          type: "session_meta",
          timestamp: "2026-07-01T00:00:00.000Z",
          payload: { id: "codex-nonmonotonic", cwd: "/workspace/stable" },
        },
        {
          type: "turn_context",
          timestamp: "2026-07-01T00:00:02.000Z",
          payload: { cwd: "/workspace/future" },
        },
        {
          type: "turn_context",
          timestamp: "2026-07-01T00:00:01.000Z",
          payload: { cwd: "/workspace/stable" },
        },
      ].map((row) => JSON.stringify(row)).join("\n"),
      "utf8",
    );
    assert.deepEqual(await inspectSourceFileLogicalSessionMetadata("codex", nonmonotonicPath), {
      sessionKey: "sess:codex:codex-nonmonotonic",
      sessionKeyState: "known",
      workingDirectoryState: "known",
      workingDirectory: "/workspace/future",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("logical-session metadata workers preserve source file order", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cchistory-grouping-workers-"));
  try {
    const filePaths: string[] = [];
    for (let index = 0; index < 16; index += 1) {
      const filePath = path.join(dir, `session-${index}.jsonl`);
      filePaths.push(filePath);
      await writeFile(
        filePath,
        JSON.stringify({
          type: "user",
          sessionId: `worker-session-${index}`,
          cwd: `/workspace/worker-${index}`,
          timestamp: `2026-07-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        }),
        "utf8",
      );
    }

    const metadata = await inspectSourceFilesLogicalSessionMetadata("claude_code", filePaths);
    assert.deepEqual(
      metadata.map((entry) => entry.sessionKey),
      filePaths.map((_, index) => `sess:claude_code:worker-session-${index}`),
    );
    assert.ok(metadata.every((entry) => entry.workingDirectoryState === "known"));
    assert.ok(metadata.every((entry) => entry.sessionKeyState === "known"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("logical-session metadata scans large JSONL files without losing the final cwd", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cchistory-grouping-stream-"));
  try {
    const filePath = path.join(dir, "large-session.jsonl");
    await writeFile(
      filePath,
      [
        {
          type: "session_meta",
          timestamp: "2026-07-01T00:00:00.000Z",
          payload: { id: "large-session", cwd: "/workspace/initial" },
        },
        ...Array.from({ length: 40_000 }, () => ({})),
        {
          type: "response_item",
          timestamp: "2026-07-01T00:00:02.000Z",
          payload: { type: "function_call", arguments: { cwd: "/workspace/tool-argument" } },
        },
        {
          type: "turn_context",
          timestamp: "2026-07-01T00:00:01.000Z",
          payload: { cwd: "/workspace/final" },
        },
      ].map((row) => JSON.stringify(row)).join("\n"),
      "utf8",
    );

    const metadata = await inspectSourceFileLogicalSessionMetadata("codex", filePath);
    assert.deepEqual(metadata, {
      sessionKey: "sess:codex:large-session",
      sessionKeyState: "known",
      workingDirectoryState: "known",
      workingDirectory: "/workspace/final",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Claude logical-session metadata scans large JSONL files and ignores nested cwd fields", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cchistory-grouping-claude-stream-"));
  try {
    const filePath = path.join(dir, "large-claude-session.jsonl");
    await writeFile(
      filePath,
      [
        {
          type: "user",
          sessionId: "large-claude-session",
          cwd: "/workspace/initial",
          timestamp: "2026-07-01T00:00:00.000Z",
        },
        ...Array.from({ length: 40_000 }, () => ({})),
        {
          type: "assistant",
          sessionId: "large-claude-session",
          cwd: "/workspace/final",
          timestamp: "2026-07-01T00:00:02.000Z",
          message: { content: [{ type: "tool_use", input: { cwd: "/workspace/tool-argument" } }] },
        },
      ].map((row) => JSON.stringify(row)).join("\n"),
      "utf8",
    );

    assert.deepEqual(await inspectSourceFileLogicalSessionMetadata("claude_code", filePath), {
      sessionKey: "sess:claude_code:large-claude-session",
      sessionKeyState: "known",
      workingDirectoryState: "known",
      workingDirectory: "/workspace/final",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("logical-session metadata bounds oversized records and degrades conservatively", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cchistory-grouping-oversized-line-"));
  try {
    const knownHeadPath = path.join(dir, "known-head.jsonl");
    await writeFile(
      knownHeadPath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-07-01T00:00:00.000Z",
          payload: { id: "known-oversized-body", cwd: "/workspace/known" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-01T00:00:01.000Z",
          payload: { type: "function_call_output", output: "x".repeat(2 * 1024 * 1024) },
        }),
      ].join("\n"),
      "utf8",
    );

    assert.deepEqual(
      await inspectSourceFileLogicalSessionMetadata("codex", knownHeadPath, { includeWorkspaceMetadata: false }),
      {
        sessionKey: "sess:codex:known-oversized-body",
        sessionKeyState: "known",
        workingDirectoryState: "absent",
      },
    );
    assert.deepEqual(await inspectSourceFileLogicalSessionMetadata("codex", knownHeadPath), {
      sessionKey: "sess:codex:known-oversized-body",
      sessionKeyState: "known",
      workingDirectoryState: "uncertain",
    });

    const oversizedHeadPath = path.join(dir, "oversized-head.jsonl");
    await writeFile(
      oversizedHeadPath,
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-01T00:00:00.000Z",
        payload: {
          padding: "x".repeat(2 * 1024 * 1024),
          id: "hidden-after-bound",
          cwd: "/workspace/hidden",
        },
      }),
      "utf8",
    );
    const oversizedHead = await inspectSourceFileLogicalSessionMetadata("codex", oversizedHeadPath);
    assert.equal(oversizedHead.sessionKeyState, "uncertain");
    assert.equal(oversizedHead.workingDirectoryState, "uncertain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("targeted Claude probes conservatively include an oversized identity record", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cchistory-grouping-oversized-target-"));
  try {
    const sessionId = "claude-hidden-after-metadata-bound";
    const filePath = path.join(dir, "opaque-name.jsonl");
    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: "user",
          padding: "x".repeat(2 * 1024 * 1024),
          sessionId,
          cwd: "/workspace/oversized-target",
          timestamp: "2026-07-01T00:00:00.000Z",
          message: { role: "user", content: "Recover the oversized target." },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId,
          cwd: "/workspace/oversized-target",
          timestamp: "2026-07-01T00:00:01.000Z",
          message: { role: "assistant", content: "Recovered." },
        }),
      ].join("\n"),
      "utf8",
    );

    const source = {
      id: "src-claude-oversized-target",
      slot_id: "claude_code",
      family: "local_coding_agent" as const,
      platform: "claude_code" as const,
      display_name: "Claude oversized target fixture",
      base_dir: dir,
    };
    const payload = (await runSourceProbe({
      source_ids: [source.id],
      target_session_refs: [sessionId],
      safe_mode: true,
    }, [source])).sources[0];

    assert.deepEqual(payload?.sessions.map((session) => session.source_session_id), [sessionId]);
    assert.equal(payload?.turns[0]?.canonical_text, "Recover the oversized target.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("streaming probes preserve identities for records between the old and new bounds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cchistory-grouping-streaming-identity-"));
  try {
    const sessionId = "claude-streaming-identity";
    const filePath = path.join(dir, "opaque-name.jsonl");
    const firstRecord = JSON.stringify({
      type: "user",
      sessionId,
      cwd: "/workspace/streaming-identity",
      timestamp: "2026-07-01T00:00:00.000Z",
      message: { role: "user", content: "Preserve this identity." },
      padding: "x".repeat(128 * 1024),
    });
    assert.ok(firstRecord.length > 64 * 1024);
    assert.ok(firstRecord.length <= 1024 * 1024);
    await writeFile(
      filePath,
      [
        firstRecord,
        JSON.stringify({
          type: "assistant",
          sessionId,
          cwd: "/workspace/streaming-identity",
          timestamp: "2026-07-01T00:00:01.000Z",
          message: { role: "assistant", content: "Identity preserved." },
        }),
      ].join("\n"),
      "utf8",
    );

    const source = {
      id: "src-claude-streaming-identity",
      slot_id: "claude_code",
      family: "local_coding_agent" as const,
      platform: "claude_code" as const,
      display_name: "Claude streaming identity fixture",
      base_dir: dir,
    };
    const probeOptions = {
      source_ids: [source.id],
      max_file_bytes: 64 * 1024,
      safe_mode: true,
    };
    const fullPayload = (await runSourceProbe(probeOptions, [source])).sources[0];
    assert.deepEqual(fullPayload?.sessions.map((session) => session.source_session_id), [sessionId]);

    const targetedPayload = (await runSourceProbe({
      ...probeOptions,
      target_session_refs: [sessionId],
    }, [source])).sources[0];
    assert.deepEqual(targetedPayload?.sessions.map((session) => session.source_session_id), [sessionId]);
    assert.equal(targetedPayload?.turns[0]?.canonical_text, "Preserve this identity.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
