/**
 * Role: Resolve Codex usage evidence into independent calls, including matched
 * compaction requests and calls without assistant text. Owns no source reads.
 */
import type { ConversationAtom, ParsedSessionMetadata, SourceFragment, TokenUsageMetrics } from "@cchistory/domain";
import { asString, buildTokenUsageCheckpointBaselineKey, diffTokenUsageMetrics,
  extractTokenUsageFromPayload, isObject, isUserTurnAtom, mergeMaxTokenUsageMetrics, mergeTokenUsageMetrics, stableId } from "@cchistory/domain";

const fields = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
  "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"] as const;

function sameUsage(left: TokenUsageMetrics | undefined, right: TokenUsageMetrics | undefined): boolean {
  return Boolean(left && right && fields.every(field => (left[field] ?? 0) === (right[field] ?? 0)));
}

function coversUsage(current: TokenUsageMetrics | undefined, prior: TokenUsageMetrics | undefined): boolean {
  return Boolean(current && prior && (current.input_tokens ?? 0) + (current.cached_input_tokens ?? 0) >=
    (prior.input_tokens ?? 0) + (prior.cached_input_tokens ?? 0) &&
    (["cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"] as const).every(field =>
      (current[field] ?? 0) >= (prior[field] ?? 0)));
}

function cumulativeDifference(current: TokenUsageMetrics, previous?: TokenUsageMetrics): TokenUsageMetrics {
  const reset = previous?.total_tokens !== undefined && current.total_tokens !== undefined && current.total_tokens < previous.total_tokens;
  if (!previous || reset) return current;
  const inclusiveInput = (usage: TokenUsageMetrics) => (usage.input_tokens ?? 0) + (usage.cached_input_tokens ?? 0);
  const delta = diffTokenUsageMetrics(current, previous);
  const input = Math.max(0, inclusiveInput(current) - inclusiveInput(previous));
  const cacheRead = Math.min(input, delta.cache_read_input_tokens ?? 0);
  const cacheWrite = Math.min(input - cacheRead, delta.cache_creation_input_tokens ?? 0);
  return { ...delta, input_tokens: input - cacheRead - cacheWrite, cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite, cached_input_tokens: cacheRead + cacheWrite };
}

export function resolveCodexUsageAtoms(
  draft: Readonly<ParsedSessionMetadata>, atoms: readonly ConversationAtom[], fragments: readonly SourceFragment[],
): readonly ConversationAtom[] {
  if (draft.source_platform !== "codex") return atoms;
  const replacements = new Map<string, ConversationAtom>();
  const requests = new Map<string, { atom: ConversationAtom; model?: string; covered: boolean }>();
  const compactions = new Set<string>();
  let model: string | undefined;
  let latestRequest: string | undefined;
  let previousCumulative: TokenUsageMetrics | undefined;
  const checkpoints = new Map<string, TokenUsageMetrics>();
  const checkpointOwners = new Map<string, string>();
  let replyUsageAtomId: string | undefined;
  let replyUsageRecordId: string | undefined;
  let replyHasToolBoundary = false;
  const recordByFragment = new Map(fragments.map(fragment => [fragment.id, fragment.record_id]));
  const callOrdinals = new Map<string, number>();

  const call = (atom: ConversationAtom, usage: TokenUsageMetrics, callId: string | undefined, callModel?: string) => {
    const signature = JSON.stringify([atom.time_key, usage.model ?? callModel, fields.map(field => usage[field] ?? 0)]);
    const ordinal = callOrdinals.get(signature) ?? 0;
    callOrdinals.set(signature, ordinal + 1);
    return { ...atom, payload: { ...atom.payload, signal_kind: "token_usage_signal",
      token_usage: usage, delta_token_usage: usage, model: usage.model ?? callModel,
      independent_usage_event_id: fields.some(field => (usage[field] ?? 0) > 0)
        ? stableId("codex-usage", draft.source_id, draft.id, callId ?? `${signature}:${ordinal}`) : undefined },
    };
  };
  for (const atom of atoms) {
    if (isUserTurnAtom(atom)) { replyUsageAtomId = undefined; replyUsageRecordId = undefined; }
    if (atom.content_kind === "tool_call") replyHasToolBoundary = true;
    if (atom.payload.signal_kind === "model_signal") model = asString(atom.payload.model) ?? model;
    if (atom.actor_kind === "assistant" && atom.content_kind === "text") {
      const usage = extractTokenUsageFromPayload(atom.payload);
      const recordId = recordByFragment.get(atom.fragment_refs[0] ?? "");
      if (usage) {
        replyUsageAtomId = atom.id;
        replyUsageRecordId = recordId;
        replyHasToolBoundary = false;
        replacements.set(atom.id, call(atom, usage, undefined, asString(atom.payload.model) ?? model));
      } else if (!recordId || recordId !== replyUsageRecordId) replyUsageAtomId = undefined;
    }
    const type = atom.payload.source_event_type;
    if (atom.payload.signal_kind === "token_usage_signal" && type !== "token_count" && atom.payload.inherited !== true) {
      const usage = extractTokenUsageFromPayload(atom.payload);
      if (usage) {
        replacements.set(atom.id, call(atom, usage, undefined, asString(atom.payload.model) ?? model));
        replyUsageAtomId = atom.id;
        replyHasToolBoundary = false;
      }
    }
    if (type === "compacted") {
      const id = asString(atom.payload.compaction_response_id);
      if (id) compactions.add(id);
    }
    if (type === "token_usage_record") {
      const id = asString(atom.payload.response_id);
      if (id && atom.payload.inherited !== true && !requests.has(id)) {
        requests.set(id, { atom, model: asString(atom.payload.model) ?? model, covered: false });
        latestRequest = id;
      }
    }
    if (type !== "token_count" || atom.payload.signal_kind !== "token_usage_signal") continue;
    const cumulative = isObject(atom.payload.cumulative_token_usage)
      ? extractTokenUsageFromPayload({ token_usage: atom.payload.cumulative_token_usage }) : undefined;
    const last = atom.payload.checkpoint_usage_present === false ? undefined : extractTokenUsageFromPayload(atom.payload);
    model = last?.model ?? asString(atom.payload.model) ?? model;
    const baseline = buildTokenUsageCheckpointBaselineKey(cumulative, last);
    const checkpointKey = baseline ? `${model ?? ""}|${baseline}` : undefined;
    let usage: TokenUsageMetrics | undefined;
    if (sameUsage(cumulative, previousCumulative)) usage = diffTokenUsageMetrics(cumulative!, cumulative);
    else if (baseline && last) {
      const startsNewSeries = cumulative?.total_tokens !== undefined && previousCumulative?.total_tokens !== undefined &&
        cumulative.total_tokens < previousCumulative.total_tokens && sameUsage(cumulative, last);
      if (startsNewSeries) { checkpoints.clear(); checkpointOwners.clear(); }
      const prior = checkpoints.get(checkpointKey!);
      const reset = cumulative?.total_tokens !== undefined && previousCumulative?.total_tokens !== undefined &&
        cumulative.total_tokens < previousCumulative.total_tokens &&
        buildTokenUsageCheckpointBaselineKey(previousCumulative, prior) === baseline;
      usage = diffTokenUsageMetrics(last, reset ? undefined : prior);
      if (reset) checkpointOwners.delete(checkpointKey!);
      checkpoints.set(checkpointKey!, reset ? last : mergeMaxTokenUsageMetrics(prior, last));
    } else usage = cumulative ? cumulativeDifference(cumulative, previousCumulative) : last;
    // Reconcile duplicate representations of the same call. A later different
    // request keeps the preceding embedded call's usage.
    const embedded = replyUsageAtomId ? replacements.get(replyUsageAtomId) : undefined;
    const embeddedUsage = embedded ? extractTokenUsageFromPayload(embedded.payload) : undefined;
    const embeddedModel = asString(embedded?.payload.model);
    if (replyUsageAtomId && (!embeddedModel || !model || embeddedModel === model) &&
      (sameUsage(embeddedUsage, last) || sameUsage(embeddedUsage, usage) ||
        !replyHasToolBoundary && coversUsage(last ?? usage, embeddedUsage))) {
      replacements.delete(replyUsageAtomId);
    }
    const advanced = cumulative && !sameUsage(cumulative, previousCumulative);
    if (cumulative) previousCumulative = cumulative;
    // A local compaction can also appear in the advancing normal counter.
    const pending = latestRequest ? requests.get(latestRequest) : undefined;
    if (advanced && pending && !compactions.has(latestRequest!) && (sameUsage(usage, extractTokenUsageFromPayload(pending.atom.payload)) ||
      sameUsage(last, extractTokenUsageFromPayload(pending.atom.payload)) ||
      sameUsage(cumulative, extractTokenUsageFromPayload({ token_usage: pending.atom.payload.thread_token_usage })))) {
      pending.covered = true;
    }
    if (usage) {
      const ownUsage = atom.payload.inherited === true
        ? Object.fromEntries(fields.map(field => [field, 0])) : usage;
      const ownerId = checkpointKey ? checkpointOwners.get(checkpointKey) : undefined;
      if (ownerId) {
        const owner = replacements.get(ownerId)!;
        const fullUsage = mergeTokenUsageMetrics(extractTokenUsageFromPayload(owner.payload), ownUsage)!;
        replacements.set(ownerId, { ...owner, payload: { ...owner.payload, token_usage: fullUsage } });
        replacements.set(atom.id, { ...atom, payload: { ...atom.payload, token_usage: ownUsage,
          delta_token_usage: ownUsage, codex_usage_owner_id: ownerId } });
      } else {
        const resolved = call(atom, ownUsage, undefined, model);
        replacements.set(atom.id, resolved);
        if (checkpointKey && resolved.payload.independent_usage_event_id) checkpointOwners.set(checkpointKey, atom.id);
      }
    }
  }
  for (const [id, request] of requests) {
    const usage = extractTokenUsageFromPayload(request.atom.payload);
    if (usage && compactions.has(id) && !request.covered) {
      replacements.set(request.atom.id, call(request.atom, usage, `response:${id}`, request.model));
    }
  }
  // Original atoms remain immutable: append refreshes can re-interpret the evidence.
  return atoms.map(atom => replacements.get(atom.id) ?? atom);
}
