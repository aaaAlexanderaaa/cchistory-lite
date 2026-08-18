import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDefaultSourcesForHost, listSourceFiles, runSourceProbe } from "../index.js";
import { createSourceDefinition } from "../test-helpers.js";
import { decodeGrokEncodedCwd, parseGrokSessionLayout } from "./grok.js";

const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("parseGrokSessionLayout recovers the native session id and decoded cwd", () => {
  const filePath = path.join(
    "/Users/mock/.grok/sessions",
    "%2Fworkspace%2Fgrok-fixture",
    SESSION_ID,
    "chat_history.jsonl",
  );
  const layout = parseGrokSessionLayout(filePath);
  assert.equal(layout?.sessionId, SESSION_ID);
  assert.equal(layout?.encodedCwd, "%2Fworkspace%2Fgrok-fixture");
  assert.equal(layout?.workingDirectory, "/workspace/grok-fixture");
  assert.equal(decodeGrokEncodedCwd("%2Fworkspace%2Fgrok-fixture"), "/workspace/grok-fixture");
});

test("[grok] chat_history sessions produce user turns and keep synthetic rows as evidence", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-grok-"));

  try {
    const grokRoot = path.join(tempRoot, ".grok");
    const sessionDir = path.join(grokRoot, "sessions", "%2Fworkspace%2Fgrok-fixture", SESSION_ID);
    const subagentDir = path.join(sessionDir, "subagents", "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
    await mkdir(subagentDir, { recursive: true });

    const chatPath = path.join(sessionDir, "chat_history.jsonl");
    const lines = [
      { type: "system", content: "You are Grok fixture assistant.", timestamp: "2026-03-09T06:00:00.000Z" },
      { type: "user", content: [{ type: "text", text: "Review the Grok adapter boundary." }], timestamp: "2026-03-09T06:01:00.000Z" },
      {
        type: "user",
        content: [{ type: "text", text: "Project instructions fixture." }],
        synthetic_reason: "project_instructions",
        timestamp: "2026-03-09T06:01:30.000Z",
      },
      {
        type: "reasoning",
        id: "r1",
        status: "completed",
        summary: [{ type: "summary_text", text: "Inspecting the source shape." }],
        encrypted_content: "enc-fixture",
        timestamp: "2026-03-09T06:02:00.000Z",
      },
      {
        type: "assistant",
        content: "I found the Grok session stream.",
        model_id: "grok-4.6",
        model_fingerprint: "fp-fixture",
        reasoning_effort: "high",
        tool_calls: [{ id: "call-1", name: "read_file", arguments: "{\"target_file\":\"README.md\"}" }],
        timestamp: "2026-03-09T06:03:00.000Z",
      },
      { type: "tool_result", tool_call_id: "call-1", content: "fixture readme", timestamp: "2026-03-09T06:03:10.000Z" },
      {
        type: "backend_tool_call",
        kind: { tool_type: "web_search", id: "call-2", status: "completed", action: { query: "grok cli sessions" } },
        timestamp: "2026-03-09T06:03:20.000Z",
      },
      { type: "user", content: [{ type: "text", text: "Now add regression coverage." }], timestamp: "2026-03-09T06:04:00.000Z" },
      {
        type: "assistant",
        content: "Coverage added.",
        model_id: "grok-4.6",
        model_fingerprint: "fp-fixture",
        reasoning_effort: "high",
        timestamp: "2026-03-09T06:05:00.000Z",
      },
    ];
    await writeFile(chatPath, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
    await writeFile(
      path.join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: SESSION_ID, cwd: "/workspace/grok-fixture" },
        generated_title: "Grok adapter fixture",
        session_summary: "Grok adapter fixture",
        parent_session_id: "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb",
        created_at: "2026-03-09T06:00:00.000Z",
        updated_at: "2026-03-09T06:10:00.000Z",
        current_model_id: "grok-4.6",
        num_messages: 8,
        num_chat_messages: 4,
        agent_name: "grok-build-plan",
        chat_format_version: 1,
      }),
      "utf8",
    );
    await writeFile(
      path.join(sessionDir, "signals.json"),
      JSON.stringify({ turnCount: 2, userMessageCount: 2, primaryModelId: "grok-4.6", contextTokensUsed: 1200 }),
      "utf8",
    );
    await writeFile(
      path.join(sessionDir, "prompt_context.json"),
      JSON.stringify({ working_directory: "/workspace/grok-fixture", version: 1 }),
      "utf8",
    );
    await writeFile(
      path.join(sessionDir, "updates.jsonl"),
      `${JSON.stringify({
        method: "session/update",
        timestamp: 1_773_000_006_000,
        params: {
          sessionId: SESSION_ID,
          update: {
            sessionUpdate: "turn_completed",
            stop_reason: "end_turn",
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          },
        },
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(subagentDir, "meta.json"),
      JSON.stringify({
        parent_session_id: SESSION_ID,
        child_session_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        subagent_type: "explore",
        status: "completed",
      }),
      "utf8",
    );
    await writeFile(path.join(subagentDir, "output.json"), JSON.stringify({ schema_version: 1, output: "child done" }), "utf8");

    const source = createSourceDefinition("src-grok", "grok", grokRoot);
    const sourceFiles = await listSourceFiles("grok", grokRoot);
    assert.deepEqual(sourceFiles, [chatPath]);

    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.sessions[0]?.id, `sess:grok:${SESSION_ID}`);
    assert.equal(payload.sessions[0]?.source_session_id, SESSION_ID);
    assert.equal(payload.sessions[0]?.title, "Grok adapter fixture");
    assert.equal(payload.sessions[0]?.working_directory, "/workspace/grok-fixture");
    assert.equal(payload.sessions[0]?.model, "grok-4.6");
    assert.equal(payload.sessions[0]?.created_at, "2026-03-09T06:00:00.000Z");
    assert.equal(payload.sessions[0]?.updated_at, "2026-03-09T06:10:00.000Z");
    assert.equal(payload.turns.length, 2);
    assert.equal(
      payload.turns.filter((turn) => turn.canonical_text.includes("Review the Grok adapter boundary.")).length,
      1,
    );
    assert.ok(payload.turns.some((turn) => turn.canonical_text.includes("Now add regression coverage.")));
    assert.equal(
      payload.turns.some((turn) => turn.canonical_text.includes("Project instructions fixture.")),
      false,
    );
    assert.equal(
      payload.turns.some((turn) => turn.canonical_text.includes("You are Grok fixture assistant.")),
      false,
    );
    assert.ok(payload.fragments.some((fragment) => fragment.fragment_kind === "tool_call"));
    assert.ok(payload.fragments.some((fragment) => fragment.fragment_kind === "tool_result"));
    assert.ok(payload.atoms.some((atom) => atom.actor_kind === "assistant" && String(atom.payload.text ?? "").includes("I found the Grok session stream.")));
    assert.ok(payload.sessions[0]?.resume_command?.includes(`grok -r ${SESSION_ID}`));
    const relation = payload.fragments.find((fragment) => fragment.fragment_kind === "session_relation");
    assert.equal(relation?.payload.parent_uuid, "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb");

    const blobPaths = new Set(payload.blobs.map((blob) => blob.origin_path));
    assert.ok(blobPaths.has(chatPath));
    assert.ok(blobPaths.has(path.join(sessionDir, "summary.json")));
    assert.ok(blobPaths.has(path.join(sessionDir, "signals.json")));
    assert.ok(blobPaths.has(path.join(sessionDir, "updates.jsonl")));
    assert.ok(blobPaths.has(path.join(subagentDir, "meta.json")));

    const [targeted] = (
      await runSourceProbe(
        { source_ids: [source.id], target_session_refs: [SESSION_ID] },
        [source],
      )
    ).sources;
    assert.ok(targeted);
    assert.deepEqual(targeted.sessions.map((session) => session.source_session_id), [SESSION_ID]);
    assert.deepEqual(targeted.turns.map((turn) => turn.id), payload.turns.map((turn) => turn.id));
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

test("[grok] empty sessions root stays healthy and preserves malformed chat_history lines", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-grok-empty-"));

  try {
    const emptyRoot = path.join(tempRoot, "empty", ".grok");
    await mkdir(path.join(emptyRoot, "sessions"), { recursive: true });
    const emptySource = createSourceDefinition("src-grok-empty", "grok", emptyRoot);
    const [emptyPayload] = (await runSourceProbe({ source_ids: [emptySource.id] }, [emptySource])).sources;
    assert.ok(emptyPayload);
    assert.equal(emptyPayload.source.sync_status, "stale");
    assert.equal(emptyPayload.sessions.length, 0);
    assert.deepEqual(await listSourceFiles("grok", emptyRoot), []);

    const grokRoot = path.join(tempRoot, "malformed", ".grok");
    const sessionDir = path.join(grokRoot, "sessions", "%2Fworkspace%2Fgrok-malformed", SESSION_ID);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "chat_history.jsonl"),
      ["{not-json", JSON.stringify({ type: "user", content: [{ type: "text", text: "Keep the valid Grok turn." }] })].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: SESSION_ID, cwd: "/workspace/grok-malformed" },
        generated_title: "Grok malformed fixture",
        created_at: "2026-03-09T06:00:00.000Z",
        updated_at: "2026-03-09T06:01:00.000Z",
        current_model_id: "grok-4.6",
      }),
      "utf8",
    );

    const malformedSource = createSourceDefinition("src-grok-malformed", "grok", grokRoot);
    const [payload] = (await runSourceProbe({ source_ids: [malformedSource.id] }, [malformedSource])).sources;
    assert.ok(payload);
    assert.equal(payload.source.sync_status, "healthy");
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.turns[0]?.canonical_text, "Keep the valid Grok turn.");
    assert.ok(payload.loss_audits.some((audit) => audit.diagnostic_code === "record_json_parse_failed"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("[grok] untimestamped chat_history lines still split into separate user turns", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-grok-ordinal-"));

  try {
    const grokRoot = path.join(tempRoot, ".grok");
    const sessionDir = path.join(grokRoot, "sessions", "%2Fworkspace%2Fgrok-ordinal", SESSION_ID);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "chat_history.jsonl"),
      [
        { type: "user", content: [{ type: "text", text: "First Grok question." }] },
        { type: "assistant", content: "First answer." },
        { type: "user", content: [{ type: "text", text: "Second Grok question." }] },
        { type: "assistant", content: "Second answer." },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8",
    );

    const source = createSourceDefinition("src-grok-ordinal", "grok", grokRoot);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.turns.length, 2);
    assert.ok(payload.turns.some((turn) => turn.canonical_text.includes("First Grok question.")));
    assert.ok(payload.turns.some((turn) => turn.canonical_text.includes("Second Grok question.")));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("[grok] default discovery selects ~/.grok when present", () => {
  const homeDir = "/Users/tester";
  const grokRoot = path.join(homeDir, ".grok");
  const sources = getDefaultSourcesForHost({
    homeDir,
    hostname: "grok-test-host",
    platform: "darwin",
    pathExists: (targetPath) => targetPath === grokRoot,
  });

  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.platform, "grok");
  assert.equal(sources[0]?.family, "local_coding_agent");
  assert.equal(sources[0]?.base_dir, grokRoot);
});
