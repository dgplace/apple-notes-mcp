import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_REVISION } from "../src/revision.js";
import {
  JXA_HTML_HELPERS,
  JXA_UPDATE_NOTE,
  JXA_WRITE_SAFETY,
} from "../src/snippets.js";

const helpers = new Function(
  `function noteIdentityMap(Notes) { return Notes.identityMap; }
   ${JXA_HTML_HELPERS}\n${JXA_REVISION}\n${JXA_UPDATE_NOTE}\n${JXA_WRITE_SAFETY};
   return { planNoteUpdate, applyNoteUpdate, assertExpectedRevision,
     assertWritableNote, assertWritableFolder, assertLiveMutationTarget,
     authoritativeNoteState, publicVerifiedState, moveNoteToFolder,
     deleteNoteToConfiguredTrash, executeWritePlan,
     postWriteVerificationFailure, assertPostWriteRevisionChanged,
     verifyPostWrite, attemptMutation, attemptCreateMutation };`
)() as Record<string, (...args: any[]) => any>;

function noteFixture(options: { locked?: boolean; shared?: boolean } = {}) {
  let body: string | (() => string) = () => "<h1>Title</h1><div>old</div>";
  let modificationReads = 0;
  const note = {
    get body() { return body; },
    set body(value) { body = value; },
    name: () => "Title",
    modificationDate: () => {
      modificationReads++;
      return new Date("2026-08-06T01:02:03.456Z");
    },
    passwordProtected: () => Boolean(options.locked),
    shared: () => Boolean(options.shared),
    attachments: Object.assign([], { name: () => [] }),
  };
  return { note, body: () => body, modificationReads: () => modificationReads };
}

const NOTE_ID = "x-coredata://A/ICNote/p1";
const LOCATION = {
  account: { id: "x-coredata://A/ICAccount/p1", name: "iCloud" },
  folder: { id: "x-coredata://A/ICFolder/work", name: "Work" },
};
const CONTEXT = { trashIds: [] };

function notesFor(note: object, location = LOCATION) {
  return { identityMap: { [NOTE_ID]: location }, note };
}

test("stale expected revision conflicts before an update can mutate", () => {
  const fixture = noteFixture();
  const Notes = notesFor(fixture.note);
  const plan = helpers.planNoteUpdate(fixture.note, "new", "replace", "", false);
  assert.throws(
    () => helpers.assertExpectedRevision(Notes, fixture.note, NOTE_ID, "r2|stale|revision", CONTEXT),
    (error: any) => error.appleNotesSafeCode === "CONFLICT"
  );
  assert.equal(typeof fixture.body(), "function");
  assert.equal(fixture.modificationReads(), 2, "conflict brackets fresh location with revision reads");
  assert.ok(plan.nextBody.includes("new"));
});

test("matching revision permits the planned append without rebuilding existing HTML", () => {
  const fixture = noteFixture();
  const Notes = notesFor(fixture.note);
  const expectedToken = [
    "r2",
    NOTE_ID,
    LOCATION.account.id,
    LOCATION.folder.id,
    "2026-08-06T01:02:03.456Z",
  ].map(encodeURIComponent).join("|");
  const current = helpers.assertExpectedRevision(
    Notes,
    fixture.note,
    NOTE_ID,
    expectedToken,
    CONTEXT
  );
  const plan = helpers.planNoteUpdate(fixture.note, "added", "append", "", false);
  helpers.applyNoteUpdate(fixture.note, plan);
  assert.match(current.revision, /\.456Z/);
  assert.equal(current.location.folder.id, LOCATION.folder.id);
  assert.equal(fixture.body(), "<h1>Title</h1><div>old</div><div>added</div>");
});

test("immediate revision check re-resolves a folder-only move", () => {
  const fixture = noteFixture();
  const oldLocation = LOCATION;
  const newLocation = {
    account: LOCATION.account,
    folder: { id: "x-coredata://A/ICFolder/archive", name: "Archive" },
  };
  const Notes = notesFor(fixture.note, newLocation);
  const stale = [
    "r2", NOTE_ID, oldLocation.account.id, oldLocation.folder.id,
    "2026-08-06T01:02:03.456Z",
  ].map(encodeURIComponent).join("|");
  assert.throws(
    () => helpers.assertExpectedRevision(Notes, fixture.note, NOTE_ID, stale, CONTEXT),
    (error: any) => error.appleNotesSafeCode === "CONFLICT"
  );
});

test("dry-run executor performs zero mutation", () => {
  let mutations = 0;
  const preview = { dry_run: true, preview: { operation: "update" } };
  const result = helpers.executeWritePlan(true, preview, () => {
    mutations++;
    return { written: true };
  });
  assert.equal(mutations, 0);
  assert.equal(result, preview);
});

test("locked notes are refused before shared policy is considered", () => {
  const fixture = noteFixture({ locked: true, shared: true });
  assert.throws(
    () => helpers.assertWritableNote(fixture.note, true, true),
    (error: any) => error.appleNotesSafeCode === "LOCKED_NOTE"
  );
});

test("shared writes require both server capability and per-call intent", () => {
  const sharedNote = noteFixture({ shared: true }).note;
  assert.throws(
    () => helpers.assertWritableNote(sharedNote, false, true),
    (error: any) => error.appleNotesSafeCode === "SHARED_WRITES_DISABLED"
  );
  assert.throws(
    () => helpers.assertWritableNote(sharedNote, true, false),
    (error: any) => error.appleNotesSafeCode === "SHARED_WRITE_CONFIRMATION_REQUIRED"
  );
  assert.equal(helpers.assertWritableNote(sharedNote, true, true), true);

  const sharedFolder = { shared: () => true };
  assert.throws(
    () => helpers.assertWritableFolder(sharedFolder, false, true),
    (error: any) => error.appleNotesSafeCode === "SHARED_WRITES_DISABLED"
  );
  assert.equal(helpers.assertWritableFolder(sharedFolder, true, true), true);
});

test("stable trash identity refuses update, move, and delete targets", () => {
  const target = { folder: { id: "x-coredata://A/ICFolder/trash" } };
  const context = { trashIds: [target.folder.id] };
  assert.throws(
    () => helpers.assertLiveMutationTarget(target, context),
    (error: any) => error.appleNotesSafeCode === "NOTE_IN_RECENTLY_DELETED"
  );
});

test("public JXA move/delete commands receive the exact resolved objects", () => {
  const calls: unknown[][] = [];
  const Notes = {
    move: (...args: unknown[]) => calls.push(["move", ...args]),
    delete: (...args: unknown[]) => calls.push(["delete", ...args]),
  };
  const note = { stable: "note" };
  const folder = { stable: "folder" };
  helpers.moveNoteToFolder(Notes, note, folder);
  helpers.deleteNoteToConfiguredTrash(Notes, note);
  assert.deepEqual(calls, [
    ["move", note, { to: folder }],
    ["delete", note],
  ]);
});

test("authoritative read-back returns verified location and a new full-precision revision", () => {
  const id = "x-coredata://A/ICNote/p1";
  let modified = new Date("2026-08-06T01:02:03.456Z");
  const note = {
    name: () => "Verified",
    body: () => "<h1>Verified</h1><div>body</div>",
    modificationDate: () => modified,
  };
  const Notes = {
    notes: {
      id: () => [id],
      byId: (selected: string) => {
        assert.equal(selected, id);
        return note;
      },
    },
    identityMap: {
      [id]: {
        account: { id: "x-coredata://A/ICAccount/p1", name: "iCloud" },
        folder: { id: "x-coredata://A/ICFolder/work", name: "Work" },
      },
    },
  };

  const before = helpers.authoritativeNoteState(Notes, id, true);
  modified = new Date("2026-08-06T01:02:04.001Z");
  Notes.identityMap[id].folder = { id: "x-coredata://A/ICFolder/archive", name: "Archive" };
  const after = helpers.authoritativeNoteState(Notes, id, true);
  const publicState = helpers.publicVerifiedState(after);

  assert.notEqual(after.revision, before.revision);
  assert.match(after.revision, /04\.001Z/);
  assert.equal(publicState.verified, true);
  assert.equal(publicState.folder.id, "x-coredata://A/ICFolder/archive");
  assert.equal(publicState.body_html_chars, note.body().length);
  assert.ok(!("body" in publicState), "read-back validation must not return raw HTML");
});

test("post-write verification failures are explicit safe errors", () => {
  assert.throws(
    () => helpers.authoritativeNoteState(
      { notes: { id: () => [], byId: () => { throw new Error("must not run"); } }, identityMap: {} },
      "x-coredata://A/ICNote/missing",
      false
    ),
    (error: any) => {
      assert.equal(error.appleNotesSafeCode, "POST_WRITE_VERIFICATION_FAILED");
      assert.match(error.message, /mutation may already have occurred/i);
      assert.match(error.message, /re-read or list/i);
      assert.match(error.message, /do not retry blindly/i);
      assert.match(error.message, /ICNote\/missing/);
      return true;
    }
  );
  assert.throws(
    () => helpers.authoritativeNoteState(
      {
        notes: { id: () => ["x-coredata://A/ICNote/p1"], byId: () => { throw new Error("must not run"); } },
        identityMap: {},
      },
      "x-coredata://A/ICNote/p1",
      false
    ),
    (error: any) => error.appleNotesSafeCode === "POST_WRITE_VERIFICATION_FAILED"
  );
});

test("an unchanged post-write revision fails safely and warns against retry", () => {
  assert.throws(
    () => helpers.assertPostWriteRevisionChanged(NOTE_ID, "same", "same"),
    (error: any) => {
      assert.equal(error.appleNotesSafeCode, "POST_WRITE_VERIFICATION_FAILED");
      assert.match(error.message, /mutation may already have occurred/i);
      assert.match(error.message, new RegExp(NOTE_ID.replaceAll("/", "\\/")));
      assert.match(error.message, /do not retry blindly/i);
      return true;
    }
  );
});

test("exceptions after a mutation attempt are converted to conservative retry warnings", () => {
  assert.throws(
    () => helpers.attemptMutation(NOTE_ID, () => { throw new Error("partial effect"); }),
    (error: any) => {
      assert.equal(error.appleNotesSafeCode, "POST_WRITE_VERIFICATION_FAILED");
      assert.match(error.message, /may already have occurred/i);
      assert.match(error.message, /do not retry blindly/i);
      assert.match(error.message, /ICNote\/p1/);
      return true;
    }
  );

  const beforeId = { id: "" };
  assert.throws(
    () => helpers.attemptCreateMutation("folder-id", "Title", beforeId, () => {
      throw new Error("push may have worked");
    }),
    (error: any) => {
      assert.match(error.message, /create mutation may already have occurred/i);
      assert.match(error.message, /list the target folder.*inspect the title/i);
      assert.match(error.message, /do not retry blindly/i);
      return true;
    }
  );

  const afterId = { id: NOTE_ID };
  assert.throws(
    () => helpers.attemptCreateMutation("folder-id", "Title", afterId, () => {
      throw new Error("readback failed");
    }),
    (error: any) => {
      assert.match(error.message, /may already have occurred/i);
      assert.match(error.message, /ICNote\/p1/);
      return true;
    }
  );
});

test("move/delete read-back never fetches or returns note bodies", () => {
  const id = "x-coredata://A/ICNote/p1";
  let bodyReads = 0;
  const Notes = {
    notes: {
      id: () => [id],
      byId: () => ({
        name: () => "Moved",
        body: () => { bodyReads++; return "private body"; },
        modificationDate: () => new Date("2026-08-06T01:02:03.456Z"),
      }),
    },
    identityMap: {
      [id]: {
        account: { id: "x-coredata://A/ICAccount/p1", name: "iCloud" },
        folder: { id: "x-coredata://A/ICFolder/archive", name: "Archive" },
      },
    },
  };
  const state = helpers.authoritativeNoteState(Notes, id, false);
  const publicState = helpers.publicVerifiedState(state);
  assert.equal(bodyReads, 0);
  assert.ok(!("body_html_chars" in publicState));
  assert.ok(!("body" in publicState));
});
