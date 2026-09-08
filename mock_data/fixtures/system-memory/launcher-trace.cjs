// Synthetic launcher verification. No native history is opened.
const { appendFileSync } = require('node:fs');
const { getHeapStatistics } = require('node:v8');
process.on('exit', () => {
  appendFileSync(process.env.TEST_LITE_LAUNCHER_TRACE, JSON.stringify({
    heapLimit: getHeapStatistics().heap_size_limit,
    adaptiveMarker: process.env.CCHISTORY_ADAPTIVE_NODE_MEMORY_MB ?? null,
  }) + '\n');
});
