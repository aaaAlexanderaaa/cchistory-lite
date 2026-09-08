import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDarwinAvailableBytes, readAvailableMemory } from "./system-memory.js";
import { assessScanRisk, createScanWatchdog, ScanGuardRefusedError } from "./scan-guard.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const darwin = readFileSync(new URL("../../../mock_data/fixtures/system-memory/darwin-vm-stat.txt", import.meta.url), "utf8");
const macDeps = {
  platform: "darwin" as const,
  readVmStat: () => darwin,
  availableMemory: () => 64 * MIB,
  freemem: () => 64 * MIB,
  totalmem: () => 64 * GIB,
  constrainedMemory: () => 0,
};

test("macOS counts free plus inactive pages, without double-counting other categories", () => {
  const reading = readAvailableMemory(macDeps);
  assert.deepEqual(reading, { bytes: 12 * GIB + 64 * MIB, source: "darwin_vm_stat" });
  assert.equal(parseDarwinAvailableBytes(darwin.replace("16384 bytes", "4096 bytes")), reading.bytes! / 4);
  assert.equal(readAvailableMemory({ ...macDeps, totalmem: () => 8 * GIB }).bytes, 8 * GIB);
  assert.equal(readAvailableMemory({ ...macDeps, constrainedMemory: () => GIB }).bytes, GIB);
});

test("missing or malformed macOS counters stay unknown instead of reviving a free-page budget", () => {
  for (const raw of ["", darwin.replace("Pages inactive:", "Inactive:"), darwin.replace("16384 bytes", "0 bytes"),
    darwin.replace("786432.", "9007199254740992."), darwin.replace("4096.", "-1.")]) {
    assert.deepEqual(readAvailableMemory({ ...macDeps, readVmStat: () => raw }), { bytes: undefined, source: "unknown" });
  }
  assert.deepEqual(readAvailableMemory({ ...macDeps, readVmStat: () => { throw new Error("EPERM"); } }),
    { bytes: undefined, source: "unknown" });
  const exhausted = darwin.replace("4096.", "0.").replace("786432.", "0.");
  assert.equal(readAvailableMemory({ ...macDeps, readVmStat: () => exhausted }).bytes, 0);
});

test("Linux uses host MemAvailable and preserves the remaining known cgroup quota, including zero", () => {
  const deps = { platform: "linux" as const, totalmem: () => 64 * GIB,
    readMeminfo: () => "MemFree: 65536 kB\nMemAvailable: 12582912 kB\n", availableMemory: () => 64 * MIB };
  assert.deepEqual(readAvailableMemory({ ...deps, constrainedMemory: () => 0 }), { bytes: 12 * GIB, source: "linux_memavailable" });
  for (const available of [0, 128 * MIB]) {
    assert.deepEqual(readAvailableMemory({ ...deps, constrainedMemory: () => GIB, availableMemory: () => available }),
      { bytes: available, source: "node_available", constrainedBytes: GIB });
  }
});

test("guard uses macOS reclaimable-memory estimate but still refuses work exceeding remaining V8 heap", async () => {
  const deps = { readMemory: () => readAvailableMemory(macDeps), readHeapBytes: () => 4 * GIB };
  const input = { roots: ["/synthetic"], profile: "light" as const };
  // Would have failed against 64 MiB of unused pages despite ample inactive pages.
  const allowed = await assessScanRisk(input, { ...deps, walkRootBytes: async () => 64 * MIB });
  assert.equal(allowed.status, "ok");
  assert.equal(allowed.systemAvailableBytes, 12 * GIB + 64 * MIB);
  assert.equal(allowed.heapAvailableBytes, 4 * GIB);
  assert.equal(allowed.memorySignal, "darwin_vm_stat");
  assert.equal(allowed.limitingResource, "heap");
  const refused = await assessScanRisk(input, { ...deps, walkRootBytes: async () => 3 * GIB });
  assert.equal(refused.status, "refuse");
  assert.equal(refused.availableBytes, 4 * GIB);
  const error = new ScanGuardRefusedError({ reason: "estimated_memory", assessment: refused });
  assert.match(error.message, /System available-memory estimate: 12\.1 GiB \(darwin_vm_stat\)/);
  assert.match(error.message, /remaining V8 heap: 4\.0 GiB; limiting resource: heap/);
  assert.doesNotMatch(error.message, /CCHISTORY_SCAN_GUARD=0/);
  const systemLimited = await assessScanRisk(input, { ...deps, walkRootBytes: async () => 64 * MIB,
    readMemory: () => ({ bytes: 128 * MIB, source: "darwin_vm_stat" }) });
  assert.equal(systemLimited.status, "refuse");
  assert.equal(systemLimited.limitingResource, "system");
  const unknown = await assessScanRisk(input, { ...deps, walkRootBytes: async () => 64 * MIB,
    readMemory: () => ({ source: "unknown" }) });
  assert.equal(unknown.status, "ok");
  assert.equal(unknown.limitingResource, "heap");
  assert.equal(unknown.systemAvailableBytes, undefined);
});

test("watchdog does not treat falling free pages alone as system memory exhaustion on macOS", () => {
  let raw = darwin;
  const watchdog = createScanWatchdog({ readAvailableBytes: () => readAvailableMemory({ ...macDeps, readVmStat: () => raw }).bytes });
  raw = darwin.replace("4096.", "0.");
  assert.doesNotThrow(() => watchdog.assertHealthy());
  raw = raw.replace("786432.", "0.");
  assert.throws(() => watchdog.assertHealthy(), /system available-memory estimate dropped to 0 B/);
});
