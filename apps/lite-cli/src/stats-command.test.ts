import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { UsageBreakdownSnapshot, UsageMatrixResult } from "@cchistory/domain";
import { scanLiteHistory, type LiveHistorySnapshot } from "@cchistory/live-runtime";
import { runLiteCli, type LiteCliIo } from "./index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const codexRoot = path.join(repoRoot, "mock_data", ".codex", "sessions");
const antigravityRoot = path.join(repoRoot, "mock_data", "fixtures", "antigravity-sqlite");

function captureCliIo(cwd: string, extra: Partial<LiteCliIo> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: LiteCliIo = {
    cwd,
    homeDir: cwd,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    isTTY: false,
    columns: 120,
    ...extra,
  };
  return { io, stdout, stderr };
}

let multiSnapshotPromise: Promise<LiveHistorySnapshot> | undefined;
function getMultiSourceSnapshot(): Promise<LiveHistorySnapshot> {
  multiSnapshotPromise ??= scanLiteHistory({
    homeDir: path.join(repoRoot, "mock_data", "empty-home"),
    hostname: "cchistory-lite-cli-stats-test",
    sourceRefs: ["codex", "antigravity"],
    sourceRoots: [
      { sourceRef: "codex", baseDir: codexRoot },
      { sourceRef: "antigravity", baseDir: antigravityRoot },
    ],
    contextMode: "none",
    safeMode: true,
  });
  return multiSnapshotPromise;
}

test("CLI stats supports four-dimension matrix, pricing config, multipliers, quota, and explain-pricing", async () => {
  const snapshot = await getMultiSourceSnapshot();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cchistory-stats-cli-"));
  try {
    const pricingPath = path.join(tempDir, "pricing.json");
    await writeFile(
      pricingPath,
      JSON.stringify({
        schema: "cchistory-lite-pricing/v1",
        timezone: "UTC",
        aliases: {
          "gemini-pro-orchestrator": "gemini-4-carbon",
        },
        multipliers: {
          "gpt-5": { model: 2, cache_read: 1.5 },
        },
        quota: {
          weekly_usd: 100,
        },
      }),
      "utf8",
    );

    const matrixRun = captureCliIo(tempDir, { scan: async () => snapshot });
    assert.equal(
      await runLiteCli(
        [
          "stats",
          "--no-dir",
          "--by",
          "project,model,source,day",
          "--pricing",
          pricingPath,
          "--alias",
          "gemini-flash-worker-agy=gemini-4-hydrogen",
          "--multiplier",
          "gpt-5=2",
          "--cache-read-multiplier",
          "gpt-5=1.5",
          "--quota",
          "50",
          "--explain-pricing",
          "--json",
        ],
        matrixRun.io,
      ),
      0,
    );

    const payload = JSON.parse(matrixRun.stdout.join("")) as {
      kind: string;
      overview: { cost?: { list_cost_usd: number; adjusted_cost_usd: number; quota_limit_usd?: number } };
      matrix?: UsageMatrixResult;
      model_resolutions?: Array<{ raw_model: string; multipliers: { model: number; cache_read: number } }>;
    };
    assert.equal(payload.kind, "stats");
    assert.ok(payload.overview.cost);
    assert.equal(payload.overview.cost?.quota_limit_usd, 50);
    assert.ok((payload.matrix?.rows.length ?? 0) > 0);
    assert.deepEqual(payload.matrix?.dimensions, ["project", "model", "source", "day"]);
    assert.ok((payload.model_resolutions?.length ?? 0) > 0);

    const humanDefault = captureCliIo(tempDir, { scan: async () => snapshot });
    assert.equal(
      await runLiteCli(["stats", "--no-dir", "--pricing", pricingPath, "--explain-pricing"], humanDefault.io),
      0,
    );
    const rendered = humanDefault.stdout.join("");
    assert.match(rendered, /By project/);
    assert.match(rendered, /By model/);
    assert.match(rendered, /By source/);
    assert.match(rendered, /By day/);
    assert.match(rendered, /Pricing Resolution & Multipliers/);
    assert.match(rendered, /List \$/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI stats --export-pricing emits valid template and blocks unsafe destinations", async () => {
  const snapshot = await getMultiSourceSnapshot();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cchistory-stats-export-"));
  try {
    const stdoutExport = captureCliIo(tempDir, { scan: async () => snapshot });
    assert.equal(await runLiteCli(["stats", "--no-dir", "--export-pricing", "-"], stdoutExport.io), 0);
    const template = JSON.parse(stdoutExport.stdout.join("")) as {
      schema: string;
      aliases: Record<string, string>;
      multipliers: Record<string, { model?: number }>;
    };
    assert.equal(template.schema, "cchistory-lite-pricing/v1");
    assert.ok(Object.keys(template.multipliers).length > 0);

    const fileExportPath = path.join(tempDir, "exported-pricing.json");
    const fileExport = captureCliIo(tempDir, { scan: async () => snapshot });
    assert.equal(await runLiteCli(["stats", "--no-dir", "--quota", "120", "--export-pricing", fileExportPath, "--json"], fileExport.io), 0);
    const written = JSON.parse(await readFile(fileExportPath, "utf8")) as {
      schema: string;
      quota?: { custom_usd?: number };
    };
    assert.equal(written.schema, "cchistory-lite-pricing/v1");
    assert.equal(written.quota?.custom_usd, 120);

    const unsafeStore = captureCliIo(tempDir, { scan: async () => snapshot });
    assert.equal(
      await runLiteCli(["stats", "--no-dir", "--export-pricing", path.join(tempDir, ".cchistory", "pricing.json")], unsafeStore.io),
      2,
    );
    assert.match(unsafeStore.stderr.join(""), /Full store path/);

    const unsafeSource = captureCliIo(tempDir, { scan: async () => snapshot });
    assert.equal(
      await runLiteCli(["stats", "--no-dir", "--export-pricing", path.join(codexRoot, "pricing.json")], unsafeSource.io),
      2,
    );
    assert.match(unsafeSource.stderr.join(""), /outside native source roots/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("CLI stats defaults to CWD scope, filters by --model/--since/--tz, and forwards TUI pricing flags", async () => {
  const snapshot = await getMultiSourceSnapshot();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "cchistory-stats-filter-"));
  try {
    const defaultRun = captureCliIo(tempDir, { scan: async () => snapshot });
    assert.equal(await runLiteCli(["stats", "--json"], defaultRun.io), 0);
    const scopedJson = JSON.parse(defaultRun.stdout.join("")) as {
      breakdown?: UsageBreakdownSnapshot;
      overview: { total_turns: number };
    };
    // No sessions ran inside fresh tempDir, verifying default CWD scope stays enforced
    assert.equal(scopedJson.overview.total_turns, 0);

    const modelFilter = captureCliIo(tempDir, { scan: async () => snapshot });
    assert.equal(
      await runLiteCli(
        ["stats", "--no-dir", "--model", "gpt", "--tz", "Asia/Shanghai", "--week-mode", "iso_week", "--json"],
        modelFilter.io,
      ),
      0,
    );
    const modelPayload = JSON.parse(modelFilter.stdout.join("")) as { breakdown?: UsageBreakdownSnapshot };
    assert.equal(modelPayload.breakdown?.timezone, "Asia/Shanghai");
    assert.equal(modelPayload.breakdown?.week_mode, "iso_week");
    assert.ok(
      (modelPayload.breakdown?.by_model.rows ?? []).every((row) => row.key.toLowerCase().includes("gpt")),
    );

    const spawnedArgs: string[][] = [];
    const tuiRun = captureCliIo(tempDir, {
      spawnTui: async (args) => {
        spawnedArgs.push(args);
        return 0;
      },
    });
    assert.equal(
      await runLiteCli(
        ["tui", "--pricing", "./my-pricing.json", "--quota", "125"],
        tuiRun.io,
      ),
      0,
    );
    assert.deepEqual(spawnedArgs, [["--pricing", path.resolve(tempDir, "./my-pricing.json"), "--quota", "125"]]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
