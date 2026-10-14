import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { encodeRecordValue } from "./decoded-record.js";

test("decoded record byte ownership agrees with JSON for controls, Unicode, surrogates and nested values", async () => {
  const fixture = JSON.parse(await readFile(new URL("../../../../mock_data/.local/share/amp/threads/T-019d19fb-1a2b-7345-8cde-0f1a2b3c4d5e.json", import.meta.url), "utf8"));
  const controls = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join("");
  const values = [fixture, { text: `${controls}中文🧭"\\\u2028\u2029\ud800x\udfff`.repeat(1000) },
    { text: "a".repeat(16_383) + "🧭" + "b".repeat(16_384) },
    { missing: undefined, array: [undefined, null, Infinity, -0, true, false, { nested: "fixture\n".repeat(5000) }] },
  ];
  for (const value of values) {
    const original = JSON.stringify(value);
    assert.deepEqual(encodeRecordValue(value, true), { rawJson: original });
    const borrowed = encodeRecordValue(value, false);
    assert.equal(borrowed.rawSizeBytes, Buffer.byteLength(original, "utf8"));
    assert.equal(borrowed.parsedValue, value);
    assert.equal(borrowed.rawJson, "");
  }
});
