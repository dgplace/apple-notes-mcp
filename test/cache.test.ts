import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { plaintextCache, staleIds } from "../src/cache.js";

beforeEach(() => {
  plaintextCache.clear();
});

test("staleIds: everything stale on a cold cache", () => {
  assert.deepEqual(staleIds(["a", "b"], ["t1", "t2"], new Set()), ["a", "b"]);
});

test("staleIds: cached unchanged note is not stale", () => {
  plaintextCache.set("a", { modified: "t1", plaintext: "x" });
  assert.deepEqual(staleIds(["a", "b"], ["t1", "t2"], new Set()), ["b"]);
});

test("staleIds: modified note becomes stale again", () => {
  plaintextCache.set("a", { modified: "t0", plaintext: "x" });
  assert.deepEqual(staleIds(["a"], ["t1"], new Set()), ["a"]);
});

test("staleIds: deleted notes are never fetched", () => {
  assert.deepEqual(staleIds(["a", "b"], ["t1", "t2"], new Set(["a"])), ["b"]);
});
