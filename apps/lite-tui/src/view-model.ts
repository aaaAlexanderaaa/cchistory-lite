import type { SessionProjection } from "@cchistory/domain";
import type { LiteTurnEntry } from "./model.js";
import { tameBrowseMarkup } from "./text.js";

export interface LiteTurnDisplayGroup {
  sessionId: string;
  title: string;
  createdAt?: string;
  /** Number of visible turns for this session in the current scope. */
  visibleTurnCount: number;
  /** Original turn indexes; the view model never reorders canonical results. */
  turnIndices: number[];
}

/**
 * Build stable labels for session rows without changing canonical session
 * identity. Duplicate titles are common in project-level fallback metadata,
 * so the shortest stable native reference is prefixed when needed.
 */
export function buildSessionDisplayLabels(sessions: readonly SessionProjection[]): Map<string, string> {
  const labels = new Map<string, string>();
  const groups = new Map<string, SessionProjection[]>();
  for (const session of sessions) {
    const base = sessionBaseLabel(session);
    const key = base.toLowerCase();
    const group = groups.get(key);
    if (group) group.push(session);
    else groups.set(key, [session]);
  }

  for (const group of groups.values()) {
    if (group.length === 1) {
      const session = group[0]!;
      labels.set(session.id, sessionBaseLabel(session));
      continue;
    }
    const nativeRefs = group.map((session) => session.source_session_id?.trim() || "");
    const canonicalRefs = group.map((session) => session.id);
    for (const [index, session] of group.entries()) {
      const nativeRef = nativeRefs[index];
      const disambiguator = nativeRef
        ? shortestUniquePrefix(nativeRef, nativeRefs, index) ?? shortestUniquePrefix(session.id, canonicalRefs, index)
        : shortestUniquePrefix(session.id, canonicalRefs, index);
      const prefix = disambiguator ?? session.source_platform;
      labels.set(session.id, `${prefix} · ${sessionBaseLabel(session)}`);
    }
  }
  return labels;
}

/**
 * Group only contiguous ranges for tree connectors while counting every
 * visible turn belonging to the session. This distinction is deliberate:
 * project and search scopes are canonically ordered across sessions, so a
 * session may reappear later without its turns being silently reordered.
 */
export function buildTurnDisplayGroups(turns: readonly LiteTurnEntry[]): LiteTurnDisplayGroup[] {
  const sessionById = new Map<string, SessionProjection>();
  const visibleTurnCounts = new Map<string, number>();
  for (const entry of turns) {
    if (entry.session) sessionById.set(entry.session.id, entry.session);
    visibleTurnCounts.set(entry.turn.session_id, (visibleTurnCounts.get(entry.turn.session_id) ?? 0) + 1);
  }
  const sessionLabels = buildSessionDisplayLabels([...sessionById.values()]);
  const groups: LiteTurnDisplayGroup[] = [];
  let groupStart = 0;
  while (groupStart < turns.length) {
    const sessionId = turns[groupStart]!.turn.session_id;
    let groupEnd = groupStart;
    while (groupEnd < turns.length && turns[groupEnd]!.turn.session_id === sessionId) groupEnd += 1;

    const first = turns[groupStart]!;
    groups.push({
      sessionId,
      title: sessionLabels.get(sessionId) ?? sessionBaseLabel(first.session, sessionId),
      createdAt: first.session?.created_at ?? first.turn.created_at,
      visibleTurnCount: visibleTurnCounts.get(sessionId) ?? groupEnd - groupStart,
      turnIndices: Array.from({ length: groupEnd - groupStart }, (_, offset) => groupStart + offset),
    });
    groupStart = groupEnd;
  }
  return groups;
}

export function sessionBaseLabel(
  session: Pick<SessionProjection, "id" | "title" | "source_session_id"> | undefined,
  fallbackId = "",
): string {
  const title = session?.title ? tameBrowseMarkup(session.title) : "";
  return title || session?.source_session_id || session?.id || fallbackId;
}

function shortestUniquePrefix(value: string, peers: readonly string[], index: number): string | undefined {
  if (!value) return undefined;
  const minimumLength = Math.min(8, value.length);
  for (let length = minimumLength; length <= value.length; length += 1) {
    const prefix = value.slice(0, length);
    if (peers.every((peer, peerIndex) => peerIndex === index || !peer.startsWith(prefix))) return prefix;
  }
  return undefined;
}
