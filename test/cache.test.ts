import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  plaintextCache,
  staleIds,
  getFolderMap,
  resetFolderMapCache,
} from "../src/cache.js";

beforeEach(() => {
  plaintextCache.clear();
  resetFolderMapCache();
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

test("getFolderMap fetches once and then serves from cache", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return { a: "Work" };
  };
  const first = await getFolderMap(["a"], false, fetcher);
  assert.equal(first.a, "Work");
  await getFolderMap(["a"], false, fetcher);
  assert.equal(calls, 1);
});

test("getFolderMap refetches when an unknown id appears", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return calls === 1 ? { a: "Work" } : { a: "Work", b: "Home" };
  };
  await getFolderMap(["a"], false, fetcher);
  const second = await getFolderMap(["a", "b"], false, fetcher);
  assert.equal(calls, 2);
  assert.equal(second.b, "Home");
});

test("getFolderMap refetches when forced", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return { a: "Work" };
  };
  await getFolderMap(["a"], false, fetcher);
  await getFolderMap(["a"], true, fetcher);
  assert.equal(calls, 2);
});
