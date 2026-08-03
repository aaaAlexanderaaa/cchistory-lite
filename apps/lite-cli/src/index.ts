#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { normalizeLocalPathIdentity } from "@cchistory/domain";
import type {
  LossAuditRecord,
  ProjectIdentity,
  SessionProjection,
  SessionRelatedWorkProjection,
  SourceStatus,
  TurnContextProjection,
  UsageStatsDimension,
  UserTurnProjection,
} from "@cchistory/domain";
import {
  runWithAdaptiveNodeMemory,
  scanLiteHistory,
  type LiteSourceRoot,
  type LiveHistorySnapshot,
  type ScanLiteHistoryOptions,
} from "@cchistory/live-runtime";

const VERSION = "0.3.0";
const EXPORT_SCHEMA = "cchistory-lite-export/v1";
const JSON_SCHEMA = "cchistory-lite/v1";
const VALUE_FLAGS = new Set([
  "source-root",
  "source",
  "limit-files",
  "limit",
  "offset",
  "project",
  "by",
  "format",
  "out",
  "dir",
]);
const BOOLEAN_FLAGS = new Set(["safe", "json", "help", "version", "all"]);
const FORBIDDEN_COMMANDS = new Set([
  "sync",
  "import",
  "backup",
  "restore",
  "restore-check",
  "merge",
  "gc",
  "migration",
  "agent",
]);
const KNOWN_COMMANDS = new Set(["sources", "ls", "latest", "tree", "search", "show", "stats", "export", "tui"]);

export interface LiteCliIo {
  cwd: string;
  homeDir?: string;
  hostname?: string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  isTTY: boolean;
  spawnTui?: (args: string[]) => Promise<number>;
  scan?: (options: ScanLiteHistoryOptions) => Promise<LiveHistorySnapshot>;
  now?: () => number;
  columns?: number;
}

interface ParsedArgs {
  command: string;
  positionals: string[];
  values: Map<string, string[]>;
  booleans: Set<string>;
}

class UsageError extends Error {}

export async function runLiteCli(argv: string[], io: LiteCliIo = defaultIo()): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.booleans.has("version")) {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    if (parsed.command === "help" || parsed.booleans.has("help")) {
      io.stdout(renderHelp(parsed.positionals[0]));
      return 0;
    }
    if (FORBIDDEN_COMMANDS.has(parsed.command)) {
      throw new UsageError(
        `${parsed.command} is not available in CC History Lite; Lite only reads live source data and exports one-way output. ` +
          `For ${parsed.command}, install and run the Full \`cchistory\` binary instead.`,
      );
    }
    if (!KNOWN_COMMANDS.has(parsed.command)) {
      throw new UsageError(`Unknown Lite command: ${parsed.command}. Run cchistory-lite help.`);
    }
    validateCommandOptions(parsed);
    if (parsed.command === "tui") {
      assertNoPositionals(parsed, "tui");
      return await launchTui(parsed, io);
    }

    validateCommandShape(parsed);
    const json = parsed.booleans.has("json");
    if (parsed.command === "show" && (parsed.positionals[0] === "session" || parsed.positionals[0] === "turn")) {
      await runShowWithContext(parsed, io, json);
      return 0;
    }
    const snapshot = await scan(parsed, io, requiresFullContextSnapshot(parsed) ? "full" : "none", json);

    switch (parsed.command) {
      case "sources":
        output(io, json, buildSourcesPayload(snapshot), renderSources(snapshot.listSources()));
        return 0;
      case "ls":
        runList(parsed, snapshot, io, json);
        return 0;
      case "latest":
        runLatest(parsed, snapshot, io, json);
        return 0;
      case "tree":
        runTree(parsed, snapshot, io, json);
        return 0;
      case "search":
        runSearch(parsed, snapshot, io, json);
        return 0;
      case "show":
        runShow(parsed, snapshot, io, json);
        return 0;
      case "stats":
        runStats(parsed, snapshot, io, json);
        return 0;
      case "export":
        await runExport(parsed, snapshot, io);
        return 0;
    }
    throw new UsageError(`Unhandled Lite command: ${parsed.command}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

async function scan(
  parsed: ParsedArgs,
  io: LiteCliIo,
  contextMode: ScanLiteHistoryOptions["contextMode"],
  json: boolean,
  overrides: Partial<ScanLiteHistoryOptions> = {},
): Promise<LiveHistorySnapshot> {
  const scanHistory = io.scan ?? scanLiteHistory;
  return scanHistory({
    homeDir: io.homeDir,
    hostname: io.hostname,
    sourceRoots: values(parsed, "source-root").map((entry) => parseSourceRoot(entry, io.cwd)),
    sourceRefs: values(parsed, "source"),
    safeMode: parsed.booleans.has("safe"),
    limitFiles: optionalInteger(parsed, "limit-files", 1),
    contextMode,
    directoryScope: resolveDirectoryScope(parsed, io),
    onProgress: io.isTTY && !json ? (event) => {
      if (event.stage === "source_start") {
        io.stderr(`Scanning ${event.display_name} (${event.slot_id})…\n`);
      } else if (event.stage === "source_missing") {
        io.stderr(`Source missing: ${event.display_name} (${event.slot_id})\n`);
      } else if (event.stage === "file_error") {
        io.stderr(`Read error in ${event.display_name}: ${event.message ?? event.file_path ?? "unknown file"}\n`);
      }
    } : undefined,
    ...overrides,
  });
}

async function runShowWithContext(parsed: ParsedArgs, io: LiteCliIo, json: boolean): Promise<void> {
  const [kind, ref] = parsed.positionals as ["session" | "turn", string];
  let snapshot: LiveHistorySnapshot;
  if (kind === "session" && /^sess:[^:]+:.+$/u.test(ref)) {
    const resolution = await scan(parsed, io, "none", json);
    const session = requireSession(resolution, ref);
    const source = requireSource(resolution, session.source_id);
    snapshot = await scan(parsed, io, "full", json, {
      sourceRefs: [source.id],
      sessionRefs: [session.id],
      limitFiles: undefined,
    });
  } else {
    snapshot = await scan(parsed, io, "matching", json, { contextTarget: { kind, ref } });
  }
  runShow(parsed, snapshot, io, json);
}

function runList(parsed: ParsedArgs, snapshot: LiveHistorySnapshot, io: LiteCliIo, json: boolean): void {
  const target = parsed.positionals[0] ?? "projects";
  const directoryScope = resolveDirectoryScope(parsed, io);
  if (parsed.booleans.has("all") && value(parsed, "limit") !== undefined) {
    throw new UsageError("--all and --limit cannot be used together.");
  }
  const limit = parsed.booleans.has("all") ? Infinity : optionalInteger(parsed, "limit", 1) ?? 20;
  if (target === "projects") {
    const allProjects = snapshot.listProjects({ directoryScope });
    const projects = allProjects.slice(0, limit);
    output(
      io,
      json,
      { schema: JSON_SCHEMA, kind: "projects", total: allProjects.length, shown: projects.length, projects },
      renderProjects(projects, collectionRenderOptions(io, "Projects", allProjects.length, "use --limit <n> or --all")),
    );
    return;
  }
  if (target === "sessions") {
    const allSessions = snapshot.listResolvedSessions({ directoryScope });
    const sessions = allSessions.slice(0, limit);
    output(
      io,
      json,
      { schema: JSON_SCHEMA, kind: "sessions", total: allSessions.length, shown: sessions.length, sessions },
      renderSessions(snapshot, sessions, collectionRenderOptions(io, "Sessions", allSessions.length, "use --limit <n> or --all")),
    );
    return;
  }
  if (target === "sources") {
    if (directoryScope) throw new UsageError("--dir is not valid for ls sources.");
    const allSources = snapshot.listSources();
    const sources = allSources.slice(0, limit);
    output(
      io,
      json,
      { schema: JSON_SCHEMA, kind: "sources", total: allSources.length, shown: sources.length, sources },
      renderSources(sources, collectionRenderOptions(io, "Sources", allSources.length, "use --limit <n> or --all")),
    );
    return;
  }
  throw new UsageError(`ls target must be projects, sessions, or sources; received ${JSON.stringify(target)}.`);
}

function runLatest(parsed: ParsedArgs, snapshot: LiveHistorySnapshot, io: LiteCliIo, json: boolean): void {
  const { kind, limit } = parseLatestPositionals(parsed.positionals);
  const directoryScope = resolveDirectoryScope(parsed, io);
  if (kind === "sessions") {
    const allSessions = snapshot.listResolvedSessions({ directoryScope });
    const sessions = allSessions.slice(0, limit);
    output(
      io,
      json,
      { schema: JSON_SCHEMA, kind: "sessions", total: allSessions.length, shown: sessions.length, sessions },
      renderSessions(snapshot, sessions, collectionRenderOptions(io, "Latest sessions", allSessions.length, "request a larger N")),
    );
    return;
  }
  const allTurns = snapshot.listResolvedTurns({ directoryScope });
  const turns = allTurns.slice(0, limit);
  output(
    io,
    json,
    { schema: JSON_SCHEMA, kind: "turns", total: allTurns.length, shown: turns.length, turns },
    renderTurns(snapshot, turns, collectionRenderOptions(io, "Latest turns", allTurns.length, "request a larger N")),
  );
}

function runTree(parsed: ParsedArgs, snapshot: LiveHistorySnapshot, io: LiteCliIo, json: boolean): void {
  const target = parsed.positionals[0] ?? "projects";
  const directoryScope = resolveDirectoryScope(parsed, io);
  if (target === "projects") {
    const tree = buildProjectsTree(snapshot, directoryScope);
    output(io, json, { schema: JSON_SCHEMA, kind: "project_tree", ...tree }, renderProjectTree(tree));
    return;
  }
  const ref = parsed.positionals[1];
  if (directoryScope) throw new UsageError(`--dir is only valid for tree projects, not tree ${target}.`);
  if (!ref) {
    throw new UsageError(`tree ${target} requires a reference.`);
  }
  if (target === "project") {
    const project = requireProject(snapshot, ref);
    const node = buildProjectNode(snapshot, project);
    output(io, json, { schema: JSON_SCHEMA, kind: "project_tree", project: node }, renderProjectTree({ projects: [node], unlinked: [] }));
    return;
  }
  if (target === "session") {
    const session = requireSession(snapshot, ref);
    const node = buildSessionNode(snapshot, session);
    output(io, json, { schema: JSON_SCHEMA, kind: "session_tree", session: node }, renderSessionTree(node));
    return;
  }
  throw new UsageError(`tree target must be projects, project, or session; received ${JSON.stringify(target)}.`);
}

function runSearch(parsed: ParsedArgs, snapshot: LiveHistorySnapshot, io: LiteCliIo, json: boolean): void {
  const query = parsed.positionals.join(" ").trim();
  if (!query) {
    throw new UsageError("search requires a query.");
  }
  const projectRef = value(parsed, "project");
  const projectId = projectRef ? requireProject(snapshot, projectRef).project_id : undefined;
  const sourceIds = values(parsed, "source").map((ref) => requireSource(snapshot, ref).id);
  const result = snapshot.search({
    query,
    projectId,
    sourceIds,
    limit: optionalInteger(parsed, "limit", 1) ?? 50,
    offset: optionalInteger(parsed, "offset", 0) ?? 0,
    directoryScope: resolveDirectoryScope(parsed, io),
  });
  output(
    io,
    json,
    { schema: JSON_SCHEMA, kind: "search", query, total: result.total, results: result.results },
    renderSearch(query, result.total, result.results),
  );
}

function runShow(parsed: ParsedArgs, snapshot: LiveHistorySnapshot, io: LiteCliIo, json: boolean): void {
  const [kind, ref] = parsed.positionals;
  if (!kind || !ref) {
    throw new UsageError("show requires project|session|turn|source and a reference.");
  }
  if (kind === "project") {
    const project = requireProject(snapshot, ref);
    const detail = buildProjectNode(snapshot, project);
    output(io, json, { schema: JSON_SCHEMA, kind: "project_detail", ...detail }, renderProjectDetail(snapshot, detail, io));
    return;
  }
  if (kind === "session") {
    const session = requireSession(snapshot, ref);
    const turns = snapshot.listSessionTurns(session.id);
    const detail = {
      session,
      related_work: snapshot.listSessionRelatedWork(session.id),
      turns: turns.map((turn) => ({ turn, context: snapshot.getTurnContext(turn.id) })),
    };
    output(io, json, { schema: JSON_SCHEMA, kind: "session_detail", ...detail }, renderSessionDetail(snapshot, detail, io));
    return;
  }
  if (kind === "turn") {
    const turn = requireTurn(snapshot, ref);
    const detail = {
      turn,
      session: snapshot.getSession(turn.session_id),
      project: turn.project_id ? snapshot.getProject(turn.project_id) : undefined,
      context: snapshot.getTurnContext(turn.id),
    };
    output(io, json, { schema: JSON_SCHEMA, kind: "turn_detail", ...detail }, renderTurnDetail(snapshot, detail, io));
    return;
  }
  if (kind === "source") {
    const source = requireSource(snapshot, ref);
    const detail = {
      source,
      sessions: snapshot.listResolvedSessions().filter((session) => session.source_id === source.id),
      loss_audits: snapshot.listLossAudits().filter((audit) => audit.source_id === source.id),
    };
    output(io, json, { schema: JSON_SCHEMA, kind: "source_detail", ...detail }, renderSourceDetail(snapshot, detail, io));
    return;
  }
  throw new UsageError(`show target must be project, session, turn, or source; received ${JSON.stringify(kind)}.`);
}

function runStats(parsed: ParsedArgs, snapshot: LiveHistorySnapshot, io: LiteCliIo, json: boolean): void {
  const projectRef = value(parsed, "project");
  const sourceIds = values(parsed, "source").map((ref) => requireSource(snapshot, ref).id);
  const filters = {
    project_id: projectRef ? requireProject(snapshot, projectRef).project_id : undefined,
    source_ids: sourceIds.length > 0 ? sourceIds : undefined,
    directory_scope: resolveDirectoryScope(parsed, io),
  };
  const overview = snapshot.getUsageOverview(filters);
  const by = value(parsed, "by");
  const dimension = by ? parseStatsDimension(by) : undefined;
  const rollup = dimension ? snapshot.getUsageRollup(dimension, filters) : undefined;
  output(
    io,
    json,
    { schema: JSON_SCHEMA, kind: "stats", overview, rollup },
    renderStats(overview, rollup),
  );
}

function requiresFullContextSnapshot(parsed: ParsedArgs): boolean {
  if (parsed.command === "export") {
    return (value(parsed, "format") ?? "jsonl") !== "markdown";
  }
  return false;
}

async function runExport(parsed: ParsedArgs, snapshot: LiveHistorySnapshot, io: LiteCliIo): Promise<void> {
  const format = value(parsed, "format") ?? "jsonl";
  if (format !== "jsonl" && format !== "json" && format !== "markdown") {
    throw new UsageError(`export format must be jsonl, json, or markdown; received ${JSON.stringify(format)}.`);
  }
  const destination = value(parsed, "out") ?? "-";
  if (destination === "-") {
    if (format === "jsonl") {
      for (const row of iterateJsonlRows(snapshot)) io.stdout(`${JSON.stringify(row)}\n`);
    } else {
      io.stdout(formatExport(snapshot, format));
    }
    return;
  }
  const outputPath = path.resolve(io.cwd, destination);
  await assertSafeExportDestination(outputPath, snapshot, io.homeDir);
  if (format === "jsonl") {
    const handle = await open(outputPath, "w");
    try {
      for (const row of iterateJsonlRows(snapshot)) {
        await handle.write(`${JSON.stringify(row)}\n`);
      }
    } finally {
      await handle.close();
    }
  } else {
    await writeFile(outputPath, formatExport(snapshot, format), "utf8");
  }
  io.stdout(`Wrote one-way ${format} export to ${outputPath}\n`);
}

function buildSourcesPayload(snapshot: LiveHistorySnapshot): Record<string, unknown> {
  const sources = snapshot.listSources();
  return { schema: JSON_SCHEMA, kind: "sources", total: sources.length, sources };
}

function buildProjectsTree(snapshot: LiveHistorySnapshot, directoryScope?: string): {
  projects: ReturnType<typeof buildProjectNode>[];
  unlinked: ReturnType<typeof buildSessionNode>[];
} {
  const projection = snapshot.getProjectsTreeProjection({ directoryScope });
  const projects = projection.projects.map(({ project, sessions, turns }) => ({
    project,
    sessions: sessions.map((session) => buildSessionNode(snapshot, session, project.project_id)),
    turns,
  }));
  const unlinked = projection.unlinkedSessions.map((session) => buildSessionNode(snapshot, session));
  return { projects, unlinked };
}

function buildProjectNode(snapshot: LiveHistorySnapshot, project: ProjectIdentity, directoryScope?: string): {
  project: ProjectIdentity;
  sessions: ReturnType<typeof buildSessionNode>[];
  turns: UserTurnProjection[];
} {
  const turns = snapshot.listProjectTurns(project.project_id, { directoryScope });
  const sessionIds = new Set(turns.map((turn) => turn.session_id));
  const sessions = snapshot.listResolvedSessions({ directoryScope })
    .filter((session) => sessionIds.has(session.id))
    .map((session) => buildSessionNode(snapshot, session, project.project_id));
  return { project, sessions, turns };
}

function buildSessionNode(snapshot: LiveHistorySnapshot, session: SessionProjection, projectId?: string): {
  session: SessionProjection;
  turns: UserTurnProjection[];
  related_work: ReturnType<LiveHistorySnapshot["listSessionRelatedWork"]>;
} {
  const turns = snapshot.listSessionTurns(session.id).filter((turn) => projectId ? turn.project_id === projectId : true);
  return { session, turns, related_work: snapshot.listSessionRelatedWork(session.id) };
}

function formatExport(snapshot: LiveHistorySnapshot, format: "json" | "markdown"): string {
  const data = snapshot.data;
  if (format === "json") {
    return `${JSON.stringify({ schema: EXPORT_SCHEMA, kind: "export", ...data }, null, 2)}\n`;
  }

  const lines = [
    "# CC History Lite Export",
    "",
    `Schema: \`${EXPORT_SCHEMA}\``,
    "",
    "> One-way canonical export. This is not a CC History Full backup and cannot be imported by Lite.",
    "",
    `- Sources: ${data.sources.length}`,
    `- Projects: ${data.projects.length}`,
    `- Sessions: ${data.sessions.length}`,
    `- UserTurns: ${data.turns.length}`,
    `- Related work: ${data.related_work.length}`,
    "",
    "## UserTurns",
    "",
  ];
  for (const turn of data.turns) {
    lines.push(`### ${turn.submission_started_at} · ${turn.id}`, "", turn.canonical_text, "");
  }
  return `${lines.join("\n")}\n`;
}

function* iterateJsonlRows(snapshot: LiveHistorySnapshot): Iterable<unknown> {
  const data = snapshot.data;
  yield { schema: EXPORT_SCHEMA, kind: "manifest" };
  yield { schema: EXPORT_SCHEMA, kind: "host", value: data.host };
  for (const value of data.sources) yield { schema: EXPORT_SCHEMA, kind: "source", value };
  for (const value of data.projects) yield { schema: EXPORT_SCHEMA, kind: "project", value };
  for (const value of data.sessions) yield { schema: EXPORT_SCHEMA, kind: "session", value };
  for (const value of data.related_work) yield { schema: EXPORT_SCHEMA, kind: "related_work", value };
  for (const value of data.turns) yield { schema: EXPORT_SCHEMA, kind: "turn", value };
  for (const value of data.contexts) yield { schema: EXPORT_SCHEMA, kind: "context", value };
  for (const value of data.ask_user_question_turns) {
    yield { schema: EXPORT_SCHEMA, kind: "ask_user_question", value };
  }
  for (const value of data.loss_audits) yield { schema: EXPORT_SCHEMA, kind: "loss_audit", value };
}

interface CollectionRenderOptions {
  heading: string;
  total: number;
  now: number;
  homeDir: string;
  columns: number;
  footerHint?: string;
}

function collectionRenderOptions(
  io: LiteCliIo,
  heading: string,
  total: number,
  footerHint?: string,
): CollectionRenderOptions {
  return {
    heading,
    total,
    now: (io.now ?? Date.now)(),
    homeDir: io.homeDir ?? os.homedir(),
    columns: Math.max(40, io.columns ?? 100),
    footerHint,
  };
}

function renderSources(sources: SourceStatus[], options?: CollectionRenderOptions): string {
  const renderOptions = options ?? {
    heading: "Sources",
    total: sources.length,
    now: Date.now(),
    homeDir: os.homedir(),
    columns: 100,
  };
  const lines = [renderCollectionHeading(renderOptions, sources.length)];
  for (const source of sources) {
    lines.push(
      `- ${source.display_name} [${source.slot_id}] ${source.sync_status} · ${source.total_sessions} sessions · ${source.total_turns} turns`,
      `  ${singleLine(foldHome(source.base_dir, renderOptions.homeDir), Math.max(20, renderOptions.columns - 2))}`,
    );
    if (source.error_message) lines.push(`  error: ${source.error_message}`);
  }
  appendCollectionFooter(lines, renderOptions, sources.length);
  return `${lines.join("\n")}\n`;
}

function renderProjects(projects: ProjectIdentity[], options: CollectionRenderOptions): string {
  const lines = [renderCollectionHeading(options, projects.length, "most active first")];
  if (options.columns >= 88) {
    lines.push(formatColumns([
      ["ACTIVITY", 8],
      ["LINKAGE", 10],
      ["SESS", 5],
      ["TURNS", 5],
      ["DIRECTORY", 20],
      ["PROJECT", Infinity],
    ], options.columns));
  }
  for (const project of projects) {
    const directory = foldHome(project.primary_workspace_path ?? project.repo_root ?? "-", options.homeDir);
    const activity = project.project_last_activity_at ?? project.updated_at;
    if (options.columns >= 88) {
      lines.push(formatColumns([
        [formatRelativeTime(activity, options.now), 8],
        [project.linkage_state, 10],
        [`${project.session_count}`, 5],
        [`${project.committed_turn_count + project.candidate_turn_count}`, 5],
        [directory, 20],
        [project.display_name, Infinity],
      ], options.columns));
      continue;
    }
    lines.push(
      `- ${project.display_name} [${project.linkage_state}] · ${project.committed_turn_count + project.candidate_turn_count} turns · ${project.session_count} sessions`,
      `  ${formatRelativeTime(activity, options.now)} · ${singleLine(directory, Math.max(20, options.columns - 2))}`,
    );
  }
  appendCollectionFooter(lines, options, projects.length);
  return `${lines.join("\n")}\n`;
}

function renderSessions(
  snapshot: LiveHistorySnapshot,
  sessions: SessionProjection[],
  options: CollectionRenderOptions,
): string {
  const lines = [renderCollectionHeading(options, sessions.length, "newest first")];
  if (options.columns >= 88) {
    lines.push(formatColumns([
      ["UPDATED", 8],
      ["SOURCE", 12],
      ["TURNS", 6],
      ["SESSION", 12],
      ["DIRECTORY", 20],
      ["TITLE", Infinity],
    ], options.columns));
  }
  for (const session of sessions) {
    const directory = foldHome(session.working_directory ?? "-", options.homeDir);
    const ref = snapshot.getSessionDisplayRef(session.id) ?? session.id;
    if (options.columns >= 88) {
      lines.push(formatColumns([
        [formatRelativeTime(session.updated_at, options.now), 8],
        [session.source_platform, 12],
        [`${session.turn_count}`, 6],
        [ref, 12],
        [directory, 20],
        [session.title ?? "-", Infinity],
      ], options.columns));
      continue;
    }
    lines.push(
      `- ${session.title ?? "Untitled session"} · ${session.source_platform} · ${session.turn_count} turns · ${ref}`,
      `  ${formatRelativeTime(session.updated_at, options.now)} · ${singleLine(directory, Math.max(20, options.columns - 2))}`,
    );
  }
  appendCollectionFooter(lines, options, sessions.length);
  return `${lines.join("\n")}\n`;
}

function renderTurns(
  snapshot: LiveHistorySnapshot,
  turns: UserTurnProjection[],
  options: CollectionRenderOptions,
): string {
  const lines = [renderCollectionHeading(options, turns.length, "newest first")];
  if (options.columns >= 88) {
    lines.push(formatColumns([
      ["SUBMITTED", 8],
      ["SOURCE", 12],
      ["SESSION", 12],
      ["TURN", 10],
      ["PROMPT", Infinity],
    ], options.columns));
  }
  for (const turn of turns) {
    const session = snapshot.getSession(turn.session_id);
    const sessionRef = session ? snapshot.getSessionDisplayRef(session.id) ?? session.id : turn.session_id;
    const turnRef = snapshot.getTurnDisplayRef(turn.id) ?? turn.id;
    if (options.columns >= 88) {
      lines.push(formatColumns([
        [formatRelativeTime(turn.submission_started_at, options.now), 8],
        [session?.source_platform ?? "unknown", 12],
        [sessionRef, 12],
        [turnRef, 10],
        [singleLine(turn.canonical_text, options.columns), Infinity],
      ], options.columns));
      continue;
    }
    lines.push(
      `- ${session?.source_platform ?? "unknown"} · ${sessionRef}/${turnRef} · ${formatRelativeTime(turn.submission_started_at, options.now)}`,
      `  ${singleLine(turn.canonical_text, Math.max(20, options.columns - 2))}`,
    );
  }
  appendCollectionFooter(lines, options, turns.length);
  return `${lines.join("\n")}\n`;
}

function renderCollectionHeading(options: CollectionRenderOptions, shown: number, order?: string): string {
  const count = shown === options.total ? `${options.total}` : `${shown} of ${options.total}`;
  return `${options.heading} (${count}${order ? `, ${order}` : ""})`;
}

function appendCollectionFooter(lines: string[], options: CollectionRenderOptions, shown: number): void {
  const remaining = options.total - shown;
  if (remaining > 0) lines.push(`… and ${remaining} more${options.footerHint ? ` (${options.footerHint})` : ""}`);
}

function formatColumns(columns: Array<readonly [string, number]>, maxColumns: number): string {
  const fixed = columns.filter(([, width]) => Number.isFinite(width));
  const fixedWidth = fixed.reduce((total, [, width]) => total + width, 0);
  const separators = Math.max(0, columns.length - 1) * 2;
  const flexibleWidth = Math.max(8, maxColumns - fixedWidth - separators);
  return columns.map(([value, width]) => {
    const actualWidth = Number.isFinite(width) ? width : flexibleWidth;
    const fitted = singleLine(value, actualWidth);
    return Number.isFinite(width) ? padToDisplayWidth(fitted, actualWidth) : fitted;
  }).join("  ").trimEnd();
}

function formatRelativeTime(value: string, now: number): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value.slice(0, 10);
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 31_536_000_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return `${Math.floor(elapsed / 31_536_000_000)}y ago`;
}

function foldHome(value: string, homeDir: string): string {
  const normalizedValue = normalizeLocalPathIdentity(value);
  const normalizedHome = normalizeLocalPathIdentity(homeDir);
  if (!normalizedValue || !normalizedHome) return value;
  const comparisonValue = process.platform === "darwin" || process.platform === "win32"
    ? normalizedValue.toLowerCase()
    : normalizedValue;
  const comparisonHome = process.platform === "darwin" || process.platform === "win32"
    ? normalizedHome.toLowerCase()
    : normalizedHome;
  if (comparisonValue === comparisonHome) return "~";
  if (comparisonValue.startsWith(`${comparisonHome}/`)) return `~${normalizedValue.slice(normalizedHome.length)}`;
  return value;
}

function renderProjectDetail(
  snapshot: LiveHistorySnapshot,
  detail: ReturnType<typeof buildProjectNode>,
  io: LiteCliIo,
): string {
  const { project, sessions, turns } = detail;
  const now = (io.now ?? Date.now)();
  const homeDir = io.homeDir ?? os.homedir();
  const lines = [
    `Project: ${project.display_name}`,
    ...renderMeta([
      ["ID", project.project_id],
      ["Linkage", `${project.linkage_state} (${Math.round(project.confidence * 100)}%, ${project.link_reason})`],
      ["Directory", foldHome(project.primary_workspace_path ?? project.repo_root ?? "-", homeDir)],
      ["Repository", project.repo_remote ?? project.repo_root ?? "-"],
      ["Platforms", project.source_platforms.join(", ") || "-"],
      ["Activity", formatDateTime(project.project_last_activity_at ?? project.updated_at, now)],
      ["Sessions", String(sessions.length)],
      ["Turns", String(turns.length)],
    ]),
  ];
  if (sessions.length > 0) {
    lines.push("", `Sessions (${sessions.length})`);
    for (const node of sessions) {
      const sessionRef = snapshot.getSessionDisplayRef(node.session.id) ?? node.session.id;
      lines.push(
        `- ${formatRelativeTime(node.session.updated_at, now)}  ${sessionRef}  ${node.session.title ?? "Untitled session"} (${node.turns.length} turns)`,
      );
    }
  }
  const related = sessions.flatMap((node) => node.related_work);
  appendRelatedWork(lines, related);
  return `${lines.join("\n")}\n`;
}

function renderSessionDetail(
  snapshot: LiveHistorySnapshot,
  detail: {
    session: SessionProjection;
    related_work: SessionRelatedWorkProjection[];
    turns: Array<{ turn: UserTurnProjection; context: TurnContextProjection | undefined }>;
  },
  io: LiteCliIo,
): string {
  const { session, turns } = detail;
  const now = (io.now ?? Date.now)();
  const source = snapshot.getSource(session.source_id);
  const project = session.primary_project_id ? snapshot.getProject(session.primary_project_id) : undefined;
  const sessionRef = snapshot.getSessionDisplayRef(session.id) ?? session.id;
  const lines = [
    `Session: ${session.title ?? sessionRef}`,
    ...renderMeta([
      ["Reference", sessionRef],
      ["ID", session.id],
      ["Source", source ? `${source.display_name} (${source.slot_id})` : session.source_platform],
      ["Directory", foldHome(session.working_directory ?? "-", io.homeDir ?? os.homedir())],
      ["Project", project?.display_name ?? session.primary_project_id ?? "-"],
      ["Created", formatDateTime(session.created_at, now)],
      ["Updated", formatDateTime(session.updated_at, now)],
      ["Model", session.model ?? "-"],
      ["Turns", String(turns.length)],
    ]),
  ];
  if (turns.length > 0) {
    lines.push("", `Turns (${turns.length}, oldest first)`);
    for (const { turn, context } of turns) {
      const turnRef = snapshot.getTurnDisplayRef(turn.id) ?? turn.id;
      const tokens = formatTokenSummary(turn.context_summary);
      const contextLabel = context
        ? `${context.assistant_replies.length} replies, ${context.tool_calls.length} tools`
        : "context unavailable";
      lines.push(
        `- ${turn.submission_started_at}  ${turnRef}  ${tokens}  ${contextLabel}`,
        `  ${singleLine(turn.canonical_text, Math.max(30, (io.columns ?? 100) - 2))}`,
      );
    }
  }
  appendRelatedWork(lines, detail.related_work);
  return `${lines.join("\n")}\n`;
}

function renderTurnDetail(
  snapshot: LiveHistorySnapshot,
  detail: {
    turn: UserTurnProjection;
    session: SessionProjection | undefined;
    project: ProjectIdentity | undefined;
    context: TurnContextProjection | undefined;
  },
  io: LiteCliIo,
): string {
  const { turn, session, project, context } = detail;
  const now = (io.now ?? Date.now)();
  const source = snapshot.getSource(turn.source_id);
  const turnRef = snapshot.getTurnDisplayRef(turn.id) ?? turn.id;
  const sessionRef = session ? snapshot.getSessionDisplayRef(session.id) ?? session.id : turn.session_id;
  const lines = [
    `Turn: ${turnRef}`,
    ...renderMeta([
      ["ID", turn.id],
      ["Session", session ? `${session.title ?? "Untitled session"} (${sessionRef})` : sessionRef],
      ["Project", project?.display_name ?? turn.project_id ?? "-"],
      ["Source", source ? `${source.display_name} (${source.slot_id})` : turn.source_id],
      ["Submitted", formatDateTime(turn.submission_started_at, now)],
      ["Model", turn.context_summary.primary_model ?? session?.model ?? "-"],
      ["Tokens", formatTokenSummary(turn.context_summary)],
      ["Context", context ? `${context.assistant_replies.length} replies, ${context.tool_calls.length} tool calls` : "unavailable"],
    ]),
    "",
    "Prompt",
    indentBlock(turn.canonical_text, "  "),
  ];
  if (context?.assistant_replies.length) {
    lines.push("", `Assistant replies (${context.assistant_replies.length})`);
    for (const reply of context.assistant_replies) {
      lines.push(
        `- ${reply.created_at}  ${reply.model}${reply.stop_reason ? `  ${reply.stop_reason}` : ""}`,
        `  ${singleLine(reply.content_preview || reply.content, Math.max(30, (io.columns ?? 100) - 2))}`,
      );
    }
  }
  if (context?.tool_calls.length) {
    lines.push("", `Tool calls (${context.tool_calls.length})`);
    for (const tool of context.tool_calls) {
      lines.push(`- ${tool.tool_name} [${tool.status}]  ${singleLine(tool.input_summary, Math.max(24, (io.columns ?? 100) - 20))}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderSourceDetail(
  snapshot: LiveHistorySnapshot,
  detail: { source: SourceStatus; sessions: SessionProjection[]; loss_audits: LossAuditRecord[] },
  io: LiteCliIo,
): string {
  const { source, sessions, loss_audits: audits } = detail;
  const now = (io.now ?? Date.now)();
  const lines = [
    `Source: ${source.display_name}`,
    ...renderMeta([
      ["ID", source.id],
      ["Slot", source.slot_id],
      ["Platform", source.platform],
      ["Root", foldHome(source.base_dir, io.homeDir ?? os.homedir())],
      ["Status", source.error_message ? `${source.sync_status}: ${source.error_message}` : source.sync_status],
      ["Last scan", source.last_sync ? formatDateTime(source.last_sync, now) : "-"],
      ["Sessions", String(source.total_sessions)],
      ["Turns", String(source.total_turns)],
      ["Loss audits", String(audits.length)],
    ]),
  ];
  if (sessions.length > 0) {
    lines.push("", `Sessions (${sessions.length}, newest first)`);
    for (const session of sessions) {
      const ref = snapshot.getSessionDisplayRef(session.id) ?? session.id;
      lines.push(`- ${formatRelativeTime(session.updated_at, now)}  ${ref}  ${session.title ?? "Untitled session"} (${session.turn_count} turns)`);
    }
  }
  if (audits.length > 0) {
    lines.push("", `Loss audits (${audits.length})`);
    for (const audit of audits) {
      lines.push(`- ${audit.severity}  ${audit.diagnostic_code}  ${singleLine(audit.detail, Math.max(30, (io.columns ?? 100) - 8))}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderMeta(entries: ReadonlyArray<readonly [string, string]>): string[] {
  const width = entries.reduce((maximum, [label]) => Math.max(maximum, label.length), 0);
  return entries.map(([label, value]) => `${label.padEnd(width)}  ${value}`);
}

function formatDateTime(value: string, now: number): string {
  return `${value} (${formatRelativeTime(value, now)})`;
}

function formatTokenSummary(summary: UserTurnProjection["context_summary"]): string {
  const usage = summary.token_usage;
  const total = usage?.total_tokens ?? summary.total_tokens;
  if (total === undefined) return summary.zero_token_reason ? `0 (${summary.zero_token_reason.replace(/_/gu, " ")})` : "unknown";
  const parts = [`${formatNumber(total)} total`];
  if (usage?.input_tokens !== undefined) parts.push(`${formatNumber(usage.input_tokens)} in`);
  if (usage?.cached_input_tokens !== undefined) parts.push(`${formatNumber(usage.cached_input_tokens)} cached`);
  if (usage?.output_tokens !== undefined) parts.push(`${formatNumber(usage.output_tokens)} out`);
  return parts.join(", ");
}

function indentBlock(value: string, prefix: string): string {
  return value.split(/\r?\n/u).map((line) => `${prefix}${line}`).join("\n");
}

function appendRelatedWork(lines: string[], relatedWork: readonly SessionRelatedWorkProjection[]): void {
  if (relatedWork.length === 0) return;
  lines.push("", `Related work (${relatedWork.length})`);
  for (const related of relatedWork) {
    lines.push(`- ${formatRelatedWorkLabel(related)}  ${related.direction ?? "unknown"}${related.status ? `  ${related.status}` : ""}`);
  }
}

function renderSearch(query: string, total: number, results: ReturnType<LiveHistorySnapshot["search"]>["results"]): string {
  const lines = [`Search ${JSON.stringify(query)} (${total} matches)`];
  for (const result of results) {
    const label = result.project?.display_name ?? result.session?.title ?? result.turn.session_id;
    lines.push(
      `- ${result.turn.submission_started_at} · ${label} · ${result.turn.id}`,
      `  ${singleLine(result.turn.canonical_text, 180)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderStats(
  overview: ReturnType<LiveHistorySnapshot["getUsageOverview"]>,
  rollup: ReturnType<LiveHistorySnapshot["getUsageRollup"]> | undefined,
): string {
  const lines = [
    "Stats",
    `- Turns: ${overview.total_turns}`,
    `- Turns with token usage: ${overview.turns_with_token_usage} (${formatPercent(overview.turn_coverage_ratio)})`,
    `- Input tokens: ${formatNumber(overview.total_input_tokens)}`,
    `- Cached input tokens: ${formatNumber(overview.total_cached_input_tokens)}`,
    `- Output tokens: ${formatNumber(overview.total_output_tokens)}`,
    `- Reasoning output tokens: ${formatNumber(overview.total_reasoning_output_tokens)}`,
    `- Total tokens: ${formatNumber(overview.total_tokens)}`,
  ];
  if (rollup) {
    lines.push("", `By ${rollup.dimension}`);
    for (const row of rollup.rows) {
      lines.push(`- ${row.label}: ${row.turn_count} turns · ${formatNumber(row.total_tokens)} tokens`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderProjectTree(tree: ReturnType<typeof buildProjectsTree>): string {
  const lines = ["Project tree"];
  for (const node of tree.projects) {
    lines.push(`├─ ${node.project.display_name} [${node.project.linkage_state}]`);
    for (const sessionNode of node.sessions) {
      lines.push(...renderSessionTreeLines(sessionNode, "│  "));
    }
  }
  if (tree.unlinked.length > 0) {
    lines.push("└─ Unlinked / candidate-only sessions");
    for (const sessionNode of tree.unlinked) {
      lines.push(...renderSessionTreeLines(sessionNode, "   "));
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderSessionTree(node: ReturnType<typeof buildSessionNode>): string {
  return `${["Session tree", ...renderSessionTreeLines(node, "")].join("\n")}\n`;
}

function renderSessionTreeLines(node: ReturnType<typeof buildSessionNode>, prefix: string): string[] {
  const lines = [`${prefix}├─ ${node.session.title ?? node.session.source_session_id ?? node.session.id}`];
  for (const turn of node.turns) {
    lines.push(`${prefix}│  └─ ${turn.submission_started_at} ${singleLine(turn.canonical_text, 100)}`);
  }
  if (node.related_work.length > 0) {
    lines.push(`${prefix}│  └─ Related Work (${node.related_work.length})`);
    for (const related of node.related_work) {
      lines.push(
        `${prefix}│     └─ ${formatRelatedWorkLabel(related)} · ${related.direction ?? "unknown"}`,
      );
    }
  }
  return lines;
}

function formatRelatedWorkLabel(
  related: ReturnType<LiveHistorySnapshot["listSessionRelatedWork"]>[number],
): string {
  const kind = related.relation_kind === "automation_run" ? "automation run" : "delegated session";
  const target = related.title ?? related.target_session_ref ?? related.target_run_ref ?? related.id;
  return `${kind}: ${target}`;
}

function output(io: LiteCliIo, json: boolean, payload: unknown, text: string): void {
  io.stdout(json ? `${JSON.stringify(payload, null, 2)}\n` : text);
}

function requireSource(snapshot: LiveHistorySnapshot, ref: string): SourceStatus {
  const value = snapshot.getSource(ref);
  if (!value) throw new UsageError(`Lite source not found: ${ref}.`);
  return value;
}

function requireProject(snapshot: LiveHistorySnapshot, ref: string): ProjectIdentity {
  const value = snapshot.getProject(ref);
  if (!value) throw new UsageError(`Project not found: ${ref}.`);
  return value;
}

function requireSession(snapshot: LiveHistorySnapshot, ref: string): SessionProjection {
  const value = snapshot.getSession(ref);
  if (!value) throw new UsageError(`Session not found: ${ref}.`);
  return value;
}

function requireTurn(snapshot: LiveHistorySnapshot, ref: string): UserTurnProjection {
  const value = snapshot.getTurn(ref);
  if (!value) throw new UsageError(`UserTurn not found: ${ref}.`);
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const valuesMap = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "-h") {
      booleans.add("help");
      continue;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    const name = argument.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (name === "store" || name === "db") {
      throw new UsageError("CC History Lite does not accept --store or --db and never reads the Full store.");
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (equalsIndex !== -1) throw new UsageError(`--${name} does not take a value.`);
      booleans.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new UsageError(`Unknown Lite option: --${name}.`);
    }
    const nextValue = equalsIndex === -1 ? argv[index + 1] : argument.slice(equalsIndex + 1);
    if (nextValue === undefined || nextValue === "" || (equalsIndex === -1 && nextValue.startsWith("--"))) {
      throw new UsageError(`--${name} requires a value.`);
    }
    if (equalsIndex === -1) index += 1;
    const entries = valuesMap.get(name) ?? [];
    entries.push(nextValue);
    valuesMap.set(name, entries);
  }

  const command = positionals.shift() ?? "help";
  return { command, positionals, values: valuesMap, booleans };
}

function validateCommandShape(parsed: ParsedArgs): void {
  switch (parsed.command) {
    case "sources":
      assertNoPositionals(parsed, "sources");
      break;
    case "ls":
      if (parsed.positionals.length > 1) throw new UsageError("ls accepts at most one target.");
      break;
    case "latest":
      if (parsed.positionals.length > 2) throw new UsageError("latest accepts at most a kind and count.");
      parseLatestPositionals(parsed.positionals);
      break;
    case "tree": {
      const target = parsed.positionals[0] ?? "projects";
      const expected = target === "projects" ? 1 : 2;
      if (parsed.positionals.length > expected) throw new UsageError(`tree ${target} received too many arguments.`);
      break;
    }
    case "search":
      break;
    case "show":
      if (parsed.positionals.length !== 2) throw new UsageError("show requires exactly a kind and reference.");
      break;
    case "stats":
    case "export":
      assertNoPositionals(parsed, parsed.command);
      break;
    default:
      break;
  }
}

function validateCommandOptions(parsed: ParsedArgs): void {
  const allowedValues = new Set(["source-root", "source", "limit-files"]);
  if (parsed.command === "ls") {
    for (const name of ["limit", "dir"]) allowedValues.add(name);
  } else if (parsed.command === "latest") {
    allowedValues.add("dir");
  } else if (parsed.command === "tree") {
    allowedValues.add("dir");
  } else if (parsed.command === "search") {
    for (const name of ["limit", "offset", "project", "dir"]) allowedValues.add(name);
  } else if (parsed.command === "stats") {
    for (const name of ["project", "by", "dir"]) allowedValues.add(name);
  } else if (parsed.command === "export") {
    for (const name of ["format", "out"]) allowedValues.add(name);
  }
  for (const name of parsed.values.keys()) {
    if (!allowedValues.has(name)) {
      throw new UsageError(`--${name} is not valid for ${parsed.command}.`);
    }
  }
  if (parsed.booleans.has("all") && parsed.command !== "ls") {
    throw new UsageError(`--all is not valid for ${parsed.command}.`);
  }
  if (parsed.booleans.has("all") && parsed.values.has("limit")) {
    throw new UsageError("--all and --limit cannot be used together.");
  }
  if (parsed.values.has("dir") && parsed.command === "ls" && (parsed.positionals[0] ?? "projects") === "sources") {
    throw new UsageError("--dir is not valid for ls sources.");
  }
  if (parsed.values.has("dir") && parsed.command === "tree" && (parsed.positionals[0] ?? "projects") !== "projects") {
    throw new UsageError("--dir is only valid for tree projects.");
  }
}

function assertNoPositionals(parsed: ParsedArgs, command: string): void {
  if (parsed.positionals.length > 0) throw new UsageError(`${command} does not accept positional arguments.`);
}

function parseSourceRoot(value: string, cwd: string): LiteSourceRoot {
  const equalsIndex = value.indexOf("=");
  if (equalsIndex <= 0 || equalsIndex === value.length - 1) {
    throw new UsageError(`--source-root must use <slot-or-id>=<path>; received ${JSON.stringify(value)}.`);
  }
  return {
    sourceRef: value.slice(0, equalsIndex),
    baseDir: path.resolve(cwd, value.slice(equalsIndex + 1)),
  };
}

function value(parsed: ParsedArgs, name: string): string | undefined {
  const entries = values(parsed, name);
  if (entries.length > 1 && name !== "source" && name !== "source-root") {
    throw new UsageError(`--${name} may only be specified once.`);
  }
  return entries.at(-1);
}

function values(parsed: ParsedArgs, name: string): string[] {
  return parsed.values.get(name) ?? [];
}

function optionalInteger(parsed: ParsedArgs, name: string, minimum: number): number | undefined {
  const raw = value(parsed, name);
  if (raw === undefined) return undefined;
  const parsedValue = Number(raw);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < minimum) {
    throw new UsageError(`--${name} must be an integer >= ${minimum}.`);
  }
  return parsedValue;
}

function parseLatestPositionals(positionals: readonly string[]): { kind: "sessions" | "turns"; limit: number } {
  const first = positionals[0];
  const second = positionals[1];
  let kind: "sessions" | "turns" = "sessions";
  let rawLimit: string | undefined;
  if (first && /^\d+$/u.test(first)) {
    if (second) throw new UsageError("latest <N> does not accept a second positional argument.");
    rawLimit = first;
  } else if (first) {
    if (first === "session" || first === "sessions") kind = "sessions";
    else if (first === "turn" || first === "turns") kind = "turns";
    else throw new UsageError(`latest kind must be sessions or turns; received ${JSON.stringify(first)}.`);
    rawLimit = second;
  }
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new UsageError("latest count must be an integer >= 1.");
  return { kind, limit };
}

function resolveDirectoryScope(parsed: ParsedArgs, io: LiteCliIo): string | undefined {
  const raw = value(parsed, "dir");
  if (!raw) return undefined;
  const homeDir = io.homeDir ?? os.homedir();
  let expanded = raw;
  if (raw === "~") expanded = homeDir;
  else if (raw.startsWith("~/") || raw.startsWith("~\\")) expanded = path.join(homeDir, raw.slice(2));
  return path.resolve(io.cwd, expanded);
}

function parseStatsDimension(value: string): UsageStatsDimension {
  if (value === "source" || value === "project" || value === "model" || value === "day") return value;
  throw new UsageError(`--by must be source, project, model, or day; received ${JSON.stringify(value)}.`);
}

async function launchTui(parsed: ParsedArgs, io: LiteCliIo): Promise<number> {
  const args = [
    ...values(parsed, "source-root").flatMap((entry) => ["--source-root", entry]),
    ...values(parsed, "source").flatMap((entry) => ["--source", entry]),
    ...(value(parsed, "limit-files") ? ["--limit-files", value(parsed, "limit-files")!] : []),
    ...(parsed.booleans.has("safe") ? ["--safe"] : []),
  ];
  if (io.spawnTui) return io.spawnTui(args);
  return new Promise<number>((resolve, reject) => {
    const child = spawn("cchistory-lite-tui", args, { cwd: io.cwd, stdio: "inherit" });
    child.once("error", (error) => reject(new Error(formatTuiLaunchError(error))));
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`cchistory-lite-tui exited on signal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}

export function formatTuiLaunchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const hint = code === "ENOENT"
    ? " Install it globally with `pnpm run lite:tui:link` (or run via `pnpm lite:tui`)."
    : "";
  return `Unable to launch cchistory-lite-tui: ${message}.${hint}`;
}

function renderHelp(command?: string): string {
  if (command) return `Run cchistory-lite ${command} --help through the command synopsis below.\n\n${renderHelp()}`;
  return `CC History Lite ${VERSION}

Live, single-machine history inspection with shared Full/Lite canonical semantics.
Lite never reads or creates a CC History Full store.

Usage:
  cchistory-lite sources [options]
  cchistory-lite ls [projects|sessions|sources] [--limit <n>|--all] [--dir <path>] [options]
  cchistory-lite latest [sessions|turns] [N] [--dir <path>] [options]
  cchistory-lite tree [projects|project <ref>|session <ref>] [--dir <path>] [options]
  cchistory-lite search <query> [--project <ref>] [--dir <path>] [--limit <n>] [options]
  cchistory-lite show project|session|turn|source <ref> [options]
  cchistory-lite stats [--by source|project|model|day] [--dir <path>] [options]
  cchistory-lite export --format jsonl|json|markdown [--out <file>|-] [options]
  cchistory-lite tui [options]

Browsing options:
  --dir <path>                       Keep history under this working directory
  --limit <n>                        Show at most n rows (ls defaults to 20)
  --all                              Show every ls row; cannot be combined with --limit

latest defaults to the 20 newest sessions. Use latest 50 or latest turns 50 to choose a count.
Directory paths are resolved from the current directory and support ~. Sessions without a
working directory are excluded when --dir is present. --dir applies only to collection views,
search, stats, and tree projects.

Source options:
  --source-root <slot-or-id>=<path>  Override one registered adapter root; repeatable
  --source <slot-or-id>              Select registered adapters; repeatable
  --limit-files <n>                  Limit source files per adapter
  --safe                             Enable adapter safe mode

Output options:
  --json                             Machine-readable output for read commands
  --help                             Show this help
  --version                          Show version

There is no sync, import, backup, restore, merge, GC, migration, --store, or --db surface.
`;
}

function defaultIo(): LiteCliIo {
  return {
    cwd: process.cwd(),
    homeDir: os.homedir(),
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    isTTY: Boolean(process.stdout.isTTY),
    now: Date.now,
    columns: process.stdout.columns ?? 100,
  };
}

function singleLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (displayWidth(normalized) <= maxLength) return normalized;
  if (maxLength <= 1) return "…";
  let width = 0;
  let result = "";
  for (const character of normalized) {
    const characterWidth = isWide(character.codePointAt(0) ?? 0) ? 2 : 1;
    if (width + characterWidth + 1 > maxLength) break;
    result += character;
    width += characterWidth;
  }
  return `${result}…`;
}

function padToDisplayWidth(value: string, targetWidth: number): string {
  return value + " ".repeat(Math.max(0, targetWidth - displayWidth(value)));
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    width += isWide(character.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3040 && code <= 0x33bf) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertSafeExportDestination(
  outputPath: string,
  snapshot: LiveHistorySnapshot,
  homeDir: string | undefined,
): Promise<void> {
  assertNotFullStorePath(outputPath);

  try {
    const outputInfo = await lstat(outputPath);
    if (outputInfo.isSymbolicLink()) {
      throw new UsageError("Lite export destination cannot be a symbolic link.");
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }

  const resolvedOutputPath = await resolvePathForContainment(outputPath);
  assertNotFullStorePath(resolvedOutputPath);

  const fullStoreRoot = await resolvePathForContainment(
    path.resolve(homeDir ?? os.homedir(), ".cchistory"),
  );
  if (isPathWithin(fullStoreRoot, resolvedOutputPath)) {
    throw new UsageError("Lite export cannot write into a Full store path.");
  }

  for (const source of snapshot.listSources()) {
    const sourceRoot = await resolvePathForContainment(path.resolve(source.base_dir));
    if (isPathWithin(sourceRoot, resolvedOutputPath)) {
      throw new UsageError("Lite export must be written outside native source roots.");
    }
  }
}

function assertNotFullStorePath(targetPath: string): void {
  const normalized = targetPath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  if (path.basename(normalized) === "cchistory.sqlite" || segments.includes(".cchistory")) {
    throw new UsageError("Lite export cannot write into a Full store path.");
  }
}

async function resolvePathForContainment(targetPath: string): Promise<string> {
  let current = path.resolve(targetPath);
  const missingSegments: string[] = [];
  while (true) {
    try {
      const resolved = await realpath(current);
      return path.resolve(resolved, ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(targetPath);
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR"),
  );
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  let resolved: string;
  try {
    resolved = realpathSync(entry);
  } catch {
    return false;
  }
  return import.meta.url === pathToFileURL(resolved).href;
}

if (isDirectEntry()) {
  runWithAdaptiveNodeMemory(() => runLiteCli(process.argv.slice(2))).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // The main catch already reports errors; the only throws that escape are
      // io failures (broken pipe, closed stderr). Keep the nonzero exit code
      // instead of crashing with an unhandled rejection.
      process.exitCode = 1;
    },
  );
}
