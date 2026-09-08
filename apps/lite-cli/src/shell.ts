import { once } from "node:events";
import { createInterface } from "node:readline";
import { SQL_REQUEST_SCHEMA, QueryValidationError, MAX_QUERY_REQUEST_BYTES, type ScanLiteHistoryOptions, type LiveHistorySnapshot } from "@cchistory/live-runtime";
import { resourceError } from "./resource-errors.js";
import { compactPayload, CONTENT_TRUST } from "./json-v2.js";
import {
  QueryRequestError,
  QUERY_REQUEST_SCHEMA,
  executePreparedQuery,
  prepareQueryRequest,
  queryContextTargets,
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
  flush?: () => Promise<void>;
}

export interface ShellClock {
  setTimeout: (callback: () => void, milliseconds: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}
const systemClock: ShellClock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer as NodeJS.Timeout) };
interface ShellLifetime { idleTimeoutSeconds?: number; clock?: ShellClock }

export async function runLiteShell(input: ShellLifetime & {
  io: LiteShellIo;
  jsonLines: boolean;
  directoryScope?: string;
  scan: (overrides?: Partial<ScanLiteHistoryOptions>) => Promise<LiveHistorySnapshot>;
}): Promise<number> {
  const idle = input.idleTimeoutSeconds ?? 300;
  if (!Number.isSafeInteger(idle) || idle < 0 || idle > 86400) throw new QueryValidationError("idle-timeout must be an integer from 0 to 86400 seconds.", "budget");
  let snapshot: LiveHistorySnapshot | undefined;
  const publish = (next: LiveHistorySnapshot) => {
    snapshot = next;
    if (!input.jsonLines) reportShellDiagnostics(next, input.io, input.directoryScope);
    return next;
  };
  const getSnapshot = async () => snapshot ?? publish(await input.scan({ contextMode: "none" }));
  const refresh = async () => { publish(await input.scan({ contextMode: "none" })); };
  try {
    if (input.jsonLines) return await runJsonLinesShell(input, getSnapshot, refresh);
    return await runHumanShell(input, getSnapshot, refresh);
  } finally { snapshot = undefined; }
}

function reportShellDiagnostics(snapshot: LiveHistorySnapshot, io: LiteShellIo, directoryScope?: string): void {
  const scope = snapshot.getDirectoryScopeDiagnostics(directoryScope);
  if (scope?.unknown_directory_sessions) io.stderr(`Directory attribution is unknown for ${scope.unknown_directory_sessions} observed sessions; excluded from this scoped result.\n`);
  for (const source of snapshot.data.sources) if (source.error_message) io.stderr(`Source ${source.slot_id}: ${source.error_message}\n`);
  for (const issue of snapshot.projectionIssues) io.stderr(`Projection issue ${issue.code}: ${issue.detail}\n`);
}

async function runJsonLinesShell(
  input: ShellLifetime & {
    io: LiteShellIo;
    directoryScope?: string;
    scan: (overrides?: Partial<ScanLiteHistoryOptions>) => Promise<LiveHistorySnapshot>;
  },
  getSnapshot: () => Promise<LiveHistorySnapshot>,
  refresh: () => Promise<void>,
): Promise<number> {
  let exitCode = 0;
  for await (const line of readShellLines(input.io, false, input)) {
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
          error instanceof Error ? error.message : String(error), error,
        ))}\n`);
      }
      continue;
    }
    try {
      const request = await normalizeShellQuery(parsed);
      const contextTargets = request.schema === SQL_REQUEST_SCHEMA ? [] : queryContextTargets(request);
      const snapshot = contextTargets.length > 0
        ? await input.scan({ contextMode: "matching", contextTargets })
        : await getSnapshot();
      const result = executePreparedQuery(request, snapshot, input.directoryScope);
      input.io.stdout(`${JSON.stringify(result.payload)}\n`);
      if (result.hasOperationErrors) exitCode = 1;
    } catch (error) {
      exitCode = 1;
      input.io.stdout(`${JSON.stringify(controlError(
        error instanceof QueryValidationError || error instanceof QueryRequestError ? "invalid_query_request" : "scan_failed",
        error instanceof Error ? error.message : String(error), error,
      ))}\n`);
    }
  }
  return exitCode;
}

async function runHumanShell(
  input: ShellLifetime & { io: LiteShellIo; directoryScope?: string; scan: (overrides?: Partial<ScanLiteHistoryOptions>) => Promise<LiveHistorySnapshot> },
  getSnapshot: () => Promise<LiveHistorySnapshot>,
  refresh: () => Promise<void>,
): Promise<number> {
  input.io.stderr(`Lite shell · directory ${input.directoryScope ?? "(all)"} · type help, refresh, or exit\n`);
  for await (const line of readShellLines(input.io, true, input)) {
    const tokens = tokenizeShellLine(line);
    if (tokens.length === 0) continue;
    const command = tokens[0]!;
    try {
      if (command === "exit" || command === "quit") break;
      if (command === "help") {
        input.io.stdout("Commands: search <query>, latest [sessions|turns] [N], ls sessions|projects|families, show session|turn <ref>, SELECT ... LIMIT N, refresh, exit\n");
        continue;
      }
      if (command === "refresh") {
        await refresh();
        input.io.stdout("Refreshed.\n");
        continue;
      }
      if (command === "search") {
        const query = tokens.slice(1).join(" ").trim();
        if (!query) throw new Error("search requires a query.");
        const snapshot = await getSnapshot();
        const result = snapshot.searchSessions({ query, directoryScope: input.directoryScope, limit: 20 });
        input.io.stdout(renderShellSearch(query, result.total, result.results));
        continue;
      }
      if (command === "latest") {
        const { kind, limit } = parseShellLatest(tokens.slice(1));
        const snapshot = await getSnapshot();
        const selected = snapshot.selectCollectionTemplate(kind === "turns" ? "latest-turns" : "latest-sessions", limit, 0, { directoryScope: input.directoryScope });
        for (const id of selected.ids) {
          if (kind === "turns") {
            const turn = snapshot.getTurn(id)!;
            input.io.stdout(`${turn.id}  ${singleLine(turn.canonical_text, 120)}\n`);
          } else {
            const session = snapshot.getSession(id)!;
            input.io.stdout(`${session.id}  ${session.title ?? session.source_session_id ?? session.id}\n`);
          }
        }
        continue;
      }
      if (command === "ls") {
        const collection = tokens[1] ?? "sessions";
        if (!["projects", "sessions", "families"].includes(collection)) throw new Error("ls target must be sessions, projects, or families.");
        const snapshot = await getSnapshot();
        if (collection === "projects") {
          for (const project of snapshot.listProjects({ directoryScope: input.directoryScope }).slice(0, 20)) {
            input.io.stdout(`${project.project_id}  ${project.display_name}\n`);
          }
        } else if (collection === "sessions") {
          for (const id of snapshot.selectCollectionTemplate("list-sessions", 20, 0, { directoryScope: input.directoryScope }).ids) {
            const session = snapshot.getSession(id)!;
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
          const snapshot = await getSnapshot();
          const session = snapshot.getSession(ref);
          if (!session) throw new Error(`Session not found: ${ref}.`);
          input.io.stdout(`${session.title ?? session.id}\n`);
          for (const turn of snapshot.listSessionTurns(session.id)) {
            input.io.stdout(`  ${turn.id}  ${singleLine(turn.canonical_text, 120)}\n`);
          }
        } else {
          const detail = await input.scan({ contextMode: "matching", contextTarget: { kind: "turn", ref } });
          reportShellDiagnostics(detail, input.io, input.directoryScope);
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
      if (/^\s*(?:SELECT\b|--|\/\*)/iu.test(line)) {
        const request = await prepareQueryRequest(JSON.stringify({ schema: SQL_REQUEST_SCHEMA, operations: [{ id: "query", kind: "sql", sql: line }] }));
        input.io.stdout(`${JSON.stringify(executePreparedQuery(request, await getSnapshot(), input.directoryScope).payload, null, 2)}\n`);
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

async function normalizeShellQuery(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value) && "operations" in value) {
    return prepareQueryRequest(JSON.stringify(value));
  }
  const operation = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!operation) throw new Error("Query line must be a JSON object.");
  const id = operation.kind === "sql" ? operation.id === undefined ? "query" : operation.id
    : typeof operation.id === "string" && operation.id.trim() ? operation.id : "op";
  return prepareQueryRequest(JSON.stringify({
    schema: operation.kind === "sql" ? SQL_REQUEST_SCHEMA : QUERY_REQUEST_SCHEMA,
    operations: [{ ...operation, id }],
  }));
}

function controlError(code: string, message: string, cause?: unknown): Record<string, unknown> {
  return { kind: "error", error: { code, message, ...resourceError(cause), ...(cause instanceof QueryValidationError ? { reason: cause.reason, operation_id: cause.operationId } : {}) } };
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

async function* readShellLines(io: LiteShellIo, prompt: boolean, lifetime: ShellLifetime): AsyncGenerator<string> {
  const clock = lifetime.clock ?? systemClock, milliseconds = (lifetime.idleTimeoutSeconds ?? 300) * 1000;
  const input = io.stdin ?? process.stdin;
  const rl = io.readLine ? undefined : createInterface({ input, output: prompt ? process.stdout : undefined, terminal: prompt ? Boolean(io.isTTY) : false, crlfDelay: Infinity });
  const iterator = rl?.[Symbol.asyncIterator]();
  let timer: unknown, waiting = false, expire: (() => void) | undefined;
  let lineBytes = 0, inputError: Error | undefined;
  const clear = () => { if (timer !== undefined) clock.clearTimeout(timer); timer = undefined; };
  const reset = () => { clear(); if (waiting && milliseconds) timer = clock.setTimeout(() => expire?.(), milliseconds); };
  const activity = (chunk: string | Buffer) => {
    for (const piece of String(chunk).split(/(?<=\n)/u)) {
      lineBytes += Buffer.byteLength(piece);
      if (lineBytes > MAX_QUERY_REQUEST_BYTES) { inputError = new QueryValidationError("Shell line exceeds 1 MiB.", "budget"); expire?.(); rl?.close(); break; }
      if (piece.endsWith("\n")) lineBytes = 0;
    }
    reset();
  };
  if (!io.readLine) input.on("data", activity);
  try {
    if (prompt && rl) { rl.setPrompt("lite> "); rl.prompt(); }
    while (true) {
      if (inputError) throw inputError;
      waiting = true;
      let expired = false;
      const expiry = new Promise<null>(resolve => { expire = () => { expired = true; resolve(null); }; });
      reset();
      const pending = io.readLine ? io.readLine() : iterator!.next().then(result => result.done ? null : String(result.value));
      const line = await Promise.race([pending, expiry]);
      waiting = false; expire = undefined; clear();
      if (inputError) throw inputError;
      if (line === null) {
        if (expired && prompt) io.stderr("Lite shell closed after idle timeout.\n");
        return;
      }
      if (Buffer.byteLength(line) > MAX_QUERY_REQUEST_BYTES) throw new QueryValidationError("Shell line exceeds 1 MiB.", "budget");
      yield line;
      if (io.flush) await io.flush();
      else if (process.stdout.writableNeedDrain) await once(process.stdout, "drain");
      if (prompt) rl?.prompt();
    }
  } finally { waiting = false; clear(); input.off("data", activity); rl?.close(); }
}
