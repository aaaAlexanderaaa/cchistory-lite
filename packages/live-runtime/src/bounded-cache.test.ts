import assert from "node:assert/strict";
import test from "node:test";
import { BoundedCache } from "./bounded-cache.js";
import { scanLiteHistory } from "./index.js";
import { fileURLToPath } from "node:url";

test("LRU limits both entries and retained units, including replacement and oversize rejection", () => {
  const cache = new BoundedCache<string, number>(2, 5, value => value);
  cache.set("a", 2); cache.set("b", 2);
  assert.equal(cache.get("a"), 2);
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.weight, 5);
  cache.set("a", 4);
  assert.equal(cache.get("c"), undefined);
  cache.set("a", 6);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.weight, 0);
  cache.set("d", 2); cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.weight, 0);
});

test("snapshot search eviction preserves answers and evidence pages retain a bounded owner", async () => {
  const root = fileURLToPath(new URL("../../../mock_data/fixtures/agent-evidence", import.meta.url));
  const snapshot = await scanLiteHistory({ homeDir: root, sourceRefs: ["codex"],
    sourceRoots: [{ sourceRef: "codex", baseDir: root }], safeMode: true, contextMode: "none", retainConversationEvidence: true });
  const before = snapshot.search({ query: "fixture" });
  for (let index = 0; index < 100; index++) { snapshot.search({ query: `fixture ${index}` }); snapshot.searchSessions({ query: `fixture ${index}` }); }
  const stats = snapshot.getCacheStats();
  for (const state of [stats.search, stats.session_search]) {
    assert.ok(state.entries <= 32);
    assert.ok(state.retained_units <= 20_000);
  }
  assert.deepEqual(snapshot.search({ query: "fixture" }), before);
  const first = snapshot.readEvidence({ kind: "session", ref: "sess:codex:evidence-parent" }, { limit: 1 })!;
  const second = snapshot.readEvidence({ kind: "session", ref: "sess:codex:evidence-parent" }, { cursor: first.next_cursor! })!;
  assert.equal(first.revision, second.revision);
  assert.equal(snapshot.getCacheStats().evidence_pages.entries, 1);
  assert.deepEqual(snapshot.projectionIssues, []);
});
