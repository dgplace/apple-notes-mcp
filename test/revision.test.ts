import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_REVISION, revisionToken } from "../src/revision.js";

const jxa = new Function(
  `function safeError(code, message) { const error = new Error(message); error.appleNotesSafeCode = code; return error; }
   ${JXA_REVISION}; return { revisionToken, noteRevision, fullModificationTime, consistentReadRevision };`,
)() as {
  revisionToken(noteId: string, accountId: string, folderId: string, modified: string): string;
  noteRevision(note: { modificationDate(): Date }, id: string, location: object): string;
  fullModificationTime(value: Date): string;
  consistentReadRevision(
    id: string,
    initialLocation: object,
    initialModified: string,
    finalLocation: object,
    finalModified: string,
    excluded: string[],
  ): string;
};

test("Node and JXA revision encoders are identical and retain milliseconds", () => {
  const id = "x-coredata://A/ICNote/p1|percent%";
  const accountId = "x-coredata://A/ICAccount/p1";
  const folderId = "x-coredata://A/ICFolder/work";
  const modified = "2026-08-06T01:02:03.987Z";
  assert.equal(jxa.revisionToken(id, accountId, folderId, modified), revisionToken(id, accountId, folderId, modified));
  assert.equal(
    jxa.noteRevision({ modificationDate: () => new Date(modified) }, id, {
      account: { id: accountId },
      folder: { id: folderId },
    }),
    revisionToken(id, accountId, folderId, modified),
  );
  assert.match(revisionToken(id, accountId, folderId, modified), /03\.987Z/);
});

test("get-note observation rejects content-time and location races conservatively", () => {
  const initial = {
    account: { id: "account" },
    folder: { id: "folder-a" },
  };
  const stable = jxa.consistentReadRevision(
    "note",
    initial,
    "2026-01-01T00:00:00.000Z",
    initial,
    "2026-01-01T00:00:00.000Z",
    [],
  );
  assert.equal(stable, revisionToken("note", "account", "folder-a", "2026-01-01T00:00:00.000Z"));
  assert.throws(
    () =>
      jxa.consistentReadRevision("note", initial, "2026-01-01T00:00:00.000Z", initial, "2026-01-01T00:00:01.000Z", []),
    (error: any) => error.appleNotesSafeCode === "NOTE_CHANGED_DURING_READ",
  );
  assert.throws(
    () =>
      jxa.consistentReadRevision(
        "note",
        initial,
        "2026-01-01T00:00:00.000Z",
        { account: { id: "account" }, folder: { id: "folder-b" } },
        "2026-01-01T00:00:00.000Z",
        [],
      ),
    (error: any) => error.appleNotesSafeCode === "NOTE_CHANGED_DURING_READ",
  );
});

test("revision encoding is collision-free across all four delimiter-like components", () => {
  const tokens = new Set([
    revisionToken("a|b", "c", "d", "e"),
    revisionToken("a", "b|c", "d", "e"),
    revisionToken("a", "b", "c|d", "e"),
    revisionToken("a", "b", "c", "d|e"),
    revisionToken("a%7Cb", "c", "d", "e"),
  ]);
  assert.equal(tokens.size, 5);
});

test("a folder-only move changes revision without a timestamp change", () => {
  const common = ["note", "account"] as const;
  const modified = "2026-08-06T01:02:03.987Z";
  assert.notEqual(revisionToken(...common, "folder-a", modified), revisionToken(...common, "folder-b", modified));
});
