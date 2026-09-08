import assert from "node:assert/strict";
import test from "node:test";
import type {
  CapturedBlob,
  ConversationAtom,
  RawRecord,
  SessionProjection,
  SourceFragment,
  SourceStatus,
  TurnContextProjection,
  UserTurnProjection,
} from "@cchistory/domain";
import { listSessionRelatedWork } from "./related-work.js";
import {
  buildSessionFamilyInventory,
  listSessionFamilies,
  mergeSessionFamilyInventories,
} from "./session-family.js";

test("session family inventory splits parent storage from delegated children and keeps I/O", () => {
  const source = createSource();
  const parent = createSession(source, "sess:grok:parent", "parent", "/workspace/parent/chat_history.jsonl");
  const child = createSession(source, "sess:grok:child", "child", "/workspace/child/chat_history.jsonl");
  child.title = "Explore helper";
  child.turn_count = 0;
  const parentBlob = createBlob("blob-parent", "/workspace/parent/chat_history.jsonl", 80_000);
  const childBlob = createBlob("blob-child", "/workspace/child/chat_history.jsonl", 20_000);
  const spawnMeta = createBlob("blob-meta", "/workspace/parent/subagents/child/meta.json", 1_200);
  const parentTurn = createTurn(source, parent, 40);
  const related = [{
    id: "related-out",
    query_session_ref: parent.id,
    source_id: source.id,
    source_platform: source.platform,
    source_session_ref: parent.id,
    parent_session_ref: parent.id,
    child_session_ref: child.id,
    relation_kind: "delegated_session" as const,
    target_kind: "session" as const,
    direction: "outbound" as const,
    target_session_ref: child.id,
    transcript_primary: true,
    evidence_confidence: 0.9,
    child_agent_key: "explore",
    status: "completed",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:01:00.000Z",
    fragment_refs: [],
    raw_detail: { description: "Search the fixture for timeout handling.", prompt: "Search the fixture for timeout handling." },
  }];

  const inventory = buildSessionFamilyInventory({
    sessions: [parent, child],
    turns: [parentTurn],
    related_work: related,
    blobs: [parentBlob, childBlob, spawnMeta],
    records: [
      createRecord("rec-parent", parent.id, parentBlob.id),
      createRecord("rec-child", child.id, childBlob.id),
      createRecord("rec-meta", parent.id, spawnMeta.id),
    ],
    atoms: [
      createAtom("atom-spawn", parent.id, "tool_call", {
        tool_name: "spawn_subagent",
        call_id: "call-1",
        input: { subagent_id: "child", prompt: "Search the fixture for timeout handling." },
      }),
      createAtom("atom-out", parent.id, "tool_result", {
        call_id: "call-1",
        output: "Found three timeout call sites.",
      }),
      createAtom("atom-child-tool", child.id, "tool_call", { tool_name: "grep", call_id: "c-tool" }),
      createAtom("atom-child-result", child.id, "tool_result", { call_id: "c-tool", output: "ok" }),
      createAtom("atom-child-err", child.id, "tool_call", { tool_name: "read_file", call_id: "c-err" }),
      createAtom("atom-child-err-result", child.id, "tool_result", { call_id: "c-err", is_error: true, output: "Error: missing" }),
    ],
    fragments: [
      createFragment("atom-spawn", parent.id, "rec-parent"),
      createFragment("atom-out", parent.id, "rec-parent"),
      createFragment("atom-child-tool", child.id, "rec-child"),
      createFragment("atom-child-result", child.id, "rec-child"),
      createFragment("atom-child-err", child.id, "rec-child"),
      createFragment("atom-child-err-result", child.id, "rec-child"),
    ],
  });

  const parentStats = inventory.contributions.find((entry) => entry.session_ref === parent.id)?.stats;
  const childStats = inventory.contributions.find((entry) => entry.session_ref === child.id)?.stats;
  assert.equal(parentStats?.storage_bytes, 80_000);
  assert.equal(childStats?.storage_bytes, 21_200);
  assert.equal(childStats?.tool_call_count, 2);
  assert.equal(childStats?.tool_success_count, 1);
  assert.equal(childStats?.tool_error_count, 1);

  const families = listSessionFamilies([parent, child], inventory);
  assert.equal(families.length, 1);
  assert.equal(families[0]?.child_count, 1);
  assert.equal(families[0]?.combined.storage_bytes, 101_200);
  assert.equal(families[0]?.children[0]?.input_preview, "Search the fixture for timeout handling.");
  assert.equal(families[0]?.children[0]?.output_preview, "Found three timeout call sites.");
  assert.equal(families[0]?.children[0]?.agent_key, "explore");
});

test("session family inventory splits a shared container blob proportionally to raw record bytes", () => {
  const source = createSource();
  const sessionA = createSession(source, "sess:zcode:a", "a", "/container/db.sqlite");
  const sessionB = createSession(source, "sess:zcode:b", "b", "/container/db.sqlite");
  const container = createBlob("blob-db", "/container/db.sqlite", 10_000);
  const inventory = buildSessionFamilyInventory({
    sessions: [sessionA, sessionB],
    blobs: [container],
    records: [
      createRecord("rec-a1", sessionA.id, container.id, "x".repeat(300)),
      createRecord("rec-a2", sessionA.id, container.id, "x".repeat(300)),
      createRecord("rec-b1", sessionB.id, container.id, "x".repeat(200)),
    ],
    atoms: [
      createAtom("atom-a", sessionA.id, "tool_call", { tool_name: "read", call_id: "a1" }),
      createAtom("atom-b1", sessionB.id, "tool_call", { tool_name: "read", call_id: "b1" }),
      createAtom("atom-b2", sessionB.id, "tool_call", { tool_name: "grep", call_id: "b2" }),
    ],
    fragments: [
      createFragment("atom-a", sessionA.id, "rec-a1"),
      createFragment("atom-b1", sessionB.id, "rec-b1"),
      createFragment("atom-b2", sessionB.id, "rec-b1"),
    ],
  });

  const contributionA = inventory.contributions.find((entry) => entry.session_ref === sessionA.id);
  const contributionB = inventory.contributions.find((entry) => entry.session_ref === sessionB.id);
  assert.equal(contributionA?.stats.storage_bytes, 7_500);
  assert.equal(contributionB?.stats.storage_bytes, 2_500);
  assert.equal(
    (contributionA?.stats.storage_bytes ?? 0) + (contributionB?.stats.storage_bytes ?? 0),
    10_000,
    "shares must sum to the container size",
  );
  assert.deepEqual(contributionA?.shared_storage, { estimated_bytes: 7_500, container_bytes: 10_000 });
  assert.deepEqual(contributionB?.shared_storage, { estimated_bytes: 2_500, container_bytes: 10_000 });
  assert.equal(contributionA?.stats.blob_count, 1);
  assert.equal(contributionB?.stats.blob_count, 1);
  // Atoms stay on their own session instead of collapsing onto the first record owner.
  assert.equal(contributionA?.stats.tool_call_count, 1);
  assert.equal(contributionB?.stats.tool_call_count, 2);
});

test("family summaries preserve projected spawn I/O when raw atoms lack matching evidence", () => {
  const source = createSource();
  const parent = createSession(source, "sess:grok:context-parent", "parent", "/parent.jsonl");
  const child = createSession(source, "sess:grok:context-child", "child", "/child.jsonl");
  const turn = createTurn(source, parent, 40);
  const context: TurnContextProjection = {
    turn_id: turn.id,
    system_messages: [],
    assistant_replies: [],
    raw_event_refs: [],
    tool_calls: [{
      id: "projected-spawn-call",
      tool_name: "spawn_subagent",
      input: { subagent_id: "child", extra: "Fixture input without a prompt or description." },
      input_summary: "Projected input summary.",
      input_display_segments: [{ type: "text", content: "Projected input summary." }],
      output: "Full output that must not displace the projected preview.",
      output_preview: "Projected output preview.",
      status: "success",
      reply_id: "reply-parent",
      sequence: 0,
      created_at: parent.created_at,
    }],
  };
  const input = {
    sessions: [parent, child],
    turns: [turn],
    related_work: [{
      id: "context-related",
      query_session_ref: parent.id,
      source_id: source.id,
      source_platform: source.platform,
      source_session_ref: parent.id,
      parent_session_ref: parent.id,
      child_session_ref: child.id,
      relation_kind: "delegated_session" as const,
      target_kind: "session" as const,
      direction: "outbound" as const,
      target_session_ref: child.id,
      transcript_primary: true,
      evidence_confidence: 0.9,
      created_at: parent.created_at,
      updated_at: parent.updated_at,
      fragment_refs: [],
      raw_detail: { description: "Relation input fallback.", output: "Relation output fallback." },
    }],
    // This is valid incomplete evidence. Its call must not accidentally match
    // the child just because that child's id is a substring of its target.
    atoms: [createAtom("unrelated-spawn", parent.id, "tool_call", {
      tool_name: "spawn_subagent",
      call_id: "raw-other-call",
      input: { subagent_id: "child-other", prompt: "Wrong input." },
    })],
  };
  const complete = buildSessionFamilyInventory({ ...input, contexts: [context] });
  const discarded = buildSessionFamilyInventory({ ...input, contexts: [] });
  assert.equal(complete.children[0]?.input_preview, "Projected input summary.");
  assert.equal(complete.children[0]?.output_preview, "Projected output preview.");
  assert.equal(discarded.children[0]?.input_preview, "Relation input fallback.");
  assert.equal(discarded.children[0]?.output_preview, "Relation output fallback.");
});

test("session family inventory marks a single-session SQLite blob as shared storage", () => {
  const source = createSource();
  const session = createSession(source, "sess:zcode:solo", "solo", "/container/db.sqlite");
  const container = createBlob("blob-db", "/container/db.sqlite", 10_000);
  const inventory = buildSessionFamilyInventory({
    sessions: [session],
    blobs: [container],
    records: [createRecord("rec-solo", session.id, container.id, "x".repeat(200))],
  });
  const contribution = inventory.contributions.find((entry) => entry.session_ref === session.id);
  assert.equal(contribution?.stats.storage_bytes, 10_000);
  assert.deepEqual(contribution?.shared_storage, { estimated_bytes: 10_000, container_bytes: 10_000 });
});

test("session family inventory does not dump a whole SQLite file onto a filtered leftover session", () => {
  const source = createSource();
  const visible = createSession(source, "sess:zcode:visible", "visible", "/container/db.sqlite");
  const container = createBlob("blob-db", "/container/db.sqlite", 10_000);
  const inventory = buildSessionFamilyInventory({
    sessions: [visible],
    blobs: [container],
    records: [
      createRecord("rec-visible", visible.id, container.id, "x".repeat(200)),
      createRecord("rec-hidden", "sess:zcode:hidden", container.id, "x".repeat(800)),
    ],
  });
  const contribution = inventory.contributions.find((entry) => entry.session_ref === visible.id);
  assert.equal(contribution?.stats.storage_bytes, 2_000);
  assert.deepEqual(contribution?.shared_storage, { estimated_bytes: 2_000, container_bytes: 10_000 });
});

test("session family inventory merges later related-work status and prompt onto the same child", () => {
  const source = createSource();
  const parent = createSession(source, "sess:grok:parent", "parent", "/parent.jsonl");
  const child = createSession(source, "sess:grok:child", "child", "/child.jsonl");
  child.turn_count = 0;
  const inventory = buildSessionFamilyInventory({
    sessions: [parent, child],
    related_work: [
      {
        id: "related-in",
        query_session_ref: child.id,
        source_id: source.id,
        source_platform: source.platform,
        source_session_ref: child.id,
        parent_session_ref: parent.id,
        child_session_ref: child.id,
        relation_kind: "delegated_session",
        target_kind: "session",
        direction: "inbound",
        target_session_ref: parent.id,
        transcript_primary: true,
        evidence_confidence: 0.8,
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:00:00.000Z",
        fragment_refs: [],
        raw_detail: {},
      },
      {
        id: "related-out",
        query_session_ref: parent.id,
        source_id: source.id,
        source_platform: source.platform,
        source_session_ref: parent.id,
        parent_session_ref: parent.id,
        child_session_ref: child.id,
        relation_kind: "delegated_session",
        target_kind: "session",
        direction: "outbound",
        target_session_ref: child.id,
        transcript_primary: true,
        evidence_confidence: 0.9,
        child_agent_key: "explore",
        status: "completed",
        created_at: "2026-01-02T00:00:00.000Z",
        updated_at: "2026-01-02T00:01:00.000Z",
        fragment_refs: [],
        raw_detail: { description: "Search the fixture for timeout handling." },
      },
    ],
  });
  assert.equal(inventory.children.length, 1);
  assert.equal(inventory.children[0]?.status, "completed");
  assert.equal(inventory.children[0]?.agent_key, "explore");
  assert.equal(inventory.children[0]?.input_preview, "Search the fixture for timeout handling.");
});

test("session family inventory matches spawn I/O by exact child id, not substring", () => {
  const source = createSource();
  const parent = createSession(source, "sess:grok:parent", "parent", "/parent.jsonl");
  const child = createSession(source, "sess:grok:child", "child", "/child.jsonl");
  child.turn_count = 0;
  const inventory = buildSessionFamilyInventory({
    sessions: [parent, child],
    related_work: [{
      id: "related-out",
      query_session_ref: parent.id,
      source_id: source.id,
      source_platform: source.platform,
      source_session_ref: parent.id,
      parent_session_ref: parent.id,
      child_session_ref: child.id,
      relation_kind: "delegated_session",
      target_kind: "session",
      direction: "outbound",
      target_session_ref: child.id,
      transcript_primary: true,
      evidence_confidence: 0.9,
      created_at: "2026-01-02T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      fragment_refs: [],
      raw_detail: {},
    }],
    atoms: [
      createAtom("atom-other", parent.id, "tool_call", {
        tool_name: "spawn_subagent",
        call_id: "call-other",
        input: { subagent_id: "child-other", prompt: "Wrong child prompt." },
      }),
      createAtom("atom-other-out", parent.id, "tool_result", {
        call_id: "call-other",
        output: "Wrong child output.",
      }),
      createAtom("atom-spawn", parent.id, "tool_call", {
        tool_name: "spawn_subagent",
        call_id: "call-1",
        input: { subagent_id: "child", prompt: "Right child prompt." },
      }),
      createAtom("atom-out", parent.id, "tool_result", {
        call_id: "call-1",
        output: "Right child output.",
      }),
    ],
  });
  assert.equal(inventory.children[0]?.input_preview, "Right child prompt.");
  assert.equal(inventory.children[0]?.output_preview, "Right child output.");
});

test("session family inventory treats Claude subagent files as sidecar children of the parent", () => {
  const source = { ...createSource(), platform: "claude_code" as const };
  const parent = createSession(
    source,
    "sess:claude_code:parent-uuid",
    "parent-uuid",
    "/.claude/projects/app/parent-uuid.jsonl",
  );
  const parentBlob = createBlob("blob-parent", "/.claude/projects/app/parent-uuid.jsonl", 50_000);
  const sidecarBlob = createBlob(
    "blob-sidecar",
    "/.claude/projects/app/parent-uuid/subagents/agent-aaaa.jsonl",
    10_000,
  );
  const inventory = buildSessionFamilyInventory({
    sessions: [parent],
    blobs: [parentBlob, sidecarBlob],
    records: [
      createRecord("rec-parent", parent.id, parentBlob.id),
      createRecord("rec-sidecar", parent.id, sidecarBlob.id),
    ],
    atoms: [
      createAtom("atom-in", parent.id, "text", {
        actor_kind: "system",
        origin_kind: "delegated_instruction",
        text: "Search the codebase for timeout handling.",
      }, "delegated_instruction"),
      createAtom("atom-out", parent.id, "text", {
        actor_kind: "assistant",
        text: "Timeouts live in retry.ts.",
      }, "assistant_authored"),
    ],
    fragments: [
      createFragment("atom-in", parent.id, "rec-sidecar"),
      createFragment("atom-out", parent.id, "rec-sidecar"),
    ],
  });

  const parentStats = inventory.contributions.find((entry) => entry.session_ref === parent.id)?.stats;
  assert.equal(parentStats?.storage_bytes, 50_000);
  assert.equal(inventory.children.length, 1);
  assert.equal(inventory.children[0]?.identity_kind, "sidecar");
  assert.equal(inventory.children[0]?.stats.storage_bytes, 10_000);
  assert.equal(inventory.children[0]?.input_preview, "Search the codebase for timeout handling.");
  assert.equal(inventory.children[0]?.output_preview, "Timeouts live in retry.ts.");
  assert.equal(listSessionFamilies([parent], inventory)[0]?.combined.storage_bytes, 60_000);
});

test("session family inventory path-links Cursor nested subagent transcripts", () => {
  const source = { ...createSource(), platform: "cursor" as const, slot_id: "cursor" };
  const parent = createSession(
    source,
    "sess:cursor:parent-uuid",
    "parent-uuid",
    "/.cursor/projects/app/agent-transcripts/parent-uuid/parent-uuid.jsonl",
  );
  const child = createSession(
    source,
    "sess:cursor:agent-aaaa",
    "agent-aaaa",
    "/.cursor/projects/app/agent-transcripts/parent-uuid/subagents/agent-aaaa.jsonl",
  );
  child.turn_count = 0;
  const inventory = buildSessionFamilyInventory({
    sessions: [parent, child],
    blobs: [
      createBlob("blob-parent", parentBlobPath(parent), 4_000),
      createBlob(
        "blob-child",
        "/.cursor/projects/app/agent-transcripts/parent-uuid/subagents/agent-aaaa.jsonl",
        8_000,
      ),
    ],
    records: [
      createRecord("rec-parent", parent.id, "blob-parent"),
      createRecord("rec-child", child.id, "blob-child"),
    ],
  });
  const family = listSessionFamilies([parent, child], inventory)[0];
  assert.equal(family?.parent_session_ref, parent.id);
  assert.equal(family?.children[0]?.child_session_ref, child.id);
  assert.equal(family?.children[0]?.stats.storage_bytes, 8_000);
  assert.equal(family?.combined.storage_bytes, 12_000);
});

function parentBlobPath(session: SessionProjection): string {
  return `/.cursor/projects/app/agent-transcripts/${session.source_session_id}/${session.source_session_id}.jsonl`;
}

test("session family inventory canonicalizes inbound parent refs when the parent session is absent", () => {
  const source = createSource();
  source.platform = "codex";
  const child = createSession(source, "sess:codex:child", "child", "/child.jsonl");
  child.turn_count = 0;
  const inventory = buildSessionFamilyInventory({
    sessions: [child],
    related_work: [{
      id: "related-in",
      query_session_ref: child.id,
      source_id: source.id,
      source_platform: source.platform,
      source_session_ref: child.id,
      parent_session_ref: "codex-delegation-parent",
      child_session_ref: child.id,
      relation_kind: "delegated_session",
      target_kind: "session",
      direction: "inbound",
      target_session_ref: "sess:codex:codex-delegation-parent",
      transcript_primary: true,
      evidence_confidence: 0.8,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      fragment_refs: [],
      raw_detail: {},
    }],
    blobs: [createBlob("blob-child", "/child.jsonl", 3_000)],
    records: [createRecord("rec-child", child.id, "blob-child")],
  });
  assert.equal(inventory.children[0]?.parent_session_ref, "sess:codex:codex-delegation-parent");
  assert.equal(inventory.children[0]?.child_session_ref, child.id);
  assert.equal(listSessionFamilies([child], inventory).length, 0);
});

test("session family inventory does not treat Claude message parentUuid as a parent session", () => {
  const source = { ...createSource(), platform: "claude_code" as const };
  const session = createSession(
    source,
    "sess:claude_code:claude-native",
    "claude-native",
    "/.claude/projects/app/claude-native.jsonl",
  );
  const sidecarBlob = createBlob(
    "blob-sidecar",
    "/.claude/projects/app/claude-native/subagents/agent-aaaa.jsonl",
    10_000,
  );
  const parentBlob = createBlob("blob-parent", "/.claude/projects/app/claude-native.jsonl", 50_000);
  const related = listSessionRelatedWork([session], [
    {
      id: "fragment-claude-parent-uuid",
      source_id: source.id,
      session_ref: session.id,
      record_id: "rec-parent",
      seq_no: 0,
      fragment_kind: "session_relation",
      time_key: "2026-01-01T00:00:00.000Z",
      payload: {
        parent_uuid: "message-uuid-not-a-session",
        is_sidechain: false,
      },
      raw_refs: [],
      source_format_profile_id: "claude:test:v1",
    },
    {
      id: "fragment-claude-sidecar-sidechain",
      source_id: source.id,
      session_ref: session.id,
      record_id: "rec-sidecar",
      seq_no: 1,
      fragment_kind: "session_relation",
      time_key: "2026-01-01T00:00:01.000Z",
      payload: {
        parent_uuid: "message-uuid-of-sidecar-parent",
        is_sidechain: true,
      },
      raw_refs: [],
      source_format_profile_id: "claude:test:v1",
    },
  ]);
  const inventory = buildSessionFamilyInventory({
    sessions: [session],
    related_work: related,
    blobs: [parentBlob, sidecarBlob],
    records: [
      createRecord("rec-parent", session.id, parentBlob.id),
      createRecord("rec-sidecar", session.id, sidecarBlob.id),
    ],
  });
  const families = listSessionFamilies([session], inventory);
  assert.equal(families.length, 1);
  assert.equal(families[0]?.parent_session_ref, session.id);
  assert.equal(families[0]?.child_count, 1);
  assert.equal(families[0]?.children[0]?.identity_kind, "sidecar");
  assert.equal(families[0]?.children[0]?.child_session_ref, undefined);
  assert.equal(families.some((family) => family.parent_session_ref.includes("message-uuid")), false);
  assert.equal(families[0]?.children.some((child) => child.child_session_ref === session.id), false);
});

test("mergeSessionFamilyInventories overlays child contributions from a later payload", () => {
  const source = createSource();
  const parent = createSession(source, "sess:codex:parent", "parent", "/parent.jsonl");
  const child = createSession(source, "sess:codex:child", "child", "/child.jsonl");
  const parentInventory = buildSessionFamilyInventory({
    sessions: [parent],
    related_work: [{
      id: "related-out",
      query_session_ref: parent.id,
      source_id: source.id,
      source_platform: source.platform,
      source_session_ref: parent.id,
      parent_session_ref: parent.id,
      child_session_ref: child.id,
      relation_kind: "delegated_session",
      target_kind: "session",
      direction: "outbound",
      target_session_ref: child.id,
      transcript_primary: true,
      evidence_confidence: 0.8,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      fragment_refs: [],
      raw_detail: {},
    }],
    blobs: [createBlob("blob-parent", "/parent.jsonl", 5_000)],
    records: [createRecord("rec-parent", parent.id, "blob-parent")],
  });
  const childInventory = buildSessionFamilyInventory({
    sessions: [child],
    blobs: [createBlob("blob-child", "/child.jsonl", 9_000)],
    records: [createRecord("rec-child", child.id, "blob-child")],
  });
  const merged = mergeSessionFamilyInventories([parentInventory, childInventory]);
  const family = listSessionFamilies([parent, child], merged)[0];
  assert.equal(family?.child_count, 1);
  assert.equal(family?.parent.storage_bytes, 5_000);
  assert.equal(family?.children[0]?.stats.storage_bytes, 9_000);
  assert.equal(family?.combined.storage_bytes, 14_000);
});

test("listSessionFamilies overlays a richer child contribution over parent-side spawn stats", () => {
  const source = createSource();
  const parent = createSession(source, "sess:grok:parent", "parent", "/workspace/parent/chat_history.jsonl");
  const child = createSession(source, "sess:grok:child", "child", "/workspace/child/chat_history.jsonl");
  child.turn_count = 0;
  const parentInventory = buildSessionFamilyInventory({
    sessions: [parent, child],
    related_work: [{
      id: "related-out",
      query_session_ref: parent.id,
      source_id: source.id,
      source_platform: source.platform,
      source_session_ref: parent.id,
      parent_session_ref: parent.id,
      child_session_ref: child.id,
      relation_kind: "delegated_session",
      target_kind: "session",
      direction: "outbound",
      target_session_ref: child.id,
      transcript_primary: true,
      evidence_confidence: 0.8,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      fragment_refs: [],
      raw_detail: {},
    }],
    blobs: [
      createBlob("blob-parent", "/workspace/parent/chat_history.jsonl", 5_000),
      createBlob("blob-meta", "/workspace/parent/subagents/child/meta.json", 1_200),
    ],
    records: [
      createRecord("rec-parent", parent.id, "blob-parent"),
      createRecord("rec-meta", parent.id, "blob-meta"),
    ],
  });
  const childInventory = buildSessionFamilyInventory({
    sessions: [child],
    blobs: [createBlob("blob-child", "/workspace/child/chat_history.jsonl", 9_000)],
    records: [createRecord("rec-child", child.id, "blob-child")],
  });
  const family = listSessionFamilies(
    [parent, child],
    mergeSessionFamilyInventories([parentInventory, childInventory]),
  )[0];
  assert.equal(family?.children[0]?.stats.storage_bytes, 10_200);
  assert.equal(family?.combined.storage_bytes, 15_200);
});

test("session family I/O previews keep maskable secrets past the compact cut", () => {
  const source = createSource();
  const parent = createSession(source, "sess:grok:parent", "parent", "/parent.jsonl");
  const child = createSession(source, "sess:grok:child", "child", "/child.jsonl");
  child.turn_count = 0;
  const secret = `sk-${"A".repeat(24)}`;
  const prompt = `${"x".repeat(220)} ${secret} trailing task`;
  const inventory = buildSessionFamilyInventory({
    sessions: [parent, child],
    related_work: [{
      id: "related-out",
      query_session_ref: parent.id,
      source_id: source.id,
      source_platform: source.platform,
      source_session_ref: parent.id,
      parent_session_ref: parent.id,
      child_session_ref: child.id,
      relation_kind: "delegated_session",
      target_kind: "session",
      direction: "outbound",
      target_session_ref: child.id,
      transcript_primary: true,
      evidence_confidence: 0.9,
      created_at: "2026-01-02T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      fragment_refs: [],
      raw_detail: {},
    }],
    atoms: [
      createAtom("atom-spawn", parent.id, "tool_call", {
        tool_name: "spawn_subagent",
        call_id: "call-1",
        input: { subagent_id: "child", prompt },
      }),
    ],
  });
  assert.match(inventory.children[0]?.input_preview ?? "", new RegExp(secret, "u"));
  assert.ok((inventory.children[0]?.input_preview?.length ?? 0) > 240);
});

function createSource(): SourceStatus {
  return {
    id: "src-family",
    slot_id: "grok",
    family: "local_coding_agent",
    platform: "grok",
    display_name: "Grok",
    base_dir: "/tmp",
    host_id: "host",
    last_sync: null,
    sync_status: "healthy",
    total_blobs: 0,
    total_records: 0,
    total_fragments: 0,
    total_atoms: 0,
    total_sessions: 0,
    total_turns: 0,
  };
}

function createSession(
  source: SourceStatus,
  id: string,
  nativeId: string,
  originPath: string,
): SessionProjection {
  void originPath;
  return {
    id,
    source_id: source.id,
    source_platform: source.platform,
    host_id: source.host_id,
    title: nativeId,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:01:00.000Z",
    turn_count: 1,
    source_session_id: nativeId,
    sync_axis: "current",
  };
}

function createTurn(source: SourceStatus, session: SessionProjection, tokens: number): UserTurnProjection {
  return {
    id: `turn-${session.id}`,
    revision_id: `turn-${session.id}:r1`,
    turn_id: `turn-${session.id}`,
    turn_revision_id: `turn-${session.id}:r1`,
    user_messages: [],
    raw_text: "parent ask",
    canonical_text: "parent ask",
    display_segments: [{ type: "text", content: "parent ask" }],
    created_at: "2026-01-01T00:00:00.000Z",
    submission_started_at: "2026-01-01T00:00:00.000Z",
    last_context_activity_at: "2026-01-01T00:01:00.000Z",
    session_id: session.id,
    source_id: source.id,
    link_state: "unlinked",
    sync_axis: "current",
    value_axis: "active",
    retention_axis: "keep_raw_and_derived",
    context_ref: `context-${session.id}`,
    context_summary: {
      assistant_reply_count: 1,
      tool_call_count: 1,
      token_usage: { input_tokens: tokens - 10, output_tokens: 10, total_tokens: tokens },
      total_tokens: tokens,
      has_errors: false,
    },
    lineage: { atom_refs: [], candidate_refs: [], fragment_refs: [], record_refs: [], blob_refs: [] },
  };
}

function createBlob(id: string, originPath: string, size: number): CapturedBlob {
  return {
    id,
    source_id: "src-family",
    host_id: "host",
    origin_path: originPath,
    checksum: id,
    size_bytes: size,
    captured_at: "2026-01-01T00:00:00.000Z",
    capture_run_id: "run",
  };
}

function createRecord(id: string, sessionRef: string, blobId: string, rawJson = "{}"): RawRecord {
  return {
    id,
    source_id: "src-family",
    blob_id: blobId,
    session_ref: sessionRef,
    ordinal: 0,
    record_path_or_offset: "0",
    observed_at: "2026-01-01T00:00:00.000Z",
    parseable: true,
    raw_json: rawJson,
  };
}

function createFragment(id: string, sessionRef: string, recordId: string): SourceFragment {
  return {
    id,
    source_id: "src-family",
    session_ref: sessionRef,
    record_id: recordId,
    seq_no: 0,
    fragment_kind: "text",
    time_key: "2026-01-01T00:00:00.000Z",
    payload: {},
    raw_refs: [],
    source_format_profile_id: "test",
  };
}

function createAtom(
  id: string,
  sessionRef: string,
  contentKind: ConversationAtom["content_kind"],
  payload: Record<string, unknown>,
  originKind: ConversationAtom["origin_kind"] = "tool_generated",
): ConversationAtom {
  return {
    id,
    source_id: "src-family",
    session_ref: sessionRef,
    seq_no: 0,
    actor_kind: (typeof payload.actor_kind === "string"
      ? payload.actor_kind
      : contentKind === "text" ? "assistant" : "tool") as ConversationAtom["actor_kind"],
    origin_kind: (payload.origin_kind as ConversationAtom["origin_kind"] | undefined) ?? originKind,
    content_kind: contentKind,
    time_key: "2026-01-01T00:00:00.000Z",
    display_policy: "show",
    payload,
    fragment_refs: [id],
    source_format_profile_id: "test",
  };
}
