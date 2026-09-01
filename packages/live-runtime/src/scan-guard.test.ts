import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acquireScanLock,
  assessScanRisk,
  createScanWatchdog,
  defaultScanLockPath,
  formatScanGuardBytes,
  isScanGuardEnabled,
  readAvailableMemoryBytes,
  scanLiteHistory,
  ScanGuardAbortedError,
  ScanGuardRefusedError,
  type ScanGuardEvent,
  type ScanGuardRequest,
  type ScanGuardRuntimeDeps,
} from "./index.js";
import { calculateAdaptiveOldSpaceMiB, resolveAdaptiveOldSpaceMiB } from "./node-memory.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const mockDataRoot = path.join(repoRoot, "mock_data");
const codexRoot = path.join(mockDataRoot, ".codex", "sessions");
const emptyHome = path.join(mockDataRoot, "empty-home");
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function guardedFixtureScan(scanGuard: ScanGuardRequest, scanGuardDeps?: ScanGuardRuntimeDeps) {
  return scanLiteHistory({
    homeDir: emptyHome,
    hostname: "cchistory-lite-guard-test-host",
    sourceRefs: ["codex"],
    sourceRoots: [{ sourceRef: "codex", baseDir: codexRoot }],
    safeMode: true,
    contextMode: "none",
    scanGuard,
    scanGuardDeps,
  });
}

// ── Pre-flight estimate ──

test("scan guard thresholds: ok at exactly 50%, warn up to exactly 75%, refuse above", async () => {
  const available = 1024;
  const assess = (bytes: number, profile: "light" | "full" = "light") =>
    assessScanRisk(
      { roots: ["/root"], profile },
      { walkRootBytes: async () => bytes, readAvailableBytes: () => available },
    );
  // light ×4: 512 is exactly 50% of 1024 → ok; 768 is exactly 75% → warn.
  assert.equal((await assess(128)).status, "ok");
  assert.equal((await assess(129)).status, "warn");
  assert.equal((await assess(192)).status, "warn");
  assert.equal((await assess(193)).status, "refuse");
  const refusal = await assess(193);
  assert.equal(refusal.estimatedBytes, 193 * 4);
  assert.equal(refusal.scannedBytes, 193);
  assert.equal(refusal.availableBytes, available);
  assert.deepEqual(refusal.roots, [{ path: "/root", bytes: 193 }]);
});

test("scan guard assessment records per-root bytes and slot labels", async () => {
  const assessment = await assessScanRisk(
    {
      roots: [
        { path: "/a", slot_id: "claude_code" },
        { path: "/b", slot_id: "codex" },
      ],
      profile: "light",
    },
    {
      walkRootBytes: async (root) => (root === "/a" ? 100 : 50),
      readAvailableBytes: () => 1024,
    },
  );
  assert.equal(assessment.scannedBytes, 150);
  assert.deepEqual(assessment.roots, [
    { path: "/a", bytes: 100, slot_id: "claude_code" },
    { path: "/b", bytes: 50, slot_id: "codex" },
  ]);
});

test("scan guard multiplier: full scans estimate 8×, light scans 4×", async () => {
  const deps = { walkRootBytes: async () => 100, readAvailableBytes: () => 1024 };
  const light = await assessScanRisk({ roots: ["/root"], profile: "light" }, deps);
  assert.equal(light.estimatedBytes, 400);
  assert.equal(light.status, "ok");
  const full = await assessScanRisk({ roots: ["/root"], profile: "full" }, deps);
  assert.equal(full.estimatedBytes, 800);
  assert.equal(full.status, "refuse");
});

test("scan guard degrades to ok when the walk fails or availability is unknown", async () => {
  const walkFailure = await assessScanRisk(
    { roots: ["/root"], profile: "light" },
    {
      walkRootBytes: async () => {
        throw new Error("EACCES");
      },
      readAvailableBytes: () => 1024,
    },
  );
  assert.equal(walkFailure.status, "ok");
  assert.match(walkFailure.detail, /could not walk/);

  const unknown = await assessScanRisk(
    { roots: ["/root"], profile: "full" },
    { walkRootBytes: async () => 10 * GIB, readAvailableBytes: () => undefined },
  );
  assert.equal(unknown.status, "ok");
  assert.match(unknown.detail, /unknown/);
  assert.equal(unknown.estimatedBytes, 80 * GIB);
});

test("scan guard walk sums regular files, honors the limitFiles cap, and never follows symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-walk-"));
  try {
    await writeFile(path.join(root, "a.jsonl"), Buffer.alloc(512));
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "b.jsonl"), Buffer.alloc(512));
    await writeFile(path.join(root, "nested", "c.jsonl"), Buffer.alloc(512));
    await writeFile(path.join(root, "nested", "d.jsonl"), Buffer.alloc(512));
    // A symlinked cycle and a symlinked file must be skipped, not followed.
    await symlink(root, path.join(root, "loop"));
    await symlink(path.join(root, "a.jsonl"), path.join(root, "alias.jsonl"));

    const scannedBytes = async (limitFiles?: number) =>
      (
        await assessScanRisk(
          { roots: [root], limitFiles, profile: "light" },
          { readAvailableBytes: () => 1024 * GIB },
        )
      ).scannedBytes;
    assert.equal(await scannedBytes(), 4 * 512);
    assert.equal(await scannedBytes(2), 2 * 512);
    assert.equal(await scannedBytes(1), 512);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan guard walk treats a missing root as zero bytes", async () => {
  const assessment = await assessScanRisk(
    { roots: [path.join(os.tmpdir(), "cchistory-lite-no-such-root-xyz")], profile: "light" },
    { readAvailableBytes: () => 1024 * GIB },
  );
  assert.equal(assessment.status, "ok");
  assert.equal(assessment.scannedBytes, 0);
});

// ── Available-memory reading ──

test("available memory prefers Linux MemAvailable, falls back to freemem, and obeys the cgroup cap", () => {
  const meminfo = "MemTotal: 33554432 kB\nMemFree: 1024 kB\nMemAvailable: 16777216 kB\nBuffers: 1 kB\n";
  assert.equal(
    readAvailableMemoryBytes({
      platform: "linux",
      readMeminfo: () => meminfo,
      freemem: () => 111,
      constrainedMemory: () => 0,
    }),
    16777216 * 1024,
  );
  // MemAvailable predates older kernels: fall back to freemem.
  assert.equal(
    readAvailableMemoryBytes({
      platform: "linux",
      readMeminfo: () => "MemTotal: 33554432 kB\nMemFree: 2048 kB\n",
      freemem: () => 4096,
      constrainedMemory: () => 0,
    }),
    4096,
  );
  // An unreadable meminfo falls back to freemem rather than unknown.
  assert.equal(
    readAvailableMemoryBytes({
      platform: "linux",
      readMeminfo: () => {
        throw new Error("EPERM");
      },
      freemem: () => 8192,
      constrainedMemory: () => 0,
    }),
    8192,
  );
  // Non-Linux reads freemem directly.
  assert.equal(
    readAvailableMemoryBytes({ platform: "darwin", freemem: () => 16384, constrainedMemory: () => 0 }),
    16384,
  );
  // An enforced cgroup limit caps the host-wide signal.
  assert.equal(
    readAvailableMemoryBytes({
      platform: "linux",
      readMeminfo: () => meminfo,
      freemem: () => 0,
      constrainedMemory: () => 1024,
    }),
    1024,
  );
  // Every signal failing means unknown, never an error.
  assert.equal(
    readAvailableMemoryBytes({
      platform: "linux",
      readMeminfo: () => {
        throw new Error("EPERM");
      },
      freemem: () => {
        throw new Error("no sysinfo");
      },
      constrainedMemory: () => {
        throw new Error("no cgroup");
      },
    }),
    undefined,
  );
});

// ── Adaptive heap ceiling ──

test("adaptive heap ceiling tracks available memory between a 512 MiB floor and the 4 GiB cap", () => {
  // Big idle machine: available ≈ total, so the R43 cap still holds.
  assert.equal(calculateAdaptiveOldSpaceMiB(32 * GIB, 32 * GIB), 4096);
  assert.equal(calculateAdaptiveOldSpaceMiB(32 * GIB, 8 * GIB), 4096);
  // Memory-tight machine: half of what is actually free.
  assert.equal(calculateAdaptiveOldSpaceMiB(32 * GIB, 4 * GIB), 2048);
  assert.equal(calculateAdaptiveOldSpaceMiB(8 * GIB, 2 * GIB), 1024);
  // Floor: below ~512 MiB old-space Lite could not project at all.
  assert.equal(calculateAdaptiveOldSpaceMiB(32 * GIB, 600 * MIB), 512);
  assert.equal(calculateAdaptiveOldSpaceMiB(32 * GIB, 1), 512);
  // Unknown availability keeps the pre-guard total/2 policy, never worse.
  assert.equal(calculateAdaptiveOldSpaceMiB(8 * GIB), 4096);
  assert.equal(calculateAdaptiveOldSpaceMiB(3 * GIB), 1536);
  assert.equal(calculateAdaptiveOldSpaceMiB(3 * GIB, Number.NaN), 1536);
  assert.equal(calculateAdaptiveOldSpaceMiB(3 * GIB, 0), 1536);
});

test("resolveAdaptiveOldSpaceMiB treats a throwing reader as unknown availability", () => {
  assert.equal(resolveAdaptiveOldSpaceMiB(32 * GIB, () => 4 * GIB), 2048);
  assert.equal(resolveAdaptiveOldSpaceMiB(32 * GIB, () => undefined), 4096);
  assert.equal(
    resolveAdaptiveOldSpaceMiB(32 * GIB, () => {
      throw new Error("no meminfo");
    }),
    4096,
  );
});

// ── Advisory scan lock ──

test("scan lock holds only pid and startedAt, and release removes it", async () => {
  const lockDir = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-lock-"));
  try {
    const lockPath = path.join(lockDir, "scan.lock");
    const acquired = await acquireScanLock({ lockPath });
    if (!acquired.acquired) assert.fail("expected the first acquire to succeed");
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), ["pid", "startedAt"]);
    assert.equal(parsed.pid, process.pid);
    assert.ok(!Number.isNaN(Date.parse(String(parsed.startedAt))));
    await acquired.handle.release();
    await assert.rejects(access(lockPath));
    // Releasing twice is safe.
    await acquired.handle.release();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
});

test("scan lock serializes contenders: the second waits, then acquires after release", async () => {
  const lockDir = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-lock-"));
  try {
    const lockPath = path.join(lockDir, "scan.lock");
    const first = await acquireScanLock({ lockPath });
    if (!first.acquired) assert.fail("expected the first acquire to succeed");

    let fakeNow = 0;
    let sleeps = 0;
    const second = await acquireScanLock({
      lockPath,
      now: () => fakeNow,
      sleep: async (ms) => {
        fakeNow += ms;
        sleeps += 1;
        if (sleeps === 2) await first.handle.release();
      },
      maxWaitMs: 10_000,
      pollIntervalMs: 100,
    });
    if (!second.acquired) assert.fail("expected the second acquire to succeed after the release");
    assert.ok(sleeps >= 2);
    const holder = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    assert.equal(holder.pid, process.pid);
    await second.handle.release();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
});

test("scan lock refuses after the bounded wait while a live holder persists", async () => {
  const lockDir = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-lock-"));
  try {
    const lockPath = path.join(lockDir, "scan.lock");
    const first = await acquireScanLock({ lockPath });
    if (!first.acquired) assert.fail("expected the first acquire to succeed");

    let fakeNow = 0;
    const second = await acquireScanLock({
      lockPath,
      now: () => fakeNow,
      sleep: async (ms) => {
        fakeNow += ms;
      },
      maxWaitMs: 1_000,
      pollIntervalMs: 300,
    });
    assert.equal(second.acquired, false);
    if (second.acquired) assert.fail("unreachable");
    assert.ok(second.waitedMs >= 1_000);
    assert.equal(second.holder?.pid, process.pid);
    await first.handle.release();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
});

test("scan lock reclaims stale holders: dead pid, expired age, and corrupt contents", async () => {
  const lockDir = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-lock-"));
  try {
    const lockPath = path.join(lockDir, "scan.lock");

    await writeFile(lockPath, JSON.stringify({ pid: 987654, startedAt: new Date().toISOString() }));
    const deadPid = await acquireScanLock({ lockPath, isProcessAlive: () => false });
    if (!deadPid.acquired) assert.fail("expected a dead-pid lock to be reclaimed");
    assert.equal((JSON.parse(await readFile(lockPath, "utf8")) as { pid: number }).pid, process.pid);
    await deadPid.handle.release();

    const expired = new Date(Date.now() - 31 * 60_000).toISOString();
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: expired }));
    const wedged = await acquireScanLock({ lockPath });
    if (!wedged.acquired) assert.fail("expected an expired lock to be reclaimed");
    await wedged.handle.release();

    await writeFile(lockPath, "this is not json");
    const corrupt = await acquireScanLock({ lockPath });
    if (!corrupt.acquired) assert.fail("expected a corrupt lock to be reclaimed");
    await corrupt.handle.release();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
});

test("scan lock degrades to proceeding without it when the lock dir is unusable", async () => {
  const lockDir = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-lock-"));
  try {
    const blocker = path.join(lockDir, "blocker");
    await writeFile(blocker, "a regular file, not a directory");
    const acquired = await acquireScanLock({ lockPath: path.join(blocker, "scan.lock") });
    if (!acquired.acquired) assert.fail("an unusable lock dir must degrade, not block");
    assert.match(acquired.degradedDetail ?? "", /proceeding without it/);
    await acquired.handle.release();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
});

test("the default scan lock lives in the runtime/temp dir and never under a Full store path", () => {
  assert.equal(
    defaultScanLockPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, () => "/tmp"),
    path.join("/run/user/1000", "cchistory-lite-scan.lock"),
  );
  const fallback = defaultScanLockPath({}, () => "/tmp");
  assert.ok(fallback.startsWith(path.join("/tmp", "cchistory-lite-scan")));
  assert.ok(fallback.endsWith(".lock"));
  for (const candidate of [fallback, defaultScanLockPath({ XDG_RUNTIME_DIR: "/run/user/1000" }, () => "/tmp")]) {
    assert.ok(!candidate.toLowerCase().includes(".cchistory"));
  }
});

// ── Scan watchdog ──

test("scan watchdog floor is max(512 MiB, 5% of total memory)", () => {
  assert.equal(
    createScanWatchdog({ totalBytes: 8 * GIB, readAvailableBytes: () => undefined }).floorBytes,
    512 * MIB,
  );
  assert.equal(
    createScanWatchdog({ totalBytes: 64 * GIB, readAvailableBytes: () => undefined }).floorBytes,
    Math.floor(64 * GIB * 0.05),
  );
});

test("scan watchdog checks on the file cadence and aborts below the floor", () => {
  const floor = 512 * MIB;
  const readings = [10 * floor, 10 * floor, floor - 1];
  let readIndex = 0;
  const watchdog = createScanWatchdog({
    readAvailableBytes: () => readings[Math.min(readIndex++, readings.length - 1)]!,
    floorBytes: floor,
    now: () => 0, // time never advances: only the file cadence can trigger a check
    checkEveryFiles: 2,
    checkIntervalMs: 1_000,
  });
  watchdog.observeProgress({ stage: "file_start" });
  assert.equal(readIndex, 0);
  watchdog.observeProgress({ stage: "file_start" });
  assert.equal(readIndex, 1);
  watchdog.observeProgress({ stage: "file_done" }); // not a counted stage
  watchdog.observeProgress({ stage: "file_start" });
  watchdog.observeProgress({ stage: "file_start" });
  assert.equal(readIndex, 2);
  watchdog.observeProgress({ stage: "file_start" });
  assert.throws(() => watchdog.observeProgress({ stage: "file_start" }), ScanGuardAbortedError);
  // A recorded breach re-throws at checkpoints even with no further events.
  assert.throws(() => watchdog.assertHealthy(), ScanGuardAbortedError);
});

test("scan watchdog checks on the time cadence for slow scans with few files", () => {
  const floor = 512 * MIB;
  let now = 0;
  let reads = 0;
  const watchdog = createScanWatchdog({
    readAvailableBytes: () => {
      reads += 1;
      return 10 * floor;
    },
    floorBytes: floor,
    now: () => now,
    checkEveryFiles: 1_000,
    checkIntervalMs: 500,
  });
  watchdog.observeProgress({ stage: "source_start" });
  assert.equal(reads, 0);
  now = 600;
  watchdog.observeProgress({ stage: "derive_start" });
  assert.equal(reads, 1);
});

test("scan watchdog never aborts on a failed or unknown memory read", () => {
  const failing = createScanWatchdog({
    readAvailableBytes: () => {
      throw new Error("no meminfo");
    },
    floorBytes: 1,
    now: () => 0,
    checkEveryFiles: 1,
  });
  failing.observeProgress({ stage: "file_start" });
  failing.assertHealthy();

  const unknown = createScanWatchdog({
    readAvailableBytes: () => undefined,
    floorBytes: 1,
    now: () => 0,
    checkEveryFiles: 1,
  });
  unknown.observeProgress({ stage: "file_start" });
  unknown.assertHealthy();
});

// ── Kill-switch and messages ──

test("CCHISTORY_SCAN_GUARD kill-switch parsing", () => {
  assert.equal(isScanGuardEnabled(undefined), true);
  assert.equal(isScanGuardEnabled("1"), true);
  assert.equal(isScanGuardEnabled("yes"), true);
  assert.equal(isScanGuardEnabled("0"), false);
  assert.equal(isScanGuardEnabled("false"), false);
  assert.equal(isScanGuardEnabled(" FALSE "), false);
});

test("refusal and warning text name the numbers, the bounds, and the override", async () => {
  const assessment = await assessScanRisk(
    { roots: ["/root"], profile: "light" },
    { walkRootBytes: async () => 193, readAvailableBytes: () => 1024 },
  );
  const estimateRefusal = new ScanGuardRefusedError({ reason: "estimated_memory", assessment });
  assert.match(estimateRefusal.message, /Refusing to scan/);
  assert.match(estimateRefusal.message, /772 B/);
  assert.match(estimateRefusal.message, /1\.0 KiB/);
  assert.match(estimateRefusal.message, /Selected source roots:/);
  assert.match(estimateRefusal.message, /\/root/);
  assert.match(estimateRefusal.message, /193 B/);
  assert.match(estimateRefusal.message, /this scan has no --dir filter/);
  assert.match(estimateRefusal.message, /--source <slot>/);
  assert.match(estimateRefusal.message, /--limit-files/);
  assert.match(estimateRefusal.message, /`sample`/);
  assert.match(estimateRefusal.message, /ls sources --limit-files 1/);
  assert.match(estimateRefusal.message, /`shell` \/ `query`/);
  assert.match(estimateRefusal.message, /CCHISTORY_SCAN_GUARD=0/);
  assert.doesNotMatch(estimateRefusal.message, /does not shrink source bytes/);
  assert.doesNotMatch(estimateRefusal.message, /Narrow the scan with --source, --dir/);

  const scopedAssessment = await assessScanRisk(
    { roots: ["/root"], profile: "light", directoryScoped: true },
    { walkRootBytes: async () => 193, readAvailableBytes: () => 1024 },
  );
  assert.equal(scopedAssessment.directoryScoped, true);
  const scopedRefusal = new ScanGuardRefusedError({ reason: "estimated_memory", assessment: scopedAssessment });
  assert.match(scopedRefusal.message, /Selected source roots after --dir filter:/);
  assert.match(scopedRefusal.message, /already limited this estimate/);
  assert.doesNotMatch(scopedRefusal.message, /no --dir filter/);

  const lockRefusal = new ScanGuardRefusedError({
    reason: "scan_in_progress",
    holder: { pid: 4321, startedAt: "2026-08-30T00:00:00.000Z" },
    waitedMs: 30_000,
  });
  assert.match(lockRefusal.message, /pid 4321/);
  assert.match(lockRefusal.message, /waited 30s/);
  assert.match(lockRefusal.message, /`shell` \/ `query`/);
  assert.match(lockRefusal.message, /`sample` and `show session <exact id>` bypass/);
  assert.match(lockRefusal.message, /CCHISTORY_SCAN_GUARD=0/);

  const abort = new ScanGuardAbortedError({ availableBytes: 300 * MIB, floorBytes: 512 * MIB });
  assert.match(abort.message, /Scan aborted/);
  assert.match(abort.message, /300 MiB/);
  assert.match(abort.message, /512 MiB/);
  assert.match(abort.message, /CCHISTORY_SCAN_GUARD=0/);

  assert.equal(formatScanGuardBytes(512), "512 B");
  assert.equal(formatScanGuardBytes(1536), "1.5 KiB");
  assert.equal(formatScanGuardBytes(200 * GIB), "200 GiB");
});

// ── Guarded scan integration ──

test("a guarded scan over the tiny fixture corpus assesses ok and succeeds without events", async () => {
  // The existing suite relies on this: mock_data fixtures are tiny, so the
  // guard never fires there.
  const assessment = await assessScanRisk({ roots: [codexRoot], profile: "light" });
  assert.equal(assessment.status, "ok");

  const events: ScanGuardEvent[] = [];
  const snapshot = await scanLiteHistory({
    homeDir: emptyHome,
    hostname: "cchistory-lite-guard-test-host",
    sourceRefs: ["codex"],
    sourceRoots: [{ sourceRef: "codex", baseDir: codexRoot }],
    safeMode: true,
    contextMode: "none",
    scanGuard: { profile: "light" },
    onScanGuardEvent: (event) => events.push(event),
  });
  assert.ok(snapshot.listSources().length > 0);
  assert.deepEqual(events, []);
});

test("a guarded scan refuses behind a held lock; bypassed probes skip the lock", async () => {
  const lockDir = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-scan-lock-"));
  try {
    const lockPath = path.join(lockDir, "scan.lock");
    const held = await acquireScanLock({ lockPath });
    if (!held.acquired) assert.fail("expected to hold the lock");
    try {
      let fakeNow = 0;
      const lock = {
        lockPath,
        now: () => fakeNow,
        sleep: async (ms: number) => {
          fakeNow += ms;
        },
        maxWaitMs: 1_000,
        pollIntervalMs: 250,
      };
      await assert.rejects(
        guardedFixtureScan({ profile: "light" }, { lock }),
        (error: unknown) => {
          assert.ok(error instanceof ScanGuardRefusedError);
          assert.equal(error.reason, "scan_in_progress");
          assert.equal(error.holder?.pid, process.pid);
          return true;
        },
      );
      // sample / exact-id show bypass: bounded probes never queue behind a scan.
      const snapshot = await guardedFixtureScan({ profile: "light", bypass: true }, { lock });
      assert.ok(snapshot.listSources().length > 0);
    } finally {
      await held.handle.release();
    }
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
});

test("an estimate refusal releases the scan lock", async () => {
  const lockDir = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-scan-lock-"));
  try {
    const lockPath = path.join(lockDir, "scan.lock");
    await assert.rejects(
      guardedFixtureScan(
        { profile: "light" },
        {
          lock: { lockPath },
          walkRootBytes: async () => GIB,
          readAvailableBytes: () => 96 * MIB,
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ScanGuardRefusedError);
        assert.equal(error.reason, "estimated_memory");
        assert.match(error.message, /CCHISTORY_SCAN_GUARD=0/);
        return true;
      },
    );
    await assert.rejects(access(lockPath));
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
});

test("a warn assessment emits exactly one event and the scan proceeds", async () => {
  const events: ScanGuardEvent[] = [];
  const snapshot = await scanLiteHistory({
    homeDir: emptyHome,
    hostname: "cchistory-lite-guard-test-host",
    sourceRefs: ["codex"],
    sourceRoots: [{ sourceRef: "codex", baseDir: codexRoot }],
    safeMode: true,
    contextMode: "none",
    scanGuard: { profile: "light" },
    onScanGuardEvent: (event) => events.push(event),
    scanGuardDeps: {
      walkRootBytes: async () => 100,
      // 400 estimated > 350 (50% of 700) but < 525 (75%) → warn, then proceed.
      readAvailableBytes: () => 700,
    },
  });
  assert.ok(snapshot.listSources().length > 0);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "warn");
  if (events[0]?.type === "warn") assert.equal(events[0].assessment.status, "warn");
});

test("the watchdog aborts a guarded scan when available memory collapses mid-probe", async () => {
  let reads = 0;
  const readAvailableBytes = () => {
    reads += 1;
    // The first read serves the pre-flight estimate; later reads serve the watchdog.
    return reads === 1 ? 16 * GIB : 64 * MIB;
  };
  await assert.rejects(
    guardedFixtureScan(
      { profile: "light" },
      { readAvailableBytes, watchdog: { checkEveryFiles: 1, floorBytes: 512 * MIB } },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ScanGuardAbortedError);
      assert.match(error.message, /safety floor/);
      assert.match(error.message, /CCHISTORY_SCAN_GUARD=0/);
      return true;
    },
  );
  assert.ok(reads > 1);
});

test("a --dir estimate prices matching source files and ignores junk plus out-of-scope Codex sessions", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-dir-estimate-"));
  const hugeRoot = path.join(tempHome, "codex-sessions");
  try {
    await cp(codexRoot, hugeRoot, { recursive: true });
    const junk = path.join(hugeRoot, "huge.bin");
    await writeFile(junk, "");
    await truncate(junk, 256 * GIB);
    const outsideSession = path.join(hugeRoot, "huge-outside.jsonl");
    await writeFile(
      outsideSession,
      `${JSON.stringify({
        timestamp: "2026-08-01T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "huge-outside", cwd: "/workspace/other" },
      })}\n`,
    );
    await truncate(outsideSession, 256 * GIB);
    const tightMemory = { readAvailableBytes: () => 512 * MIB };

    await assert.rejects(
      scanLiteHistory({
        homeDir: emptyHome,
        hostname: "cchistory-lite-dir-estimate-host",
        sourceRefs: ["codex"],
        sourceRoots: [{ sourceRef: "codex", baseDir: hugeRoot }],
        safeMode: true,
        contextMode: "none",
        scanGuard: { profile: "light" },
        scanGuardDeps: tightMemory,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ScanGuardRefusedError);
        assert.equal(error.reason, "estimated_memory");
        assert.equal(error.assessment?.directoryScoped, undefined);
        assert.match(error.message, /this scan has no --dir filter/);
        return true;
      },
    );

    const scoped = await scanLiteHistory({
      homeDir: emptyHome,
      hostname: "cchistory-lite-dir-estimate-host",
      sourceRefs: ["codex"],
      sourceRoots: [{ sourceRef: "codex", baseDir: hugeRoot }],
      directoryScope: "/workspace/codex-delegated",
      safeMode: true,
      contextMode: "none",
      scanGuard: { profile: "light" },
      scanGuardDeps: tightMemory,
    });
    assert.ok(scoped.listResolvedSessions({ directoryScope: "/workspace/codex-delegated" }).length > 0);
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("a --dir estimate keeps a logical-session group whose known cwds conflict", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "cchistory-lite-dir-conflict-"));
  const hugeRoot = path.join(tempHome, "codex-sessions");
  try {
    await mkdir(hugeRoot, { recursive: true });
    const writeSession = async (fileName: string, cwd: string, day: string): Promise<string> => {
      const filePath = path.join(hugeRoot, fileName);
      await writeFile(
        filePath,
        `${JSON.stringify({
          timestamp: `2026-08-0${day}T00:00:00.000Z`,
          type: "session_meta",
          payload: { id: "cwd-conflict", cwd },
        })}\n`,
      );
      return filePath;
    };
    await writeSession("split-a.jsonl", "/workspace/alpha", "1");
    const splitB = await writeSession("split-b.jsonl", "/workspace/beta", "2");
    await truncate(splitB, 256 * GIB);
    await assert.rejects(
      scanLiteHistory({
        homeDir: emptyHome,
        hostname: "cchistory-lite-dir-conflict-host",
        sourceRefs: ["codex"],
        sourceRoots: [{ sourceRef: "codex", baseDir: hugeRoot }],
        directoryScope: "/workspace/gamma",
        safeMode: true,
        contextMode: "none",
        scanGuard: { profile: "light" },
        scanGuardDeps: { readAvailableBytes: () => 512 * MIB },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ScanGuardRefusedError);
        assert.equal(error.reason, "estimated_memory");
        assert.equal(error.assessment?.directoryScoped, true);
        assert.ok((error.assessment?.scannedBytes ?? 0) >= 256 * GIB);
        return true;
      },
    );
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("CCHISTORY_SCAN_GUARD=0 disables the lock, the estimate, and the watchdog", async () => {
  process.env.CCHISTORY_SCAN_GUARD = "0";
  try {
    const snapshot = await guardedFixtureScan(
      { profile: "light" },
      {
        walkRootBytes: async () => {
          throw new Error("the walk must not run with the guard disabled");
        },
        readAvailableBytes: () => {
          throw new Error("memory must not be read with the guard disabled");
        },
      },
    );
    assert.ok(snapshot.listSources().length > 0);
  } finally {
    delete process.env.CCHISTORY_SCAN_GUARD;
  }
});
