import {
  normalizeLocalPathIdentity,
  type ProjectIdentity,
  type SessionProjection,
  type SessionRelatedWorkProjection,
  type UserTurnProjection,
} from "@cchistory/domain";
import { filterTopLevelSessions } from "./session-collections.js";

export interface DirectoryScopeOptions {
  platform?: NodeJS.Platform;
}

export function normalizeDirectoryScopePath(
  value: string | undefined,
  options: DirectoryScopeOptions = {},
): string | undefined {
  const normalized = normalizeLocalPathIdentity(value);
  if (!normalized) return undefined;
  const platform = options.platform ?? process.platform;
  return platform === "darwin" || platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function pathMatchesDirectoryScope(
  candidatePath: string | undefined,
  directoryScope: string,
  options: DirectoryScopeOptions = {},
): boolean {
  const candidate = normalizeDirectoryScopePath(candidatePath, options);
  const scope = normalizeDirectoryScopePath(directoryScope, options);
  if (!candidate || !scope) return false;
  if (candidate === scope) return true;
  if (scope === "/") return candidate.startsWith("/");
  if (/^[a-z]:\/$/u.test(scope)) return candidate.startsWith(scope);
  return candidate.startsWith(`${scope}/`);
}

export function sessionMatchesDirectoryScope(
  session: SessionProjection | undefined,
  directoryScope: string,
  options: DirectoryScopeOptions = {},
): boolean {
  return pathMatchesDirectoryScope(session?.working_directory, directoryScope, options);
}

export function projectMatchesDirectoryScope(
  project: ProjectIdentity,
  directoryScope: string,
  relatedSessions: readonly SessionProjection[] = [],
  options: DirectoryScopeOptions = {},
): boolean {
  return (
    pathMatchesDirectoryScope(project.primary_workspace_path, directoryScope, options) ||
    pathMatchesDirectoryScope(project.repo_root, directoryScope, options) ||
    relatedSessions.some((session) => sessionMatchesDirectoryScope(session, directoryScope, options))
  );
}

export function filterSessionsByDirectoryScope(
  sessions: readonly SessionProjection[],
  directoryScope: string | undefined,
  options: DirectoryScopeOptions = {},
): SessionProjection[] {
  if (!directoryScope) return [...sessions];
  return sessions.filter((session) => sessionMatchesDirectoryScope(session, directoryScope, options));
}

export function filterTurnsByDirectoryScope(
  turns: readonly UserTurnProjection[],
  sessions: readonly SessionProjection[],
  directoryScope: string | undefined,
  options: DirectoryScopeOptions = {},
): UserTurnProjection[] {
  if (!directoryScope) return [...turns];
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  return turns.filter((turn) =>
    sessionMatchesDirectoryScope(sessionsById.get(turn.session_id), directoryScope, options),
  );
}

export function filterProjectsByDirectoryScope(params: {
  projects: readonly ProjectIdentity[];
  sessions: readonly SessionProjection[];
  turns: readonly UserTurnProjection[];
  directoryScope?: string;
  options?: DirectoryScopeOptions;
}): ProjectIdentity[] {
  const { projects, sessions, turns, directoryScope, options = {} } = params;
  if (!directoryScope) return [...projects];

  const scopedSessionIds = new Set(
    filterSessionsByDirectoryScope(sessions, directoryScope, options).map((session) => session.id),
  );
  const projectIdsBySession = new Map<string, Set<string>>();
  for (const session of sessions) {
    if (!session.primary_project_id) continue;
    projectIdsBySession.set(session.id, new Set([session.primary_project_id]));
  }
  for (const turn of turns) {
    if (!turn.project_id) continue;
    const projectIds = projectIdsBySession.get(turn.session_id) ?? new Set<string>();
    projectIds.add(turn.project_id);
    projectIdsBySession.set(turn.session_id, projectIds);
  }

  return projects.filter((project) => {
    const relatedSessions = sessions.filter((session) =>
      projectIdsBySession.get(session.id)?.has(project.project_id),
    );
    return (
      projectMatchesDirectoryScope(project, directoryScope, relatedSessions, options) ||
      relatedSessions.some((session) => scopedSessionIds.has(session.id))
    );
  });
}

export interface DirectoryScopedProjectTreeProjection {
  projects: Array<{
    project: ProjectIdentity;
    sessions: SessionProjection[];
    turns: UserTurnProjection[];
  }>;
  unlinkedSessions: SessionProjection[];
}

export function buildDirectoryScopedProjectTreeProjection(params: {
  projects: readonly ProjectIdentity[];
  sessions: readonly SessionProjection[];
  turns: readonly UserTurnProjection[];
  relatedWork?: readonly SessionRelatedWorkProjection[];
  directoryScope?: string;
}): DirectoryScopedProjectTreeProjection {
  const { projects, sessions, turns, relatedWork = [], directoryScope } = params;
  const topLevelSessions = filterTopLevelSessions(sessions, relatedWork);
  const scopedSessions = filterSessionsByDirectoryScope(topLevelSessions, directoryScope);
  const scopedSessionIds = new Set(scopedSessions.map((session) => session.id));
  const scopedTurns = turns.filter((turn) => scopedSessionIds.has(turn.session_id));
  const projectNodes = projects.flatMap((project) => {
    const projectTurns = scopedTurns.filter((turn) => turn.project_id === project.project_id);
    const projectSessionIds = new Set(projectTurns.map((turn) => turn.session_id));
    for (const session of scopedSessions) {
      if (session.primary_project_id === project.project_id) projectSessionIds.add(session.id);
    }
    const projectSessions = scopedSessions.filter((session) => projectSessionIds.has(session.id));
    if (directoryScope && projectSessions.length === 0) return [];
    return [{ project, sessions: projectSessions, turns: projectTurns }];
  });
  const linkedSessionIds = new Set(projectNodes.flatMap((node) => node.sessions.map((session) => session.id)));
  return {
    projects: projectNodes,
    unlinkedSessions: scopedSessions.filter((session) => !linkedSessionIds.has(session.id)),
  };
}
