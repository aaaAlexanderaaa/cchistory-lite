// Synthetic launcher verification. No native history is opened.
const { appendFileSync } = require('node:fs');
const { getHeapStatistics } = require('node:v8');
// Deterministic capacity for launcher integration tests, independent of host load.
if (process.env.TEST_LITE_LAUNCHER_CAPACITY === '32GiB') {
  const fs = require('node:fs');
  const os = require('node:os');
  const cp = require('node:child_process');
  const readFileSync = fs.readFileSync;
  const execFileSync = cp.execFileSync;
  os.totalmem = () => 64 * 1024 ** 3;
  os.freemem = () => 32 * 1024 ** 3;
  process.constrainedMemory = () => 0;
  process.availableMemory = () => 32 * 1024 ** 3;
  fs.readFileSync = function(file, ...args) {
    return file === '/proc/meminfo' ? 'MemAvailable: 33554432 kB\n' : readFileSync.call(this, file, ...args);
  };
  cp.execFileSync = function(file, ...args) {
    return file === '/usr/bin/vm_stat'
      ? 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 4194304.\nPages inactive: 4194304.\n'
      : execFileSync.call(this, file, ...args);
  };
  require('node:module').syncBuiltinESMExports();
}
process.on('exit', () => {
  appendFileSync(process.env.TEST_LITE_LAUNCHER_TRACE, JSON.stringify({
    heapLimit: getHeapStatistics().heap_size_limit,
    adaptiveMarker: process.env.CCHISTORY_ADAPTIVE_NODE_MEMORY_MB ?? null,
  }) + '\n');
});
