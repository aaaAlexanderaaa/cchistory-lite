import { createInterface } from "node:readline";
import type { ScanLiteHistoryOptions, LiveHistorySnapshot } from "@cchistory/live-runtime";
import { compactPayload, CONTENT_TRUST } from "./json-v2.js";
import {
  QUERY_REQUEST_SCHEMA,
  executeQuery,
  parseQueryRequest,
  queryContextTargets,
  type QueryRequest,
} from "./query.js";

export interface LiteShellIo {
  cwd: string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  isTTY: boolean;
  stdinIsTTY?: boolean;
  stdin?: NodeJS.ReadableStream;
  readLine?: () => Promise<string | null>;
  readStdin?: () => Promise<string>;
}

export async function runLiteShell(input: {
  io: LiteShellIo;
  jsonLines: boolean;
  directoryScope?: string;
  scan: (overrides?: Partial<ScanLiteHistoryOptions>) => Promise<LiveHistorySnapshot>;
}): Promise<number> {
  let snapshot = await input.scan({ contextMode: "none" });
  const refresh = async () => {
    snapshot = await input.scan({ contextMode: "none" });
  };
  if (input.jsonLines) {
    return await runJsonLinesShell(input, () => snapshot, refresh);
  }
  return await runHumanShell(input, () => snapshot, refresh);
}

async function runJsonLinesShell(
  input: {
    io: LiteShellIo;
    directoryScope?: string;
    scan: (overrides?: Partial<ScanLiteHistoryOptions>) => Promise<LiveHistorySnapshot>;
  },
  getSnapshot: () => LiveHistorySnapshot,
  refresh: () => Promise<void>,
): Promise<number> {
  let exitCode = 0;
  for await (const line of readShellLines(input.io, false)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      exitCode = 1;
      input.io.stdout(`${JSON.stringify(controlError("invalid_query_request", error instanceof Error ? error.message : String(error)))}\n`);
      continue;
    }
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
    if (record?.kind === "exit") break;
    if (record?.kind === "refresh") {
      try {
        await refresh();
        input.io.stdout(`${JSON.stringify({ kind: "refreshed", content_trust: CONTENT_TRUST })}\n`);
      } catch (error) {
        exitCode = 1;
        input.io.stdout(`${JSON.stringify(controlError(
          "scan_failed",
          error instanceof Error ? error.message : String(error),
        ))}\n`);
      }
      continue;
    }
    try {
      const request = normalizeShellQuery(parsed);
      const contextTargets = queryContextTargets(request);
      const snapshot = contextTargets.length > 0
        ? await input.scan({ contextMode: "matching", contextTargets })
        : getSnapshot();
      const result = executeQuery(request, snapshot, input.directoryScope);
      input.io.stdout(`${JSON.stringify(result.payload)}\n`);
      if (result.hasOperationErrors) exitCode = 1;
    } catch (error) {
      exitCode = 1;
      input.io.stdout(`${JSON.stringify(controlError(
        "invalid_query_request",
        error instanceof Error ? error.message : String(error),
      ))}\n`);
    }
  }
  return exitCode;
}

async function runHumanShell(
  input: { io: LiteShellIo; directoryScope?: string; scan: (overrides?: Partial<ScanLiteHistoryOptions>) => Promise<LiveHistorySnapshot> },
  getSnapshot: () => LiveHistorySnapshot,
  refresh: () => Promise<void>,
): Promise<number> {
  input.io.stderr(`Lite shell · directory ${input.directoryScope ?? "(all)"} · type help, refresh, or exit\n`);
  for await (const line of readShellLines(input.io, true)) {
    const tokens = tokenizeShellLine(line);
    if (tokens.length === 0) continue;
    const command = tokens[0]!;
    try {
      if (command === "exit" || command === "quit") break;
      if (command === "help") {
        input.io.stdout("Commands: search <query>, latest [sessions|turns] [N], ls sessions|projects|families, show session|turn <ref>, refresh, exit\n");
        continue;
      }
      if (command === "refresh") {
        await refresh();
        input.io.stdout("Refreshed.\n");
        continue;
      }
      const snapshot = getSnapshot();
      if (command === "search") {
        const query = tokens.slice(1).join(" ").trim();
        if (!query) throw new Error("search requires a query.");
        const result = snapshot.searchSessions({ query, directoryScope: input.directoryScope, limit: 20 });
        input.io.stdout(renderShellSearch(query, result.total, result.results));
        continue;
      }
      if (command === "latest") {
        const { kind, limit } = parseShellLatest(tokens.slice(1));
        if (kind === "turns") {
          const turns = snapshot.listResolvedTurns({ directoryScope: input.directoryScope }).slice(0, limit);
          for (const turn of turns) {
            input.io.stdout(`${turn.id}  ${singleLine(turn.canonical_text, 120)}\n`);
          }
        } else {
          const sessions = snapshot.listTopLevelSessions({ directoryScope: input.directoryScope })
            .filter((session) => session.turn_count > 0)
            .slice(0, limit);
          for (const session of sessions) {
            input.io.stdout(`${session.id}  ${session.title ?? session.source_session_id ?? session.id}\n`);
          }
        }
        continue;
      }
      if (command === "ls") {
        const collection = tokens[1] ?? "sessions";
        if (collection === "projects") {
          for (const project of snapshot.listProjects({ directoryScope: input.directoryScope }).slice(0, 20)) {
            input.io.stdout(`${project.project_id}  ${project.display_name}\n`);
          }
        } else if (collection === "sessions") {
          for (const session of snapshot.listTopLevelSessions({ directoryScope: input.directoryScope }).slice(0, 20)) {
            input.io.stdout(`${session.id}  ${session.title ?? session.source_session_id ?? session.id}\n`);
          }
        } else if (collection === "families") {
          for (const family of snapshot.listSessionFamilies({ directoryScope: input.directoryScope }).slice(0, 20)) {
            const parent = snapshot.getSession(family.parent_session_ref);
            input.io.stdout(`${family.parent_session_ref}  ${family.child_count} subagents  ${family.combined.storage_bytes}B  ${parent?.title ?? ""}\n`);
          }
        } else {
          throw new Error("ls target must be sessions, projects, or families.");
        }
        continue;
      }
      if (command === "show") {
        const kind = tokens[1];
        const ref = tokens[2];
        if ((kind !== "session" && kind !== "turn") || !ref) throw new Error("show requires session|turn and a reference.");
        if (kind === "session") {
          const session = snapshot.getSession(ref);
          if (!session) throw new Error(`Session not found: ${ref}.`);
          input.io.stdout(`${session.title ?? session.id}\n`);
          for (const turn of snapshot.listSessionTurns(session.id)) {
            input.io.stdout(`  ${turn.id}  ${singleLine(turn.canonical_text, 120)}\n`);
          }
        } else {
          const detail = await input.scan({ contextMode: "matching", contextTarget: { kind: "turn", ref } });
          const turn = detail.getTurn(ref);
          if (!turn) throw new Error(`UserTurn not found: ${ref}.`);
          const compact = compactPayload({
            schema: "cchistory-lite/v2",
            kind: "turn_detail",
            turn,
            session: detail.getSession(turn.session_id),
            project: turn.project_id ? detail.getProject(turn.project_id) : undefined,
            context: detail.getTurnContext(turn.id),
          }, detail);
          input.io.stdout(`${JSON.stringify(compact, null, 2)}\n`);
        }
        continue;
      }
      throw new Error(`Unknown shell command: ${command}. Type help.`);
    } catch (error) {
      input.io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return 0;
}

function parseShellLatest(positionals: readonly string[]): { kind: "sessions" | "turns"; limit: number } {
  const first = positionals[0];
  const second = positionals[1];
  let kind: "sessions" | "turns" = "sessions";
  let rawLimit: string | undefined;
  if (first && /^\d+$/u.test(first)) {
    if (second) throw new Error("latest <N> does not accept a second positional argument.");
    rawLimit = first;
  } else if (first) {
    if (first === "session" || first === "sessions") kind = "sessions";
    else if (first === "turn" || first === "turns") kind = "turns";
    else throw new Error(`latest kind must be sessions or turns; received ${JSON.stringify(first)}.`);
    rawLimit = second;
  }
  if (positionals.length > 2) throw new Error("latest accepts at most a kind and count.");
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("latest count must be an integer >= 1.");
  return { kind, limit };
}

function normalizeShellQuery(value: unknown): QueryRequest {
  if (value && typeof value === "object" && !Array.isArray(value) && "operations" in value) {
    return parseQueryRequest(JSON.stringify(value));
  }
  const operation = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (!operation) throw new Error("Query line must be a JSON object.");
  const id = typeof operation.id === "string" && operation.id.trim() ? operation.id : "op";
  return parseQueryRequest(JSON.stringify({
    schema: QUERY_REQUEST_SCHEMA,
    operations: [{ ...operation, id }],
  }));
}

function controlError(code: string, message: string): Record<string, unknown> {
  return { kind: "error", error: { code, message } };
}

function renderShellSearch(
  query: string,
  total: number,
  results: ReturnType<LiveHistorySnapshot["searchSessions"]>["results"],
): string {
  const shown = results.length;
  const count = shown === total ? `${total}` : `${shown} of ${total}`;
  const lines = [`Search ${JSON.stringify(query)} (${count} sessions; one record = one session)`];
  for (const result of results) {
    const title = result.session.title ?? result.session.canonical_title ?? result.session.id;
    lines.push(`- ${result.session.id}`, `  ${singleLine(title, 180)}`);
    if (result.best_turn && result.match_field !== "title") {
      lines.push(`  ${singleLine(result.best_turn.canonical_text, 180)}`);
    }
  }
  if (total > shown) lines.push(`… and ${total - shown} more`);
  return `${lines.join("\n")}\n`;
}

function singleLine(value: string, width: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length <= width) return compact;
  return `${compact.slice(0, Math.max(1, width - 1))}…`;
}

function tokenizeShellLine(line: string): string[] {
  const tokens: string[] = [];
  const matcher = /"([^"]*)"|'([^']*)'|[^\s]+/gu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(line)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[0]!);
  }
  return tokens;
}

async function* readShellLines(io: LiteShellIo, prompt: boolean): AsyncGenerator<string> {
  if (io.readLine) {
    while (true) {
      const line = await io.readLine();
      if (line === null) return;
      yield line;
    }
  }
  const input = io.stdin ?? process.stdin;
  const rl = createInterface({
    input,
    output: prompt ? process.stdout : undefined,
    terminal: prompt ? Boolean(io.isTTY) : false,
    crlfDelay: Infinity,
  });
  try {
    if (prompt) {
      rl.setPrompt("lite> ");
      rl.prompt();
    }
    for await (const line of rl) {
      yield String(line);
      if (prompt) rl.prompt();
    }
  } finally {
    rl.close();
  }
}
