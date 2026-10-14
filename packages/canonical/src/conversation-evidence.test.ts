import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ConversationEvidence } from "@cchistory/domain";
import { readConversationEvidence, prepareConversationEvidence, searchConversationEvidence, EvidenceCursorError, validateEvidenceBudget } from "./conversation-evidence.js";
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

test("prepared pages own immutable content and agree with direct reads, including unpaired surrogates", () => {
  const mutable = messages.map(message => ({ ...message, text: message.text.repeat(37) + "\ud800" }));
  const original = mutable.map(message => ({ ...message }));
  const prepared = prepareConversationEvidence(mutable, "session:fixture-parent");
  mutable[0]!.text = "Changed after preparation";
  mutable.reverse();
  let cursor: string | undefined;
  for (let count = 0; ; count++) {
    assert.ok(count < 100);
    const options = { max_chars: 257, limit: 2, cursor };
    const page = prepared.read(options);
    assert.deepEqual(page, readConversationEvidence(original, "session:fixture-parent", options));
    if (!page.has_more) break;
    cursor = page.next_cursor!;
  }
  assert.notEqual(prepared.read().revision, readConversationEvidence(mutable, "session:fixture-parent").revision);
  const replaced = original.map(message => ({ ...message, text: message.text.replace(/\ud800/g, "\ufffd") }));
  assert.notEqual(prepared.read().revision, readConversationEvidence(replaced, "session:fixture-parent").revision);
});

test("empty sessions and empty messages terminate without inventing text", () => {
  assert.deepEqual(readConversationEvidence([], "empty").messages, []);
  assert.equal(readConversationEvidence([], "empty").next_cursor, null);
  const result = readConversationEvidence(messages.map(m => ({ ...m, text: "" })), "empty-body", { limit: 2 });
  assert.equal(result.returned_chars, 0);
  assert.equal(result.messages.length, 2);
  assert.ok(result.next_cursor);
});

test("message-grouped search paginates older matches without changing default session grouping", () => {
  const sessions: Parameters<typeof searchConversationEvidence>[0]["sessions"] = [{ id: "fixture-parent", source_id: "fixture-source",
    source_platform: "codex", host_id: "fixture-host", created_at: messages[0]!.created_at,
    updated_at: messages.at(-1)!.created_at, turn_count: 2, sync_axis: "current" }];
  const input = { messages, sessions, related_work: [], query: "fixture", limit: 1 };
  const grouped = searchConversationEvidence(input);
  assert.equal(grouped.total, 1);
  assert.equal(grouped.results[0]?.message_id, "message-3");
  assert.equal(grouped.next_offset, null);
  const first = searchConversationEvidence({ ...input, group_by: "message" });
  const second = searchConversationEvidence({ ...input, group_by: "message", offset: first.next_offset! });
  assert.equal(first.total, 2);
  assert.equal(first.next_offset, 1);
  assert.equal(second.results[0]?.message_id, "message-0");
  assert.equal(second.results[0]?.turn_id, "turn-0");
  assert.equal(second.results[0]?.session_id, "fixture-parent");
  assert.equal(second.next_offset, null);
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
