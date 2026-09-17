import assert from "node:assert/strict";
import test from "node:test";
import { adaptiveHeapLimitMiB } from "./launcher-memory.js";

const gib = 1024 ** 3;
const normal = { availableBytes: 32 * gib, heapLimitBytes: 4 * gib, execArgv: [] };
test("default heap can grow with available capacity without consuming all host memory", () => {
  assert.equal(adaptiveHeapLimitMiB(normal), 16 * 1024);
  for (const availableBytes of [undefined, 0, 2 * gib, 8 * gib, NaN, Infinity]) {
    assert.equal(adaptiveHeapLimitMiB({ ...normal, availableBytes }), undefined);
  }
  assert.equal(adaptiveHeapLimitMiB({ ...normal, arch: "ia32" }), undefined);
});

test("explicit heap policies and the adaptive child's flag prevent relaunch", () => {
  for (const flag of ["--max-old-space-size=768", "--max_old_space_size 768", "--max-heap-size=768",
    "--max-old-space-size-percentage=40", "--huge-max-old-generation-size", "--max-old-space-size=16384"]) {
    assert.equal(adaptiveHeapLimitMiB({ ...normal, execArgv: flag.split(" ") }), undefined, flag);
    assert.equal(adaptiveHeapLimitMiB({ ...normal, nodeOptions: `--no-warnings ${flag}` }), undefined, flag);
  }
});
