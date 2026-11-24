import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SourceDefinition } from "@cchistory/domain";
import { getDefaultSourcesForHost, listSourceFiles } from "../index.js";
import { getPlatformAdapter, listPlatformAdapters, listPlatformAdaptersBySupportTier } from "../platforms/registry.js";
import { extractDeepSeekHarnessSeeds } from "../platforms/deepseek-harness/reader.js";
import { createSourceDefinition, getRepoMockDataRoot } from "../test-helpers.js";
import { runSourceProbe } from "../probe-reference.test.js";

const fixtureRoot = path.join(getRepoMockDataRoot(), ".deepseek-harness/sessions");

function zstdCompress(value: Buffer): Buffer | undefined {
  const factory = (zlib as unknown as { zstdCompressSync?: (buffer: Buffer) => Buffer }).zstdCompressSync;
  return typeof factory === "function" ? factory(value) : undefined;
}

async function withTempRoot(prefix: string, body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function deepSeekHarnessSource(baseDir: string): SourceDefinition {
  return createSourceDefinition("src-deepseek-harness", "deepseek_harness", baseDir);
}

test("[deepseek_harness] registers as an experimental local coding agent source", () => {
  const adapter = getPlatformAdapter("deepseek_harness");
  assert.ok(adapter);
  assert.equal(adapter.supportTier, "experimental");
  assert.equal(adapter.sessionTargeting, "file");
  assert.equal(adapter.projectionBoundary, "source");
  assert.ok(listPlatformAdapters().some((entry) => entry.platform === "deepseek_harness"));
  assert.deepEqual(
    listPlatformAdaptersBySupportTier("experimental").map((entry) => entry.platform).includes("deepseek_harness"),
    true,
  );

  assert.ok(adapter.matchesSourceFile("/tmp/dsh/sessions/--p--/session-1/session.v4.jsonl"));
  assert.ok(adapter.matchesSourceFile("/tmp/dsh/sessions/--p--/session-1/session.jsonl.zstd"));
  assert.equal(adapter.matchesSourceFile("/tmp/dsh/sessions/--p--/session-1/summary.json"), false);
  assert.equal(adapter.matchesSourceFile("/tmp/dsh/sessions/--p--/session-1/notes.jsonl"), false);
});

test("[deepseek_harness] default discovery resolves $DSH_HOME/sessions and ~/.dsh/sessions", () => {
  const adapter = getPlatformAdapter("deepseek_harness");
  assert.ok(adapter);
  const candidates = adapter.getDefaultBaseDirCandidates({ homeDir: "/Users/tester", env: {} });
  assert.deepEqual(candidates, [path.join("/Users/tester", ".dsh", "sessions")]);
  const overridden = adapter.getDefaultBaseDirCandidates({
    homeDir: "/Users/tester",
    env: { DSH_HOME: "/opt/dsh-home" },
  });
  assert.deepEqual(overridden, [path.join("/opt/dsh-home", "sessions"), path.join("/Users/tester", ".dsh", "sessions")]);
  for (const candidate of candidates) {
    assert.equal(path.basename(candidate), "sessions");
  }

  const sources = getDefaultSourcesForHost({
    homeDir: "/Users/tester",
    hostname: "dsh-test-host",
    platform: "darwin",
    env: {},
    pathExists: (targetPath) => targetPath === path.join("/Users/tester", ".dsh", "sessions"),
  });
  const resolved = sources.find((source) => source.platform === "deepseek_harness");
  assert.ok(resolved);
  assert.equal(resolved.display_name, "DeepSeek Harness");
  assert.equal(resolved.family, "local_coding_agent");
});

test("[deepseek_harness] retains the current session generation when older formats coexist", async () => {
  await withTempRoot("cchistory-dsh-generations-", async (root) => {
    const sessionDir = path.join(root, "sessions", "--project--", "session-fixture-generations");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "session.v3.jsonl"), "{}\n", "utf8");
    await writeFile(path.join(sessionDir, "session.v4.jsonl.zstd"), "stub", "utf8");
    await writeFile(path.join(sessionDir, "session.lock"), "", "utf8");

    const adapter = getPlatformAdapter("deepseek_harness");
    assert.ok(adapter?.filterSourceFiles);
    assert.deepEqual(
      adapter.filterSourceFiles(
        [
          path.join(sessionDir, "session.v3.jsonl"),
          path.join(sessionDir, "session.v4.jsonl.zstd"),
          path.join(sessionDir, "session.lock"),
        ],
        root,
      ),
      [path.join(sessionDir, "session.v4.jsonl.zstd")],
    );
  });
});

test("[deepseek_harness] fixture sessions project turns, per-call usage, tools, and a delegated child", async () => {
  const source = deepSeekHarnessSource(fixtureRoot);
  const files = await listSourceFiles("deepseek_harness", fixtureRoot);
  assert.equal(files.length, 2);

  const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
  assert.ok(payload);
  assert.equal(payload.source.sync_status, "healthy");
  assert.equal(payload.sessions.length, 2);

  const parent = payload.sessions.find((session) => session.id === "sess:deepseek_harness:session-fixture-dsh-main");
  assert.ok(parent);
  assert.equal(parent.source_session_id, "session-fixture-dsh-main");
  assert.equal(parent.title, "Retry backoff helper");
  assert.equal(parent.model, "deepseek-v4-pro");
  assert.equal(parent.working_directory, "/Users/mock_user/workspace/dsh-demo");
  assert.equal(parent.created_at, "2026-10-02T09:00:00.000Z");
  assert.equal(parent.updated_at, "2026-10-02T09:00:07.000Z");
  assert.equal(parent.turn_count, 2);

  const child = payload.sessions.find((session) => session.id === "sess:deepseek_harness:session-fixture-dsh-child");
  assert.ok(child);
  assert.equal(child.turn_count, 1);

  const parentTurns = payload.turns.filter((turn) => turn.session_id === parent.id);
  assert.deepEqual(
    parentTurns.map((turn) => turn.canonical_text),
    ["Find the retry helper and explain its backoff.", "Now show the timeout constant."],
  );
  const [firstTurn, secondTurn] = parentTurns;
  assert.equal(firstTurn?.context_summary?.token_usage?.total_tokens, 44_396);
  assert.equal(firstTurn?.user_messages.some((message) => message.is_injected), true);
  assert.equal(secondTurn?.context_summary?.token_usage?.total_tokens, 22_684);

  const usageFragments = payload.fragments.filter((fragment) => fragment.fragment_kind === "token_usage_signal");
  assert.equal(usageFragments.length, 4);
  assert.ok(usageFragments.every((fragment) => typeof fragment.payload.independent_usage_event_id === "string"));
  assert.ok(usageFragments.every((fragment) => fragment.payload.scope === "call"));

  const toolResults = payload.fragments.filter((fragment) => fragment.fragment_kind === "tool_result");
  assert.equal(toolResults.length, 2);
  assert.equal(toolResults.some((fragment) => fragment.payload.is_error === true), true);
  assert.equal(
    toolResults.some((fragment) => fragment.payload.error_code === "COMMAND_FAILED"),
    true,
  );

  const relation = payload.fragments.find((fragment) => fragment.fragment_kind === "session_relation");
  assert.ok(relation);
  assert.equal(relation.payload.child_session_id, "session-fixture-dsh-child");
  assert.equal(relation.payload.relation_source, "subagent_catalog");
  assert.deepEqual(payload.loss_audits, []);

  const targeted = (
    await runSourceProbe({ source_ids: [source.id], target_session_refs: [parent.id] }, [source])
  ).sources[0];
  assert.ok(targeted);
  assert.deepEqual(targeted.sessions.map((session) => session.id), [parent.id]);
  assert.deepEqual(targeted.turns.map((turn) => turn.id), parentTurns.map((turn) => turn.id));

  await assert.rejects(
    runSourceProbe({ source_ids: [source.id], target_session_refs: ["missing-session"] }, [source]),
    /requested session/u,
  );
});

test("[deepseek_harness] compresses and decompresses to the same projection", async () => {
  await withTempRoot("cchistory-dsh-zstd-", async (root) => {
    const plainPath = path.join(fixtureRoot, "--Users-mock-user-workspace-dsh-demo--", "session-fixture-dsh-main", "session.v4.jsonl");
    const plain = await readFile(plainPath);
    const compressed = zstdCompress(plain);
    if (!compressed) {
      return;
    }
    const sessionDir = path.join(root, "sessions", "--Users-mock-user-workspace-dsh-demo--", "session-fixture-dsh-main");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, "session.v4.jsonl.zstd"), compressed);

    const source = deepSeekHarnessSource(root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.sessions[0]?.id, "sess:deepseek_harness:session-fixture-dsh-main");
    assert.deepEqual(
      payload.turns.map((turn) => [turn.canonical_text, turn.context_summary?.token_usage?.total_tokens]),
      [
        ["Find the retry helper and explain its backoff.", 44_396],
        ["Now show the timeout constant.", 22_684],
      ],
    );
    assert.deepEqual(payload.loss_audits, []);
  });
});

test("[deepseek_harness] a truncated trailing frame keeps the complete prefix", async () => {
  await withTempRoot("cchistory-dsh-truncated-", async (root) => {
    const plainPath = path.join(fixtureRoot, "--Users-mock-user-workspace-dsh-demo--", "session-fixture-dsh-main", "session.v4.jsonl");
    const lines = (await readFile(plainPath, "utf8")).split("\n").filter(Boolean);
    const firstTurnCut = lines.findIndex((line) => JSON.parse(line).type === "turn/start" && JSON.parse(line).data.turn === 2);
    assert.ok(firstTurnCut > 0);
    const firstFrame = zstdCompress(Buffer.from(`${lines.slice(0, firstTurnCut).join("\n")}\n`));
    const secondFrame = zstdCompress(Buffer.from(`${lines.slice(firstTurnCut).join("\n")}\n`));
    if (!firstFrame || !secondFrame) {
      return;
    }
    const sessionDir = path.join(root, "sessions", "--project--", "session-fixture-truncated");
    await mkdir(sessionDir, { recursive: true });
    // Simulate a crash during the second append: the first frame is complete,
    // the trailing frame is cut before its checksum.
    const truncatedTail = secondFrame.subarray(0, Math.max(4, secondFrame.length - 12));
    await writeFile(path.join(sessionDir, "session.v4.jsonl.zstd"), Buffer.concat([firstFrame, truncatedTail]));

    const source = deepSeekHarnessSource(root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.sessions.length, 1);
    assert.equal(payload.turns.length, 1);
    assert.equal(payload.turns[0]?.canonical_text, "Find the retry helper and explain its backoff.");
    assert.ok(payload.loss_audits.some((audit) => audit.diagnostic_code === "dsh_zstd_partial_frame"));
  });
});

test("[deepseek_harness] malformed records and unsupported formats degrade with diagnostics", async () => {
  await withTempRoot("cchistory-dsh-malformed-", async (root) => {
    const sessionDir = path.join(root, "sessions", "--project--", "session-fixture-malformed");
    await mkdir(sessionDir, { recursive: true });
    const header = {
      type: "session",
      version: 4,
      id: "session-fixture-malformed",
      createdAt: Date.UTC(2026, 9, 2, 9, 0, 0),
      cwd: "/Users/mock_user/workspace/dsh-demo",
    };
    await writeFile(
      path.join(sessionDir, "session.v4.jsonl"),
      [
        JSON.stringify(header),
        "{ this is not json",
        JSON.stringify({
          type: "user/message",
          seq: 0,
          time: Date.UTC(2026, 9, 2, 9, 0, 1),
          data: { content: [{ type: "text", text: "Keep the readable turn." }], source: { kind: "user" }, role: "user", id: "m1" },
        }),
        JSON.stringify({ type: "future/unknown-event", seq: 1, time: Date.UTC(2026, 9, 2, 9, 0, 2), data: {} }),
        JSON.stringify({
          type: "assistant/message",
          seq: 2,
          time: Date.UTC(2026, 9, 2, 9, 0, 3),
          data: {
            turn: 1,
            step: 1,
            message: {
              role: "assistant",
              id: "m2",
              source: { kind: "model", provider: "deepseek", model: "deepseek-v4-pro" },
              content: [{ type: "text", text: "Readable reply." }],
            },
            usage: { inputTokens: 10, outputTokens: 2 },
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const source = deepSeekHarnessSource(root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.equal(payload.turns.length, 1);
    assert.ok(payload.loss_audits.some((audit) => audit.diagnostic_code === "dsh_malformed_jsonl_record"));
    assert.ok(payload.loss_audits.some((audit) => audit.diagnostic_code === "dsh_unhandled_event_type"));

    const legacyDir = path.join(root, "sessions", "--project--", "session-fixture-legacy");
    await mkdir(legacyDir, { recursive: true });
    await writeFile(
      path.join(legacyDir, "session.v3.jsonl"),
      [
        JSON.stringify({ ...header, version: 3, id: "session-fixture-legacy" }),
        JSON.stringify({ type: "user/message", seq: 0, time: Date.UTC(2026, 9, 2, 9, 0, 1), data: { content: [], source: { kind: "user" } } }),
      ].join("\n"),
      "utf8",
    );

    const [withLegacy] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(withLegacy);
    const legacySession = withLegacy.sessions.find((session) => session.id === "sess:deepseek_harness:session-fixture-legacy");
    assert.ok(legacySession);
    assert.equal(legacySession.turn_count, 0);
    assert.ok(withLegacy.loss_audits.some((audit) => audit.diagnostic_code === "dsh_unsupported_session_format"));
  });
});

test("[deepseek_harness] a tagged fork seed does not duplicate inherited parent history", async () => {
  await withTempRoot("cchistory-dsh-fork-", async (root) => {
    const sessionDir = path.join(root, "sessions", "--project--", "session-fixture-fork");
    await mkdir(sessionDir, { recursive: true });
    const base = Date.UTC(2026, 9, 2, 9, 0, 0);
    const rows = [
      { type: "session", version: 4, id: "session-fixture-fork", createdAt: base, cwd: "/Users/mock_user/workspace/dsh-demo", isSeeded: true, delegationDepth: 0 },
      { type: "turn/start", seq: 0, time: base + 1_000, data: { turn: 1 } },
      { type: "user/message", seq: 1, time: base + 2_000, data: { content: [{ type: "text", text: "Inherited prompt." }], source: { kind: "user" }, role: "user", id: "inherited-user" } },
      { type: "session/end-seed", seq: 2, time: base + 3_000, data: { inherited: true } },
      { type: "turn/start", seq: 3, time: base + 4_000, data: { turn: 2 } },
      { type: "user/message", seq: 4, time: base + 5_000, data: { content: [{ type: "text", text: "Fork-only prompt." }], source: { kind: "user" }, role: "user", id: "fork-user" } },
      { type: "assistant/message", seq: 5, time: base + 6_000, data: { turn: 2, step: 1, message: { role: "assistant", id: "fork-assistant", source: { kind: "model", provider: "deepseek", model: "deepseek-v4-pro" }, content: [{ type: "text", text: "Fork-only reply." }] }, usage: { inputTokens: 12, outputTokens: 3 } } },
    ];
    await writeFile(path.join(sessionDir, "session.v4.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");

    const seeds = await extractDeepSeekHarnessSeeds(path.join(sessionDir, "session.v4.jsonl"), await readFile(path.join(sessionDir, "session.v4.jsonl")));
    assert.equal(seeds.length, 1);
    assert.ok(seeds[0]?.diagnostics?.some((diagnostic) => diagnostic.code === "dsh_fork_seed_prefix_omitted"));

    const source = deepSeekHarnessSource(root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(payload);
    assert.deepEqual(payload.turns.map((turn) => turn.canonical_text), ["Fork-only prompt."]);
    assert.equal(payload.turns[0]?.context_summary?.assistant_reply_count, 1);
  });
});

test("[deepseek_harness] multi-frame concatenated zstd decodes every frame, charges read budget, and preserves cacheWriteTokens", async () => {
  await withTempRoot("cchistory-dsh-multiframe-", async (root) => {
    const plainPath = path.join(fixtureRoot, "--Users-mock-user-workspace-dsh-demo--", "session-fixture-dsh-main", "session.v4.jsonl");
    const lines = (await readFile(plainPath, "utf8")).split("\n").filter(Boolean);
    const firstTurnCut = lines.findIndex((line) => JSON.parse(line).type === "turn/start" && JSON.parse(line).data.turn === 2);
    assert.ok(firstTurnCut > 0);
    // Inject cacheWriteTokens into turn 2's assistant message to verify cache creation extraction.
    const secondHalf = lines.slice(firstTurnCut).map((line) => {
      const parsed = JSON.parse(line);
      if (parsed.type === "assistant/message" && parsed.data?.usage) {
        parsed.data.usage.cacheWriteTokens = 100;
        parsed.data.usage.totalTokens += 100;
        return JSON.stringify(parsed);
      }
      return line;
    });
    const frame1 = zstdCompress(Buffer.from(`${lines.slice(0, firstTurnCut).join("\n")}\n`));
    const frame2 = zstdCompress(Buffer.from(`${secondHalf.join("\n")}\n`));
    if (!frame1 || !frame2) {
      return;
    }
    const sessionDir = path.join(root, "sessions", "--project--", "session-fixture-dsh-main");
    await mkdir(sessionDir, { recursive: true });
    const multiFramePath = path.join(sessionDir, "session.v4.jsonl.zstd");
    const combined = Buffer.concat([frame1, frame2]);
    await writeFile(multiFramePath, combined);

    const admittedUnits: string[] = [];
    const budget = {
      admit(_bytes: number, unit: string): void {
        admittedUnits.push(unit);
      },
      maximumUnitBytes(): number {
        return 64 * 1024 * 1024;
      },
    };
    const source = deepSeekHarnessSource(root);
    const [payload] = (await runSourceProbe({ source_ids: [source.id], read_budget: budget }, [source])).sources;
    assert.ok(payload);
    assert.deepEqual(
      payload.turns.map((turn) => [turn.canonical_text, turn.context_summary?.token_usage?.total_tokens]),
      [
        ["Find the retry helper and explain its backoff.", 44_396],
        ["Now show the timeout constant.", 22_784],
      ],
      "every concatenated Zstandard frame must be decoded on Node 22+",
    );
    assert.equal(payload.turns[1]?.context_summary?.token_usage?.cache_creation_input_tokens, 100);
    assert.ok(admittedUnits.some((unit) => unit.endsWith(":zstd decoded")), "zstd expansion must charge the read budget");
    assert.deepEqual(payload.loss_audits, []);

    // Corrupt .zstd with broken magic reports dsh_zstd_decode_failed instead of parsing binary as JSONL.
    const corruptDir = path.join(root, "sessions", "--project--", "session-fixture-corrupt-zstd");
    await mkdir(corruptDir, { recursive: true });
    await writeFile(path.join(corruptDir, "session.v4.jsonl.zstd"), Buffer.from([0x28, 0xb5]));
    const [withCorrupt] = (await runSourceProbe({ source_ids: [source.id] }, [source])).sources;
    assert.ok(withCorrupt?.loss_audits.some((audit) => audit.diagnostic_code === "dsh_zstd_decode_failed"));
  });
});
