import { Buffer } from "node:buffer";
import type {
  CapturedBlob,
  ConversationAtom,
  DelegatedChildProjection,
  RawRecord,
  SessionContributionProjection,
  SessionContributionStats,
  SessionFamilyProjection,
  SessionProjection,
  SessionRelatedWorkProjection,
  SourceFragment,
  TokenUsageSummary,
  TurnContextProjection,
  UserTurnProjection,
} from "@cchistory/domain";
import { buildSessionRelatedWorkIndex } from "./related-work.js";
import { resolveStructuredTokenTotal, resolveTurnUsage } from "./usage.js";
import { asOptionalString, compositeKey, uniqueStrings } from "./utils.js";

export const FAMILY_IO_PREVIEW_CHARS = 240;
const FAMILY_IO_EVIDENCE_CHARS = 8192;
const SPAWN_TOOL_NAMES = new Set(["spawn_subagent", "Task", "Agent", "task"]);

export interface SessionFamilyInput {
  sessions: readonly SessionProjection[];
  turns?: readonly UserTurnProjection[];
  contexts?: readonly TurnContextProjection[];
  related_work?: readonly SessionRelatedWorkProjection[];
  fragments?: readonly SourceFragment[];
  blobs?: readonly CapturedBlob[];
  records?: readonly RawRecord[];
  atoms?: readonly ConversationAtom[];
}

export interface SessionFamilyInventory {
  contributions: SessionContributionProjection[];
  children: DelegatedChildProjection[];
}

export function emptyContributionStats(): SessionContributionStats {
  return {
    storage_bytes: 0,
    blob_count: 0,
    turn_count: 0,
    assistant_reply_count: 0,
    tool_call_count: 0,
    tool_success_count: 0,
    tool_error_count: 0,
    tool_pending_count: 0,
  };
}

export function addContributionStats(
  left: SessionContributionStats,
  right: SessionContributionStats,
): SessionContributionStats {
  return {
    storage_bytes: left.storage_bytes + right.storage_bytes,
    blob_count: left.blob_count + right.blob_count,
    turn_count: left.turn_count + right.turn_count,
    assistant_reply_count: left.assistant_reply_count + right.assistant_reply_count,
    tool_call_count: left.tool_call_count + right.tool_call_count,
    tool_success_count: left.tool_success_count + right.tool_success_count,
    tool_error_count: left.tool_error_count + right.tool_error_count,
    tool_pending_count: left.tool_pending_count + right.tool_pending_count,
    input_tokens: addOptionalNumber(left.input_tokens, right.input_tokens),
    output_tokens: addOptionalNumber(left.output_tokens, right.output_tokens),
    cached_input_tokens: addOptionalNumber(left.cached_input_tokens, right.cached_input_tokens),
    reasoning_output_tokens: addOptionalNumber(left.reasoning_output_tokens, right.reasoning_output_tokens),
    total_tokens: addOptionalNumber(left.total_tokens, right.total_tokens),
  };
}

export function mergeSessionFamilyInventories(
  inventories: readonly SessionFamilyInventory[],
): SessionFamilyInventory {
  const contributions = new Map<string, SessionContributionProjection>();
  const children = new Map<string, DelegatedChildProjection>();
  for (const inventory of inventories) {
    for (const contribution of inventory.contributions) {
      const existing = contributions.get(contribution.session_ref);
      if (!existing) {
        contributions.set(contribution.session_ref, cloneContribution(contribution));
        continue;
      }
      existing.stats = addContributionStats(existing.stats, contribution.stats);
      if (contribution.shared_storage) {
        existing.shared_storage = {
          estimated_bytes: (existing.shared_storage?.estimated_bytes ?? 0) + contribution.shared_storage.estimated_bytes,
          container_bytes: (existing.shared_storage?.container_bytes ?? 0) + contribution.shared_storage.container_bytes,
        };
      }
    }
    for (const child of inventory.children) {
      const existing = children.get(child.id);
      children.set(child.id, existing ? mergeChild(existing, child) : cloneChild(child));
    }
  }
  return {
    contributions: [...contributions.values()],
    children: [...children.values()].sort(compareChildren),
  };
}

export function buildSessionFamilyInventory(input: SessionFamilyInput): SessionFamilyInventory {
  const sessions = input.sessions;
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const relatedWork = input.related_work ?? listRelatedWork(sessions, input.fragments ?? []);
  const turnsBySession = groupTurns(input.turns ?? []);
  const attribution = attributeBlobs(input.blobs ?? [], input.records ?? [], sessions);
  const atomsByOwner = groupAtoms(input.atoms ?? [], input.fragments ?? [], input.records ?? [], attribution);
  const toolIo = collectToolIo(input.atoms ?? [], input.contexts ?? [], input.turns ?? []);

  const contributions: SessionContributionProjection[] = sessions.map((session) => {
    const ownerKey = sessionOwnerKey(session.id);
    const sharedStorage = attribution.shared.get(ownerKey);
    return {
      session_ref: session.id,
      source_id: session.source_id,
      source_platform: session.source_platform,
      stats: buildOwnerStats({
        ownerKey,
        session,
        turns: turnsBySession.get(session.id) ?? [],
        attribution,
        atoms: atomsByOwner.get(ownerKey) ?? [],
      }),
      ...(sharedStorage
        ? {
            shared_storage: {
              estimated_bytes: sharedStorage.estimatedBytes,
              container_bytes: sharedStorage.containerBytes,
            },
          }
        : {}),
    };
  });

  const children = new Map<string, DelegatedChildProjection>();
  for (const entry of relatedWork) {
    if (entry.relation_kind !== "delegated_session") continue;
    const rawParentRef = entry.parent_session_ref;
    const rawChildRef = entry.child_session_ref ?? (entry.direction === "inbound" ? entry.query_session_ref : entry.target_session_ref);
    if (!rawParentRef || !rawChildRef) continue;
    if (entry.direction !== "outbound" && entry.direction !== "inbound") continue;
    const childSession = sessionsById.get(rawChildRef) ?? resolveSessionByNativeId(rawChildRef, sessions);
    const parent = sessionsById.get(rawParentRef) ?? resolveSessionByNativeId(rawParentRef, sessions);
    if (!parent && !childSession) continue;
    if (parent && childSession && parent.id === childSession.id) continue;
    // Keep unresolved parents for child-only merge; listing requires a real session.
    const parentRef = parent?.id
      ?? (childSession ? `sess:${childSession.source_platform}:${stripSessPrefix(rawParentRef)}` : rawParentRef);
    const childRef = childSession?.id ?? rawChildRef;
    if (parentRef === childRef) continue;
    const childId = compositeKey("delegated-child", parentRef, childRef);
    const ownerKey = sessionOwnerKey(childRef);
    const stats = childSession
      ? buildOwnerStats({
          ownerKey,
          session: childSession,
          turns: turnsBySession.get(childSession.id) ?? [],
          attribution,
          atoms: atomsByOwner.get(ownerKey) ?? [],
        })
      : statsForOwner(ownerKey, attribution, atomsByOwner.get(ownerKey) ?? []);
    const io = resolveChildIo(
      parentRef,
      childRef,
      childNativeIds(childSession, childRef),
      toolIo,
      atomsByOwner.get(ownerKey) ?? [],
      entry,
    );
    upsertChild(children, {
      id: childId,
      identity_kind: "session",
      parent_session_ref: parentRef,
      child_session_ref: childRef,
      source_id: parent?.source_id ?? childSession?.source_id ?? entry.source_id,
      source_platform: parent?.source_platform ?? childSession?.source_platform ?? entry.source_platform,
      agent_key: entry.child_agent_key ?? asOptionalString(entry.raw_detail.agent_id),
      title: childSession?.canonical_title ?? childSession?.title ?? entry.canonical_title ?? entry.title,
      status: entry.status,
      created_at: childSession?.created_at ?? entry.created_at,
      updated_at: childSession?.updated_at ?? entry.updated_at,
      input_preview: io.input,
      output_preview: io.output,
      parent_tool_ref: entry.parent_tool_ref,
      origin_paths: attribution.originPaths.get(ownerKey) ?? [],
      stats,
    });
  }

  for (const blob of input.blobs ?? []) {
    const subagent = matchSubagentPath(blob.origin_path);
    if (!subagent) continue;
    const parent = resolveSessionByNativeId(subagent.parentDirName, sessions);
    const child = resolveSessionByNativeId(subagent.childId, sessions);
    if (!parent || !child || parent.id === child.id) continue;
    const ownerKey = sessionOwnerKey(child.id);
    const childId = compositeKey("delegated-child", parent.id, child.id);
    const existing = children.get(childId);
    if (existing) {
      existing.origin_paths = uniqueStrings([...existing.origin_paths, blob.origin_path]);
      existing.agent_key = existing.agent_key ?? subagent.childId;
      continue;
    }
    const io = resolveChildIo(
      parent.id,
      child.id,
      childNativeIds(child, child.id),
      toolIo,
      atomsByOwner.get(ownerKey) ?? [],
      undefined,
    );
    upsertChild(children, {
      id: childId,
      identity_kind: "session",
      parent_session_ref: parent.id,
      child_session_ref: child.id,
      source_id: parent.source_id,
      source_platform: parent.source_platform,
      agent_key: subagent.childId,
      title: child.canonical_title ?? child.title,
      created_at: child.created_at,
      updated_at: child.updated_at,
      input_preview: io.input,
      output_preview: io.output,
      origin_paths: attribution.originPaths.get(ownerKey) ?? [blob.origin_path],
      stats: buildOwnerStats({
        ownerKey,
        session: child,
        turns: turnsBySession.get(child.id) ?? [],
        attribution,
        atoms: atomsByOwner.get(ownerKey) ?? [],
      }),
    });
  }

  for (const [ownerKey, nativeId] of attribution.sidecarOwners) {
    const parentId = parentIdFromSidecarOwner(ownerKey, nativeId);
    const parent = parentId ? sessionsById.get(parentId) : undefined;
    if (!parent || !parentId) continue;
    const matching = [...children.values()].find((child) =>
      child.parent_session_ref === parent.id && childMatchesNativeId(child, nativeId, sessionsById),
    );
    const sidecarStats = statsForOwner(ownerKey, attribution, atomsByOwner.get(ownerKey) ?? []);
    const io = resolveChildIo(parent.id, nativeId, [nativeId], toolIo, atomsByOwner.get(ownerKey) ?? [], undefined);
    if (matching) {
      matching.origin_paths = uniqueStrings([...matching.origin_paths, ...(attribution.originPaths.get(ownerKey) ?? [])]);
      matching.stats = addContributionStats(matching.stats, sidecarStats);
      matching.input_preview = matching.input_preview ?? io.input;
      matching.output_preview = matching.output_preview ?? io.output;
      continue;
    }
    const atoms = atomsByOwner.get(ownerKey) ?? [];
    upsertChild(children, {
      id: compositeKey("delegated-child", parent.id, "sidecar", nativeId),
      identity_kind: "sidecar",
      parent_session_ref: parent.id,
      source_id: parent.source_id,
      source_platform: parent.source_platform,
      agent_key: nativeId,
      title: io.input ? previewText(io.input, 72) : nativeId,
      created_at: firstAtomTime(atoms) ?? parent.created_at,
      updated_at: lastAtomTime(atoms) ?? parent.updated_at,
      input_preview: io.input,
      output_preview: io.output,
      origin_paths: attribution.originPaths.get(ownerKey) ?? [],
      stats: sidecarStats,
    });
  }

  return {
    contributions,
    children: [...children.values()].sort(compareChildren),
  };
}

export function listSessionFamilies(
  sessions: readonly SessionProjection[],
  inventory: SessionFamilyInventory,
): SessionFamilyProjection[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const contributions = new Map(inventory.contributions.map((entry) => [entry.session_ref, entry]));
  const grouped = new Map<string, DelegatedChildProjection[]>();
  for (const child of inventory.children) {
    const siblings = grouped.get(child.parent_session_ref) ?? [];
    siblings.push(child);
    grouped.set(child.parent_session_ref, siblings);
  }

  const families: SessionFamilyProjection[] = [];
  for (const [parentId, children] of grouped) {
    const parent = sessionsById.get(parentId);
    if (!parent) continue;
    const contribution = contributions.get(parentId);
    const parentStats = contribution?.stats ?? emptyContributionStats();
    const resolvedChildren = children
      .map((child) => overlayChildContribution(child, contributions))
      .sort(compareChildren);
    let combined = parentStats;
    for (const child of resolvedChildren) combined = addContributionStats(combined, child.stats);
    families.push({
      parent_session_ref: parentId,
      source_id: parent?.source_id ?? contribution?.source_id ?? resolvedChildren[0]?.source_id ?? "",
      source_platform: parent?.source_platform ?? contribution?.source_platform ?? resolvedChildren[0]?.source_platform ?? "other",
      child_count: resolvedChildren.length,
      parent: parentStats,
      children: resolvedChildren,
      combined,
    });
  }
  return families.sort((left, right) =>
    right.combined.storage_bytes - left.combined.storage_bytes ||
    right.child_count - left.child_count ||
    left.parent_session_ref.localeCompare(right.parent_session_ref),
  );
}

export function listDelegatedRelationsForFamilyChildren(
  sessions: readonly SessionProjection[],
  children: readonly DelegatedChildProjection[],
  existing: readonly SessionRelatedWorkProjection[],
): SessionRelatedWorkProjection[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const known = new Set(
    existing
      .filter((entry) => entry.relation_kind === "delegated_session" && entry.parent_session_ref && entry.child_session_ref)
      .map((entry) => `${entry.parent_session_ref}:${entry.child_session_ref}:${entry.direction ?? ""}`),
  );
  const extra: SessionRelatedWorkProjection[] = [];
  for (const child of children) {
    if (child.identity_kind !== "session" || !child.child_session_ref) continue;
    const parent = sessionsById.get(child.parent_session_ref);
    const childSession = sessionsById.get(child.child_session_ref);
    if (!parent || !childSession || parent.id === childSession.id) continue;
    for (const direction of ["outbound", "inbound"] as const) {
      const key = `${parent.id}:${childSession.id}:${direction}`;
      if (known.has(key)) continue;
      known.add(key);
      const querySession = direction === "outbound" ? parent : childSession;
      extra.push({
        id: compositeKey("session-related-work", querySession.id, "family", parent.id, childSession.id, direction),
        query_session_ref: querySession.id,
        source_id: parent.source_id,
        source_platform: parent.source_platform,
        source_session_ref: querySession.id,
        evidence_session_ref: querySession.id,
        parent_session_ref: parent.id,
        child_session_ref: childSession.id,
        relation_kind: "delegated_session",
        target_kind: "session",
        direction,
        target_session_ref: direction === "outbound" ? childSession.id : parent.id,
        transcript_primary: true,
        evidence_confidence: 0.8,
        child_agent_key: child.agent_key,
        title: child.title ?? childSession.title,
        canonical_title: childSession.canonical_title,
        status: child.status,
        created_at: child.created_at,
        updated_at: child.updated_at,
        fragment_refs: [],
        raw_detail: {
          relation_source: "family_path_link",
          direction,
          parent_session_ref: parent.id,
          child_session_ref: childSession.id,
        },
      });
    }
  }
  return extra;
}

function listRelatedWork(
  sessions: readonly SessionProjection[],
  fragments: readonly SourceFragment[],
): SessionRelatedWorkProjection[] {
  return [...buildSessionRelatedWorkIndex(sessions, fragments).values()].flat();
}

function groupTurns(turns: readonly UserTurnProjection[]): Map<string, UserTurnProjection[]> {
  const grouped = new Map<string, UserTurnProjection[]>();
  for (const turn of turns) {
    const bucket = grouped.get(turn.session_id) ?? [];
    bucket.push(turn);
    grouped.set(turn.session_id, bucket);
  }
  return grouped;
}

interface BlobAttribution {
  ownerByBlobId: Map<string, string>;
  storage: Map<string, { bytes: number; count: number }>;
  originPaths: Map<string, string[]>;
  /** Per-owner proportional share of container blobs (estimatedBytes) and the total size of those containers. */
  shared: Map<string, { estimatedBytes: number; containerBytes: number }>;
  sidecarOwners: Array<[string, string]>;
}

function attributeBlobs(
  blobs: readonly CapturedBlob[],
  records: readonly RawRecord[],
  sessions: readonly SessionProjection[],
): BlobAttribution {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const recordSessionsByBlob = new Map<string, string[]>();
  const recordBytesByBlob = new Map<string, Map<string, number>>();
  for (const record of records) {
    const owners = recordSessionsByBlob.get(record.blob_id) ?? [];
    owners.push(record.session_ref);
    recordSessionsByBlob.set(record.blob_id, owners);
    let bytesBySession = recordBytesByBlob.get(record.blob_id);
    if (!bytesBySession) {
      bytesBySession = new Map();
      recordBytesByBlob.set(record.blob_id, bytesBySession);
    }
    bytesBySession.set(
      record.session_ref,
      (bytesBySession.get(record.session_ref) ?? 0) + Buffer.byteLength(record.raw_json, "utf8"),
    );
  }

  const ownerByBlobId = new Map<string, string>();
  const storage = new Map<string, { bytes: number; count: number }>();
  const originPaths = new Map<string, string[]>();
  const shared = new Map<string, { estimatedBytes: number; containerBytes: number }>();
  const sidecarOwners = new Map<string, string>();

  const credit = (ownerKey: string, blob: CapturedBlob, bytes: number): void => {
    const current = storage.get(ownerKey) ?? { bytes: 0, count: 0 };
    current.bytes += bytes;
    current.count += 1;
    storage.set(ownerKey, current);
    originPaths.set(ownerKey, uniqueStrings([...(originPaths.get(ownerKey) ?? []), blob.origin_path]));
  };

  for (const blob of blobs) {
    const subagent = matchSubagentPath(blob.origin_path);
    const recordSessions = uniqueStrings(recordSessionsByBlob.get(blob.id) ?? []);
    let ownerKey: string | undefined;
    if (subagent) {
      const parent = resolveSessionByNativeId(subagent.parentDirName, sessions);
      const child = resolveSessionByNativeId(subagent.childId, sessions);
      if (child) {
        ownerKey = sessionOwnerKey(child.id);
      } else if (parent) {
        ownerKey = sidecarOwnerKey(parent.id, subagent.childId);
        sidecarOwners.set(ownerKey, subagent.childId);
      }
    }
    if (!ownerKey) {
      const participants = recordSessions.filter((id) => sessionsById.has(id));
      const shareOwners = recordSessions.length > 0 ? recordSessions : participants;
      const isContainer = shareOwners.length > 1 || isSqliteContainerPath(blob.origin_path);
      if (isContainer && participants.length > 0) {
        // Container blob (SQLite stores, or any blob whose records name more
        // than one session): split bytes by raw record size. Share against
        // every record owner so a filtered snapshot does not dump the whole
        // file onto the remaining session. ownerByBlobId stays unset so
        // groupAtoms buckets each atom by its own session_ref.
        const shares = shareOwners.map((id) => recordBytesByBlob.get(blob.id)?.get(id) ?? 0);
        const totalShare = shares.reduce((sum, value) => sum + value, 0);
        let assigned = 0;
        const shareByOwner = new Map<string, number>();
        for (const [index, ownerId] of shareOwners.entries()) {
          const isLast = index === shareOwners.length - 1;
          const share = isLast
            ? blob.size_bytes - assigned
            : Math.floor(
                totalShare > 0
                  ? (blob.size_bytes * shares[index]!) / totalShare
                  : blob.size_bytes / shareOwners.length,
              );
          assigned += share;
          shareByOwner.set(ownerId, share);
        }
        for (const sessionId of participants) {
          const share = shareByOwner.get(sessionId) ?? 0;
          const participantKey = sessionOwnerKey(sessionId);
          credit(participantKey, blob, share);
          const current = shared.get(participantKey) ?? { estimatedBytes: 0, containerBytes: 0 };
          current.estimatedBytes += share;
          current.containerBytes += blob.size_bytes;
          shared.set(participantKey, current);
        }
        continue;
      }
      const sessionId = participants[0]
        ?? recordSessions[0]
        ?? sessionOwningPath(blob.origin_path, sessions)?.id;
      if (sessionId) ownerKey = sessionOwnerKey(sessionId);
    }
    if (!ownerKey) continue;
    ownerByBlobId.set(blob.id, ownerKey);
    credit(ownerKey, blob, blob.size_bytes);
  }

  return {
    ownerByBlobId,
    storage,
    originPaths,
    shared,
    sidecarOwners: [...sidecarOwners.entries()],
  };
}

function groupAtoms(
  atoms: readonly ConversationAtom[],
  fragments: readonly SourceFragment[],
  records: readonly RawRecord[],
  attribution: BlobAttribution,
): Map<string, ConversationAtom[]> {
  const fragmentById = new Map(fragments.map((fragment) => [fragment.id, fragment]));
  const recordById = new Map(records.map((record) => [record.id, record]));
  const grouped = new Map<string, ConversationAtom[]>();
  for (const atom of atoms) {
    const blobId = blobIdForAtom(atom, fragmentById, recordById);
    const ownerKey = (blobId ? attribution.ownerByBlobId.get(blobId) : undefined) ?? sessionOwnerKey(atom.session_ref);
    const bucket = grouped.get(ownerKey) ?? [];
    bucket.push(atom);
    grouped.set(ownerKey, bucket);
  }
  return grouped;
}

function blobIdForAtom(
  atom: ConversationAtom,
  fragmentById: Map<string, SourceFragment>,
  recordById: Map<string, RawRecord>,
): string | undefined {
  for (const fragmentRef of atom.fragment_refs) {
    const fragment = fragmentById.get(fragmentRef);
    if (!fragment) continue;
    const record = recordById.get(fragment.record_id);
    if (record?.blob_id) return record.blob_id;
  }
  return undefined;
}

function buildOwnerStats(options: {
  ownerKey: string;
  session?: SessionProjection;
  turns: readonly UserTurnProjection[];
  attribution: BlobAttribution;
  atoms: readonly ConversationAtom[];
}): SessionContributionStats {
  const stats = statsForOwner(options.ownerKey, options.attribution, options.atoms);
  stats.turn_count = options.session?.turn_count ?? options.turns.length;
  const turnUsage = summarizeTurnUsage(options.turns);
  if (turnUsage.total_tokens !== undefined) {
    stats.input_tokens = turnUsage.input_tokens;
    stats.output_tokens = turnUsage.output_tokens;
    stats.cached_input_tokens = turnUsage.cached_input_tokens;
    stats.reasoning_output_tokens = turnUsage.reasoning_output_tokens;
    stats.total_tokens = turnUsage.total_tokens;
  }
  if (options.turns.length > 0) {
    stats.assistant_reply_count = options.turns.reduce(
      (total, turn) => total + (turn.context_summary.assistant_reply_count ?? 0),
      0,
    );
  }
  return stats;
}

function statsForOwner(
  ownerKey: string,
  attribution: BlobAttribution,
  atoms: readonly ConversationAtom[],
): SessionContributionStats {
  const stats = emptyContributionStats();
  const storage = attribution.storage.get(ownerKey);
  if (storage) {
    stats.storage_bytes = storage.bytes;
    stats.blob_count = storage.count;
  }
  applyAtomStats(stats, atoms);
  return stats;
}

function applyAtomStats(stats: SessionContributionStats, atoms: readonly ConversationAtom[]): void {
  const toolCalls = new Map<string, { hasResult: boolean; error: boolean }>();
  let assistantReplies = 0;
  let usage: TokenUsageSummary | undefined;
  for (const atom of atoms) {
    if (atom.actor_kind === "assistant" && atom.content_kind === "text") assistantReplies += 1;
    const atomUsage = tokenUsageFromPayload(atom.payload);
    if (atomUsage) usage = mergeTokenUsage(usage, atomUsage);
    if (atom.content_kind === "tool_call") {
      const callId = asOptionalString(atom.payload.call_id) ?? atom.id;
      const existing = toolCalls.get(callId) ?? { hasResult: false, error: false };
      toolCalls.set(callId, existing);
    }
    if (atom.content_kind === "tool_result") {
      const callId = asOptionalString(atom.payload.call_id) ?? atom.id;
      const existing = toolCalls.get(callId) ?? { hasResult: false, error: false };
      existing.hasResult = true;
      existing.error = existing.error || isToolResultError(atom.payload);
      toolCalls.set(callId, existing);
    }
  }
  if (assistantReplies > 0 && stats.assistant_reply_count === 0) stats.assistant_reply_count = assistantReplies;
  if (toolCalls.size > 0) {
    stats.tool_call_count = toolCalls.size;
    stats.tool_success_count = [...toolCalls.values()].filter((entry) => entry.hasResult && !entry.error).length;
    stats.tool_error_count = [...toolCalls.values()].filter((entry) => entry.error).length;
    stats.tool_pending_count = [...toolCalls.values()].filter((entry) => !entry.hasResult && !entry.error).length;
  }
  if (usage && stats.total_tokens === undefined) {
    stats.input_tokens = usage.input_tokens;
    stats.output_tokens = usage.output_tokens;
    stats.cached_input_tokens = usage.cached_input_tokens;
    stats.reasoning_output_tokens = usage.reasoning_output_tokens;
    stats.total_tokens = resolveStructuredTokenTotal(usage);
  }
}

function summarizeTurnUsage(turns: readonly UserTurnProjection[]): TokenUsageSummary {
  const usage: TokenUsageSummary = {};
  let hasTotal = false;
  for (const turn of turns) {
    const resolved = resolveTurnUsage(turn);
    if (resolved.input_tokens !== undefined) usage.input_tokens = (usage.input_tokens ?? 0) + resolved.input_tokens;
    if (resolved.output_tokens !== undefined) usage.output_tokens = (usage.output_tokens ?? 0) + resolved.output_tokens;
    if (resolved.cached_input_tokens !== undefined) {
      usage.cached_input_tokens = (usage.cached_input_tokens ?? 0) + resolved.cached_input_tokens;
    }
    if (resolved.reasoning_output_tokens !== undefined) {
      usage.reasoning_output_tokens = (usage.reasoning_output_tokens ?? 0) + resolved.reasoning_output_tokens;
    }
    if (resolved.total_tokens !== undefined) {
      usage.total_tokens = (usage.total_tokens ?? 0) + resolved.total_tokens;
      hasTotal = true;
    }
  }
  return hasTotal ? usage : {};
}

interface ToolIoIndex {
  inputs: Array<{ parentSessionRef: string; names: string[]; text?: string; callId?: string }>;
  outputs: Array<{ parentSessionRef: string; names: string[]; text?: string; callId?: string }>;
}

function collectToolIo(
  atoms: readonly ConversationAtom[],
  contexts: readonly TurnContextProjection[],
  turns: readonly UserTurnProjection[],
): ToolIoIndex {
  const inputs: ToolIoIndex["inputs"] = [];
  const outputs: ToolIoIndex["outputs"] = [];
  const spawnCallIds = new Set<string>();
  const sessionByTurnId = new Map(turns.map((turn) => [turn.id, turn.session_id]));
  for (const atom of atoms) {
    if (atom.content_kind === "tool_call") {
      const toolName = asOptionalString(atom.payload.tool_name) ?? "";
      if (!SPAWN_TOOL_NAMES.has(toolName)) continue;
      const input = isRecord(atom.payload.input) ? atom.payload.input : {};
      const callId = asOptionalString(atom.payload.call_id);
      if (SPAWN_TOOL_NAMES.has(toolName)) {
        if (callId) spawnCallIds.add(callId);
        inputs.push({
          parentSessionRef: atom.session_ref,
          names: collectTargetNames(input),
          text: asOptionalString(input.prompt) ?? asOptionalString(input.description) ?? asOptionalString(input.task),
          callId,
        });
      }
    }
  }
  for (const atom of atoms) {
    if (atom.content_kind !== "tool_result") continue;
    const callId = asOptionalString(atom.payload.call_id);
    if (!callId || !spawnCallIds.has(callId)) continue;
    outputs.push({
      parentSessionRef: atom.session_ref,
      names: collectTargetNames(isRecord(atom.payload) ? atom.payload : {}),
      text: asOptionalString(atom.payload.output),
      callId,
    });
  }
  for (const context of contexts) {
    const parentSessionRef = sessionByTurnId.get(context.turn_id);
    if (!parentSessionRef) continue;
    for (const call of context.tool_calls) {
      if (SPAWN_TOOL_NAMES.has(call.tool_name)) {
        spawnCallIds.add(call.id);
        inputs.push({
          parentSessionRef,
          names: collectTargetNames(call.input),
          text: asOptionalString(call.input.prompt) ?? asOptionalString(call.input.description) ?? call.input_summary,
          callId: call.id,
        });
      }
    }
    for (const call of context.tool_calls) {
      if (!call.output || !spawnCallIds.has(call.id)) continue;
      outputs.push({
        parentSessionRef,
        names: collectTargetNames(call.input),
        text: call.output_preview ?? call.output,
        callId: call.id,
      });
    }
  }
  return { inputs, outputs };
}

function resolveChildIo(
  parentId: string,
  childRef: string,
  nativeIds: readonly string[],
  toolIo: ToolIoIndex,
  childAtoms: readonly ConversationAtom[],
  related?: SessionRelatedWorkProjection,
): { input?: string; output?: string } {
  const aliases = new Set([childRef, ...nativeIds].map((value) => value.toLowerCase()));
  const inputFromTool = toolIo.inputs.find((entry) =>
    entry.parentSessionRef === parentId &&
    entry.names.some((name) => aliases.has(name.toLowerCase())),
  );
  const outputFromTool = toolIo.outputs.find((entry) =>
    entry.parentSessionRef === parentId &&
    (
      entry.names.some((name) => aliases.has(name.toLowerCase())) ||
      (inputFromTool?.callId !== undefined && entry.callId === inputFromTool.callId)
    ),
  );
  const delegatedInput = childAtoms.find((atom) => atom.origin_kind === "delegated_instruction");
  const lastAssistant = [...childAtoms].reverse().find((atom) =>
    atom.actor_kind === "assistant" && atom.content_kind === "text",
  );
  return {
    input: previewText(
      inputFromTool?.text ??
        asOptionalString(related?.raw_detail.description) ??
        asOptionalString(related?.raw_detail.prompt) ??
        asOptionalString(delegatedInput?.payload.text),
      FAMILY_IO_EVIDENCE_CHARS,
    ),
    output: previewText(
      outputFromTool?.text ??
        asOptionalString(related?.raw_detail.output) ??
        asOptionalString(lastAssistant?.payload.text),
      FAMILY_IO_EVIDENCE_CHARS,
    ),
  };
}

function collectTargetNames(value: Record<string, unknown>): string[] {
  return uniqueStrings([
    asOptionalString(value.subagent_id),
    asOptionalString(value.child_session_id),
    asOptionalString(value.child_session_ref),
    asOptionalString(value.agent_id),
    asOptionalString(value.task_id),
  ].filter((entry): entry is string => entry !== undefined));
}

function overlayChildContribution(
  child: DelegatedChildProjection,
  contributions: Map<string, SessionContributionProjection>,
): DelegatedChildProjection {
  if (!child.child_session_ref) return child;
  const contribution = contributions.get(child.child_session_ref);
  if (!contribution) return child;
  return {
    ...child,
    stats: preferRicherStats(child.stats, contribution.stats),
  };
}

function upsertChild(children: Map<string, DelegatedChildProjection>, child: DelegatedChildProjection): void {
  const existing = children.get(child.id);
  children.set(child.id, existing ? mergeChild(existing, child) : child);
}

function mergeChild(left: DelegatedChildProjection, right: DelegatedChildProjection): DelegatedChildProjection {
  return {
    ...left,
    child_session_ref: left.child_session_ref ?? right.child_session_ref,
    agent_key: left.agent_key ?? right.agent_key,
    title: left.title ?? right.title,
    status: right.status ?? left.status,
    created_at: left.created_at <= right.created_at ? left.created_at : right.created_at,
    updated_at: left.updated_at >= right.updated_at ? left.updated_at : right.updated_at,
    input_preview: left.input_preview ?? right.input_preview,
    output_preview: left.output_preview ?? right.output_preview,
    parent_tool_ref: left.parent_tool_ref ?? right.parent_tool_ref,
    origin_paths: uniqueStrings([...left.origin_paths, ...right.origin_paths]),
    stats: preferRicherStats(left.stats, right.stats),
  };
}

function preferRicherStats(
  left: SessionContributionStats,
  right: SessionContributionStats,
): SessionContributionStats {
  if (right.storage_bytes > left.storage_bytes) return right;
  if (left.storage_bytes > right.storage_bytes) return left;
  if (right.tool_call_count > left.tool_call_count) return right;
  return left;
}

function cloneContribution(value: SessionContributionProjection): SessionContributionProjection {
  return {
    ...value,
    stats: { ...value.stats },
    ...(value.shared_storage ? { shared_storage: { ...value.shared_storage } } : {}),
  };
}

function cloneChild(value: DelegatedChildProjection): DelegatedChildProjection {
  return { ...value, origin_paths: [...value.origin_paths], stats: { ...value.stats } };
}

function compareChildren(left: DelegatedChildProjection, right: DelegatedChildProjection): number {
  return right.stats.storage_bytes - left.stats.storage_bytes ||
    left.created_at.localeCompare(right.created_at) ||
    left.id.localeCompare(right.id);
}

function sessionOwnerKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function sidecarOwnerKey(parentId: string, nativeId: string): string {
  return `sidecar:${parentId}:${nativeId}`;
}

function parentIdFromSidecarOwner(ownerKey: string, nativeId: string): string | undefined {
  const prefix = "sidecar:";
  const suffix = `:${nativeId}`;
  if (!ownerKey.startsWith(prefix) || !ownerKey.endsWith(suffix)) return undefined;
  return ownerKey.slice(prefix.length, ownerKey.length - suffix.length);
}

function isSqliteContainerPath(originPath: string): boolean {
  const base = originPath.replace(/\\/gu, "/").split("/").pop() ?? "";
  const lower = base.toLowerCase();
  return lower === "state.vscdb" || lower === "store.db" || lower.endsWith(".sqlite");
}

function matchSubagentPath(originPath: string): { parentDirName: string; childId: string } | undefined {
  const normalized = originPath.replace(/\\/g, "/");
  const match = normalized.match(/\/([^/]+)\/subagents\/([^/]+)/u);
  if (!match?.[1] || !match[2]) return undefined;
  return {
    parentDirName: match[1],
    childId: match[2].replace(/\.jsonl$/iu, ""),
  };
}

function resolveSessionByNativeId(
  nativeId: string,
  sessions: readonly SessionProjection[],
): SessionProjection | undefined {
  const matches = sessions.filter((session) =>
    session.source_session_id === nativeId ||
    session.id === nativeId ||
    session.id.endsWith(`:${nativeId}`),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function sessionOwningPath(
  originPath: string,
  sessions: readonly SessionProjection[],
): SessionProjection | undefined {
  const normalized = originPath.replace(/\\/g, "/");
  const matches = sessions.filter((session) => {
    const nativeId = session.source_session_id;
    return nativeId ? normalized.includes(`/${nativeId}/`) || normalized.endsWith(`/${nativeId}.jsonl`) : false;
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function childNativeIds(session: SessionProjection | undefined, childRef: string): string[] {
  return uniqueStrings([
    childRef,
    session?.source_session_id,
    session ? sourceSessionSuffix(session.id) : undefined,
  ].filter((value): value is string => value !== undefined));
}

function childMatchesNativeId(
  child: DelegatedChildProjection,
  nativeId: string,
  sessionsById: Map<string, SessionProjection>,
): boolean {
  if (child.agent_key === nativeId) return true;
  if (child.child_session_ref === nativeId || child.child_session_ref?.endsWith(`:${nativeId}`)) return true;
  const session = child.child_session_ref ? sessionsById.get(child.child_session_ref) : undefined;
  return session?.source_session_id === nativeId;
}

function sourceSessionSuffix(sessionId: string): string | undefined {
  const match = /^sess:[^:]+:(.+)$/u.exec(sessionId);
  return match?.[1];
}

function stripSessPrefix(sessionRef: string): string {
  return sourceSessionSuffix(sessionRef) ?? sessionRef;
}

function tokenUsageFromPayload(payload: Record<string, unknown>): TokenUsageSummary | undefined {
  const nested = isRecord(payload.token_usage) ? payload.token_usage : payload;
  const usage: TokenUsageSummary = {
    input_tokens: asNumber(nested.input_tokens),
    output_tokens: asNumber(nested.output_tokens),
    cached_input_tokens: asNumber(nested.cached_input_tokens),
    cache_read_input_tokens: asNumber(nested.cache_read_input_tokens),
    cache_creation_input_tokens: asNumber(nested.cache_creation_input_tokens),
    reasoning_output_tokens: asNumber(nested.reasoning_output_tokens),
    total_tokens: asNumber(nested.total_tokens),
  };
  return Object.values(usage).some((value) => typeof value === "number") ? usage : undefined;
}

function mergeTokenUsage(left: TokenUsageSummary | undefined, right: TokenUsageSummary): TokenUsageSummary {
  if (!left) return { ...right };
  return {
    input_tokens: addOptionalNumber(left.input_tokens, right.input_tokens),
    output_tokens: addOptionalNumber(left.output_tokens, right.output_tokens),
    cached_input_tokens: addOptionalNumber(left.cached_input_tokens, right.cached_input_tokens),
    cache_read_input_tokens: addOptionalNumber(left.cache_read_input_tokens, right.cache_read_input_tokens),
    cache_creation_input_tokens: addOptionalNumber(left.cache_creation_input_tokens, right.cache_creation_input_tokens),
    reasoning_output_tokens: addOptionalNumber(left.reasoning_output_tokens, right.reasoning_output_tokens),
    total_tokens: addOptionalNumber(left.total_tokens, right.total_tokens),
  };
}

function isToolResultError(payload: Record<string, unknown>): boolean {
  if (payload.is_error === true || payload.isError === true) return true;
  const status = asOptionalString(payload.status)?.toLowerCase();
  if (status === "error" || status === "failed") return true;
  if (asOptionalString(payload.error) || asOptionalString(payload.error_message)) return true;
  const output = asOptionalString(payload.output) ?? "";
  return /^(error|traceback|failed)\b/iu.test(output);
}

function previewText(value: string | undefined, max = FAMILY_IO_PREVIEW_CHARS): string | undefined {
  if (!value) return undefined;
  const single = value.replace(/\s+/gu, " ").trim();
  if (!single) return undefined;
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function firstAtomTime(atoms: readonly ConversationAtom[]): string | undefined {
  return atoms.reduce<string | undefined>(
    (earliest, atom) => earliest && earliest <= atom.time_key ? earliest : atom.time_key,
    undefined,
  );
}

function lastAtomTime(atoms: readonly ConversationAtom[]): string | undefined {
  return atoms.reduce<string | undefined>(
    (latest, atom) => latest && latest >= atom.time_key ? latest : atom.time_key,
    undefined,
  );
}

function addOptionalNumber(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
