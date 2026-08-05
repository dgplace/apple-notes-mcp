import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupIntegrationNoteOnce } from "./integration-cleanup.js";

test("integration cleanup never trashes a note that is absent or already trashed", async () => {
  const state = { trashAttempted: false, trashVerified: false };
  let trashCalls = 0;
  const outcome = await cleanupIntegrationNoteOnce(
    state,
    async () => undefined,
    async () => {
      trashCalls++;
      return true;
    },
  );

  assert.equal(outcome, "not-authoritatively-live");
  assert.equal(trashCalls, 0);
  assert.equal(state.trashAttempted, false);
});

test("integration cleanup makes one attempt and never retries an unknown trash outcome", async () => {
  const state = { trashAttempted: false, trashVerified: false };
  let observationCalls = 0;
  let trashCalls = 0;
  const observe = async () => {
    observationCalls++;
    return { revision: "r2|exact-fixture" };
  };
  const trash = async () => {
    trashCalls++;
    return false;
  };

  assert.equal(await cleanupIntegrationNoteOnce(state, observe, trash), "outcome-unknown");
  assert.equal(await cleanupIntegrationNoteOnce(state, observe, trash), "already-attempted");
  assert.equal(observationCalls, 1);
  assert.equal(trashCalls, 1);
});
