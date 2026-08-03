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
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("logical-session metadata bounds inspection for large JSONL files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cchistory-grouping-prefix-"));
  try {
    const filePath = path.join(dir, "large-session.jsonl");
    const firstRecord = JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-01T00:00:00.000Z",
      payload: { id: "large-session", cwd: "/workspace/large" },
    });
    await writeFile(filePath, `${firstRecord}\n${"{}\n".repeat(40_000)}`, "utf8");

    const metadata = await inspectSourceFileLogicalSessionMetadata("codex", filePath);
    assert.equal(metadata.sessionKey, "sess:codex:large-session");
    assert.equal(metadata.workingDirectoryState, "uncertain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
