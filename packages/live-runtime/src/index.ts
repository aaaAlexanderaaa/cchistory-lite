import { randomUUID } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  type LogicalQuery,
  deriveHostId,
  deriveSourceInstanceId,
  normalizeLocalPathIdentity,
  type AskUserQuestionTurn,
  type DerivedCandidate,
  type Host,
  type LossAuditRecord,
  type ProjectIdentity,
  type SessionProjection,
  type SessionRelatedWorkProjection,
  type SessionContributionProjection,
  type DelegatedChildProjection,
  type SessionFamilyProjection,
  type SourceFragment,
  type SourceDefinition,
  type SourcePlatform,
  type SourceStatus,
  type SourceSyncPayload,
  type TurnContextProjection,
  type SessionSearchResult,
  type TurnSearchResult,
  type UsageStatsDimension,
  type UsageStatsOverview,
  type UsageStatsRollup,
  type UserTurnProjection,
} from "@cchistory/domain";
import {
  executeCanonicalQuery,
  collectionQueryTemplate,
  hasSessionFamilyLinkTool,
  auditProjectionConsistency,
  interpretSessionEvidence,
  buildSessionLastMessageIndex,
  buildDirectoryScopedProjectTreeProjection,
  buildFallbackProjectObservationCandidates,
  buildProjectDisplayList,
  buildSessionRelatedWorkIndex,
  compareTurnsByChronology,
  compareTurnsByRecency,
  computeUsageOverview,
  computeUsageRollup,
  deriveProjectLinkSnapshot,
  filterProjectsByDirectoryScope,
  selectSampleSessions,
  summarizeDirectoryScope,
  filterSessionsByDirectoryScope,
  filterTopLevelSessions,
  filterTurnsByDirectoryScope,
  buildSessionFamilyInventory,
  FAMILY_IO_PREVIEW_CHARS,
  listDelegatedRelationsForFamilyChildren,
  listSessionFamilies,
  mergeSessionFamilyInventories,
  installRuntimeWarningFilter,
  orderSessionsByLastMessage,
  pathMatchesDirectoryScope,
  searchSessionsInMemory,
  searchTurnsInMemory,
  resolveTurnUsage,
  summarizeSessionUsage,
  type ProjectionAuditIssue,
  type SessionUsageProjection,
  type TurnUsageProjection,
  type UsageFilters,
} from "@cchistory/canonical";
import { SourceReadBudgetExceededError, type SourceReadBudget, applyMaskTemplates, type SourceProbeProgressEvent, type SourceFileReadPlan } from "@cchistory/source-adapters";
import { SAMPLE_RANK_CONCURRENCY, mapPool } from "./async-pool.js";
import { isSelectiveLatestQuery, newQueryReadWork, type LiveQueryRead, type QueryReadWork, type SelectiveGroupPlan } from "./selective-query.js";
import { PreparationMetadata } from "./preparation-metadata.js";
import {
  readRemainingHeapBytes,
  LIGHT_SCAN_MEMORY_MULTIPLIER, FULL_SCAN_MEMORY_MULTIPLIER, SCAN_GUARD_REFUSE_AVAILABLE_FRACTION,
  acquireScanLock,
  assessScanRisk,
  createScanWatchdog,
  isScanGuardEnabled,
  ScanGuardRefusedError,
  type ScanGuardEvent,
  type ScanGuardProfile,
  type ScanLockDeps,
  type ScanLockHandle,
  type ScanWatchdogDeps,
} from "./scan-guard.js";


export {
  acquireScanLock,
  assessScanRisk,
  createScanWatchdog,
  defaultScanLockPath,
  formatScanGuardBytes,
  formatScanGuardWarning,
  FULL_SCAN_MEMORY_MULTIPLIER,
  isScanGuardEnabled,
  LIGHT_SCAN_MEMORY_MULTIPLIER,
  SCAN_GUARD_REFUSE_AVAILABLE_FRACTION,
  SCAN_GUARD_WARN_AVAILABLE_FRACTION,
  SCAN_LOCK_WAIT_MS,
  SCAN_WATCHDOG_AVAILABLE_RESERVE_FRACTION,
  ScanGuardAbortedError,
  ScanGuardRefusedError,
} from "./scan-guard.js";
export type {
  AssessScanRiskDeps,
  AssessScanRiskInput,
  ScanGuardEvent,
  ScanGuardProfile,
  ScanLockAcquisition,
  ScanLockDeps,
  ScanLockHandle,
  ScanLockHolder,
  ScanRiskAssessment,
  ScanRiskRoot,
  ScanWatchdog,
  ScanWatchdogDeps,
} from "./scan-guard.js";
import { readAvailableMemoryBytes } from "./system-memory.js";
export { SourceReadBudgetExceededError } from "@cchistory/source-adapters";
export { readAvailableMemory, readAvailableMemoryBytes } from "./system-memory.js";
export type { AvailableMemoryReading, SystemMemoryDeps } from "./system-memory.js";

installRuntimeWarningFilter();

export function maskCompactPreview(
  value: string | undefined,
  kind: "tool_input" | "tool_output" | "user_message",
): string | undefined {
  if (!value?.trim()) return undefined;
  const masked = applyMaskTemplates(value, kind).canonical_text.replace(/\s+/gu, " ").trim();
  if (!masked) return undefined;
  if (kind === "user_message" || masked.length <= FAMILY_IO_PREVIEW_CHARS) return masked;
  return `${masked.slice(0, FAMILY_IO_PREVIEW_CHARS - 1)}…`;
}

export interface LiteSourceRoot {
  sourceRef: string;
  baseDir: string;
}

export interface ResolveLiteSourcesOptions {
  homeDir?: string;
  hostname?: string;
  platform?: NodeJS.Platform;
  appDataDir?: string;
  sourceRefs?: readonly string[];
  sourceRoots?: readonly LiteSourceRoot[];
}

export interface ScanLiteHistoryOptions extends ResolveLiteSourcesOptions {
  /** Attempt-local native allocation admission, installed by the runtime guard. */
  readBudget?: SourceReadBudget;
  limitFiles?: number;
  safeMode?: boolean;
  contextMode?: LiteContextMode;
  contextTarget?: LiteContextTarget;
  contextTargets?: readonly LiteContextTarget[];
  sessionRefs?: readonly string[];
  directoryScope?: string;
  sample?: { perSource: number };
  onProgress?: (event: SourceProbeProgressEvent) => void;
  /**
   * Pre-flight / in-flight memory guard. Absent means unguarded: library
   * callers opt in, and the Lite surfaces always do. CCHISTORY_SCAN_GUARD=0
   * (or "false") disables the guard layer for a scan that requests it.
   */
  scanGuard?: ScanGuardRequest;
  onScanGuardEvent?: (event: ScanGuardEvent) => void;
  /** Test injection for the guard; production callers leave this unset. */
  scanGuardDeps?: ScanGuardRuntimeDeps;
}

export interface ScanGuardRequest {
  /** light scans release context after projection; full scans (export, full-context show) retain it. */
  profile: ScanGuardProfile;
  /**
   * Skip only the advisory scan queue (sample / exact-id show).
   * Native read admission, preflight estimation and the watchdog still apply.
   */
  bypass?: boolean;
}

export interface ScanGuardRuntimeDeps {
  lock?: ScanLockDeps;
  watchdog?: ScanWatchdogDeps;
  walkRootBytes?: (root: string, limitFiles?: number) => Promise<number>;
  readAvailableBytes?: () => number | undefined;
  readHeapBytes?: () => number;
}

export type LiteContextMode = "full" | "none" | "matching";

export interface LiteContextTarget {
  kind: "session" | "turn";
  ref: string;
}

export class AmbiguousReferenceError extends Error {
  readonly ref: string;
  readonly candidateIds: string[];

  constructor(ref: string, candidateIds: readonly string[], prefix: boolean) {
    super(`${prefix ? "Ambiguous ID prefix" : "Ambiguous reference"} ${JSON.stringify(ref)} matched ${candidateIds.length} objects.`);
    this.name = "AmbiguousReferenceError";
    this.ref = ref;
    this.candidateIds = [...candidateIds];
  }
}

export interface LiveDirectoryScopeOptions {
  directoryScope?: string;
}

type LiveSourcePayload = Pick<
  SourceSyncPayload,
  | "source"
  | "blobs"
  | "candidates"
  | "sessions"
  | "turns"
  | "contexts"
  | "ask_user_question_turns"
  | "loss_audits"
> & {
  fragments?: readonly SourceFragment[];
  records?: SourceSyncPayload["records"];
  atoms?: SourceSyncPayload["atoms"];
  related_work?: readonly SessionRelatedWorkProjection[];
  session_contributions?: readonly SessionContributionProjection[];
  delegated_children?: readonly DelegatedChildProjection[];
};

export interface LiveSnapshotData {
  host: Host;
  sources: SourceStatus[];
  projects: ProjectIdentity[];
  sessions: SessionProjection[];
  related_work: SessionRelatedWorkProjection[];
  session_contributions: SessionContributionProjection[];
  delegated_children: DelegatedChildProjection[];
  turns: UserTurnProjection[];
  contexts: TurnContextProjection[];
  ask_user_question_turns: AskUserQuestionTurn[];
  loss_audits: LossAuditRecord[];
}

type LiveSnapshotInputData = Omit<LiveSnapshotData, "related_work" | "session_contributions" | "delegated_children"> & {
  related_work?: SessionRelatedWorkProjection[];
  session_contributions?: SessionContributionProjection[];
  delegated_children?: DelegatedChildProjection[];
};

export interface LiveSearchOptions {
  query?: string;
  projectId?: string;
  sourceIds?: readonly string[];
  limit?: number;
  offset?: number;
  directoryScope?: string;
}

export class LiveHistorySnapshot {
  selectSampleSessions(perSource: number, directoryScope?: string) {
    return selectSampleSessions(this.data, perSource, directoryScope);
  }
  getDirectoryScopeDiagnostics(directoryScope?: string) {
    return summarizeDirectoryScope(this.data.sessions, directoryScope);
  }
  readonly data: LiveSnapshotData;
  readonly readIdentity = { id: randomUUID(), prepared_at: new Date().toISOString() };
  /** Non-fatal projection diagnostics kept visible to read-only surfaces. */
  readonly projectionIssues: readonly ProjectionAuditIssue[];
  private readonly sourcesById: Map<string, SourceStatus>;
  private readonly projectsById: Map<string, ProjectIdentity>;
  private readonly sessionsById: Map<string, SessionProjection>;
  private readonly relatedWorkBySessionId: Map<string, SessionRelatedWorkProjection[]>;
  private readonly turnsById: Map<string, UserTurnProjection>;
  private readonly contextsByTurnId: Map<string, TurnContextProjection>;
  private readonly lastMessageAtBySessionId: ReadonlyMap<string, string>;
  private readonly searchCandidates: readonly DerivedCandidate[];
  private readonly contributionsBySessionId: Map<string, SessionContributionProjection>;
  private readonly childrenByParentId: Map<string, DelegatedChildProjection[]>;
  private readonly familiesByParentId: Map<string, SessionFamilyProjection>;
  private readonly families: SessionFamilyProjection[];
  // Snapshot data is immutable, so derived indexes and ranked searches are
  // memoized for the lifetime of the instance (a refresh builds a new one).
  private turnsBySessionId?: Map<string, UserTurnProjection[]>;
  private turnsByProjectId?: Map<string, UserTurnProjection[]>;
  private searchRankCache?: Map<string, readonly TurnSearchResult[]>;
  private sessionSearchRankCache?: Map<string, readonly SessionSearchResult[]>;

  constructor(data: LiveSnapshotInputData, searchCandidates: readonly DerivedCandidate[] = []) {
    this.data = {
      ...data,
      related_work: data.related_work ?? [],
      session_contributions: data.session_contributions ?? [],
      delegated_children: data.delegated_children ?? [],
    };
    this.projectionIssues = auditProjectionConsistency(this.data);
    this.sourcesById = new Map(data.sources.map((source) => [source.id, source]));
    this.projectsById = new Map(data.projects.map((project) => [project.project_id, project]));
    this.sessionsById = new Map(this.data.sessions.map((session) => [session.id, session]));
    this.relatedWorkBySessionId = new Map();
    for (const entry of this.data.related_work) {
      const related = this.relatedWorkBySessionId.get(entry.query_session_ref);
      if (related) related.push(entry);
      else this.relatedWorkBySessionId.set(entry.query_session_ref, [entry]);
    }
    this.turnsById = new Map(data.turns.map((turn) => [turn.id, turn]));
    this.lastMessageAtBySessionId = buildSessionLastMessageIndex(data.turns);
    this.contextsByTurnId = new Map(data.contexts.map((context) => [context.turn_id, context]));
    this.searchCandidates = searchCandidates;
    this.contributionsBySessionId = new Map(
      this.data.session_contributions.map((entry) => [entry.session_ref, entry]),
    );
    this.families = listSessionFamilies(this.data.sessions, {
      contributions: this.data.session_contributions,
      children: this.data.delegated_children,
    });
    this.familiesByParentId = new Map(this.families.map((family) => [family.parent_session_ref, family]));
    this.data.delegated_children = this.families.flatMap((family) => family.children);
    this.childrenByParentId = new Map();
    for (const child of this.data.delegated_children) {
      const siblings = this.childrenByParentId.get(child.parent_session_ref) ?? [];
      siblings.push(child);
      this.childrenByParentId.set(child.parent_session_ref, siblings);
    }
  }

  listSources(): SourceStatus[] {
    return [...this.data.sources];
  }

  listProjects(options: LiveDirectoryScopeOptions = {}): ProjectIdentity[] {
    return buildProjectDisplayList(filterProjectsByDirectoryScope({
      projects: this.data.projects,
      sessions: this.data.sessions,
      turns: this.data.turns,
      directoryScope: options.directoryScope,
    }));
  }

  executeCollectionQuery(query: LogicalQuery, options: LiveDirectoryScopeOptions = {}) {
    return executeCanonicalQuery(this.data, query, options.directoryScope);
  }

  selectCollectionTemplate(kind: "latest-sessions" | "latest-turns" | "list-sessions", limit = 20, offset = 0, options: LiveDirectoryScopeOptions = {}) {
    return this.executeCollectionQuery(collectionQueryTemplate(kind, limit, offset), options);
  }

  listResolvedSessions(options: LiveDirectoryScopeOptions = {}): SessionProjection[] {
    return filterSessionsByDirectoryScope(this.data.sessions, options.directoryScope);
  }

  listTopLevelSessions(options: LiveDirectoryScopeOptions = {}): SessionProjection[] {
    return filterSessionsByDirectoryScope(
      filterTopLevelSessions(this.data.sessions, this.data.related_work),
      options.directoryScope,
    );
  }

  listResolvedTurns(options: LiveDirectoryScopeOptions = {}): UserTurnProjection[] {
    return filterTurnsByDirectoryScope(this.data.turns, this.data.sessions, options.directoryScope);
  }

  getSessionActivityAt(sessionRef: string): string | undefined {
    const session = this.getSession(sessionRef);
    return session ? this.lastMessageAtBySessionId.get(session.id) ?? session.updated_at : undefined;
  }

  getProjectsTreeProjection(options: LiveDirectoryScopeOptions = {}) {
    return buildDirectoryScopedProjectTreeProjection({
      projects: this.listProjects(),
      sessions: this.data.sessions,
      turns: this.data.turns,
      relatedWork: this.data.related_work,
      directoryScope: options.directoryScope,
    });
  }

  listSessionRelatedWork(sessionRef: string): SessionRelatedWorkProjection[] {
    const session = this.getSession(sessionRef);
    return session ? [...(this.relatedWorkBySessionId.get(session.id) ?? [])] : [];
  }

  getSessionContribution(sessionRef: string): SessionContributionProjection | undefined {
    const session = this.getSession(sessionRef);
    if (!session) return undefined;
    return this.contributionsBySessionId.get(session.id);
  }

  listDelegatedChildren(sessionRef: string): DelegatedChildProjection[] {
    const session = this.getSession(sessionRef);
    if (!session) return [];
    return [...(this.childrenByParentId.get(session.id) ?? [])];
  }

  getSessionFamily(sessionRef: string): SessionFamilyProjection | undefined {
    const session = this.getSession(sessionRef);
    if (!session) return undefined;
    return this.familiesByParentId.get(session.id);
  }

  listSessionFamilies(options: LiveDirectoryScopeOptions = {}): SessionFamilyProjection[] {
    if (!options.directoryScope) return [...this.families];
    const allowed = new Set(this.listResolvedSessions(options).map((session) => session.id));
    return this.families.filter((family) => allowed.has(family.parent_session_ref));
  }

  listAskUserQuestionTurns(filter: { sourceId?: string; sessionId?: string } = {}): AskUserQuestionTurn[] {
    return this.data.ask_user_question_turns.filter((turn) => {
      if (filter.sourceId && turn.source_id !== filter.sourceId) return false;
      if (filter.sessionId && turn.session_id !== filter.sessionId) return false;
      return true;
    });
  }

  listLossAudits(): LossAuditRecord[] {
    return [...this.data.loss_audits];
  }

  getSource(ref: string): SourceStatus | undefined {
    const exact = this.sourcesById.get(ref);
    if (exact) return exact;
    return resolveUnique(
      this.data.sources,
      ref,
      (source) => source.id,
      (source) => [source.slot_id, source.platform, source.display_name, source.base_dir],
    );
  }

  getProject(ref: string): ProjectIdentity | undefined {
    const exact = this.projectsById.get(ref);
    if (exact) return exact;
    return resolveUnique(
      this.data.projects,
      ref,
      (project) => project.project_id,
      (project) => [
        project.slug,
        project.display_name,
        project.primary_workspace_path,
        path.basename(project.primary_workspace_path ?? ""),
      ],
    );
  }

  getSession(ref: string): SessionProjection | undefined {
    const exact = this.sessionsById.get(ref);
    if (exact) return exact;
    return resolveUnique(
      this.data.sessions,
      ref,
      (session) => session.id,
      (session) => [
        session.source_session_id,
        session.title,
        session.working_directory,
        path.basename(session.working_directory ?? ""),
      ],
      (session) => [session.source_session_id],
    );
  }

  getSessionDisplayRef(sessionRef: string, minimumLength = 8): string | undefined {
    const session = this.getSession(sessionRef);
    if (!session) return undefined;
    const nativeRef = session.source_session_id;
    if (nativeRef) {
      const minimum = Math.min(Math.max(1, minimumLength), nativeRef.length);
      for (let length = minimum; length <= nativeRef.length; length += 1) {
        const candidate = nativeRef.slice(0, length);
        try {
          if (this.getSession(candidate)?.id === session.id) return candidate;
        } catch {
          // Keep extending until the reference resolves uniquely.
        }
      }
    }
    return session.id;
  }

  getTurn(ref: string): UserTurnProjection | undefined {
    const exact = this.turnsById.get(ref);
    if (exact) return exact;
    return resolveUnique(this.data.turns, ref, (turn) => turn.id, () => []);
  }

  getTurnDisplayRef(turnRef: string, minimumLength = 8): string | undefined {
    const turn = this.getTurn(turnRef);
    if (!turn) return undefined;
    const minimum = Math.min(Math.max(1, minimumLength), turn.id.length);
    for (let length = minimum; length <= turn.id.length; length += 1) {
      const candidate = turn.id.slice(0, length);
      try {
        if (this.getTurn(candidate)?.id === turn.id) return candidate;
      } catch {
        // Keep extending until the reference resolves uniquely.
      }
    }
    return turn.id;
  }

  getTurnContext(turnRef: string): TurnContextProjection | undefined {
    const turn = this.getTurn(turnRef);
    return turn ? this.contextsByTurnId.get(turn.id) : undefined;
  }

  getTurnUsage(turnRef: string): TurnUsageProjection | undefined {
    const turn = this.getTurn(turnRef);
    return turn ? resolveTurnUsage(turn) : undefined;
  }

  getSessionUsage(sessionRef: string): SessionUsageProjection | undefined {
    const session = this.getSession(sessionRef);
    return session ? summarizeSessionUsage(this.sessionTurnBuckets().get(session.id) ?? []) : undefined;
  }

  listProjectTurns(projectRef: string, options: LiveDirectoryScopeOptions = {}): UserTurnProjection[] {
    const project = this.getProject(projectRef);
    if (!project) return [];
    return filterTurnsByDirectoryScope(
      this.projectTurnBuckets().get(project.project_id) ?? [],
      this.data.sessions,
      options.directoryScope,
    );
  }

  listSessionTurns(sessionRef: string): UserTurnProjection[] {
    const session = this.getSession(sessionRef);
    if (!session) return [];
    return [...(this.sessionTurnBuckets().get(session.id) ?? [])];
  }

  search(options: LiveSearchOptions = {}): { results: TurnSearchResult[]; total: number } {
    const limit = Math.max(0, options.limit ?? 50);
    const offset = Math.max(0, options.offset ?? 0);
    const cacheKey = JSON.stringify([
      options.query ?? "",
      options.projectId ?? null,
      options.sourceIds ?? null,
      options.directoryScope ?? null,
    ]);
    this.searchRankCache ??= new Map();
    let ranked = this.searchRankCache.get(cacheKey);
    if (!ranked) {
      ranked = searchTurnsInMemory({
        turns: filterTurnsByDirectoryScope(this.data.turns, this.data.sessions, options.directoryScope),
        sessions: this.data.sessions,
        projects: this.data.projects,
        candidates: this.searchCandidates,
        query: options.query,
        project_id: options.projectId,
        source_ids: options.sourceIds,
        limit: Infinity,
        offset: 0,
      }).results;
      this.searchRankCache.set(cacheKey, ranked);
    }
    return { results: ranked.slice(offset, offset + limit), total: ranked.length };
  }

  searchSessions(options: LiveSearchOptions = {}): { results: SessionSearchResult[]; total: number } {
    const limit = Math.max(0, options.limit ?? 50);
    const offset = Math.max(0, options.offset ?? 0);
    const cacheKey = JSON.stringify([
      options.query ?? "",
      options.projectId ?? null,
      options.sourceIds ?? null,
      options.directoryScope ?? null,
    ]);
    this.sessionSearchRankCache ??= new Map();
    let ranked = this.sessionSearchRankCache.get(cacheKey);
    if (!ranked) {
      ranked = searchSessionsInMemory({
        turns: filterTurnsByDirectoryScope(this.data.turns, this.data.sessions, options.directoryScope),
        sessions: filterSessionsByDirectoryScope(this.data.sessions, options.directoryScope),
        projects: this.data.projects,
        candidates: this.searchCandidates,
        related_work: this.data.related_work,
        query: options.query,
        project_id: options.projectId,
        source_ids: options.sourceIds,
        limit: Infinity,
        offset: 0,
      }).results;
      this.sessionSearchRankCache.set(cacheKey, ranked);
    }
    return { results: ranked.slice(offset, offset + limit), total: ranked.length };
  }

  private sessionTurnBuckets(): Map<string, UserTurnProjection[]> {
    if (!this.turnsBySessionId) {
      const buckets = new Map<string, UserTurnProjection[]>();
      for (const turn of this.data.turns) {
        const bucket = buckets.get(turn.session_id);
        if (bucket) bucket.push(turn);
        else buckets.set(turn.session_id, [turn]);
      }
      for (const bucket of buckets.values()) bucket.sort(compareTurnsByChronology);
      this.turnsBySessionId = buckets;
    }
    return this.turnsBySessionId;
  }

  private projectTurnBuckets(): Map<string, UserTurnProjection[]> {
    if (!this.turnsByProjectId) {
      const buckets = new Map<string, UserTurnProjection[]>();
      for (const turn of this.data.turns) {
        if (!turn.project_id) continue;
        const bucket = buckets.get(turn.project_id);
        if (bucket) bucket.push(turn);
        else buckets.set(turn.project_id, [turn]);
      }
      this.turnsByProjectId = buckets;
    }
    return this.turnsByProjectId;
  }

  getUsageOverview(filters: UsageFilters = {}): UsageStatsOverview {
    return computeUsageOverview({
      filters,
      listResolvedTurns: () => this.data.turns,
      listResolvedSessions: () => this.data.sessions,
      listSources: () => this.data.sources,
      listProjects: () => this.data.projects,
    });
  }

  getUsageRollup(dimension: UsageStatsDimension, filters: UsageFilters = {}): UsageStatsRollup {
    return computeUsageRollup({
      dimension,
      filters,
      listResolvedTurns: () => this.data.turns,
      listResolvedSessions: () => this.data.sessions,
      listSources: () => this.data.sources,
      listProjects: () => this.data.projects,
    });
  }
}

export async function scanLiteHistory(options: ScanLiteHistoryOptions = {}): Promise<LiveHistorySnapshot> {
  return withPreparedScan(options, (sources, scanGuard, getPlan) =>
    scanResolvedSources(scanGuard.guardedOptions(options), sources, scanGuard, getPlan));
}

/** Query-only selective reads never escape as a reusable full snapshot. */
export async function scanLiteQuery(query: LogicalQuery, options: ScanLiteHistoryOptions = {}): Promise<LiveQueryRead> {
  const work = newQueryReadWork();
  options = { ...options, contextMode: "none" };
  return withPreparedScan(options, async (sources, scanGuard, getPlan) => {
    const guardedOptions = scanGuard.guardedOptions(options);
    let selection: SelectiveGroupPlan | undefined;
    for (const source of sources) {
      const plan = await getPlan(source, options);
      work.discoveredPrimaryFiles += plan.discoveredPrimaryFiles;
      work.plannedPrimaryFiles += plan.readPlan.files.length;
      work.metadataEvidenceFiles += new Set(plan.selectionEvidence.flatMap(e => [...e.files])).size;
    }
    if (isSelectiveLatestQuery(query) && sources.length === 1 && sources[0]!.platform === "codex" && !options.sample && !options.sessionRefs?.length) {
      const source = sources[0]!, plan = await getPlan(source, options);
      selection = await prepareSelectiveGroups(plan, query, work, scanGuard);
    } else work.fallbackReason = query.complete ? "complete_requested" : "query_or_source_shape";
    const snapshot = await scanResolvedSources(guardedOptions, sources, scanGuard, getPlan, work, selection);
    const result = snapshot.executeCollectionQuery(query, { directoryScope: options.directoryScope });
    if (selection?.stopped) result.coverage = { execution: "selective", rows: "exact", diagnostics: "observed" };
    work.retainedSessions = snapshot.data.sessions.length; work.retainedTurns = snapshot.data.turns.length;
    return { identity: snapshot.readIdentity, sourceIds: snapshot.data.sources.map(s => s.id), directoryScope: options.directoryScope,
      result, projectionIssues: snapshot.projectionIssues, sources: snapshot.data.sources, lossAudits: snapshot.data.loss_audits, directoryScopeDiagnostics: snapshot.getDirectoryScopeDiagnostics(options.directoryScope), work };
  });
}

async function withPreparedScan<T>(options: ScanLiteHistoryOptions,
  run: (sources: SourceDefinition[], guard: ActiveScanGuard, getPlan: GetSourceScanPlan) => Promise<T>,
): Promise<T> {
  if (options.contextMode === "matching" && resolveContextTargets(options).length === 0) {
    throw new Error("matching context mode requires at least one context target.");
  }
  let sources = await resolveLiteSources(options);
  const exactPlatforms = exactCanonicalSessionPlatforms(options.sessionRefs ?? []);
  if (exactPlatforms.size > 0) {
    sources = sources.filter((source) => exactPlatforms.has(source.platform));
    if (sources.length === 0) {
      throw new Error(`No selected Lite source can resolve requested session ${options.sessionRefs?.join(", ")}.`);
    }
  }
  const sourceAdapters = await import("@cchistory/source-adapters");
  const metadata = new PreparationMetadata();
  const plans = new Map<string, Promise<PreparedSourceScan>>();
  const getPlan: GetSourceScanPlan = (source, scanOptions) => {
    const key = JSON.stringify([source.id, scanOptions.sessionRefs ?? []]);
    let pending = plans.get(key);
    if (!pending) {
      pending = prepareSourceScan(source, scanOptions, sourceAdapters, metadata);
      plans.set(key, pending);
    }
    return pending;
  };
  const scanGuard = await beginScanGuard(options, sources, getPlan);
  try {
    return await run(sources, scanGuard, getPlan);
  } finally {
    await scanGuard.release();
  }
}

interface ActiveScanGuard {
  guardedOptions(options: ScanLiteHistoryOptions): ScanLiteHistoryOptions;
  assertHealthy(): void;
  assess(options: ScanLiteHistoryOptions): Promise<void>;
  release(): Promise<void>;
}

/**
 * Runs the guard layer around a scan: serialize full scans on this machine,
 * refuse when the conservative peak estimate risks swap-death, and arm the
 * watchdog that aborts the scan if available memory collapses mid-probe. The
 * kill-switch env is read here — the live-runtime entry — so the guard module
 * and its tests stay explicit about behavior.
 */
async function beginScanGuard(
  options: ScanLiteHistoryOptions,
  sources: readonly SourceDefinition[],
  getPlan: GetSourceScanPlan,
): Promise<ActiveScanGuard> {
  const request = options.scanGuard;
  if (!request || !isScanGuardEnabled(process.env.CCHISTORY_SCAN_GUARD)) {
    return {
      guardedOptions: (scanOptions) => scanOptions,
      assertHealthy: () => {},
      assess: async () => {},
      release: async () => {},
    };
  }
  const deps = options.scanGuardDeps ?? {};

  let lockHandle: ScanLockHandle | undefined;
  if (!request.bypass) {
    const lock = await acquireScanLock({ ...deps.lock });
    if (!lock.acquired) {
      throw new ScanGuardRefusedError({
        reason: "scan_in_progress",
        holder: lock.holder,
        waitedMs: lock.waitedMs,
      });
    }
    lockHandle = lock.handle;
  }

  const assess = async (scanOptions: ScanLiteHistoryOptions) => {
    const directoryScoped = Boolean(scanOptions.directoryScope);
    // Planning failures must propagate before the generic estimator's best-effort walk.
    const prepared = new Map<string, PreparedSourceScan>();
    if (!deps.walkRootBytes) {
      for (const source of sources) prepared.set(source.slot_id, await getPlan(source, scanOptions));
    }
    const walkRootBytes = deps.walkRootBytes ?? (async (_root: string, _limit: number | undefined, slotId?: string) => {
      const plan = slotId && prepared.get(slotId);
      if (!plan) throw new Error(`Scan estimate has no source for ${slotId}.`);
      return plan.readPlan.bytes;
    });
    const assessment = await assessScanRisk(
      {
        roots: sources.map((source) => ({ path: source.base_dir, slot_id: source.slot_id })),
        limitFiles: scanOptions.limitFiles,
        profile: request.profile,
        ...(directoryScoped ? { directoryScoped: true } : {}),
      },
      { walkRootBytes, readAvailableBytes: deps.readAvailableBytes, readHeapBytes: deps.readHeapBytes },
    );
    if (assessment.status === "refuse") {
      throw new ScanGuardRefusedError({ reason: "estimated_memory", assessment });
    }
    if (assessment.status === "warn") {
      options.onScanGuardEvent?.({ type: "warn", assessment });
    }
  };

  try {
    await assess(options);
  } catch (error) {
    // A refused scan must not keep siblings queued behind a lock it no longer needs.
    await lockHandle?.release();
    throw error;
  }

  const multiplier = request.profile === "full" ? FULL_SCAN_MEMORY_MULTIPLIER : LIGHT_SCAN_MEMORY_MULTIPLIER;
  const readHeadroom = () => {
    let available: number | undefined;
    try { available = (deps.readAvailableBytes ?? readAvailableMemoryBytes)(); } catch { /* use heap */ }
    const heap = (deps.readHeapBytes ?? readRemainingHeapBytes)();
    return Math.max(0, Math.min(heap, available ?? heap)) * SCAN_GUARD_REFUSE_AVAILABLE_FRACTION / multiplier;
  };
  let remaining = readHeadroom();
  const readBudget: SourceReadBudget = {
    admit(bytes, unit) {
      const allowed = Math.floor(Math.min(remaining, readHeadroom()));
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > allowed) throw new SourceReadBudgetExceededError(unit, bytes, allowed);
      remaining -= bytes;
    },
  };
  const watchdog = createScanWatchdog({
    ...deps.watchdog,
    readAvailableBytes: deps.watchdog?.readAvailableBytes ?? deps.readAvailableBytes,
  });
  return {
    guardedOptions: (scanOptions) => ({
      ...scanOptions,
      readBudget,
      onProgress: (event) => {
        watchdog.observeProgress(event);
        scanOptions.onProgress?.(event);
      },
    }),
    assertHealthy: () => watchdog.assertHealthy(),
    assess,
    release: async () => {
      await lockHandle?.release();
    },
  };
}

async function scanResolvedSources(
  options: ScanLiteHistoryOptions,
  sources: readonly SourceDefinition[],
  scanGuard: ActiveScanGuard,
  getPlan: GetSourceScanPlan,
  work?: QueryReadWork,
  selection?: SelectiveGroupPlan,
): Promise<LiveHistorySnapshot> {
  const sourceAdapters = await import("@cchistory/source-adapters");
  const contextMode = options.contextMode ?? "full";

  const scanSources = async (scanOptions: ScanLiteHistoryOptions) => {
    const nextPayloads: LiveSourcePayload[] = [];
    let nextHost: Host | undefined;
    // Reuse this attempt's inventory, then scan one source at a time so raw
    // adapter payloads can be released promptly. Each
    // adapter explicitly declares its minimum safe projection boundary; the
    // runtime never infers independence from a file-oriented source shape.
    for (const source of sources) {
      const plan = await getPlan(source, scanOptions);
      for (const evidence of plan.selectionEvidence) await sourceAdapters.assertSourceFileReadPlanCurrent(evidence);
      await sourceAdapters.assertSourceFileReadPlanCurrent(plan.readPlan);
      const result = plan.groups
        ? await scanLogicalSessionGroups(source, scanOptions, contextMode, sourceAdapters, plan, () => scanGuard.assess(scanOptions), work, selection)
        : await scanSourceWithCollector(source, scanOptions, contextMode, sourceAdapters, plan.readPlan.files, plan.readPlan, plan.selectSessionFiles, work);
      for (const evidence of plan.selectionEvidence) await sourceAdapters.assertSourceFileReadPlanCurrent(evidence);
      if (selection) await sourceAdapters.assertSourceFileReadPlanCurrent(plan.readPlan);
      nextHost ??= result.host;
      nextPayloads.push(result.payload);
      // Watchdog backstop: breaches recorded inside adapter progress callbacks
      // (where a throw can be swallowed as a per-file error) surface here at
      // the latest, before the next source starts.
      scanGuard.assertHealthy();
    }
    if (!nextHost) {
      const emptyProbe = await sourceAdapters.runSourceProbe(interpretSessionEvidence, {}, []);
      nextHost = emptyProbe.host;
    }
    return { host: nextHost, payloads: nextPayloads };
  };

  let { host, payloads } = await scanSources(options);
  const requestedSessionRefs = options.sessionRefs?.filter((ref) => ref.trim().length > 0) ?? [];
  if (requestedSessionRefs.length === 0) return buildLiveSnapshot({ host, sources: payloads });

  const missingChildRefs = missingDelegatedChildSessionRefs(payloads, requestedSessionRefs);
  if (missingChildRefs.length > 0) {
    const expandedOptions = { ...options, sessionRefs: [...requestedSessionRefs, ...missingChildRefs] };
    await scanGuard.assess(expandedOptions);
    ({ host, payloads } = await scanSources(expandedOptions));
  }

  const combined = buildLiveSnapshot({ host, sources: payloads });
  const resolvedSessionRefs = requestedSessionRefs.map((ref) => {
    const session = combined.getSession(ref);
    if (!session) throw new Error(`Lite scan did not find requested session ${ref}.`);
    return session.id;
  });
  return buildLiveSnapshot({
    host,
    sources: payloads.map((payload) => filterLiveSourcePayloadBySessions(payload, resolvedSessionRefs)),
  });
}

export function buildLiveSnapshot(probe: { host: Host; sources: readonly LiveSourcePayload[] }): LiveHistorySnapshot {
  const sources = probe.sources.map((payload) => payload.source);
  const turns = probe.sources
    .flatMap((payload) => payload.turns)
    .sort(compareTurnsByRecency);
  const sessions = orderSessionsByLastMessage(
    probe.sources.flatMap((payload) => payload.sessions),
    turns,
  );
  const candidates = probe.sources.flatMap((payload) => payload.candidates);
  const blobs = probe.sources.flatMap((payload) => payload.blobs);
  const blobsById = new Map(blobs.map((blob) => [blob.id, blob]));
  const fallbackCandidates = buildFallbackProjectObservationCandidates({
    sessions,
    turns,
    candidates,
    sources,
    selectBlobsByIds: (ids) => ids.flatMap((id) => {
      const blob = blobsById.get(id);
      return blob ? [blob] : [];
    }),
  });
  const linked = deriveProjectLinkSnapshot({
    sessions,
    turns,
    candidates: [...candidates, ...fallbackCandidates],
  });
  const relatedWork = probe.sources.flatMap((payload) => materializeRelatedWork(payload));
  const family = mergeSessionFamilyInventories(probe.sources.map((payload) => familyInventoryForLivePayload(payload)));
  const familyRelatedWork = [
    ...relatedWork,
    ...listDelegatedRelationsForFamilyChildren(linked.sessions, family.children, relatedWork),
  ];

  return new LiveHistorySnapshot(normalizeJsonShapeForJsonOutputMutating({
    host: probe.host,
    sources,
    projects: linked.projects,
    sessions: linked.sessions,
    related_work: familyRelatedWork,
    session_contributions: family.contributions,
    delegated_children: family.children,
    turns: linked.turns,
    contexts: probe.sources.flatMap((payload) => payload.contexts),
    ask_user_question_turns: probe.sources.flatMap((payload) => payload.ask_user_question_turns),
    loss_audits: probe.sources.flatMap((payload) => payload.loss_audits),
  }), candidates);
}

interface LogicalSessionScanGroup {
  files: readonly string[];
  targetSessionRefs?: readonly string[];
}

interface PreparedSourceScan {
  discoveredPrimaryFiles: number;
  readPlan: SourceFileReadPlan;
  selectionEvidence: readonly SourceFileReadPlan[];
  selectSessionFiles?: boolean;
  groups?: readonly LogicalSessionScanGroup[];
  fallbackFiles?: readonly string[];
}

type GetSourceScanPlan = (source: SourceDefinition, options: ScanLiteHistoryOptions) => Promise<PreparedSourceScan>;

async function prepareSourceScan(
  source: SourceDefinition,
  options: ScanLiteHistoryOptions,
  adapters: typeof import("@cchistory/source-adapters"),
  metadata: PreparationMetadata,
): Promise<PreparedSourceScan> {
  const adapter = adapters.listPlatformAdapters().find((entry) => entry.platform === source.platform);
  let files: readonly string[];
  let discoveredPrimaryFiles: number;
  let groups: readonly LogicalSessionScanGroup[] | undefined;
  const selectionEvidence = new Set<SourceFileReadPlan>();
  if (adapter?.projectionBoundary === "logical_session") {
    ({ files, groups, discoveredPrimaryFiles } = await prepareLogicalSessionGroups(source, options, adapters,
      async (filePaths, includeWorkspaceMetadata) => {
        const inspected = await metadata.inspect(source, filePaths, {
          includeWorkspaceMetadata,
          workspaceScan: source.platform === "codex" && options.directoryScope ? "first" : "full",
        });
        for (const evidence of inspected.evidence) selectionEvidence.add(evidence);
        return inspected.metadata;
      }));
  } else {
    files = await adapters.listSourceFiles(source.platform, source.base_dir, options.limitFiles);
    discoveredPrimaryFiles = files.length;
    if (options.directoryScope) {
      files = files.filter((file) => sourceFileMayBeInDirectoryScope(adapters, source, file, options.directoryScope!));
    }
    if (options.sample) files = await selectSampleSourceFiles(source, files, options.sample.perSource, adapters);
  }
  const selectedFiles = groups ? groups.flatMap((group) => group.files) : files;
  const readPlan = await adapters.createSourceFileReadPlan(source, selectedFiles, options.safeMode ?? false);
  // Some source-level identity lookups read whole JSON files. Budget all their
  // candidates before doing that work; retain the probe's existing targeting rule.
  const selectSessionFiles = adapter?.projectionBoundary !== "logical_session"
    && !options.directoryScope && !options.sample && Boolean(options.sessionRefs?.length);
  return { discoveredPrimaryFiles, readPlan, selectionEvidence: [...selectionEvidence], selectSessionFiles, groups, fallbackFiles: groups ? files : undefined };
}

async function prepareSelectiveGroups(plan: PreparedSourceScan, query: LogicalQuery, work: QueryReadWork, guard: ActiveScanGuard): Promise<SelectiveGroupPlan | undefined> {
  if (!plan.groups?.length) { work.fallbackReason = "uncertain_grouping"; return undefined; }
  const adapters = await import("@cchistory/source-adapters");
  for (const evidence of plan.selectionEvidence) await adapters.assertSourceFileReadPlanCurrent(evidence);
  await adapters.assertSourceFileReadPlanCurrent(plan.readPlan);
  const byFile = new Map<string, import("@cchistory/source-adapters").CodexActivityEvidence>();
  for (const file of plan.readPlan.files) {
    const evidence = await adapters.inspectCodexActivityEvidence(plan.readPlan, file);
    work.inventoryFiles++; work.inventoryBytesRead += evidence.bytesRead; work.inventoryRecordsDecoded += evidence.recordsDecoded;
    byFile.set(file, evidence); guard.assertHealthy();
    if (!evidence.supported || hasSessionFamilyLinkTool(evidence.toolNames)) {
      work.fallbackReason = evidence.reason ?? "family_link_tool"; return undefined;
    }
  }
  const groups = plan.groups.map(group => ({ group, evidence: group.files.map(file => byFile.get(file)!) }));
  if (groups.some(g => new Set(g.evidence.map(e => e.sessionId)).size !== 1)
    || new Set(groups.map(g => g.evidence[0]?.sessionId)).size !== groups.length) {
    work.fallbackReason = "group_identity_mismatch"; return undefined;
  }
  const ranked = groups.map(g => ({ group: g.group, bound: g.evidence.reduce((max, e) => e.upperBound! > max ? e.upperBound! : max, "") }))
    .sort((a, b) => b.bound.localeCompare(a.bound));
  await adapters.assertSourceFileReadPlanCurrent(plan.readPlan);
  return { groups: ranked.map(x => x.group), upperBounds: ranked.map(x => x.bound), query, stopped: false };
}

async function scanSourceWithCollector(
  source: SourceDefinition,
  options: ScanLiteHistoryOptions,
  contextMode: LiteContextMode,
  sourceAdapters: typeof import("@cchistory/source-adapters"),
  sourceFiles: readonly string[],
  readPlan: SourceFileReadPlan,
  selectSessionFiles = false,
  work?: QueryReadWork,
): Promise<{ host: Host; payload: LiveSourcePayload }> {
  if (selectSessionFiles) {
    sourceFiles = await sourceAdapters.selectSourceSessionFiles(source, sourceFiles, options.sessionRefs!);
    await sourceAdapters.assertSourceFileReadPlanCurrent(readPlan);
  }
  const probe = await sourceAdapters.runSourceProbe(work ? evidence => { work.canonicalInterpretations++; return interpretSessionEvidence(evidence); } : interpretSessionEvidence,
    {
      ...buildProbeOptions(source, options),
      source_file_paths: { [source.id]: sourceFiles },
      source_file_plans: { [source.id]: readPlan },
    },
    [source],
  );
  const payload = probe.sources[0];
  if (!payload) {
    throw new Error(`Lite source probe produced no payload for ${source.display_name}.`);
  }
  if (work) { work.payloadFilesProcessed += sourceFiles.length; work.payloadRecordsProcessed += payload.source.total_records; }
  const compacted = compactSourcePayload(payload, contextMode, resolveContextTargets(options));
  return {
    host: probe.host,
    payload: options.sessionRefs?.length
      ? filterLiveSourcePayloadBySessions(compacted, options.sessionRefs)
      : compacted,
  };
}

async function prepareLogicalSessionGroups(
  source: SourceDefinition,
  options: ScanLiteHistoryOptions,
  sourceAdapters: typeof import("@cchistory/source-adapters"),
  inspectGroupFiles: (
    filePaths: readonly string[],
    includeWorkspaceMetadata: boolean,
  ) => Promise<import("@cchistory/source-adapters").SourceFileLogicalSessionMetadata[]>,
): Promise<{ files: readonly string[]; groups?: readonly LogicalSessionScanGroup[]; discoveredPrimaryFiles: number }> {
  const listedFiles = await sourceAdapters.listSourceFiles(source.platform, source.base_dir, options.limitFiles);
  let files = options.directoryScope
    ? listedFiles.filter((filePath) => sourceFileMayBeInDirectoryScope(
      sourceAdapters,
      source,
      filePath,
      options.directoryScope!,
    ))
    : listedFiles;
  if (options.sample) {
    if (options.directoryScope && files.length > 0) {
      const inspected = await inspectGroupFiles(files, true);
      files = files.filter((_filePath, index) => {
        const metadata = inspected[index]!;
        if (metadata.workingDirectoryState !== "known" || !metadata.workingDirectory) return true;
        return pathMatchesDirectoryScope(metadata.workingDirectory, options.directoryScope!);
      });
    }
    files = await selectSampleSourceFiles(source, files, options.sample.perSource, sourceAdapters);
  }
  if (files.length === 0) {
    return { files: [], discoveredPrimaryFiles: listedFiles.length };
  }

  const filesByGroup = new Map<string, {
    files: string[];
    workingDirectoryState: "known" | "absent" | "uncertain";
    workingDirectory?: string;
    relatedSessionRefs: Set<string>;
  }>();
  const requestedSessionRefs = options.sessionRefs?.filter((ref) => ref.trim().length > 0) ?? [];
  const inspectedFiles = await inspectGroupFiles(
    files,
    Boolean(options.directoryScope || requestedSessionRefs.length > 0),
  );
  if (inspectedFiles.some((metadata) => metadata.sessionKeyState === "uncertain")) {
    return { files, discoveredPrimaryFiles: listedFiles.length };
  }
  for (const [fileIndex, filePath] of files.entries()) {
    const metadata = inspectedFiles[fileIndex]!;
    const key = metadata.sessionKey;
    const group = filesByGroup.get(key);
    if (group) {
      group.files.push(filePath);
      for (const ref of metadata.relatedSessionRefs ?? []) group.relatedSessionRefs.add(ref);
      if (
        group.workingDirectoryState === "uncertain" ||
        metadata.workingDirectoryState === "uncertain" ||
        (
          group.workingDirectoryState === "known" &&
          metadata.workingDirectoryState === "known" &&
          group.workingDirectory !== metadata.workingDirectory
        )
      ) {
        group.workingDirectoryState = "uncertain";
        group.workingDirectory = undefined;
      } else if (group.workingDirectoryState === "absent" && metadata.workingDirectoryState === "known") {
        group.workingDirectoryState = metadata.workingDirectoryState;
        group.workingDirectory = metadata.workingDirectory;
      }
    } else {
      filesByGroup.set(key, {
        files: [filePath],
        workingDirectoryState: metadata.workingDirectoryState,
        workingDirectory: metadata.workingDirectory,
        relatedSessionRefs: new Set(metadata.relatedSessionRefs ?? []),
      });
    }
  }

  const directMatchingGroupEntries = [...filesByGroup.entries()]
    .filter(([groupKey]) => requestedSessionRefs.some((ref) => sessionRefMatchesGroup(ref, groupKey, source)));
  const relatedMatchingGroupEntries = [...filesByGroup.entries()]
    .filter(([, group]) => requestedSessionRefs.some((ref) =>
      [...group.relatedSessionRefs].some((relatedRef) => sessionRefMatchesGroup(ref, relatedRef, source))
    ));
  const companionRefs = new Set(
    directMatchingGroupEntries.flatMap(([, group]) => [...group.relatedSessionRefs]),
  );
  const matchingGroupEntries = [...filesByGroup.entries()].filter(([groupKey, group]) =>
    directMatchingGroupEntries.some(([directKey]) => directKey === groupKey) ||
    relatedMatchingGroupEntries.some(([relatedKey]) => relatedKey === groupKey) ||
    [...companionRefs].some((ref) => sessionRefMatchesGroup(ref, groupKey, source)) ||
    [...group.relatedSessionRefs].some((relatedRef) =>
      directMatchingGroupEntries.some(([directKey]) => sessionRefMatchesGroup(relatedRef, directKey, source))
    )
  );
  const targetGroups = requestedSessionRefs.length === 0 || matchingGroupEntries.length === 0
    ? [...filesByGroup.entries()]
    : matchingGroupEntries;
  const selectedGroupFiles = targetGroups
    .filter(([, group]) =>
      !options.directoryScope ||
      group.workingDirectoryState !== "known" ||
      !group.workingDirectory ||
      pathMatchesDirectoryScope(group.workingDirectory, options.directoryScope),
    )
    .map(([, group]) => ({
      files: group.files,
      targetSessionRefs: matchingGroupEntries.length > 0
        ? []
        : requestedSessionRefs.length > 0
          ? []
          : undefined,
    }));

  if (selectedGroupFiles.length === 0) {
    return { files: [], discoveredPrimaryFiles: listedFiles.length };
  }

  return { files, groups: selectedGroupFiles, discoveredPrimaryFiles: listedFiles.length };
}

async function scanLogicalSessionGroups(
  source: SourceDefinition,
  options: ScanLiteHistoryOptions,
  contextMode: LiteContextMode,
  sourceAdapters: typeof import("@cchistory/source-adapters"),
  plan: PreparedSourceScan,
  assessExpandedPlan: () => Promise<void>,
  work?: QueryReadWork,
  selection?: SelectiveGroupPlan,
): Promise<{ host: Host; payload: LiveSourcePayload }> {
  const selectedGroupFiles = selection?.groups ?? plan.groups!;
  const blobsById = new Map<string, SourceSyncPayload["blobs"][number]>();
  const candidatesById = new Map<string, SourceSyncPayload["candidates"][number]>();
  const sessionsById = new Map<string, SessionProjection>();
  const turnsById = new Map<string, UserTurnProjection>();
  const contextsByTurnId = new Map<string, TurnContextProjection>();
  const askTurnsById = new Map<string, SourceSyncPayload["ask_user_question_turns"][number]>();
  const sessionRelationFragments: SourceFragment[] = [];
  const familyInventories: Array<ReturnType<typeof familyInventoryFromPayload>> = [];
  const lossAudits: LossAuditRecord[] = [];
  const fileProcessingErrors: string[] = [];
  let totalRecords = 0;
  let totalFragments = 0;
  let totalAtoms = 0;
  let requiresSourceCollector = false;
  let forwardedSourceStart = false;
  let host: Host | undefined;

  for (const [groupIndex, group] of selectedGroupFiles.entries()) {
    const probe = await sourceAdapters.runSourceProbe(work ? evidence => { work.canonicalInterpretations++; return interpretSessionEvidence(evidence); } : interpretSessionEvidence,
      {
        ...buildProbeOptions(source, options, group.targetSessionRefs),
        source_file_paths: { [source.id]: group.files },
        source_file_plans: { [source.id]: plan.readPlan },
        on_progress: (event) => {
          if (event.stage === "source_start") {
            if (forwardedSourceStart) return;
            forwardedSourceStart = true;
          }
          if (event.stage === "source_done") return;
          if (event.stage === "file_error" && event.message) {
            fileProcessingErrors.push(event.message);
          }
          options.onProgress?.(event);
        },
      },
      [source],
    );
    host ??= probe.host;
    const groupPayload = probe.sources[0];
    if (!groupPayload) {
      throw new Error(`Lite source probe produced no payload for ${source.display_name}.`);
    }
    if (work) { work.payloadFilesProcessed += group.files.length; work.payloadRecordsProcessed += groupPayload.source.total_records; }
    totalRecords += groupPayload.source.total_records;
    totalFragments += groupPayload.source.total_fragments;
    totalAtoms += groupPayload.source.total_atoms;
    for (const blob of groupPayload.blobs) blobsById.set(blob.id, blob);
    for (const candidate of groupPayload.candidates) {
      if (candidate.candidate_kind === "project_observation") {
        candidatesById.set(candidate.id, candidate);
      }
    }
    for (const session of groupPayload.sessions) {
      if (sessionsById.has(session.id)) requiresSourceCollector = true;
      sessionsById.set(session.id, session);
    }
    for (const turn of groupPayload.turns) turnsById.set(turn.id, turn);
    for (const context of selectPayloadContexts(groupPayload, contextMode, resolveContextTargets(options))) {
      contextsByTurnId.set(context.turn_id, context);
    }
    for (const askTurn of groupPayload.ask_user_question_turns) askTurnsById.set(askTurn.id, askTurn);
    sessionRelationFragments.push(
      ...groupPayload.fragments.filter((fragment) => fragment.fragment_kind === "session_relation"),
    );
    familyInventories.push(familyInventoryFromPayload(
      groupPayload,
      flattenRelatedWorkIndex(buildSessionRelatedWorkIndex(groupPayload.sessions, groupPayload.fragments)),
    ));
    lossAudits.push(...groupPayload.loss_audits);
    if (selection && !requiresSourceCollector) {
      // Unexpected cross-session relationships invalidate the narrow independence proof.
      if (sessionRelationFragments.length || familyInventories.some(f => f.children.length > 0)) {
        if (work) work.fallbackReason = "derived_relationship";
        selection = undefined;
      } else {
        const turns = [...turnsById.values()].sort(compareTurnsByRecency);
        const sessions = orderSessionsByLastMessage([...sessionsById.values()], turns);
        const current = executeCanonicalQuery({ sessions, turns, related_work: [] }, selection.query, options.directoryScope);
        const cutoff = current.rows.at(-1)?.last_message_at;
        const nextBound = selection.upperBounds[groupIndex + 1];
        if (current.shown === selection.query.limit && typeof cutoff === "string" && nextBound !== undefined && nextBound < cutoff) {
          selection.stopped = true;
          if (work) work.skippedPrimaryFiles = selectedGroupFiles.slice(groupIndex + 1).reduce((n, g) => n + g.files.length, 0);
          break;
        }
      }
    }
  }

  if (requiresSourceCollector) {
    plan.readPlan = await sourceAdapters.createSourceFileReadPlan(source, plan.fallbackFiles!, options.safeMode ?? false);
    await assessExpandedPlan();
    await sourceAdapters.assertSourceFileReadPlanCurrent(plan.readPlan);
    if (selection) selection.stopped = false;
    if (work) work.fallbackReason = "duplicate_identity";
    return scanSourceWithCollector(source, options, contextMode, sourceAdapters, plan.readPlan.files, plan.readPlan, false, work);
  }
  if (!host) {
    throw new Error(`Lite logical-session scan produced no host for ${source.display_name}.`);
  }

  const sessions = [...sessionsById.values()];
  const turns = [...turnsById.values()];
  const firstError = fileProcessingErrors[0];
  const family = mergeSessionFamilyInventories(familyInventories);
  return {
    host,
    payload: {
      source: {
        id: source.id,
        slot_id: source.slot_id,
        family: source.family,
        platform: source.platform,
        display_name: source.display_name,
        base_dir: source.base_dir,
        host_id: host.id,
        last_sync: new Date().toISOString(),
        sync_status:
          sessions.length > 0 || turns.length > 0
            ? "healthy"
            : fileProcessingErrors.length > 0
              ? "error"
              : "stale",
        error_message: firstError
          ? `${firstError}${fileProcessingErrors.length > 1 ? ` (+${fileProcessingErrors.length - 1} more)` : ""}`
          : undefined,
        total_blobs: blobsById.size,
        total_records: totalRecords,
        total_fragments: totalFragments,
        total_atoms: totalAtoms,
        total_sessions: sessions.length,
        total_turns: turns.length,
      },
      blobs: [...blobsById.values()],
      candidates: [...candidatesById.values()],
      sessions,
      related_work: flattenRelatedWorkIndex(buildSessionRelatedWorkIndex(sessions, sessionRelationFragments)),
      session_contributions: family.contributions,
      delegated_children: family.children,
      turns,
      contexts: [...contextsByTurnId.values()],
      ask_user_question_turns: [...askTurnsById.values()],
      loss_audits: lossAudits,
    },
  };
}

async function selectSampleSourceFiles(
  source: SourceDefinition,
  files: readonly string[],
  perSource: number,
  sourceAdapters: typeof import("@cchistory/source-adapters"),
): Promise<string[]> {
  if (!Number.isInteger(perSource) || perSource < 1) return [];
  const ranked = await mapPool(files, SAMPLE_RANK_CONCURRENCY, async (filePath) => {
    if (source.platform === "grok") {
      const catalog = await sourceAdapters.inspectGrokChatHistoryCatalog(filePath);
      return {
        filePath,
        rank: catalog.lastActiveAt ?? await fileModifiedAt(filePath),
        parentPath: grokSampleParentPath(filePath, files, catalog, sourceAdapters),
      };
    }
    return {
      filePath,
      rank: await fileModifiedAt(filePath),
      parentPath: await cheapSampleParentPath(source.platform, filePath, files, sourceAdapters),
    };
  });
  ranked.sort((left, right) => right.rank.localeCompare(left.rank) || left.filePath.localeCompare(right.filePath));
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const entry of ranked) {
    const target = entry.parentPath ?? entry.filePath;
    if (seen.has(target)) continue;
    seen.add(target);
    selected.push(target);
    if (selected.length >= perSource) break;
  }
  return selected;
}

async function fileModifiedAt(filePath: string): Promise<string> {
  try {
    return (await stat(filePath)).mtime.toISOString();
  } catch {
    return "1970-01-01T00:00:00.000Z";
  }
}

function grokSampleParentPath(
  filePath: string,
  files: readonly string[],
  catalog: { isDelegatedChild: boolean; parentSessionId?: string },
  sourceAdapters: typeof import("@cchistory/source-adapters"),
): string | undefined {
  if (!catalog.isDelegatedChild || !catalog.parentSessionId) return undefined;
  const parentPath = sourceAdapters.resolveGrokSiblingSessionChatHistory(filePath, catalog.parentSessionId);
  return parentPath && files.includes(parentPath) ? parentPath : undefined;
}

async function cheapSampleParentPath(
  platform: SourcePlatform,
  filePath: string,
  files: readonly string[],
  sourceAdapters: typeof import("@cchistory/source-adapters"),
): Promise<string | undefined> {
  const normalized = filePath.replace(/\\/gu, "/");
  const subagentMatch = normalized.match(/^(.*)\/([^/]+)\/subagents\/[^/]+\.jsonl$/u);
  if (platform === "claude_code" && subagentMatch) {
    const parentPath = `${subagentMatch[1]}/${subagentMatch[2]}.jsonl`;
    return files.includes(parentPath) ? parentPath : undefined;
  }
  if (platform === "codex") {
    const metadata = await sourceAdapters.inspectSourceFileLogicalSessionMetadata(platform, filePath, {
      includeWorkspaceMetadata: false,
    });
    const parentRef = metadata.relatedSessionRefs?.[0];
    if (!parentRef) return undefined;
    const native = parentRef.replace(/^sess:codex:/u, "").toLowerCase();
    return files.find((candidate) => candidate.replace(/\\/gu, "/").toLowerCase().includes(native));
  }
  return undefined;
}

function sourceFileMayBeInDirectoryScope(
  sourceAdapters: typeof import("@cchistory/source-adapters"),
  source: SourceDefinition,
  filePath: string,
  directoryScope: string,
): boolean {
  const layout = sourceAdapters.sourceFileMayMatchDirectoryScope({
    platform: source.platform,
    baseDir: source.base_dir,
    filePath,
    directoryScope,
  });
  if (layout === "no") return false;
  if (layout === "yes") return true;
  const preview = sourceAdapters.previewSourceFileWorkingDirectory(source.platform, filePath);
  if (preview.state !== "known" || !preview.workingDirectory) return true;
  return pathMatchesDirectoryScope(preview.workingDirectory, directoryScope);
}

function buildProbeOptions(
  source: SourceDefinition,
  options: ScanLiteHistoryOptions,
  targetSessionRefs: readonly string[] | undefined = options.sessionRefs,
) {
  return {
    source_ids: [source.id],
    read_budget: options.readBudget,
    target_session_refs: targetSessionRefs,
    limit_files_per_source: options.limitFiles,
    safe_mode: options.safeMode,
    on_progress: options.onProgress,
  };
}

function compactSourcePayload(
  payload: SourceSyncPayload,
  contextMode: LiteContextMode,
  contextTargets: readonly LiteContextTarget[] = [],
): LiveSourcePayload {
  const relatedWork = flattenRelatedWorkIndex(buildSessionRelatedWorkIndex(payload.sessions, payload.fragments));
  const family = familyInventoryFromPayload(payload, relatedWork);
  return {
    source: payload.source,
    blobs: payload.blobs,
    candidates: payload.candidates.filter((candidate) => candidate.candidate_kind === "project_observation"),
    sessions: payload.sessions,
    related_work: relatedWork,
    session_contributions: family.contributions,
    delegated_children: family.children,
    turns: payload.turns,
    contexts: selectPayloadContexts(payload, contextMode, contextTargets),
    ask_user_question_turns: payload.ask_user_question_turns,
    loss_audits: payload.loss_audits,
  };
}

function familyInventoryFromPayload(
  payload: {
    sessions: SourceSyncPayload["sessions"];
    turns: SourceSyncPayload["turns"];
    contexts: SourceSyncPayload["contexts"];
    blobs: SourceSyncPayload["blobs"];
    records?: SourceSyncPayload["records"];
    atoms?: SourceSyncPayload["atoms"];
    fragments?: readonly SourceFragment[];
  },
  relatedWork: readonly SessionRelatedWorkProjection[],
) {
  return buildSessionFamilyInventory({
    sessions: payload.sessions,
    turns: payload.turns,
    contexts: payload.contexts,
    related_work: relatedWork,
    fragments: payload.fragments,
    blobs: payload.blobs,
    records: payload.records,
    atoms: payload.atoms,
  });
}

function familyInventoryForLivePayload(payload: LiveSourcePayload) {
  if (payload.session_contributions !== undefined && payload.delegated_children !== undefined) {
    return {
      contributions: [...payload.session_contributions],
      children: [...payload.delegated_children],
    };
  }
  return familyInventoryFromPayload(
    {
      sessions: payload.sessions,
      turns: payload.turns,
      contexts: payload.contexts,
      blobs: payload.blobs,
      records: payload.records ?? [],
      atoms: payload.atoms ?? [],
      fragments: payload.fragments ?? [],
    },
    materializeRelatedWork(payload),
  );
}

function selectPayloadContexts(
  payload: Pick<SourceSyncPayload, "sessions" | "turns" | "contexts">,
  contextMode: LiteContextMode,
  contextTargets: readonly LiteContextTarget[] = [],
): TurnContextProjection[] {
  if (contextMode === "full") return [...payload.contexts];
  if (contextMode === "none") return [];
  if (contextTargets.length === 0) throw new Error("matching context mode requires at least one context target.");

  const turnIds = new Set<string>();
  for (const contextTarget of contextTargets) {
    if (contextTarget.kind === "turn") {
      for (const turn of payload.turns) {
        if (turn.id === contextTarget.ref || turn.id.startsWith(contextTarget.ref)) turnIds.add(turn.id);
      }
      continue;
    }
    const sessionIds = new Set(
      payload.sessions
        .filter((session) => sessionPotentiallyMatchesRef(session, contextTarget.ref))
        .map((session) => session.id),
    );
    for (const turn of payload.turns) if (sessionIds.has(turn.session_id)) turnIds.add(turn.id);
  }
  return payload.contexts.filter((context) => turnIds.has(context.turn_id));
}

function resolveContextTargets(options: Pick<ScanLiteHistoryOptions, "contextTarget" | "contextTargets">): LiteContextTarget[] {
  const targets = [...(options.contextTargets ?? []), ...(options.contextTarget ? [options.contextTarget] : [])];
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.kind}:${target.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sessionPotentiallyMatchesRef(session: SessionProjection, ref: string): boolean {
  const normalizedRef = normalizeLookup(ref);
  if (!normalizedRef) return false;
  const exactAliases = [
    session.source_session_id,
    session.title,
    session.working_directory,
    path.basename(session.working_directory ?? ""),
  ];
  return (
    session.id === ref ||
    session.id.startsWith(ref) ||
    exactAliases.some((alias) => normalizeLookup(alias) === normalizedRef) ||
    normalizeLookup(session.source_session_id).startsWith(normalizedRef)
  );
}

function exactCanonicalSessionPlatforms(refs: readonly string[]): Set<SourcePlatform> {
  if (refs.length === 0) return new Set();
  const platforms = new Set<SourcePlatform>();
  for (const ref of refs) {
    const match = ref.match(/^sess:([^:]+):.+$/u);
    if (!match?.[1]) return new Set();
    platforms.add(match[1] as SourcePlatform);
  }
  return platforms;
}

function filterLiveSourcePayloadBySessions(
  payload: LiveSourcePayload,
  sessionRefs: readonly string[],
): LiveSourcePayload {
  const selectedIds = new Set(
    payload.sessions
      .filter((session) => sessionRefs.some((ref) => sessionMatchesRequestedRef(session, ref)))
      .map((session) => session.id),
  );
  const familySessionIds = expandDelegatedFamilySessionIds(payload, selectedIds);
  const sessions = payload.sessions.filter((session) => familySessionIds.has(session.id));
  const sessionIds = new Set(sessions.map((session) => session.id));
  const turns = payload.turns.filter((turn) => sessionIds.has(turn.session_id));
  const turnIds = new Set(turns.map((turn) => turn.id));
  const relatedWork = payload.related_work?.filter((entry) => sessionIds.has(entry.query_session_ref));
  return {
    ...payload,
    sessions,
    turns,
    candidates: payload.candidates.filter((candidate) => sessionIds.has(candidate.session_ref)),
    contexts: payload.contexts.filter((context) => turnIds.has(context.turn_id)),
    ask_user_question_turns: payload.ask_user_question_turns.filter((turn) => sessionIds.has(turn.session_id)),
    related_work: relatedWork,
    session_contributions: payload.session_contributions?.filter((entry) => familySessionIds.has(entry.session_ref)),
    delegated_children: payload.delegated_children?.filter((entry) =>
      familySessionIds.has(entry.parent_session_ref) ||
      (entry.child_session_ref !== undefined && familySessionIds.has(entry.child_session_ref)),
    ),
  };
}

function missingDelegatedChildSessionRefs(
  payloads: readonly LiveSourcePayload[],
  sessionRefs: readonly string[],
): string[] {
  const missing = new Set<string>();
  for (const payload of payloads) {
    const selectedIds = new Set(
      payload.sessions
        .filter((session) => sessionRefs.some((ref) => sessionMatchesRequestedRef(session, ref)))
        .map((session) => session.id),
    );
    for (const ref of expandDelegatedFamilySessionIds(payload, selectedIds)) {
      if (payload.sessions.some((session) => session.id === ref || session.source_session_id === ref)) {
        continue;
      }
      missing.add(ref);
    }
  }
  return [...missing];
}

function expandDelegatedFamilySessionIds(
  payload: LiveSourcePayload,
  selectedIds: ReadonlySet<string>,
): Set<string> {
  const familySessionIds = new Set(selectedIds);
  const add = (ref: string | undefined) => {
    if (!ref) return;
    familySessionIds.add(ref);
    for (const session of payload.sessions) {
      if (session.id === ref || session.source_session_id === ref) familySessionIds.add(session.id);
    }
  };
  const family = familyInventoryForLivePayload(payload);
  let grew = true;
  while (grew) {
    const before = familySessionIds.size;
    for (const child of family.children) {
      if (familySessionIds.has(child.parent_session_ref)) add(child.child_session_ref);
    }
    for (const entry of payload.related_work ?? []) {
      if (entry.relation_kind !== "delegated_session") continue;
      if (entry.parent_session_ref && familySessionIds.has(entry.parent_session_ref)) {
        add(entry.child_session_ref);
      }
    }
    grew = familySessionIds.size > before;
  }
  return familySessionIds;
}

function sessionMatchesRequestedRef(
  session: { id: string; source_session_id?: string },
  ref: string,
): boolean {
  if (!ref) return false;
  if (ref === session.id || ref === session.source_session_id) return true;
  if (/^sess:[^:]+:./u.test(ref) && session.id.startsWith(ref)) return true;
  if (ref.startsWith("sess:")) return false;
  return Boolean(
    session.source_session_id?.startsWith(ref) ||
    session.id.startsWith(ref) ||
    session.id.endsWith(`:${ref}`),
  );
}

function sessionRefMatchesGroup(ref: string, groupKey: string, source: SourceDefinition): boolean {
  const expected = `sess:${source.platform}:`;
  const canonicalGroup = groupKey.startsWith(expected) ? groupKey : `${expected}${groupKey}`;
  const nativeGroup = canonicalGroup.startsWith(expected) ? canonicalGroup.slice(expected.length) : groupKey;
  if (
    ref === groupKey ||
    ref === canonicalGroup ||
    ref === nativeGroup ||
    ref.endsWith(`:${groupKey}`) ||
    ref.endsWith(`:${nativeGroup}`) ||
    groupKey.endsWith(`:${ref}`)
  ) {
    return true;
  }
  if (ref.startsWith("sess:")) {
    if (!ref.startsWith(expected) || ref.length <= expected.length) return false;
    const nativeRef = ref.slice(expected.length);
    return canonicalGroup.startsWith(ref) || nativeGroup.startsWith(nativeRef);
  }
  return ref.length > 0 && (nativeGroup.startsWith(ref) || groupKey.startsWith(ref));
}

function materializeRelatedWork(payload: LiveSourcePayload): SessionRelatedWorkProjection[] {
  if (payload.related_work) return [...payload.related_work];
  return flattenRelatedWorkIndex(buildSessionRelatedWorkIndex(payload.sessions, payload.fragments ?? []));
}

function flattenRelatedWorkIndex(
  index: ReadonlyMap<string, readonly SessionRelatedWorkProjection[]>,
): SessionRelatedWorkProjection[] {
  return [...index.values()].flatMap((entries) => [...entries]);
}

export async function resolveLiteSources(options: ResolveLiteSourcesOptions = {}): Promise<SourceDefinition[]> {
  const { getDefaultSourcesForHost } = await import("@cchistory/source-adapters");
  const sourceRoots = options.sourceRoots ?? [];
  const sourceRefs = options.sourceRefs ?? [];
  const discoveryOptions = {
    homeDir: options.homeDir,
    hostname: options.hostname,
    platform: options.platform,
    appDataDir: options.appDataDir,
  };
  const discoveredRoster = getDefaultSourcesForHost(discoveryOptions);
  const completeRoster = getDefaultSourcesForHost({
    ...discoveryOptions,
    includeMissing: true,
  });
  const hostId = deriveHostId(options.hostname ?? os.hostname());
  const overrideRefs = new Set<string>();
  const overridesBySlotId = new Map<string, SourceDefinition>();

  for (const override of sourceRoots) {
    if (overrideRefs.has(override.sourceRef)) {
      throw new Error(`Duplicate --source-root for ${override.sourceRef}.`);
    }
    overrideRefs.add(override.sourceRef);
    await assertLiteSourceRoot(override.baseDir, { homeDir: options.homeDir });
    const source = findSource(completeRoster, override.sourceRef);
    if (!source) {
      throw new Error(formatUnknownLiteSourceAdapter(override.sourceRef, completeRoster));
    }
    if (overridesBySlotId.has(source.slot_id)) {
      throw new Error(`Duplicate --source-root for ${source.platform}.`);
    }
    const baseDir = path.resolve(override.baseDir);
    overridesBySlotId.set(source.slot_id, {
      ...source,
      base_dir: baseDir,
      id: deriveSourceInstanceId({
        host_id: hostId,
        slot_id: source.slot_id,
        base_dir: baseDir,
      }),
    });
  }

  const resolvedRoster = completeRoster.map((source) => overridesBySlotId.get(source.slot_id) ?? source);
  let result: SourceDefinition[];
  if (sourceRefs.length === 0) {
    const discoveredSlots = new Set(discoveredRoster.map((source) => source.slot_id));
    result = resolvedRoster.filter(
      (source) => discoveredSlots.has(source.slot_id) || overridesBySlotId.has(source.slot_id),
    );
  } else {
    const selected: SourceDefinition[] = [];
    for (const ref of sourceRefs) {
      const source = findSource(resolvedRoster, ref);
      if (!source) {
        throw new Error(formatUnknownLiteSourceAdapter(ref, completeRoster));
      }
      if (!selected.some((entry) => entry.id === source.id)) {
        selected.push(source);
      }
    }
    result = selected;
  }

  for (const source of result) {
    await assertLiteSourceRoot(source.base_dir, { homeDir: options.homeDir });
  }
  return result;
}

export async function assertLiteSourceRoot(
  inputPath: string,
  options: { homeDir?: string } = {},
): Promise<void> {
  const requestedPath = path.resolve(inputPath);
  const resolved = await resolveExistingRealPath(requestedPath);
  const normalized = normalizeLocalPathIdentity(resolved) ?? resolved.replace(/\\/g, "/");
  // Case-insensitive on purpose: macOS/Windows filesystems resolve `.CCHISTORY`
  // and `CCHistory.sqlite` to the Full store too.
  const lowerNormalized = normalized.toLowerCase();
  const segments = lowerNormalized.split("/").filter(Boolean);
  if (segments.includes(".cchistory") || path.basename(lowerNormalized) === "cchistory.sqlite") {
    throw new Error(`Full store paths are not Lite sources: ${resolved}`);
  }

  const canonicalFullStoreRoot = path.resolve(options.homeDir ?? os.homedir(), ".cchistory");
  const resolvedFullStoreRoot = await resolveExistingRealPath(canonicalFullStoreRoot);
  if (
    await pathExists(canonicalFullStoreRoot) &&
    [requestedPath, resolved].some((sourceRoot) =>
      [canonicalFullStoreRoot, resolvedFullStoreRoot].some((fullStoreRoot) =>
        pathsOverlap(sourceRoot, fullStoreRoot),
      ),
    )
  ) {
    throw new Error(`Source roots overlapping the Full store are not allowed in Lite: ${resolved}`);
  }

  if (await pathExists(path.join(resolved, "cchistory.sqlite"))) {
    throw new Error(`Full store paths are not Lite sources: ${resolved}`);
  }
  if (
    await pathExists(path.join(resolved, "manifest.json")) &&
    await pathExists(path.join(resolved, "payloads"))
  ) {
    throw new Error(`Full bundle paths are not Lite sources: ${resolved}`);
  }
}

function formatUnknownLiteSourceAdapter(ref: string, roster: readonly SourceDefinition[]): string {
  const slots = [...new Set(roster.map((source) => source.slot_id))].sort();
  return `Unknown Lite source adapter: ${ref}. Registered slots: ${slots.join(", ")}. ` +
    `--source-root overrides an adapter's default root (for example ~/.claude/projects), not a single project folder.`;
}

function findSource(sources: SourceDefinition[], ref: string): SourceDefinition | undefined {
  return sources.find(
    (source) =>
      source.id === ref ||
      source.slot_id === ref ||
      source.platform === (ref as SourcePlatform),
  );
}

function resolveUnique<T>(
  values: readonly T[],
  ref: string,
  getId: (value: T) => string,
  getAliases: (value: T) => readonly (string | undefined)[],
  getPrefixAliases: (value: T) => readonly (string | undefined)[] = () => [],
): T | undefined {
  const normalizedRef = normalizeLookup(ref);
  // A blank ref would otherwise match every alias-less object (and every id
  // prefix), returning an arbitrary object or a confusing "Ambiguous" error.
  if (normalizedRef === "") return undefined;
  const exact = values.filter((value) => {
    if (getId(value) === ref) return true;
    return getAliases(value).some((alias) => normalizeLookup(alias) === normalizedRef);
  });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new AmbiguousReferenceError(ref, exact.map(getId), false);
  }

  const prefix = values.filter(
    (value) =>
      getId(value).startsWith(ref) ||
      getPrefixAliases(value).some((alias) => normalizeLookup(alias).startsWith(normalizedRef)),
  );
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    throw new AmbiguousReferenceError(ref, prefix.map(getId), true);
  }
  return undefined;
}

function normalizeLookup(value: string | undefined): string {
  return (normalizeLocalPathIdentity(value) ?? value ?? "").trim().toLowerCase();
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveExistingRealPath(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath);
  } catch {
    return targetPath;
  }
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(leftPath: string, rightPath: string): boolean {
  return isPathWithin(leftPath, rightPath) || isPathWithin(rightPath, leftPath);
}

// Mutates the input so it matches what JSON.stringify would produce: arrays
// have undefined slots replaced with null and object keys with undefined
// values are deleted. This keeps Lite's in-memory snapshot byte-identical to
// what Full persists and reads back from SQLite payload_json.
function normalizeJsonShapeForJsonOutputMutating<T>(value: T): T {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === undefined) {
        value[index] = null;
      } else {
        normalizeJsonShapeForJsonOutputMutating(value[index]);
      }
    }
    return value;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) {
        delete (value as Record<string, unknown>)[key];
      } else {
        normalizeJsonShapeForJsonOutputMutating(child);
      }
    }
  }
  return value;
}

export { compileSql, compileSqlRequest, parseSqlRequest, QueryValidationError, SQL_REQUEST_SCHEMA, SQL_RESULT_SCHEMA, MAX_SQL_BYTES, MAX_QUERY_REQUEST_BYTES } from "./sql-query.js";
export type { SqlRequest, SqlOperation, CompiledSqlRequest } from "./sql-query.js";

export type { LiveQueryRead, QueryReadWork } from "./selective-query.js";
