import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDefaultSourcesForHost, listSourceFiles, runSourceProbe } from "../index.js";
import { createSourceDefinition } from "../test-helpers.js";

test("[cursor_agent] default discovery stays opt-in so cursor does not double-scan transcripts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-agent-default-"));

  try {
    const sessionId = "cursor-agent-default-session";
    const projectsRoot = path.join(tempRoot, ".cursor", "projects");
    const transcriptDir = path.join(projectsRoot, "workspace-a", "agent-transcripts", sessionId);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "Keep a single default transcript session." }] } })}\n`,
      "utf8",
    );

    const discovered = getDefaultSourcesForHost({
      homeDir: tempRoot,
      hostname: "cursor-agent-default-host",
      platform: "darwin",
    });
    assert.deepEqual(discovered.map((source) => source.platform), ["cursor"]);

    const optedIn = getDefaultSourcesForHost({
      homeDir: tempRoot,
      hostname: "cursor-agent-default-host",
      platform: "darwin",
      includeMissing: true,
    });
    const cursorAgent = optedIn.find((source) => source.platform === "cursor_agent");
    assert.ok(cursorAgent);
    assert.equal(cursorAgent.family, "local_coding_agent");
    assert.equal(cursorAgent.base_dir, projectsRoot);

    const [payload] = (await runSourceProbe({}, discovered)).sources;
    assert.ok(payload);
    assert.deepEqual(payload.sessions.map((session) => session.id), [`sess:cursor:${sessionId}`]);
    assert.equal(payload.sessions.some((session) => session.id.startsWith("sess:cursor_agent:")), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("[cursor_agent] agent-transcripts produce user turns and keep turn_ended as evidence", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-agent-"));

  try {
    const sessionId = "cursor-agent-cli-session";
    const projectsRoot = path.join(tempRoot, ".cursor", "projects");
    const transcriptDir = path.join(projectsRoot, "Users-test-my-app", "agent-transcripts", sessionId);
    const workspaceDir = path.join(
      tempRoot,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "workspaceStorage",
      "ws-cursor-agent",
    );
    await mkdir(transcriptDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      path.join(workspaceDir, "workspace.json"),
      JSON.stringify({ folder: "file:///Users/test/my_app" }),
      "utf8",
    );
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);
    await writeFile(
      transcriptPath,
      [
        {
          role: "user",
          message: {
            content: [{
              type: "text",
              text: "<user_query>\nReview the Cursor Agent adapter boundary.\n</user_query>",
            }],
          },
        },
        {
          role: "assistant",
          message: {
            content: [{ type: "text", text: "Cursor Agent transcript ingestion is working." }],
          },
        },
        { type: "turn_ended", status: "completed" },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8",
    );

    const source = createSourceDefinition("src-cursor-agent", "cursor_agent", projectsRoot);
    assert.deepEqual(await listSourceFiles("cursor_agent", projectsRoot), [transcriptPath]);

    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.sessions[0]?.id, `sess:cursor_agent:${sessionId}`);
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.turns[0]?.canonical_text, "Review the Cursor Agent adapter boundary.");
    assert.doesNotMatch(payload.turns[0]?.canonical_text ?? "", /<user_query>/u);
    assert.equal(payload.sessions[0]?.working_directory, "/Users/test/my_app");
    assert.ok(payload.sessions[0]?.resume_command?.includes(`cursor-agent --resume ${sessionId}`));
    assert.ok(
      payload.atoms.some(
        (atom) =>
          atom.actor_kind === "assistant" &&
          typeof atom.payload.text === "string" &&
          atom.payload.text.includes("is working"),
      ),
    );
    assert.equal(
      payload.loss_audits.some((audit) => audit.diagnostic_code === "cursor_agent_unhandled_record"),
      false,
    );

    const [targeted] = (
      await runSourceProbe(
        { source_ids: [source.id], target_session_refs: [sessionId] },
        [source],
      )
    ).sources;
    assert.ok(targeted);
    assert.deepEqual(targeted.sessions.map((session) => session.source_session_id ?? session.id.split(":").at(-1)), [sessionId]);
    await assert.rejects(
      runSourceProbe(
        { source_ids: [source.id], target_session_refs: ["missing-session"] },
        [source],
      ),
      /requested session/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("[cursor_agent] transcript file mtimes drive session recency instead of scan time", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-agent-mtime-"));

  try {
    const projectsRoot = path.join(tempRoot, ".cursor", "projects");
    const olderId = "cursor-agent-older";
    const newerId = "cursor-agent-newer";
    const olderPath = path.join(projectsRoot, "workspace-a", "agent-transcripts", olderId, `${olderId}.jsonl`);
    const newerPath = path.join(projectsRoot, "workspace-a", "agent-transcripts", newerId, `${newerId}.jsonl`);
    await mkdir(path.dirname(olderPath), { recursive: true });
    await mkdir(path.dirname(newerPath), { recursive: true });
    await writeFile(
      olderPath,
      `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "Older Cursor Agent ask." }] } })}\n`,
      "utf8",
    );
    await writeFile(
      newerPath,
      `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "Newer Cursor Agent ask." }] } })}\n`,
      "utf8",
    );
    const olderAt = new Date("2026-03-09T06:00:00.000Z");
    const newerAt = new Date("2026-03-10T06:00:00.000Z");
    await utimes(olderPath, olderAt, olderAt);
    await utimes(newerPath, newerAt, newerAt);

    const source = createSourceDefinition("src-cursor-agent-mtime", "cursor_agent", projectsRoot);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    const older = payload.sessions.find((session) => session.source_session_id === olderId);
    const newer = payload.sessions.find((session) => session.source_session_id === newerId);
    assert.ok(older);
    assert.ok(newer);
    assert.equal(older.updated_at?.startsWith("2026-03-09T06:00:00"), true);
    assert.equal(newer.updated_at?.startsWith("2026-03-10T06:00:00"), true);
    assert.ok((newer.updated_at ?? "") > (older.updated_at ?? ""));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("[cursor_agent] empty projects root stays healthy and preserves malformed transcripts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-cursor-agent-empty-"));

  try {
    const emptyRoot = path.join(tempRoot, "empty", ".cursor", "projects");
    await mkdir(emptyRoot, { recursive: true });
    const emptySource = createSourceDefinition("src-cursor-agent-empty", "cursor_agent", emptyRoot);
    const [emptyPayload] = (await runSourceProbe({ source_ids: [emptySource.id] }, [emptySource])).sources;
    assert.ok(emptyPayload);
    assert.equal(emptyPayload.source.sync_status, "stale");
    assert.equal(emptyPayload.sessions.length, 0);

    const projectsRoot = path.join(tempRoot, "malformed", ".cursor", "projects");
    const sessionId = "cursor-agent-malformed";
    const transcriptDir = path.join(projectsRoot, "workspace-a", "agent-transcripts", sessionId);
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      path.join(transcriptDir, `${sessionId}.jsonl`),
      ["{not-json", JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "Keep the valid Cursor Agent turn." }] } })].join("\n"),
      "utf8",
    );

    const malformedSource = createSourceDefinition("src-cursor-agent-malformed", "cursor_agent", projectsRoot);
    const [payload] = (await runSourceProbe({ source_ids: [malformedSource.id] }, [malformedSource])).sources;
    assert.ok(payload);
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.turns[0]?.canonical_text, "Keep the valid Cursor Agent turn.");
    assert.ok(payload.loss_audits.some((audit) => audit.diagnostic_code === "record_json_parse_failed"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
