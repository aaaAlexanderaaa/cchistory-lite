import { runSourceProbe } from "../probe-reference.test.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getDefaultSourcesForHost, listSourceFiles} from "../index.js";
import { createSourceDefinition } from "../test-helpers.js";
import { decodeGrokEncodedCwd, parseGrokSessionLayout, previewSourceFileWorkingDirectory } from "./grok.js";
import { collectGrokTurnCompletedUpdateRecords, interleaveGrokTurnCompletedRecords } from "./grok/runtime.js";
import type { RawRecord } from "@cchistory/domain";

const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CHILD_SESSION_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

function grokRecord(pointer: string, payload: unknown, observedAt = "2026-03-09T06:00:00.000Z"): RawRecord {
  return {
    id: pointer,
    source_id: "src-grok",
    blob_id: "blob",
    session_ref: `sess:grok:${SESSION_ID}`,
    ordinal: Number(pointer.replace(/\D/gu, "") || 0),
    record_path_or_offset: pointer,
    observed_at: observedAt,
    parseable: true,
    raw_json: JSON.stringify(payload),
  };
}

test("interleaveGrokTurnCompletedRecords places each turn_completed after its user turn", () => {
  const records = [
    grokRecord("0", { type: "user", content: "one" }),
    grokRecord("1", { type: "assistant", content: "ok" }),
    grokRecord("2", { type: "user", content: "two" }),
    grokRecord("3", { type: "assistant", content: "done" }),
    grokRecord("updates:0", {
      timestamp: 1_773_000_183,
      params: { update: { sessionUpdate: "turn_completed", usage: { totalTokens: 120 } } },
    }),
    grokRecord("updates:1", {
      timestamp: 1_773_000_300,
      params: { update: { sessionUpdate: "turn_completed", usage: { totalTokens: 58 } } },
    }),
  ];
  const ordered = interleaveGrokTurnCompletedRecords(records);
  assert.deepEqual(ordered.map((record) => record.record_path_or_offset), ["0", "1", "2", "3"]);
  assert.equal(JSON.parse(ordered[1]!.raw_json).usage.totalTokens, 120);
  assert.equal(JSON.parse(ordered[3]!.raw_json).usage.totalTokens, 58);
});

test("collectGrokTurnCompletedUpdateRecords keeps only turn_completed lines from a noisy sidecar", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-grok-updates-"));
  try {
    const updatesPath = path.join(tempRoot, "updates.jsonl");
    const noise = Array.from({ length: 80 }, (_, index) => ({
      method: "session/update",
      timestamp: 1_773_000_000 + index,
      params: {
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: index % 3 === 0 ? "agent_thought" : "tool_call",
          text: `noise-${index}`,
        },
      },
    }));
    const completed = [
      {
        method: "session/update",
        timestamp: 1_773_000_183,
        params: {
          sessionId: SESSION_ID,
          update: {
            sessionUpdate: "turn_completed",
            usage: { totalTokens: 120 },
          },
        },
      },
      {
        method: "session/update",
        timestamp: 1_773_000_300,
        params: {
          sessionId: SESSION_ID,
          update: {
            sessionUpdate: "turn_completed",
            usage: { totalTokens: 58 },
          },
        },
      },
    ];
    await writeFile(
      updatesPath,
      [...noise.slice(0, 40), completed[0], ...noise.slice(40), completed[1]]
        .map((row) => JSON.stringify(row))
        .join("\n"),
      "utf8",
    );

    const records = await collectGrokTurnCompletedUpdateRecords({
      filePath: updatesPath,
      identity: { sourceId: "src-grok", blobId: "blob", sessionId: `sess:grok:${SESSION_ID}` },
      startOrdinal: 10,
      createRecordId: (ordinal, pointer) => `${ordinal}:${pointer}`,
      nowIso: () => "2026-03-09T06:00:00.000Z",
    });

    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((record) => record.record_path_or_offset),
      ["updates:40", "updates:81"],
    );
    assert.equal(JSON.parse(records[0]!.raw_json).params.update.usage.totalTokens, 120);
    assert.equal(JSON.parse(records[1]!.raw_json).params.update.usage.totalTokens, 58);
    assert.ok(records.every((record) => !record.raw_json.includes("agent_thought")));
    assert.ok(records.every((record) => record.raw_json.length < 400));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("[grok] probe does not materialize thought/tool update events as raw records", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-grok-noisy-updates-"));
  try {
    const grokRoot = path.join(tempRoot, ".grok");
    const sessionDir = path.join(grokRoot, "sessions", "%2Fworkspace%2Fgrok-fixture", SESSION_ID);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "chat_history.jsonl"),
      [
        { type: "user", content: [{ type: "text", text: "Count the tokens." }], timestamp: "2026-03-09T06:01:00.000Z" },
        { type: "assistant", content: [{ type: "text", text: "Counted." }], timestamp: "2026-03-09T06:01:01.000Z" },
      ].map((row) => JSON.stringify(row)).join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(sessionDir, "summary.json"),
      JSON.stringify({
        info: { id: SESSION_ID, cwd: "/workspace/grok-fixture" },
        generated_title: "Noisy updates",
        created_at: "2026-03-09T06:00:00.000Z",
        updated_at: "2026-03-09T06:10:00.000Z",
        current_model_id: "grok-4.6",
      }),
      "utf8",
    );
    await writeFile(
      path.join(sessionDir, "updates.jsonl"),
      [
        {
          method: "session/update",
          timestamp: 1_773_000_100,
          params: { update: { sessionUpdate: "agent_thought", text: "thinking" } },
        },
        {
          method: "session/update",
          timestamp: 1_773_000_110,
          params: { update: { sessionUpdate: "tool_call", name: "grep" } },
        },
        {
          method: "session/update",
          timestamp: 1_773_000_183,
          params: {
            update: {
              sessionUpdate: "turn_completed",
              usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 },
            },
          },
        },
      ].map((row) => JSON.stringify(row)).join("\n"),
      "utf8",
    );
    const source = createSourceDefinition("src-grok", "grok", grokRoot);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(
      payload.records.some((record) =>
        record.raw_json.includes("agent_thought") || record.raw_json.includes('"tool_call"')
      ),
      false,
    );
    assert.equal(
      payload.fragments.filter((fragment) => fragment.fragment_kind === "token_usage_signal").length,
      1,
    );
    assert.equal(
      payload.contexts[0]?.assistant_replies[0]?.token_usage?.total_tokens,
      13,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("previewSourceFileWorkingDirectory reads Grok cwd from the encoded path without opening files", () => {
  const filePath = path.join(
    "/Users/mock/.grok/sessions",
    "%2Fworkspace%2Fgrok-fixture",
    SESSION_ID,
    "chat_history.jsonl",
  );
  assert.deepEqual(previewSourceFileWorkingDirectory("grok", filePath), {
    state: "known",
    workingDirectory: "/workspace/grok-fixture",
  });
  assert.deepEqual(previewSourceFileWorkingDirectory("codex", filePath), { state: "absent" });
});

test("[grok] sibling subagent sessions link through spawn meta without a parent-less summary relation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-grok-child-"));

  try {
    const grokRoot = path.join(tempRoot, ".grok");
    const cwdDir = path.join(grokRoot, "sessions", "%2Fworkspace%2Fgrok-fixture");
    const parentDir = path.join(cwdDir, SESSION_ID);
    const childDir = path.join(cwdDir, CHILD_SESSION_ID);
    const subagentDir = path.join(parentDir, "subagents", CHILD_SESSION_ID);
    await mkdir(subagentDir, { recursive: true });
    await mkdir(childDir, { recursive: true });

    const parentChat = path.join(parentDir, "chat_history.jsonl");
    const childChat = path.join(childDir, "chat_history.jsonl");
    await writeFile(
      parentChat,
      `${JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "Review the Grok adapter boundary." }],
        timestamp: "2026-03-09T06:01:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(
      childChat,
      `${JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "Review the Grok adapter boundary as a delegated child." }],
        timestamp: "2026-03-09T06:03:00.000Z",
      })}\n`,
      "utf8",
    );
    await writeFile(
      path.join(parentDir, "summary.json"),
      JSON.stringify({
        info: { id: SESSION_ID, cwd: "/workspace/grok-fixture" },
        generated_title: "Grok adapter fixture",
        parent_session_id: "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb",
        created_at: "2026-03-09T06:00:00.000Z",
        current_model_id: "grok-4.6",
      }),
      "utf8",
    );
    await writeFile(
      path.join(childDir, "summary.json"),
      JSON.stringify({
        info: { id: CHILD_SESSION_ID, cwd: "/workspace/grok-fixture" },
        generated_title: "Grok adapter child review",
        session_kind: "subagent",
        agent_name: "general-purpose",
        created_at: "2026-03-09T06:03:00.000Z",
        current_model_id: "grok-4.6",
      }),
      "utf8",
    );
    await writeFile(
      path.join(subagentDir, "meta.json"),
      JSON.stringify({
        parent_session_id: SESSION_ID,
        child_session_id: CHILD_SESSION_ID,
        subagent_type: "explore",
        status: "completed",
      }),
      "utf8",
    );

    const source = createSourceDefinition("src-grok-child", "grok", grokRoot);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.sessions.length, 2);
    const childSession = payload.sessions.find((session) => session.source_session_id === CHILD_SESSION_ID);
    assert.ok(childSession);
    const relations = payload.fragments.filter((fragment) => fragment.fragment_kind === "session_relation");
    assert.ok(relations.length > 0);
    assert.equal(relations.some((fragment) => fragment.payload.parent_uuid === undefined), false);
    assert.equal(
      relations.some((fragment) => fragment.payload.parent_uuid === "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb"),
      false,
    );
    assert.ok(relations.every((fragment) =>
      fragment.payload.parent_uuid === SESSION_ID &&
      fragment.payload.child_session_id === CHILD_SESSION_ID
    ));
    assert.equal(
      payload.fragments.some((fragment) =>
        fragment.session_ref === childSession.id &&
        fragment.fragment_kind === "session_meta" &&
        fragment.payload.session_kind === "subagent"
      ),
      true,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

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
      { type: "system", content: "You are Grok fixture assistant." },
      { type: "user", content: [{ type: "text", text: "Review the Grok adapter boundary." }] },
      {
        type: "user",
        content: [{ type: "text", text: "Project instructions fixture." }],
        synthetic_reason: "project_instructions",
      },
      {
        type: "reasoning",
        id: "r1",
        status: "completed",
        summary: [{ type: "summary_text", text: "Inspecting the source shape." }],
        encrypted_content: "enc-fixture",
      },
      {
        type: "assistant",
        content: "I found the Grok session stream.",
        model_id: "grok-4.6",
        model_fingerprint: "fp-fixture",
        reasoning_effort: "high",
        tool_calls: [{ id: "call-1", name: "read_file", arguments: "{\"target_file\":\"README.md\"}" }],
      },
      { type: "tool_result", tool_call_id: "call-1", content: "fixture readme" },
      {
        type: "backend_tool_call",
        kind: { tool_type: "web_search", id: "call-2", status: "completed", action: { query: "grok cli sessions" } },
      },
      { type: "user", content: [{ type: "text", text: "Now add regression coverage." }] },
      {
        type: "assistant",
        content: "Coverage added.",
        model_id: "grok-4.6",
        model_fingerprint: "fp-fixture",
        reasoning_effort: "high",
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
      [
        {
          method: "session/update",
          timestamp: 1_773_000_183,
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: "turn_completed",
              stop_reason: "end_turn",
              usage: {
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
                cachedReadTokens: 10,
                reasoningTokens: 4,
              },
            },
          },
        },
        {
          method: "session/update",
          timestamp: 1_773_000_300,
          params: {
            sessionId: SESSION_ID,
            update: {
              sessionUpdate: "turn_completed",
              stop_reason: "end_turn",
              usage: { inputTokens: 50, outputTokens: 8, totalTokens: 58 },
            },
          },
        },
      ].map((row) => JSON.stringify(row)).join("\n"),
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
      payload.fragments.filter((fragment) => fragment.fragment_kind === "token_usage_signal").length,
      2,
    );
    const usageTotals = payload.contexts.flatMap((context) =>
      context.assistant_replies.map((reply) => reply.token_usage?.total_tokens),
    );
    assert.deepEqual(
      usageTotals.filter((value) => value !== undefined).sort((left, right) => (left ?? 0) - (right ?? 0)),
      [58, 120],
    );
    assert.equal(payload.turns[0]?.last_context_activity_at, new Date(1_773_000_183 * 1000).toISOString());
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
    assert.equal(
      payload.fragments.some((fragment) =>
        fragment.fragment_kind === "session_relation" &&
        fragment.payload.parent_uuid === "ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb"
      ),
      false,
    );
    const relation = payload.fragments.find((fragment) => fragment.fragment_kind === "session_relation");
    assert.equal(relation?.payload.parent_uuid, SESSION_ID);
    assert.equal(relation?.payload.child_session_id, "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff");
    assert.equal(relation?.payload.is_sidechain, true);

    const blobPaths = new Set(payload.blobs.map((blob) => blob.origin_path));
    assert.ok(blobPaths.has(chatPath));
    assert.ok(blobPaths.has(path.join(sessionDir, "summary.json")));
    assert.ok(blobPaths.has(path.join(sessionDir, "signals.json")));
    assert.equal(blobPaths.has(path.join(sessionDir, "updates.jsonl")), false);
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

test("[grok] sibling subagent sessions nest under the parent instead of becoming top-level", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cchistory-grok-subagent-"));
  const parentId = SESSION_ID;
  const childId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const resumeId = "cccccccc-dddd-4eee-8fff-000000000000";

  try {
    const grokRoot = path.join(tempRoot, ".grok");
    const cwdDir = path.join(grokRoot, "sessions", "%2Fworkspace%2Fgrok-fixture");
    const parentDir = path.join(cwdDir, parentId);
    const childDir = path.join(cwdDir, childId);
    const resumeDir = path.join(cwdDir, resumeId);
    const childMetaDir = path.join(parentDir, "subagents", childId);
    const resumeMetaDir = path.join(parentDir, "subagents", resumeId);
    await mkdir(childMetaDir, { recursive: true });
    await mkdir(resumeMetaDir, { recursive: true });
    await mkdir(childDir, { recursive: true });
    await mkdir(resumeDir, { recursive: true });

    await writeFile(
      path.join(parentDir, "chat_history.jsonl"),
      [
        { type: "user", content: [{ type: "text", text: "Review the parent adapter." }], timestamp: "2026-03-09T06:01:00.000Z" },
        { type: "assistant", content: "Spawning a reviewer.", model_id: "grok-4.6", timestamp: "2026-03-09T06:02:00.000Z" },
      ].map((line) => JSON.stringify(line)).join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(parentDir, "summary.json"),
      JSON.stringify({
        info: { id: parentId, cwd: "/workspace/grok-fixture" },
        generated_title: "Grok parent fixture",
        created_at: "2026-03-09T06:00:00.000Z",
        updated_at: "2026-03-09T06:10:00.000Z",
        current_model_id: "grok-4.6",
        agent_name: "grok-build-plan",
      }),
      "utf8",
    );
    await writeFile(
      path.join(childDir, "chat_history.jsonl"),
      [
        { type: "user", content: [{ type: "text", text: "Review the child adapter independently." }], timestamp: "2026-03-09T06:03:00.000Z" },
        { type: "assistant", content: "Child review complete.", model_id: "grok-4.6", timestamp: "2026-03-09T06:04:00.000Z" },
      ].map((line) => JSON.stringify(line)).join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(childDir, "summary.json"),
      JSON.stringify({
        info: { id: childId, cwd: "/workspace/grok-fixture" },
        generated_title: "Grok child review",
        created_at: "2026-03-09T06:03:00.000Z",
        updated_at: "2026-03-09T06:05:00.000Z",
        current_model_id: "grok-4.6",
        session_kind: "subagent",
        agent_name: "general-purpose",
      }),
      "utf8",
    );
    await writeFile(
      path.join(childMetaDir, "meta.json"),
      JSON.stringify({
        subagent_id: childId,
        parent_session_id: parentId,
        child_session_id: childId,
        subagent_type: "general-purpose",
        description: "Review the child adapter independently.",
        status: "completed",
      }),
      "utf8",
    );
    await writeFile(
      path.join(resumeDir, "chat_history.jsonl"),
      [
        { type: "user", content: [{ type: "text", text: "Continue the child review." }], timestamp: "2026-03-09T06:06:00.000Z" },
        { type: "assistant", content: "Resume review complete.", model_id: "grok-4.6", timestamp: "2026-03-09T06:07:00.000Z" },
      ].map((line) => JSON.stringify(line)).join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(resumeDir, "summary.json"),
      JSON.stringify({
        info: { id: resumeId, cwd: "/workspace/grok-fixture" },
        generated_title: "Grok child resume",
        created_at: "2026-03-09T06:06:00.000Z",
        updated_at: "2026-03-09T06:08:00.000Z",
        current_model_id: "grok-4.6",
        session_kind: "subagent_resume",
        agent_name: "general-purpose",
        parent_session_id: childId,
      }),
      "utf8",
    );
    await writeFile(
      path.join(resumeMetaDir, "meta.json"),
      JSON.stringify({
        subagent_id: resumeId,
        parent_session_id: parentId,
        child_session_id: resumeId,
        subagent_type: "general-purpose",
        description: "Continue the child review.",
        status: "completed",
      }),
      "utf8",
    );

    const source = createSourceDefinition("src-grok-subagent", "grok", grokRoot);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    const parent = payload.sessions.find((session) => session.source_session_id === parentId);
    const child = payload.sessions.find((session) => session.source_session_id === childId);
    const resume = payload.sessions.find((session) => session.source_session_id === resumeId);
    assert.ok(parent && child && resume);
    assert.equal(parent.resume_command?.includes(`grok -r ${parentId}`), true);
    assert.equal(child.resume_command, undefined);
    assert.equal(resume.resume_command, undefined);

    const childRelation = payload.fragments.find((fragment) =>
      fragment.session_ref === child.id &&
      fragment.fragment_kind === "session_relation" &&
      fragment.payload.parent_uuid === parentId &&
      fragment.payload.child_session_id === childId &&
      fragment.payload.is_sidechain === true
    );
    assert.ok(childRelation);
    const resumeFromParent = payload.fragments.find((fragment) =>
      fragment.fragment_kind === "session_relation" &&
      fragment.payload.parent_uuid === parentId &&
      fragment.payload.child_session_id === resumeId &&
      fragment.payload.is_sidechain === true
    );
    assert.ok(resumeFromParent);
    const resumeFromPriorChild = payload.fragments.find((fragment) =>
      fragment.session_ref === resume.id &&
      fragment.fragment_kind === "session_relation" &&
      fragment.payload.parent_uuid === childId &&
      fragment.payload.is_sidechain === true
    );
    assert.ok(resumeFromPriorChild);

    const [targetedChild] = (
      await runSourceProbe(
        { source_ids: [source.id], target_session_refs: [childId] },
        [source],
      )
    ).sources;
    assert.ok(targetedChild);
    assert.deepEqual(targetedChild.sessions.map((session) => session.source_session_id), [childId]);
    assert.ok(targetedChild.fragments.some((fragment) =>
      fragment.fragment_kind === "session_relation" &&
      fragment.payload.parent_uuid === parentId &&
      fragment.payload.child_session_id === childId
    ));
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
