import { createHash } from "node:crypto";
import { applyMaskTemplates, stableId, type ConversationAtom, type ConversationEvidence, type EvidenceReadOptions, type SessionProjection,
  type SessionRelatedWorkProjection, type TurnContextProjection, type UserTurnProjection } from "@cchistory/domain";
import { compareTurnsByChronology } from "./read-order.js";
import { filterSessionsByDirectoryScope } from "./directory-scope.js";
import { filterTopLevelSessions } from "./session-collections.js";
import { buildSearchPlan, computeSearchRecencyScore, matchesSearchPlan } from "./search.js";

export const DEFAULT_EVIDENCE_CHARS = 8_000;
export const MAX_EVIDENCE_CHARS = 64_000;

export class EvidenceCursorError extends Error {
  readonly code = "invalid_evidence_cursor";
  constructor(message: string) { super(message); }
}

export function buildConversationEvidence(turns: readonly UserTurnProjection[], contexts: readonly TurnContextProjection[],
  atoms: readonly ConversationAtom[] = [], sessions: readonly SessionProjection[] = []): ConversationEvidence[] {
  const byTurn = new Map(contexts.map(context => [context.turn_id, context]));
  const messages: ConversationEvidence[] = [...turns].sort(compareTurnsByChronology).flatMap(turn => [
    { message_id: turn.id, session_id: turn.session_id, turn_id: turn.id, role: "user" as const,
      created_at: turn.submission_started_at, text: turn.canonical_text },
    ...(byTurn.get(turn.id)?.assistant_replies ?? []).map(reply => ({
      message_id: reply.id, session_id: turn.session_id, turn_id: turn.id, role: "assistant" as const,
      created_at: reply.created_at, text: reply.canonical_text,
    })),
  ]);
  const projected = new Set(messages.map(message => message.message_id));
  const sessionIds = new Set(sessions.map(session => session.id));
  for (const atom of atoms) {
    if (atom.actor_kind !== "assistant" || atom.content_kind !== "text" || atom.display_policy === "hide" || !sessionIds.has(atom.session_ref)) continue;
    const messageId = stableId("assistant-reply", atom.source_id, atom.session_ref, atom.id);
    if (projected.has(messageId) || typeof atom.payload.text !== "string") continue;
    projected.add(messageId);
    messages.push({ message_id: messageId, session_id: atom.session_ref, turn_id: null, role: "assistant",
      created_at: atom.time_key, text: applyMaskTemplates(atom.payload.text, "assistant_reply").canonical_text });
  }
  // Stable order preserves canonical turn/reply order for equal source timestamps.
  return messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Offsets/budgets use UTF-16 code units, without cutting a surrogate pair. */
function boundary(text: string, offset: number): number {
  return offset > 0 && offset < text.length && /[\uD800-\uDBFF]/u.test(text[offset - 1]!)
    && /[\uDC00-\uDFFF]/u.test(text[offset]!) ? offset - 1 : offset;
}

export function validateEvidenceBudget(options: EvidenceReadOptions): void {
  const chars = options.max_chars ?? DEFAULT_EVIDENCE_CHARS, limit = options.limit ?? 20;
  if (!Number.isSafeInteger(chars) || chars < 256 || chars > MAX_EVIDENCE_CHARS) throw new Error(`max_chars must be an integer from 256 to ${MAX_EVIDENCE_CHARS}.`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Evidence limit must be an integer from 1 to 100.");
  if (options.cursor !== undefined && (typeof options.cursor !== "string" || !options.cursor || options.cursor.length > 2048)) throw new EvidenceCursorError("Invalid evidence cursor; restart this read without a cursor.");
  if (options.cursor) {
    try {
      if (!/^[A-Za-z0-9_-]+$/u.test(options.cursor)) throw new Error();
      const cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (cursor?.v !== 1 || !/^[a-f0-9]{64}$/u.test(cursor.revision) || !Number.isSafeInteger(cursor.index)
        || cursor.index < 0 || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
    } catch { throw new EvidenceCursorError("Invalid evidence cursor; restart this read without a cursor."); }
  }
}

/** Cursor identity binds the complete ordered evidence and resolved target, never a title or row position alone. */
export function readConversationEvidence(messages: readonly ConversationEvidence[], selector: string, options: EvidenceReadOptions = {}) {
  validateEvidenceBudget(options);
  const maxChars = options.max_chars ?? DEFAULT_EVIDENCE_CHARS, limit = options.limit ?? 20;
  const hash = createHash("sha256").update(selector);
  for (const message of messages) hash.update(JSON.stringify(message));
  const revision = hash.digest("hex");
  let index = 0, offset = 0;
  if (options.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (cursor.v !== 1 || cursor.revision !== revision) throw new Error();
      index = cursor.index; offset = cursor.offset;
      if (!Number.isSafeInteger(index) || index < 0 || index >= messages.length || !Number.isSafeInteger(offset)
        || offset < 0 || offset > messages[index]!.text.length || boundary(messages[index]!.text, offset) !== offset) throw new Error();
    } catch { throw new EvidenceCursorError("Evidence or target changed, or cursor is invalid; restart this read without a cursor."); }
  }
  const chunks: Array<ConversationEvidence & { start: number; end: number; total_chars: number; truncated: boolean }> = [];
  let remaining = maxChars;
  while (index < messages.length && chunks.length < limit && remaining > 0) {
    const message = messages[index]!;
    const end = boundary(message.text, Math.min(message.text.length, offset + remaining));
    if (end === offset && offset < message.text.length) break;
    chunks.push({ ...message, text: message.text.slice(offset, end), start: offset, end,
      total_chars: message.text.length, truncated: offset > 0 || end < message.text.length });
    remaining -= end - offset;
    if (end === message.text.length) { index++; offset = 0; } else offset = end;
  }
  return {
    revision, messages: chunks, shown: chunks.length, total_messages: messages.length,
    returned_chars: maxChars - remaining, max_chars: maxChars,
    has_more: index < messages.length,
    next_cursor: index < messages.length ? Buffer.from(JSON.stringify({ v: 1, revision, index, offset })).toString("base64url") : null,
  };
}

/** Full masked user/reply text; delegated matches keep their own evidence IDs under a top-level parent. */
export function searchConversationEvidence(input: {
  messages: readonly ConversationEvidence[];
  sessions: readonly SessionProjection[];
  related_work: readonly SessionRelatedWorkProjection[];
  query: string;
  directoryScope?: string;
  projectId?: string;
  projectTurnIds?: ReadonlySet<string>;
  limit?: number;
  offset?: number;
  max_chars?: number;
}) {
  validateEvidenceBudget(input);
  const plan = buildSearchPlan(input.query);
  const top = new Set(filterTopLevelSessions(input.sessions, input.related_work).map(s => s.id));
  const scoped = new Set(filterSessionsByDirectoryScope(input.sessions, input.directoryScope).map(s => s.id));
  const sessions = new Map(input.sessions.map(s => [s.id, s]));
  const parents = new Map<string, string>();
  for (const relation of input.related_work) {
    if (relation.relation_kind === "delegated_session" && relation.direction === "inbound" && relation.child_session_ref
      && relation.parent_session_ref && relation.child_session_ref !== relation.parent_session_ref && sessions.has(relation.parent_session_ref)) {
      if (!parents.has(relation.child_session_ref)) parents.set(relation.child_session_ref, relation.parent_session_ref);
    }
  }
  const root = (id: string): string => {
    const seen = new Set<string>();
    while (!top.has(id) && parents.has(id) && !seen.has(id)) { seen.add(id); id = parents.get(id)!; }
    return id;
  };
  const now = input.sessions.reduce((latest, session) => Math.max(latest, Date.parse(session.updated_at) || 0), 0);
  const matches = new Map<string, { message: ConversationEvidence; score: number }>();
  for (const message of input.messages) {
    const parent = root(message.session_id);
    if (!scoped.has(message.session_id) || !scoped.has(parent) || !top.has(parent)) continue;
    if (input.projectId && (message.turn_id === null ? sessions.get(message.session_id)?.primary_project_id !== input.projectId
      : !input.projectTurnIds?.has(message.turn_id))) continue;
    if (!matchesSearchPlan(message.text, plan)) continue;
    const score = computeSearchRecencyScore({ submission_started_at: message.created_at }, now);
    const previous = matches.get(parent);
    if (!previous || score > previous.score || score === previous.score && message.message_id < previous.message.message_id) matches.set(parent, { message, score });
  }
  const ranked = [...matches].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  const offset = input.offset ?? 0, limit = input.limit ?? 20, maxChars = input.max_chars ?? DEFAULT_EVIDENCE_CHARS;
  const results: Array<{ session_id: string; matched_session_id: string; turn_id: string | null; message_id: string; role: "user" | "assistant";
    created_at: string; text: string; start: number; end: number; total_chars: number; truncated: boolean }> = [];
  let remaining = maxChars;
  for (const [sessionId, { message }] of ranked.slice(offset, offset + limit)) {
    if (remaining < 2) break;
    const first = message.text.toLowerCase().indexOf(plan.terms[0]?.value ?? "");
    const start = boundary(message.text, Math.max(0, first - 80));
    const end = boundary(message.text, Math.min(message.text.length, start + Math.min(400, remaining)));
    results.push({ session_id: sessionId, matched_session_id: message.session_id, turn_id: message.turn_id, message_id: message.message_id,
      role: message.role, created_at: message.created_at, text: message.text.slice(start, end), start, end,
      total_chars: message.text.length, truncated: start > 0 || end < message.text.length });
    remaining -= end - start;
  }
  return { content: "conversation", searched_roles: ["user", "assistant"], text_coverage: "full", tool_output_searched: false,
    total: ranked.length, shown: results.length, offset, limit, results, returned_chars: maxChars - remaining, max_chars: maxChars,
    next_offset: offset + results.length < ranked.length ? offset + results.length : null };
}
