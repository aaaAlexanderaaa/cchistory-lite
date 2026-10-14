import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, mkdtemp, mkdir, open, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import v8 from "node:v8";
import { createHash } from "node:crypto";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mib = 1024 ** 2;

if (process.argv[2] === "--worker") {
  const [runtimeRoot, sourceRoot, platform, expectedTurns, lockPath] = process.argv.slice(3);
  const jsonWork = { parse_calls: 0, parse_utf16_units: 0, parse_ms: 0, stringify_calls: 0, stringify_utf16_units: 0, stringify_ms: 0 };
  const nativeParse = JSON.parse, nativeStringify = JSON.stringify;
  JSON.parse = function (input, ...args) {
    if (typeof input !== "string" || input.length < 64 * 1024) return nativeParse(input, ...args);
    const started = performance.now();
    try { return nativeParse(input, ...args); } finally {
      jsonWork.parse_calls++; jsonWork.parse_utf16_units += input.length; jsonWork.parse_ms += performance.now() - started;
    }
  };
  JSON.stringify = function (...args) {
    const started = performance.now();
    const output = nativeStringify(...args);
    if (output?.length >= 64 * 1024) {
      jsonWork.stringify_calls++; jsonWork.stringify_utf16_units += output.length; jsonWork.stringify_ms += performance.now() - started;
    }
    return output;
  };
  // Experiment-only native query timing, identical for both builds. No SQL/data is logged.
  const sqlWork = {};
  if (platform === "zcode") {
    const { DatabaseSync } = await import("node:sqlite");
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      const category = /sum\((?:128|152)/.test(sql) ? "admission" : /AS native_locator/.test(sql) ? "part_inventory"
        : /FROM part WHERE/.test(sql) ? "part_value" : /FROM message/.test(sql) ? "messages" : "metadata";
      const measure = run => {
        const start = performance.now();
        try { return run(); } finally {
          const state = sqlWork[category] ??= { calls: 0, elapsed_ms: 0 };
          state.calls++; state.elapsed_ms += performance.now() - start;
        }
      };
      return new Proxy(statement, { get(target, key) {
        if (key === "get" || key === "all") return (...args) => measure(() => target[key](...args));
        if (key === "iterate") return (...args) => {
          const iterator = target.iterate(...args);
          return { next: (...input) => measure(() => iterator.next(...input)),
            return: (...input) => iterator.return?.(...input) ?? { done: true },
            [Symbol.iterator]() { return this; } };
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    };
  }
  const { scanLiteHistory } = await import(pathToFileURL(path.join(runtimeRoot, "packages/live-runtime/dist/index.js")).href);
  let events = 0;
  let maximumAdmittedUnit = 0;
  let parsedUnits = 0;
  let interpretedSessions = 0;
  const stageMs = {};
  const started = performance.now();
  const snapshot = await scanLiteHistory({
    homeDir: path.dirname(sourceRoot), sourceRefs: [platform],
    sourceRoots: [{ sourceRef: platform, baseDir: sourceRoot }], safeMode: true,
    contextMode: "none", retainConversationEvidence: true,
    scanGuard: { profile: "light" }, scanGuardDeps: { lock: { lockPath } },
    onDiagnostic: event => {
      if (event.kind === "budget" && event.decision === "admitted") maximumAdmittedUnit = Math.max(maximumAdmittedUnit, Number(event.requested_bytes) || 0);
    },
    onProgress: event => {
      events++;
      if (event.elapsed_ms !== undefined) stageMs[event.stage] = (stageMs[event.stage] ?? 0) + event.elapsed_ms;
      if (event.stage === "file_parse_progress") parsedUnits = Math.max(parsedUnits, event.count ?? 0);
      if (event.stage === "derive_progress") interpretedSessions = Math.max(interpretedSessions, event.count ?? 0);
      process.stdout.write(JSON.stringify({ progress: event.stage }) + "\n");
    },
  });
  const elapsed = performance.now() - started;
  const status = snapshot.getReadStatus();
  const query = platform === "codex" ? "exponential backoff" : platform === "amp" ? "AMP relies" : "ZCode parent inspected";
  const directoryScope = platform === "zcode" ? "/workspace/zcode-semantic" : undefined;
  const hit = snapshot.searchConversation({ query, limit: 1, directoryScope }).results[0];
  const evidence = hit ? snapshot.readEvidence(hit.turn_id ? { kind: "turn", ref: hit.turn_id }
    : { kind: "session", ref: hit.matched_session_id }, { max_chars: 1024, limit: 10 }, directoryScope) : undefined;
  const taskSuccess = snapshot.data.turns.length === Number(expectedTurns)
    && snapshot.projectionIssues.length === 0 && status.status === "no_known_gaps"
    && evidence?.messages.some(message => message.role === "assistant" && message.text.includes(query));
  const taskElapsed = performance.now() - started;
  // The verification digest is measurement work, not production serialization.
  const semanticDigest = createHash("sha256").update(nativeStringify({
    sessions: snapshot.data.sessions, turns: snapshot.data.turns, conversation_evidence: snapshot.data.conversation_evidence,
    related_work: snapshot.data.related_work, session_contributions: snapshot.data.session_contributions,
    projects: snapshot.data.projects.map(project => ({ id: project.id, committed_turn_count: project.committed_turn_count,
      candidate_turn_count: project.candidate_turn_count, session_count: project.session_count,
      project_last_activity_at: project.project_last_activity_at })),
  })).digest("hex");
  const summary = {
    result: true, task_success: Boolean(taskSuccess), turns: snapshot.data.turns.length,
    sessions: snapshot.data.sessions.length, projection_issues: snapshot.projectionIssues.length,
    read_status: status.status, loss_count: snapshot.data.loss_audits.length,
    elapsed_ms: elapsed, task_elapsed_ms: taskElapsed, query_evidence_ms: taskElapsed - elapsed,
    semantic_digest: semanticDigest, peak_rss_mib: process.resourceUsage().maxRSS / 1024,
    heap_limit_mib: v8.getHeapStatistics().heap_size_limit / mib, events,
    stage_elapsed_ms: stageMs, native_query_work: sqlWork, large_json_work: jsonWork,
    maximum_admitted_native_bytes: maximumAdmittedUnit || null,
    maximum_parse_progress: parsedUnits ? { count: parsedUnits, unit: platform === "zcode" ? "sessions" : "records" } : null,
    maximum_derive_progress_sessions: interpretedSessions,
    collected_records: snapshot.data.sources.reduce((count, source) => count + source.total_records, 0),
    captured_blobs: snapshot.data.sources.reduce((count, source) => count + source.total_blobs, 0),
    retained_turns: snapshot.data.turns.length, retained_contexts: snapshot.data.contexts.length,
    retained_evidence_messages: snapshot.data.conversation_evidence?.length ?? 0,
    retained_evidence_utf16_units: snapshot.data.conversation_evidence?.reduce((count, message) => count + message.text.length, 0) ?? 0,
    node: process.version, platform: os.platform(), arch: os.arch(), host_total_mib: os.totalmem() / mib,
  };
  process.stdout.write(JSON.stringify(summary) + "\n");
} else {
  const baselineIndex = process.argv.indexOf("--baseline");
  const baseline = baselineIndex === -1 ? undefined : process.argv[baselineIndex + 1];
  if (baselineIndex !== -1 && !baseline) throw new Error("--baseline needs a compiled repository path");
  const repeatsIndex = process.argv.indexOf("--repeats");
  const repeats = repeatsIndex === -1 ? 1 : Number(process.argv[repeatsIndex + 1]);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error("--repeats must be an integer from 1 to 5");
  const root = await mkdtemp(path.join(os.tmpdir(), "lite-read-capacity-"));
  const onlyLarge = process.argv.includes("--only-large");
  const onlyZcode = process.argv.includes("--only-zcode");
  const largeDatabase = onlyLarge || process.argv.includes("--large-db");
  const records = (await readFile(path.join(repo, "mock_data/fixtures/agent-evidence/parent.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  const turns = 512;
  const body = "Fixture tool output.\n".repeat(Math.ceil(256 * 1024 / 21));
  const timestamp = offset => new Date(Date.parse("2026-04-12T10:00:00Z") + offset * 1000).toISOString();

  async function codexCorpus(name, sessionCount) {
    const dir = path.join(root, name); await mkdir(dir);
    for (let session = 0; session < sessionCount; session++) {
      const file = await open(path.join(dir, `fixture-${session}.jsonl`), "w");
      try {
        await file.write(JSON.stringify({ ...records[0], payload: { ...records[0].payload, id: `capacity-${session}` } }) + "\n");
        for (let index = 0; index < turns / sessionCount; index++) {
          const callId = `fixture-call-${session}-${index}`;
          const entry = { ...records[1], timestamp: timestamp(index * 4 + 1) };
          await file.write(JSON.stringify(entry) + "\n");
          await file.write(JSON.stringify({ timestamp: timestamp(index * 4 + 2), type: "response_item",
            payload: { type: "function_call", name: "Read", call_id: callId, arguments: '{"file_path":"/fixture/README.md"}' } }) + "\n");
          await file.write(JSON.stringify({ timestamp: timestamp(index * 4 + 3), type: "response_item",
            payload: { type: "function_call_output", call_id: callId, output: `Fixture ${session}/${index}: ${body}` } }) + "\n");
          await file.write(JSON.stringify({ ...records[2], timestamp: timestamp(index * 4 + 4) }) + "\n");
        }
      } finally { await file.close(); }
    }
    let bytes = 0;
    for (let session = 0; session < sessionCount; session++) bytes += (await stat(path.join(dir, `fixture-${session}.jsonl`))).size;
    return { name, sourceRoot: dir, platform: "codex", turns, native_mib: bytes / mib };
  }

  async function zcodeCorpus(large = false) {
    const { DatabaseSync } = await import("node:sqlite");
    const name = large ? "zcode-1.4g" : "zcode";
    const dir = path.join(root, name); await mkdir(path.join(dir, "cli/db"), { recursive: true });
    const file = path.join(dir, "cli/db/db.sqlite");
    const db = new DatabaseSync(file);
    try {
      db.exec(await readFile(path.join(repo, "mock_data/fixtures/context-boundary/zcode/fixture.sql"), "utf8"));
      const messageTemplate = db.prepare("SELECT data FROM message WHERE id = ?").get("parent-assistant").data;
      const tool = JSON.parse(db.prepare("SELECT data FROM part WHERE id = ?").get("parent-tool").data);
      const insertSession = db.prepare("INSERT INTO session VALUES (?, NULL, '/fixture/unrelated-project', NULL, 'Capacity fixture', 'interactive', 1775955600000, 1775955610000, NULL, NULL)");
      const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
      const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
      db.exec("BEGIN");
      for (let session = 0; session < 8; session++) {
        const sid = `capacity-${session}`; insertSession.run(sid);
        for (let index = 0; index < turns / 8; index++) {
          const uid = `${sid}-u-${index}`, aid = `${sid}-a-${index}`, time = 1775955700000 + index * 1000;
          insertMessage.run(uid, sid, time, time, '{"role":"user"}');
          insertMessage.run(aid, sid, time + 1, time + 2, messageTemplate);
          insertPart.run(uid, uid, sid, time, time, '{"type":"text","text":"Inspect the ZCode semantic fixture."}');
          insertPart.run(aid, aid, sid, time + 1, time + 1, '{"type":"text","text":"ZCode parent inspected."}');
          tool.callID = `call-${sid}-${index}`;
          tool.state.output = `Fixture ${session}/${index}: ${large ? body.repeat(10) : body}`;
          insertPart.run(`${aid}-tool`, aid, sid, time + 2, time + 2, JSON.stringify(tool));
        }
      }
      db.exec("COMMIT");
    } finally { db.close(); }
    return { name, sourceRoot: dir, platform: "zcode", turns: turns + 2, native_mib: (await stat(file)).size / mib,
      heap_mib: large ? 2048 : 512, rss_mib: large ? 2560 : 1280 };
  }

  async function ampCorpus() {
    const dir = path.join(root, "amp"); await mkdir(dir);
    const fixture = JSON.parse(await readFile(path.join(repo,
      "mock_data/.local/share/amp/threads/T-019d19fb-1a2b-7345-8cde-0f1a2b3c4d5e.json"), "utf8"));
    fixture.messages[2].content[0].content[0].text = body.repeat(410);
    fixture.messages[3].content = fixture.messages[3].content.filter(item => item.type === "text");
    const file = path.join(dir, `${fixture.id}.json`);
    const handle = await open(file, "w");
    try { await handle.write(JSON.stringify(fixture)); } finally { await handle.close(); }
    return { name: "amp-whole-json", sourceRoot: dir, platform: "amp", turns: 1,
      native_mib: (await stat(file)).size / mib, heap_mib: 1024, rss_mib: 1792 };
  }

  async function measure(corpus, runtimeRoot, label) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [`--max-old-space-size=${corpus.heap_mib ?? 512}`, fileURLToPath(import.meta.url), "--worker",
        runtimeRoot, corpus.sourceRoot, corpus.platform, String(corpus.turns), path.join(root, "scan.lock")],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let text = "", errors = "", outputBytes = 0, lastProgress = Date.now(), stopReason, peakSampledRss = 0;
      const stop = reason => {
        if (stopReason) return; stopReason = reason;
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      };
      child.stdout.on("data", data => {
        outputBytes += data.length; lastProgress = Date.now();
        if (outputBytes > mib) stop("output_limit");
        text = (text + data).slice(-mib);
      });
      child.stderr.on("data", data => {
        outputBytes += data.length;
        if (outputBytes > mib) stop("output_limit");
        errors = (errors + data).slice(-64 * 1024);
      });
      const total = setTimeout(() => stop("time_limit"), 60000);
      const watcher = setInterval(() => {
        if (Date.now() - lastProgress > 20000) stop("no_progress");
        const sample = spawnSync("ps", ["-o", "rss=", "-p", String(child.pid)], { timeout: 1000, maxBuffer: 1024 });
        const rss = Number(sample.stdout?.toString().trim());
        if (sample.status === 0 && rss > 0) {
          peakSampledRss = Math.max(peakSampledRss, rss / 1024);
          if (rss > (corpus.rss_mib ?? 1280) * 1024) stop("rss_limit");
        }
      }, 250);
      child.once("error", error => { clearTimeout(total); clearInterval(watcher); reject(error); });
      child.once("exit", (exitCode, signal) => {
        clearTimeout(total); clearInterval(watcher);
        const summary = text.trim().split("\n").map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(entry => entry?.result);
        resolve({ corpus: corpus.name, build: label, native_mib: corpus.native_mib,
          ...summary, exit_code: exitCode, signal, stop_reason: stopReason ?? null,
          sampled_peak_rss_mib: peakSampledRss || null,
          heap_oom: errors.includes("heap out of memory"), observer: "250ms sampled RSS, not a hard OS quota" });
      });
    });
  }

  try {
    const supervision = spawnSync("ps", ["-o", "rss=", "-p", String(process.pid)], { timeout: 1000, maxBuffer: 1024 });
    if (supervision.status !== 0 || Number(supervision.stdout?.toString().trim()) <= 0) {
      throw new Error("RSS supervision unavailable; rerun in an environment that permits inspecting this experiment's child processes.");
    }
    const corpora = onlyLarge ? [] : onlyZcode ? [await zcodeCorpus()] : [await codexCorpus("one-large-session", 1), await codexCorpus("many-sessions", 64), await zcodeCorpus(), await ampCorpus()];
    if (largeDatabase) {
      const { readAvailableMemoryBytes } = await import(pathToFileURL(path.join(repo, "packages/live-runtime/dist/system-memory.js")).href);
      const available = readAvailableMemoryBytes();
      console.log(JSON.stringify({ experiment: "large-database-preflight", system_available_bytes: available ?? null,
        heap_mib: 2048, sampled_rss_limit_mib: 2560 }));
      if (available === undefined || available < 3 * 1024 ** 3) throw new Error("Insufficient observed host headroom for the optional large database experiment.");
      corpora.push(await zcodeCorpus(true));
    }
    for (const corpus of corpora) {
      for (let run = 1; run <= repeats; run++) {
        const builds = baseline ? [["baseline", path.resolve(baseline)], ["current", repo]] : [["current", repo]];
        // Reverse every other pair so one build is not always the second reader.
        if (run % 2 === 0) builds.reverse();
        const results = {};
        for (const [label, runtimeRoot] of builds) {
          const result = await measure(corpus, runtimeRoot, label);
          results[label] = result;
          console.log(JSON.stringify({ run, ...result }));
        }
        assert.equal(results.current.task_success, true, `Current build did not finish ${corpus.name}, run ${run}`);
        if (results.baseline?.semantic_digest) assert.equal(results.current.semantic_digest, results.baseline.semantic_digest, `Projection parity failed for ${corpus.name}, run ${run}`);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}
