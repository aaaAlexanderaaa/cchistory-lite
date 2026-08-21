import { Buffer } from "node:buffer";
import type {
  DerivedCandidate,
  LinkState,
  ProjectIdentity,
  SearchHighlight,
  SearchMatchField,
  SessionProjection,
  SessionRelatedWorkProjection,
  SessionSearchResult,
  TurnSearchResult,
  UserTurnProjection,
  ValueAxis,
} from "@cchistory/domain";
import { filterTopLevelSessions } from "./session-collections.js";
import { asOptionalString } from "./utils.js";

export const SEARCH_CANONICAL_TEXT_SCAN_BYTES = 16 * 1024;
export const SEARCH_TRUNCATION_MARKER = "...[truncated]";
const TITLE_SCORE = 1000;
const TEXT_SCORE = 100;
const PATH_SCORE = 10;

export interface SearchCandidateFields {
  canonical_text?: string;
  path_text?: string;
  title_text?: string;
}

export interface SearchCandidateSessionFields {
  working_directory?: string;
  resume_working_directory?: string;
  source_native_project_ref?: string;
  title?: string;
  canonical_title?: string;
}

export type SearchProjectObservationCandidate = Pick<
  DerivedCandidate,
  "candidate_kind" | "evidence"
>;

export interface MaterializeSearchCandidateInput {
  turn: SearchCandidateFields;
  session?: SearchCandidateSessionFields;
  project_observation_candidates?: readonly SearchProjectObservationCandidate[];
}

export interface SearchPlan {
  normalizedQuery: string;
  terms: SearchTerm[];
}

export interface SearchTerm {
  value: string;
  mode: "prefix" | "literal";
}

export interface SearchTurnsInMemoryInput {
  turns: readonly UserTurnProjection[];
  sessions: readonly SessionProjection[];
  projects: readonly ProjectIdentity[];
  candidates?: readonly DerivedCandidate[];
  query?: string;
  project_id?: string;
  source_ids?: readonly string[];
  link_states?: readonly LinkState[];
  value_axes?: readonly ValueAxis[];
  limit?: number;
  offset?: number;
  now_ms?: number;
}

export interface SearchSessionsInMemoryInput extends SearchTurnsInMemoryInput {
  related_work?: readonly SessionRelatedWorkProjection[];
}

export function searchTurnsInMemory(input: SearchTurnsInMemoryInput): {
  results: TurnSearchResult[];
  total: number;
} {
  const query = input.query?.trim() ?? "";
  const limit = Math.max(0, input.limit ?? 50);
  const offset = Math.max(0, input.offset ?? 0);
  const nowMs = input.now_ms ?? Date.now();
  const plan = buildSearchPlan(query);
  const indexes = buildSearchIndexes(input);
  const matched: TurnSearchResult[] = [];

  for (const turn of input.turns) {
    if (!turnPassesFilters(turn, input, indexes.sourceIds, indexes.linkStates, indexes.valueAxes)) continue;
    const session = indexes.sessionsById.get(turn.session_id);
    const candidate = materializeSearchCandidate({
      turn,
      session,
      project_observation_candidates: indexes.projectObservationCandidatesBySessionId.get(turn.session_id),
    });
    const matchField = classifySearchMatch(candidate, plan);
    if (!matchField) continue;
    const highlightSource = matchField === "title"
      ? candidate.title_text ?? ""
      : matchField === "path"
        ? candidate.path_text ?? ""
        : candidate.canonical_text ?? "";
    const highlights = query.length > 0 ? findHighlights(highlightSource, query) : [];
    matched.push({
      turn,
      session,
      project: turn.project_id ? indexes.projectsById.get(turn.project_id) : undefined,
      highlights: matchField === "text" ? highlights : query.length > 0 ? findHighlights(candidate.canonical_text ?? "", query) : [],
      relevance_score: computeRelevanceScore(turn, highlights, nowMs, matchField),
      match_field: matchField,
    });
  }

  const collapsed = collapseTitleOnlyTurnMatches(matched);
  collapsed.sort(compareTurnSearchResults);
  return {
    results: limit === 0 ? [] : collapsed.slice(offset, offset + limit),
    total: collapsed.length,
  };
}

export function searchSessionsInMemory(input: SearchSessionsInMemoryInput): {
  results: SessionSearchResult[];
  total: number;
} {
  const query = input.query?.trim() ?? "";
  const limit = Math.max(0, input.limit ?? 50);
  const offset = Math.max(0, input.offset ?? 0);
  const nowMs = input.now_ms ?? Date.now();
  const plan = buildSearchPlan(query);
  const indexes = buildSearchIndexes(input);
  const topLevel = new Set(
    filterTopLevelSessions(input.sessions, input.related_work ?? []).map((session) => session.id),
  );
  const turnsBySessionId = new Map<string, UserTurnProjection[]>();
  for (const turn of input.turns) {
    const bucket = turnsBySessionId.get(turn.session_id);
    if (bucket) bucket.push(turn);
    else turnsBySessionId.set(turn.session_id, [turn]);
  }

  const matched: SessionSearchResult[] = [];
  for (const session of input.sessions) {
    if (!topLevel.has(session.id)) continue;
    if (indexes.sourceIds && !indexes.sourceIds.has(session.source_id)) continue;
    if (input.project_id && session.primary_project_id !== input.project_id) continue;

    const titleText = sessionTitleText(session);
    const titleHit = matchesSearchPlan(titleText, plan);
    const turnMatches: TurnSearchResult[] = [];
    for (const turn of turnsBySessionId.get(session.id) ?? []) {
      if (!turnPassesFilters(turn, input, indexes.sourceIds, indexes.linkStates, indexes.valueAxes)) continue;
      const candidate = materializeSearchCandidate({
        turn,
        session,
        project_observation_candidates: indexes.projectObservationCandidatesBySessionId.get(session.id),
      });
      const matchField = classifySearchMatch(candidate, plan);
      if (!matchField || matchField === "title") continue;
      const highlightSource = matchField === "path" ? candidate.path_text ?? "" : candidate.canonical_text ?? "";
      const highlights = query.length > 0 ? findHighlights(highlightSource, query) : [];
      turnMatches.push({
        turn,
        session,
        project: turn.project_id ? indexes.projectsById.get(turn.project_id) : undefined,
        highlights,
        relevance_score: computeRelevanceScore(turn, highlights, nowMs, matchField),
        match_field: matchField,
      });
    }

    if (!titleHit && turnMatches.length === 0) continue;
    turnMatches.sort(compareTurnSearchResults);
    const bestTurn = turnMatches[0];
    const matchField: SearchMatchField = titleHit ? "title" : bestTurn?.match_field ?? "title";
    const highlightSource = titleHit ? titleText : bestTurn?.match_field === "path"
      ? materializeSearchCandidate({
          turn: bestTurn.turn,
          session,
          project_observation_candidates: indexes.projectObservationCandidatesBySessionId.get(session.id),
        }).path_text ?? ""
      : bestTurn?.turn.canonical_text ?? "";
    const recencyTurn = bestTurn?.turn ?? {
      submission_started_at: session.updated_at,
    };
    const highlights = query.length > 0 ? findHighlights(highlightSource, query) : [];
    matched.push({
      session,
      project: session.primary_project_id
        ? indexes.projectsById.get(session.primary_project_id)
        : bestTurn?.project,
      best_turn: bestTurn?.turn,
      highlights,
      relevance_score: (titleHit ? TITLE_SCORE : 0) + (bestTurn
        ? bestTurn.relevance_score
        : computeSearchRecencyScore(recencyTurn, nowMs)),
      match_field: matchField,
    });
  }

  matched.sort(compareSessionSearchResults);
  return {
    results: limit === 0 ? [] : matched.slice(offset, offset + limit),
    total: matched.length,
  };
}

function buildSearchIndexes(input: SearchTurnsInMemoryInput): {
  sourceIds: Set<string> | undefined;
  linkStates: Set<LinkState> | undefined;
  valueAxes: Set<ValueAxis> | undefined;
  sessionsById: Map<string, SessionProjection>;
  projectsById: Map<string, ProjectIdentity>;
  projectObservationCandidatesBySessionId: Map<string, DerivedCandidate[]>;
} {
  const projectObservationCandidatesBySessionId = new Map<string, DerivedCandidate[]>();
  for (const candidate of input.candidates ?? []) {
    if (candidate.candidate_kind !== "project_observation") continue;
    const existing = projectObservationCandidatesBySessionId.get(candidate.session_ref);
    if (existing) existing.push(candidate);
    else projectObservationCandidatesBySessionId.set(candidate.session_ref, [candidate]);
  }
  return {
    sourceIds: input.source_ids && input.source_ids.length > 0 ? new Set(input.source_ids) : undefined,
    linkStates: input.link_states && input.link_states.length > 0 ? new Set(input.link_states) : undefined,
    valueAxes: input.value_axes && input.value_axes.length > 0 ? new Set(input.value_axes) : undefined,
    sessionsById: new Map(input.sessions.map((session) => [session.id, session])),
    projectsById: new Map(input.projects.map((project) => [project.project_id, project])),
    projectObservationCandidatesBySessionId,
  };
}

function turnPassesFilters(
  turn: UserTurnProjection,
  input: SearchTurnsInMemoryInput,
  sourceIds: Set<string> | undefined,
  linkStates: Set<LinkState> | undefined,
  valueAxes: Set<ValueAxis> | undefined,
): boolean {
  if (input.project_id && turn.project_id !== input.project_id) return false;
  if (sourceIds && !sourceIds.has(turn.source_id)) return false;
  if (linkStates && !linkStates.has(turn.link_state)) return false;
  if (valueAxes && !valueAxes.has(turn.value_axis)) return false;
  return true;
}

function collapseTitleOnlyTurnMatches(matches: readonly TurnSearchResult[]): TurnSearchResult[] {
  const titleOnlyBySession = new Map<string, TurnSearchResult>();
  const kept: TurnSearchResult[] = [];
  for (const result of matches) {
    if (result.match_field !== "title") {
      kept.push(result);
      continue;
    }
    const current = titleOnlyBySession.get(result.turn.session_id);
    if (!current || compareTurnSearchResults(result, current) < 0) {
      titleOnlyBySession.set(result.turn.session_id, result);
    }
  }
  kept.push(...titleOnlyBySession.values());
  return kept;
}

export function materializeSearchCandidate(input: MaterializeSearchCandidateInput): SearchCandidateFields {
  const pathParts = [
    input.turn.path_text,
    input.session?.working_directory,
    input.session?.resume_working_directory,
    input.session?.source_native_project_ref,
  ];

  for (const candidate of input.project_observation_candidates ?? []) {
    if (candidate.candidate_kind !== "project_observation") {
      continue;
    }
    const evidence = candidate.evidence;
    pathParts.push(
      asOptionalString(evidence.workspace_path),
      asOptionalString(evidence.workspace_path_normalized),
      asOptionalString(evidence.repo_root),
      asOptionalString(evidence.repo_remote),
      asOptionalString(evidence.repo_fingerprint),
      asOptionalString(evidence.source_native_project_ref),
    );
  }

  return {
    canonical_text: boundSearchCanonicalText(input.turn.canonical_text ?? ""),
    path_text: pathParts.filter((value): value is string => Boolean(value)).join(" ") || undefined,
    title_text: sessionTitleText(input.session) || undefined,
  };
}

export function boundSearchCanonicalText(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= SEARCH_CANONICAL_TEXT_SCAN_BYTES) {
    return value;
  }

  const cut = SEARCH_CANONICAL_TEXT_SCAN_BYTES - Buffer.byteLength(SEARCH_TRUNCATION_MARKER, "utf8");
  const sliced = bytes.subarray(0, cut);
  const decoded = sliced.toString("utf8");
  if (Buffer.from(decoded, "utf8").byteLength === sliced.byteLength) {
    return decoded + SEARCH_TRUNCATION_MARKER;
  }
  return decoded.replace(/\uFFFD$/u, "") + SEARCH_TRUNCATION_MARKER;
}

/** Remove the bound marker so index text does not match searches for "truncated". */
export function stripSearchTruncationMarker(value: string): string {
  return value.endsWith(SEARCH_TRUNCATION_MARKER)
    ? value.slice(0, value.length - SEARCH_TRUNCATION_MARKER.length)
    : value;
}

export function computeSearchRecencyScore(
  turn: Pick<UserTurnProjection, "submission_started_at">,
  nowMs = Date.now(),
): number {
  const turnMs = Date.parse(turn.submission_started_at) || 0;
  const ageMs = Math.max(0, nowMs - turnMs);
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  return 5 * Math.max(0, 1 - Math.log1p(ageMs / ninetyDaysMs) / Math.log1p(100));
}

export function computeRelevanceScore(
  turn: Pick<UserTurnProjection, "submission_started_at">,
  highlights: readonly SearchHighlight[],
  nowMs = Date.now(),
  matchField: SearchMatchField = "text",
): number {
  const fieldWeight = matchField === "title" ? TITLE_SCORE : matchField === "path" ? PATH_SCORE : TEXT_SCORE;
  return fieldWeight + highlights.length * 10 + computeSearchRecencyScore(turn, nowMs);
}

export function findHighlights(text: string, query: string): SearchHighlight[] {
  const plan = buildSearchPlan(query);
  const terms = plan.terms.length > 0
    ? plan.terms.map((term) => term.value)
    : plan.normalizedQuery
      ? [plan.normalizedQuery]
      : [];
  if (terms.length === 0) {
    return [];
  }

  const highlights: SearchHighlight[] = [];
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "gi");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      highlights.push({ start: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) {
        regex.lastIndex += 1;
      }
    }
  }
  return mergeHighlights(highlights);
}

export function matchesSearchCandidateQuery(candidate: SearchCandidateFields, query: string): boolean {
  return matchesSearchCandidatePlan(candidate, buildSearchPlan(query));
}

export function matchesSearchCandidatePlan(candidate: SearchCandidateFields, plan: SearchPlan): boolean {
  return classifySearchMatch(candidate, plan) !== undefined;
}

export function classifySearchMatch(candidate: SearchCandidateFields, plan: SearchPlan): SearchMatchField | undefined {
  if (plan.normalizedQuery.length === 0) return "text";
  if (matchesSearchPlan(candidate.canonical_text ?? "", plan)) return "text";
  if (matchesSearchPlan(candidate.title_text ?? "", plan)) return "title";
  if (matchesSearchPlan(candidate.path_text ?? "", plan)) return "path";
  return undefined;
}

export function compareTurnSearchResults(left: TurnSearchResult, right: TurnSearchResult): number {
  if (left.relevance_score !== right.relevance_score) {
    return right.relevance_score - left.relevance_score;
  }
  const timeOrder = right.turn.submission_started_at.localeCompare(left.turn.submission_started_at);
  if (timeOrder !== 0) {
    return timeOrder;
  }
  return left.turn.id.localeCompare(right.turn.id);
}

export function compareSessionSearchResults(left: SessionSearchResult, right: SessionSearchResult): number {
  if (left.relevance_score !== right.relevance_score) {
    return right.relevance_score - left.relevance_score;
  }
  const leftTime = left.best_turn?.submission_started_at ?? left.session.updated_at;
  const rightTime = right.best_turn?.submission_started_at ?? right.session.updated_at;
  const timeOrder = rightTime.localeCompare(leftTime);
  if (timeOrder !== 0) return timeOrder;
  return left.session.id.localeCompare(right.session.id);
}

export function buildSearchPlan(query: string): SearchPlan {
  const normalizedQuery = query.trim().toLowerCase();
  const seen = new Set<string>();
  const terms: SearchTerm[] = [];
  for (const segment of normalizedQuery.split(/\s+/u)) {
    if (!segment) {
      continue;
    }
    const mode = /^[\p{L}\p{N}]+$/u.test(segment) && segment.length > 1 ? "prefix" : "literal";
    const key = `${mode}:${segment}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    terms.push({ value: segment, mode });
  }
  return { normalizedQuery, terms };
}

export function matchesSearchPlan(text: string, plan: SearchPlan): boolean {
  const loweredText = text.toLowerCase();
  if (plan.terms.length > 0) {
    return plan.terms.every((term) => loweredText.includes(term.value));
  }
  return plan.normalizedQuery.length === 0 ? true : loweredText.includes(plan.normalizedQuery);
}

function sessionTitleText(session: SearchCandidateSessionFields | undefined): string {
  return [session?.canonical_title, session?.title].filter((value): value is string => Boolean(value)).join(" ");
}

function mergeHighlights(highlights: SearchHighlight[]): SearchHighlight[] {
  if (highlights.length <= 1) {
    return highlights;
  }
  const ordered = [...highlights].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SearchHighlight[] = [];
  for (const highlight of ordered) {
    const previous = merged.at(-1);
    if (!previous || highlight.start > previous.end) {
      merged.push({ ...highlight });
      continue;
    }
    previous.end = Math.max(previous.end, highlight.end);
  }
  return merged;
}
