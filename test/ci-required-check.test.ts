import assert from "node:assert/strict";
import test from "node:test";

test("required CI rejects a deliberately failing test", () => {
  assert.fail("intentional failure used only to verify branch protection");
});
