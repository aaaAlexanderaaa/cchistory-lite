import type { AtomEdge, ConversationAtom, StageRun, StageKind, LossAuditRecord, SourcePlatform, SourceDefinition, AskUserQuestionTurn } from "@cchistory/domain";
import { stableId, asString } from "@cchistory/domain";
import { buildStageRunId } from "./source-identity.js";
import type { SessionDraft } from "./types.js";
import { resolveSourceFormatProfile } from "./discovery.js";
import { getAskUserProfile } from "./ask-user-registry.js";

export function buildStageRuns(
  sourceId: string,
  sourcePlatform: SourcePlatform,
  startedAt: string,
  finishedAt: string,
  counts: {
    blobs: number;
    records: number;
    fragments: number;
    atoms: number;
    sessions: number;
    turns: number;
  },
  lossAudits: readonly LossAuditRecord[],
): StageRun[] {
  const sourceDefinition: SourceDefinition = {
    id: sourceId,
    slot_id: sourceId,
    family: "local_runtime_sessions",
    platform: sourcePlatform,
    base_dir: "unknown",
    display_name: "unknown",
  };
  const sourceFormatProfile = resolveSourceFormatProfile(sourceDefinition);
  const failureCounts = countLossAuditsByStage(lossAudits);

  const stageStats: Record<StageKind, StageRun["stats"]> = {
    capture: {
      input_count: 1,
      output_count: counts.blobs,
      success_count: counts.blobs,
      failure_count: failureCounts.capture,
      skipped_count: 0,
      unparseable_count: 0,
    },
    extract_records: {
      input_count: counts.blobs,
      output_count: counts.records,
      success_count: counts.records,
      failure_count: failureCounts.extract_records,
      skipped_count: 0,
      unparseable_count: failureCounts.extract_records,
    },
    parse_source_fragments: {
      input_count: counts.records,
      output_count: counts.fragments,
      success_count: counts.fragments,
      failure_count: failureCounts.parse_source_fragments,
      skipped_count: 0,
      unparseable_count: failureCounts.parse_source_fragments,
    },
    atomize: {
      input_count: counts.fragments,
      output_count: counts.atoms,
      success_count: counts.atoms,
      failure_count: failureCounts.atomize,
      skipped_count: 0,
      unparseable_count: 0,
    },
    derive_candidates: {
      input_count: counts.atoms,
      output_count: counts.sessions + counts.turns,
      success_count: counts.sessions + counts.turns,
      failure_count: failureCounts.derive_candidates,
      skipped_count: 0,
      unparseable_count: 0,
    },
    finalize_projections: {
      input_count: counts.sessions + counts.turns,
      output_count: counts.sessions + counts.turns,
      success_count: counts.sessions + counts.turns,
      failure_count: failureCounts.finalize_projections,
      skipped_count: 0,
      unparseable_count: 0,
      sessions: counts.sessions,
      turns: counts.turns,
    },
    apply_masks: {
      input_count: counts.turns,
      output_count: counts.turns,
      success_count: counts.turns,
      failure_count: failureCounts.apply_masks,
      skipped_count: 0,
      unparseable_count: 0,
      turns: counts.turns,
    },
    index_projections: {
      input_count: counts.turns,
      output_count: counts.turns,
      success_count: counts.turns,
      failure_count: failureCounts.index_projections,
      skipped_count: 0,
      unparseable_count: 0,
      turns: counts.turns,
    },
  };

  return (Object.keys(stageStats) as StageKind[]).map((stage) => ({
    id: buildStageRunId(sourceId, stage),
    source_id: sourceId,
    stage_kind: stage,
    parser_version: sourceFormatProfile.parser_version,
    parser_capabilities: [...sourceFormatProfile.capabilities],
    source_format_profile_ids: [sourceFormatProfile.id],
    started_at: startedAt,
    finished_at: finishedAt,
    status: failureCounts[stage] > 0 && stageStats[stage].success_count === 0 ? "error" : "success",
    stats: stageStats[stage],
  }));
}

export function countLossAuditsByStage(lossAudits: readonly LossAuditRecord[]): Record<StageKind, number> {
  const counts: Record<StageKind, number> = {
    capture: 0,
    extract_records: 0,
    parse_source_fragments: 0,
    atomize: 0,
    derive_candidates: 0,
    finalize_projections: 0,
    apply_masks: 0,
    index_projections: 0,
  };
  for (const audit of lossAudits) {
    if (audit.severity === "info") {
      continue;
    }
    counts[audit.stage_kind] += 1;
  }
  return counts;
}

export function buildAskUserQuestionTurns(
  draft: SessionDraft,
  atoms: ConversationAtom[],
  edges: AtomEdge[],
): AskUserQuestionTurn[] {
  const profile = getAskUserProfile(draft.source_platform);
  if (!profile) {
    return [];
  }
  const toolNameSet = new Set(profile.toolNames);
  const atomById = new Map<string, ConversationAtom>();
  const toolCallEntries: Array<{ atom: ConversationAtom; toolName: string }> = [];
  for (const atom of atoms) {
    atomById.set(atom.id, atom);
    if (atom.content_kind !== "tool_call") {
      continue;
    }
    const toolName = asString(atom.payload.tool_name);
    if (!toolName || !toolNameSet.has(toolName)) {
      continue;
    }
    toolCallEntries.push({ atom, toolName });
  }
  if (toolCallEntries.length === 0) {
    return [];
  }

  const toolCallAtomIds = new Set(toolCallEntries.map((entry) => entry.atom.id));
  const resultAtomByCallAtomId = new Map<string, ConversationAtom>();
  for (const edge of edges) {
    if (edge.edge_kind !== "tool_result_for") {
      continue;
    }
    if (!toolCallAtomIds.has(edge.to_atom_id)) {
      continue;
    }
    const resultAtom = atomById.get(edge.from_atom_id);
    if (resultAtom && resultAtom.content_kind === "tool_result") {
      resultAtomByCallAtomId.set(edge.to_atom_id, resultAtom);
    }
  }

  const turns: AskUserQuestionTurn[] = [];
  for (const { atom: callAtom, toolName } of toolCallEntries) {
    const resultAtom = resultAtomByCallAtomId.get(callAtom.id);
    if (!resultAtom) {
      continue;
    }
    const questions = profile.parseCall(callAtom.payload.input);
    if (questions.length === 0) {
      continue;
    }
    const answers = profile.parseResult(resultAtom.payload.output, questions);
    turns.push({
      id: stableId("aqq", draft.source_id, callAtom.id, resultAtom.id),
      source_id: draft.source_id,
      session_id: draft.id,
      source_platform: draft.source_platform,
      created_at: resultAtom.time_key,
      tool_name: toolName,
      call_atom_id: callAtom.id,
      result_atom_id: resultAtom.id,
      questions,
      answers,
    });
  }
  return turns;
}
