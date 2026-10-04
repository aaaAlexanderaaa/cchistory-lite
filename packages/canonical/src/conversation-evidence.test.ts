import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ConversationEvidence } from "@cchistory/domain";
import { readConversationEvidence, EvidenceCursorError, validateEvidenceBudget } from "./conversation-evidence.js";
import { auditProjectionConsistency } from "./projection-audit.js";
import { summarizeReadStatus } from "./read-status.js";

const records = (await readFile(new URL("../../../mock_data/fixtures/agent-evidence/parent.jsonl", import.meta.url), "utf8")).trim().split("\n").map(line => JSON.parse(line));
const messages: ConversationEvidence[] = records.filter(r => r.payload.type === "message").map((record, index) => ({
  message_id: `message-${index}`, session_id: "fixture-parent", turn_id: `turn-${Math.floor(index / 2)}`,
  role: record.payload.role, created_at: record.timestamp, text: record.payload.content[0].text,
}));

test("bounded evidence pages reconstruct all Unicode text without duplicates or split surrogate pairs", () => {
  const expanded = messages.map(m => ({ ...m, text: m.text.repeat(37) }));
  const recovered = new Map<string, string>();
  let cursor: string | undefined;
  for (let pages = 0; ; pages++) {
    assert.ok(pages < 100);
    const result = readConversationEvidence(expanded, "session:fixture-parent", { max_chars: 257, limit: 2, cursor });
    assert.ok(result.returned_chars <= 257);
    assert.ok(result.messages.length <= 2);
    for (const chunk of result.messages) {
      assert.equal(chunk.start, (recovered.get(chunk.message_id) ?? "").length);
      assert.equal(chunk.text.length, chunk.end - chunk.start);
      assert.doesNotMatch(chunk.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      recovered.set(chunk.message_id, (recovered.get(chunk.message_id) ?? "") + chunk.text);
    }
    if (!result.has_more) { assert.equal(result.next_cursor, null); break; }
    assert.ok(result.next_cursor && result.next_cursor !== cursor);
    cursor = result.next_cursor;
  }
  assert.deepEqual(expanded.map(m => recovered.get(m.message_id)), expanded.map(m => m.text));
});

test("cursors reject changed content, another target, reordered evidence and malformed offsets", () => {
  const cursor = readConversationEvidence(messages, "session:a", { limit: 1 }).next_cursor!;
  assert.throws(() => readConversationEvidence(messages, "session:b", { cursor }), EvidenceCursorError);
  assert.throws(() => readConversationEvidence([...messages].reverse(), "session:a", { cursor }), EvidenceCursorError);
  assert.throws(() => readConversationEvidence(messages.map(m => ({ ...m, text: m.text + "." })), "session:a", { cursor }), EvidenceCursorError);
  const modified = JSON.parse(Buffer.from(cursor, "base64url").toString());
  modified.offset = -1;
  assert.throws(() => validateEvidenceBudget({ cursor: Buffer.from(JSON.stringify(modified)).toString("base64url") }), EvidenceCursorError);
  assert.throws(() => validateEvidenceBudget({ cursor: "not-a-cursor" }), EvidenceCursorError);
});

test("empty sessions and empty messages terminate without inventing text", () => {
  assert.deepEqual(readConversationEvidence([], "empty").messages, []);
  assert.equal(readConversationEvidence([], "empty").next_cursor, null);
  const result = readConversationEvidence(messages.map(m => ({ ...m, text: "" })), "empty-body", { limit: 2 });
  assert.equal(result.returned_chars, 0);
  assert.equal(result.messages.length, 2);
  assert.ok(result.next_cursor);
});

test("evidence identity failures remain projection diagnostics", () => {
  const issues = auditProjectionConsistency({ sources: [], projects: [], sessions: [], turns: [], conversation_evidence: [messages[0]!, messages[0]!] });
  assert.ok(issues.some(issue => issue.code === "evidence-turn-mismatch"));
  assert.ok(issues.some(issue => issue.code === "duplicate-id" && issue.entity === "evidence"));
});

test("limited scans and observed diagnostics cannot report no known gaps", () => {
  const input = { sources: [], lossAudits: [], projectionIssueCount: 0 };
  assert.equal(summarizeReadStatus(input).status, "no_known_gaps");
  assert.equal(summarizeReadStatus({ ...input, limitedScan: true }).status, "unverified");
  assert.equal(summarizeReadStatus({ ...input, observedDiagnostics: true }).status, "unverified");
  assert.equal(summarizeReadStatus({ ...input, unknownDirectorySessions: 1 }).status, "partial");
  assert.equal(summarizeReadStatus({ ...input, projectionIssueCount: 1 }).status, "partial");
});
