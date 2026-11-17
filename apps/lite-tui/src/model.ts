/**
 * Read model for the Lite TUI.
 *
 * Wraps one ephemeral {@link LiveHistorySnapshot} in the project-first shape
 * the browser panes need. It derives nothing new: ordering, linkage, search,
 * and usage all come from the shared canonical pipeline, so Lite and Full
 * answer the same question the same way.
 */

import type {
  ModelCostMultipliers,
  ProjectIdentity,
  SessionProjection,
  SessionRelatedWorkProjection,
  SourceStatus,
  TurnContextProjection,
  TurnSearchResult,
  UsageBreakdownSnapshot,
  UsageMatrixSort,
  UsagePricingConfig,
  UsageStatsDimension,
  UsageStatsOverview,
  UsageStatsRollup,
  UsageTimeBucket,
  UsageTimePreset,
  UsageWeekMode,
  UserTurnProjection,
} from "@cchistory/domain";
import type { LiveHistorySnapshot, UsageFilters } from "@cchistory/live-runtime";
import {
  BoundedCache,
  mergeUsagePricingConfigs,
  resolveEffectiveQuotaLimitUsd,
  resolveTimeWindowBounds,
  resolveUsageTimezone,
} from "@cchistory/live-runtime";

export const UNLINKED_PROJECT_KEY = "__unlinked__";
const CONTEXT_OVERLAY_MAX_ENTRIES = 64;
const CONTEXT_OVERLAY_MAX_BYTES = 16 * 1024 * 1024;

export interface LiteTurnEntry {
  turn: UserTurnProjection;
  session?: SessionProjection;
}

export interface LiteProjectEntry {
  key: string;
  displayName: string;
  /** Absent for the synthetic unlinked bucket. */
  project?: ProjectIdentity;
  linkageState: string;
  workspacePath?: string;
  sessionCount: number;
  turnCount: number;
  lastActivityAt?: string;
  turns: LiteTurnEntry[];
}

export interface LiteSessionEntry {
  session: SessionProjection;
  sourceName: string;
  turns: LiteTurnEntry[];
  relatedWorkCount: number;
}

export interface LiteSourceHealth {
  counts: { healthy: number; stale: number; error: number };
  sources: SourceStatus[];
}

export interface LiteCounts {
  sources: number;
  projects: number;
  sessions: number;
  turns: number;
}

export interface LiteSearchPage {
  results: TurnSearchResult[];
  total: number;
}

export class LiteBrowserModel {
  readonly snapshot: LiveHistorySnapshot;
  readonly projects: LiteProjectEntry[];
  /** Top-level sessions plus any explicitly requested session detail. */
  readonly sessions: LiteSessionEntry[];
  readonly counts: LiteCounts;
  readonly sourceHealth: LiteSourceHealth;
  readonly pricingConfig?: UsagePricingConfig;
  readonly quotaLimitUsd?: number;
  readonly defaultTimezone: string;

  private readonly sessionsById: Map<string, SessionProjection>;
  /** Bounded cache for contexts fetched on demand after the initial scan. */
  private readonly contextOverlay = new BoundedCache<string, TurnContextProjection>(
    CONTEXT_OVERLAY_MAX_ENTRIES,
    CONTEXT_OVERLAY_MAX_BYTES,
    estimateContextBytes,
  );
  /** Holds contexts from the latest targeted load that individually exceed the overlay budget. */
  private readonly transientOversizedContexts = new Map<string, TurnContextProjection>();
  private readonly searchCache = new BoundedCache<string, LiteSearchPage>(32, 20_000,
    (page, query) => page.results.reduce((total, row) => total + 1 + row.highlights.length * 2, Math.ceil(query.length / 128)));

  constructor(
    snapshot: LiveHistorySnapshot,
    options: {
      includeSessionRefs?: readonly string[];
      pricingConfig?: UsagePricingConfig;
      quotaLimitUsd?: number;
      timezone?: string;
    } = {},
  ) {
    this.snapshot = snapshot;
    this.pricingConfig = options.pricingConfig;
    this.quotaLimitUsd = options.quotaLimitUsd;
    this.defaultTimezone = resolveUsageTimezone(options.timezone ?? options.pricingConfig?.timezone);
    const resolvedSessions = snapshot.listResolvedSessions();
    const sessions = snapshot.listTopLevelSessions();
    const includedIds = new Set(sessions.map((session) => session.id));
    for (const ref of options.includeSessionRefs ?? []) {
      const session = snapshot.getSession(ref);
      if (session && !includedIds.has(session.id)) {
        sessions.push(session);
        includedIds.add(session.id);
      }
    }
    this.sessionsById = new Map(resolvedSessions.map((session) => [session.id, session]));
    this.projects = buildProjectEntries(snapshot, this.sessionsById);
    const sourceNames = new Map(snapshot.listSources().map((source) => [source.id, source.display_name]));
    const paneSessions: LiteSessionEntry[] = [];
    for (const session of sessions) {
      const relatedWorkCount = snapshot.listSessionRelatedWork(session.id).length;
      const requested = options.includeSessionRefs?.some((ref) => snapshot.getSession(ref)?.id === session.id);
      if (session.turn_count === 0 && relatedWorkCount === 0 && !requested) continue;
      paneSessions.push({
        session,
        sourceName: sourceNames.get(session.source_id) ?? session.source_platform,
        turns: snapshot.listSessionTurns(session.id).map((turn) => ({ turn, session })),
        relatedWorkCount,
      });
    }
    this.sessions = paneSessions;
    this.counts = {
      sources: snapshot.listSources().length,
      projects: this.projects.filter((entry) => entry.project).length,
      sessions: paneSessions.length,
      turns: snapshot.listResolvedTurns().length,
    };
    this.sourceHealth = buildSourceHealth(snapshot.listSources());
  }

  getSession(sessionId: string): SessionProjection | undefined {
    return this.sessionsById.get(sessionId);
  }

  /** All turns of one session, chronologically, as browser entries. */
  listSessionTurns(sessionId: string): LiteTurnEntry[] {
    return this.snapshot
      .listSessionTurns(sessionId)
      .map((turn) => ({ turn, session: this.sessionsById.get(turn.session_id) }));
  }

  getSessionRelatedWork(sessionId: string): SessionRelatedWorkProjection[] {
    return this.snapshot.listSessionRelatedWork(sessionId);
  }

  getTurnContext(turnId: string): TurnContextProjection | undefined {
    return (
      this.snapshot.getTurnContext(turnId) ??
      this.contextOverlay.get(turnId) ??
      this.transientOversizedContexts.get(turnId)
    );
  }

  /**
   * Record contexts fetched by a targeted rescan. Never replaces context that
   * the base snapshot already carries, while updating stale overlay entries
   * from earlier on-demand loads within bounded memory.
   */
  putContexts(contexts: readonly TurnContextProjection[]): void {
    if (contexts.length === 0) return;
    this.transientOversizedContexts.clear();
    for (const context of contexts) {
      if (this.snapshot.getTurnContext(context.turn_id)) continue;
      if (estimateContextBytes(context, context.turn_id) <= CONTEXT_OVERLAY_MAX_BYTES) {
        this.contextOverlay.set(context.turn_id, context);
      } else {
        this.transientOversizedContexts.set(context.turn_id, context);
      }
    }
  }

  hasContext(turnId: string): boolean {
    return this.getTurnContext(turnId) !== undefined;
  }

  /**
   * Every ranked match for `query`.
   *
   * The snapshot ranks the whole corpus once and memoizes it, so asking for
   * all rows costs one array slice. The TUI needs the full set to group hits
   * by project the way the Full TUI does.
   */
  searchAll(query: string): LiteSearchPage {
    const cached = this.searchCache.get(query);
    if (cached) return cached;
    const page = this.snapshot.search({ query, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    this.searchCache.set(query, page);
    return page;
  }

  getUsageOverview(): UsageStatsOverview {
    return this.snapshot.getUsageOverview();
  }

  getUsageRollup(dimension: UsageStatsDimension): UsageStatsRollup {
    return this.snapshot.getUsageRollup(dimension);
  }

  getUsageBreakdown(options: {
    timePreset?: UsageTimePreset;
    timeBucket?: UsageTimeBucket;
    weekMode?: UsageWeekMode;
    timezone?: string;
    nowMs?: number;
    projectIds?: readonly string[];
    models?: readonly string[];
    sourceIds?: readonly string[];
    timeKeys?: readonly string[];
    matrixDimensions?: readonly UsageStatsDimension[];
    sortBy?: UsageMatrixSort;
    customAliases?: Readonly<Record<string, string>>;
    multiplierOverrides?: Readonly<Record<string, ModelCostMultipliers>>;
    quotaUsdOverride?: number;
  } = {}): UsageBreakdownSnapshot {
    const timeZone = resolveUsageTimezone(options.timezone ?? this.defaultTimezone);
    const weekMode = options.weekMode ?? this.pricingConfig?.quota?.week_mode ?? "rolling_7d";
    const timePreset = options.timePreset ?? "all";
    const timeBucket = options.timeBucket ?? "day";
    const nowMs = options.nowMs ?? Date.now();
    const bounds = resolveTimeWindowBounds(timePreset, {
      timezone: timeZone,
      week_mode: weekMode,
      week_start_day: this.pricingConfig?.quota?.week_start_day,
      week_reset_hour: this.pricingConfig?.quota?.week_reset_hour,
      now_ms: nowMs,
    });
    const effectiveQuotaUsd = options.quotaUsdOverride ?? this.quotaLimitUsd;
    const effectivePricing = mergeUsagePricingConfigs(this.pricingConfig, {
      schema: "cchistory-lite-pricing/v1",
      timezone: timeZone,
      aliases: options.customAliases ? { ...options.customAliases } : undefined,
      multipliers: options.multiplierOverrides ? { ...options.multiplierOverrides } : undefined,
      quota: {
        week_mode: weekMode,
        ...(effectiveQuotaUsd !== undefined ? { custom_usd: effectiveQuotaUsd } : {}),
      },
    });
    const filters: UsageFilters = {
      project_ids: options.projectIds?.length ? [...options.projectIds] : undefined,
      models: options.models?.length ? [...options.models] : undefined,
      source_ids: options.sourceIds?.length ? [...options.sourceIds] : undefined,
      time_keys: options.timeKeys?.length ? [...options.timeKeys] : undefined,
      time_dimension: timeBucket,
      time_preset: timePreset,
      timezone: timeZone,
      week_mode: weekMode,
      now_ms: nowMs,
      after_ts: bounds.after_ts,
      before_ts: bounds.before_ts,
      after_date: bounds.after_date,
      before_date: bounds.before_date,
      pricing: effectivePricing,
      quota_limit_usd: resolveEffectiveQuotaLimitUsd(effectivePricing, timePreset, effectiveQuotaUsd),
    };
    return this.snapshot.getUsageBreakdown({
      filters,
      time_dimension: timeBucket,
      matrix_dimensions: options.matrixDimensions ?? ["project", "model", "source", timeBucket],
      sort_by: options.sortBy ?? "adjusted_cost",
    });
  }
}

function buildProjectEntries(
  snapshot: LiveHistorySnapshot,
  sessionsById: Map<string, SessionProjection>,
): LiteProjectEntry[] {
  const entries: LiteProjectEntry[] = [];
  const linkedTurnIds = new Set<string>();

  for (const project of snapshot.listProjects()) {
    const turns = snapshot.listProjectTurns(project.project_id);
    for (const turn of turns) linkedTurnIds.add(turn.id);
    entries.push({
      key: project.project_id,
      displayName: project.display_name,
      project,
      linkageState: project.linkage_state,
      workspacePath: project.primary_workspace_path ?? project.repo_root,
      sessionCount: new Set(turns.map((turn) => turn.session_id)).size,
      turnCount: turns.length,
      lastActivityAt: project.project_last_activity_at,
      turns: turns.map((turn) => ({ turn, session: sessionsById.get(turn.session_id) })),
    });
  }

  const unlinkedTurns = snapshot.listResolvedTurns().filter((turn) => !linkedTurnIds.has(turn.id));
  if (unlinkedTurns.length > 0) {
    entries.push({
      key: UNLINKED_PROJECT_KEY,
      displayName: "Unlinked / candidate-only",
      linkageState: "unlinked",
      sessionCount: new Set(unlinkedTurns.map((turn) => turn.session_id)).size,
      turnCount: unlinkedTurns.length,
      lastActivityAt: snapshot.getLatestTurnActivityAt(unlinkedTurns),
      turns: unlinkedTurns.map((turn) => ({ turn, session: sessionsById.get(turn.session_id) })),
    });
  }

  return entries;
}

function estimateContextBytes(context: TurnContextProjection, turnId: string): number {
  let bytes = 64 + 2 * turnId.length;
  for (const sys of context.system_messages) {
    bytes += 64 + 2 * sys.content.length;
  }
  for (const reply of context.assistant_replies) {
    bytes += 64 + 2 * (reply.content.length + reply.content_preview.length);
  }
  for (const call of context.tool_calls) {
    bytes += 64 + 2 * (call.input_summary.length + (call.output?.length ?? 0) + (call.output_preview?.length ?? 0));
  }
  return bytes;
}

function buildSourceHealth(sources: SourceStatus[]): LiteSourceHealth {
  const counts = { healthy: 0, stale: 0, error: 0 };
  for (const source of sources) {
    if (source.sync_status === "healthy") counts.healthy += 1;
    else if (source.sync_status === "stale") counts.stale += 1;
    else counts.error += 1;
  }
  return { counts, sources };
}
