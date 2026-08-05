import { test } from "node:test";
import assert from "node:assert/strict";
import { factorIds, truncateBody, ok, fail } from "../src/helpers.js";

test("factorIds factors a shared prefix", () => {
  const { idPrefix, shorten } = factorIds([
    "x-coredata://AAA/ICNote/p1",
    "x-coredata://AAA/ICNote/p2",
  ]);
  assert.equal(idPrefix, "x-coredata://AAA/ICNote/");
  assert.equal(shorten("x-coredata://AAA/ICNote/p1"), "p1");
});

test("factorIds keeps full ids when prefixes differ", () => {
  const ids = ["x-coredata://AAA/ICNote/p1", "x-coredata://BBB/ICNote/p2"];
  const { idPrefix, shorten } = factorIds(ids);
  assert.equal(idPrefix, "");
  assert.equal(shorten(ids[1]), ids[1]);
});

test("factorIds handles empty input", () => {
  const { idPrefix, shorten } = factorIds([]);
  assert.equal(idPrefix, "");
  assert.equal(shorten("anything"), "anything");
});

test("truncateBody returns short text unchanged", () => {
  assert.equal(truncateBody("hello", 100), "hello");
});

test("truncateBody caps long text with a marker", () => {
  const out = truncateBody("a".repeat(150), 100);
  assert.ok(out.startsWith("a".repeat(100)));
  assert.match(out, /truncated 50 of 150 chars/);
  assert.match(out, /max_chars=150/);
});

test("ok wraps data as compact JSON", () => {
  const res = ok({ a: 1 });
  assert.equal(res.content[0].text, '{"a":1}');
});

test("fail wraps an Error message and sets isError", () => {
  const res = fail(new Error("boom"));
  assert.equal(res.isError, true);
  assert.equal(
    res.content[0].text,
    "Error [AUTOMATION_FAILED]: Apple Notes automation failed without a safe diagnostic."
  );
  assert.doesNotMatch(res.content[0].text, /boom/);
});
