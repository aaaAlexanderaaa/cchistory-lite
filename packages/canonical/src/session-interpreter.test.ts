import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { ParsedSessionEvidence } from "@cchistory/domain";
import { interpretSessionEvidence } from "./session-interpreter.js";

async function readEvidence(): Promise<ParsedSessionEvidence> {
  return JSON.parse(await readFile(new URL("../../../mock_data/fixtures/context-boundary/canonical-evidence.json", import.meta.url), "utf8"));
}

function freezeEvidence<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeEvidence(child);
    Object.freeze(value);
  }
  return value;
}

test("canonical interpretation borrows frozen evidence without accumulating submission edges", async () => {
  const evidence = freezeEvidence(await readEvidence());
  const before = structuredClone(evidence);
  const first = interpretSessionEvidence(evidence);
  const second = interpretSessionEvidence(evidence);
  assert.deepEqual(evidence, before);
  assert.deepEqual(second, first);
  assert.equal(evidence.edges.length, 2);
  assert.equal(new Set(first.edges.map((edge) => edge.id)).size, 4);
  assert.equal(first.edges.length, 8, "preserve legacy multiplicity until a separate evidence correction");
  assert.equal(first.session?.turn_count, 2);
  assert.equal(first.candidates.filter((candidate) => candidate.candidate_kind === "submission_group").length, 2);
  assert.equal(first.turns[0]?.canonical_text, "Review the fixture.");
  assert.equal(first.turns[0]?.context_summary.total_tokens, 6);
  assert.equal(first.turns[0]?.context_summary.has_errors, true);
  assert.equal(first.turns[0]?.context_summary.primary_model, "model-fixture");
  assert.equal(first.turns[0]?.last_context_activity_at, "2026-04-12T00:00:05.000Z");
  assert.equal(first.contexts[0]?.assistant_replies[0]?.tool_call_ids.length, 1);
  assert.equal(first.contexts[0]?.tool_calls[0]?.output, "Fixture content");
  assert.equal(first.turns[1]?.context_summary.total_tokens, undefined);
  assert.equal(first.turns[1]?.context_summary.zero_token_reason, "no_assistant_reply");
  assert.deepEqual(first.contexts[1]?.assistant_replies, []);
});

test("canonical interpretation retains empty sessions and explicitly suppresses empty CodeBuddy evidence", async () => {
  const fixture = await readEvidence();
  const empty = { ...fixture, atoms: [], edges: [] };
  const retained = interpretSessionEvidence(freezeEvidence(empty));
  assert.equal(retained.session?.id, fixture.draft.id);
  assert.equal(retained.session?.turn_count, 0);
  assert.deepEqual(retained.turns, []);
  assert.deepEqual(retained.contexts, []);

  const suppressed = interpretSessionEvidence(freezeEvidence({
    ...empty,
    draft: { ...empty.draft, source_platform: "codebuddy" },
  }));
  assert.equal(suppressed.session, undefined);
  assert.deepEqual(suppressed.candidates, []);
  assert.deepEqual(suppressed.turns, []);
  assert.deepEqual(suppressed.contexts, []);
});
