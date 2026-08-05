import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_IDENTITY_HELPERS } from "../src/snippets.js";

const {
  folderCatalog,
  noteIdentityMap,
  resolveFolderForRead,
  resolveFolderForMutation,
  resolveNoteForRead,
  resolveNoteForMutation,
} = new Function(
  `${JXA_IDENTITY_HELPERS}; return {
    folderCatalog, noteIdentityMap, resolveFolderForRead,
    resolveFolderForMutation, resolveNoteForRead, resolveNoteForMutation
  };`,
)();

interface NoteFixture {
  id: string;
  name: string;
}

interface FolderFixture {
  id: string;
  name: string;
  notes: NoteFixture[];
  children?: FolderFixture[];
}

interface AccountFixture {
  id: string;
  name: string;
  folders: FolderFixture[];
}

function collection<T extends { id: string; name: string }>(
  items: T[],
  names: string[] = [],
): T[] & { id: () => string[]; name: () => string[] } {
  return Object.assign(items, {
    id: () => items.map((item) => String(item.id)),
    name: () => (names.length > 0 ? names : items.map((item) => String(item.name))),
  });
}

function mockNotes(accounts: AccountFixture[]) {
  const noteObjects = new Map<string, { id: () => string; name: () => string }>();
  const allNotes: NoteFixture[] = [];
  const allFolders: Array<{
    id: string;
    name: string;
    notes: ReturnType<typeof collection>;
    folders: ReturnType<typeof collection>;
  }> = [];

  function buildFolder(fixture: FolderFixture): (typeof allFolders)[number] {
    const notes = fixture.notes.map((note) => {
      allNotes.push(note);
      const object = { id: () => note.id, name: () => note.name };
      noteObjects.set(note.id, object);
      return { id: note.id, name: note.name };
    });
    const children = (fixture.children ?? []).map(buildFolder);
    const folder = {
      id: fixture.id,
      name: fixture.name,
      notes: collection(notes),
      folders: collection(children),
    };
    allFolders.push(folder);
    return folder;
  }

  const accountObjects = accounts.map((account) => ({
    id: account.id,
    name: account.name,
    folders: collection(account.folders.map(buildFolder)),
  }));

  let byIdCalls = 0;
  const notes = Object.assign(collection(allNotes), {
    byId: (id: string) => {
      byIdCalls++;
      const note = noteObjects.get(id);
      if (!note) throw new Error("invalid note id");
      return note;
    },
  });
  const folders = Object.assign(collection(allFolders), {
    whose: ({ name }: { name: string }) => allFolders.filter((folder) => folder.name === name),
  });

  return {
    Notes: { accounts: collection(accountObjects), notes, folders },
    byIdCalls: () => byIdCalls,
  };
}

const A_ACCOUNT = "x-coredata://A/ICAccount/p1";
const B_ACCOUNT = "x-coredata://B/ICAccount/p1";
const A_NOTES = "x-coredata://A/ICFolder/notes";
const A_WORK = "x-coredata://A/ICFolder/work";
const A_NESTED = "x-coredata://A/ICFolder/nested";
const B_NOTES = "x-coredata://B/ICFolder/notes";
const B_WORK = "x-coredata://B/ICFolder/work";
const A_DUPLICATE_SUFFIX = "x-coredata://A/ICNote/same";
const B_DUPLICATE_SUFFIX = "x-coredata://B/ICNote/same";
const A_UNIQUE = "x-coredata://A/ICNote/unique";
const B_UNIQUE = "x-coredata://B/ICNote/local-only";

const ACCOUNTS: AccountFixture[] = [
  {
    id: A_ACCOUNT,
    name: "iCloud",
    folders: [
      {
        id: A_NOTES,
        name: "Notes",
        notes: [
          { id: A_DUPLICATE_SUFFIX, name: "Duplicate title" },
          { id: A_UNIQUE, name: "Cloud unique" },
        ],
        children: [
          {
            id: A_NESTED,
            name: "Projects",
            notes: [],
          },
        ],
      },
      { id: A_WORK, name: "Work", notes: [] },
    ],
  },
  {
    id: B_ACCOUNT,
    name: "On My Mac",
    folders: [
      {
        id: B_NOTES,
        name: "Notes",
        notes: [{ id: B_DUPLICATE_SUFFIX, name: "Duplicate title" }],
      },
      {
        id: B_WORK,
        name: "Work",
        notes: [{ id: B_UNIQUE, name: "Local unique" }],
      },
    ],
  },
];

test("folder catalog preserves stable iCloud and On My Mac identities, duplicates, nesting, and counts", () => {
  const { Notes } = mockNotes(ACCOUNTS);
  const folders = folderCatalog(Notes, true).map(
    ({ id, name, account, count }: { id: string; name: string; account: object; count: number }) => ({
      id,
      name,
      account,
      count,
    }),
  );

  assert.deepEqual(folders, [
    {
      id: A_NOTES,
      name: "Notes",
      account: { id: A_ACCOUNT, name: "iCloud" },
      count: 2,
    },
    {
      id: A_NESTED,
      name: "Projects",
      account: { id: A_ACCOUNT, name: "iCloud" },
      count: 0,
    },
    {
      id: A_WORK,
      name: "Work",
      account: { id: A_ACCOUNT, name: "iCloud" },
      count: 0,
    },
    {
      id: B_NOTES,
      name: "Notes",
      account: { id: B_ACCOUNT, name: "On My Mac" },
      count: 1,
    },
    {
      id: B_WORK,
      name: "Work",
      account: { id: B_ACCOUNT, name: "On My Mac" },
      count: 1,
    },
  ]);
});

test("note identity map carries stable account and folder ids", () => {
  const { Notes } = mockNotes(ACCOUNTS);
  const map = noteIdentityMap(Notes);

  assert.deepEqual(map[A_UNIQUE], {
    account: { id: A_ACCOUNT, name: "iCloud" },
    folder: { id: A_NOTES, name: "Notes" },
  });
  assert.deepEqual(map[B_UNIQUE], {
    account: { id: B_ACCOUNT, name: "On My Mac" },
    folder: { id: B_WORK, name: "Work" },
  });
});

test("folder read resolution rejects duplicate Notes and Work names with stable candidates", () => {
  const { Notes } = mockNotes(ACCOUNTS);
  for (const name of ["Notes", "Work"]) {
    assert.throws(
      () => resolveFolderForRead(Notes, "", name),
      (error: Error) => {
        assert.match(error.message, /ambiguous.*Retry with folder_id/i);
        assert.match(error.message, new RegExp(A_ACCOUNT.replaceAll("/", "\\/")));
        assert.match(error.message, new RegExp(B_ACCOUNT.replaceAll("/", "\\/")));
        return true;
      },
    );
  }
});

test("folder read and mutation resolution accept one exact full folder id", () => {
  const { Notes } = mockNotes(ACCOUNTS);
  const read = resolveFolderForRead(Notes, B_WORK, "");
  const mutation = resolveFolderForMutation(Notes, B_WORK);

  assert.deepEqual(read.account, { id: B_ACCOUNT, name: "On My Mac" });
  assert.equal(read.id, B_WORK);
  assert.equal(mutation.id, B_WORK);
});

test("folder read resolution accepts an ordinary unique name and rejects two selectors", () => {
  const { Notes } = mockNotes(ACCOUNTS);
  const target = resolveFolderForRead(Notes, "", "Projects");

  assert.equal(target.id, A_NESTED);
  assert.deepEqual(target.account, { id: A_ACCOUNT, name: "iCloud" });
  assert.throws(() => resolveFolderForRead(Notes, A_NESTED, "Projects"), /either folder_id or folder, not both/i);
});

test("folder mutation resolution rejects a name, wrong-kind id, and unknown full id", () => {
  const { Notes } = mockNotes(ACCOUNTS);
  assert.throws(() => resolveFolderForMutation(Notes, "Work"), /must be a full.*ICFolder/i);
  assert.throws(() => resolveFolderForMutation(Notes, A_UNIQUE), /must be a full.*ICFolder/i);
  assert.throws(() => resolveFolderForMutation(Notes, "x-coredata://A/ICFolder/missing"), /Folder id not found/);
});

test("read resolver allows a uniquely matching short note id and returns its stable location", () => {
  const { Notes } = mockNotes(ACCOUNTS);
  const target = resolveNoteForRead(Notes, "local-only", "");

  assert.equal(target.id, B_UNIQUE);
  assert.equal(target.note.name(), "Local unique");
  assert.deepEqual(target.account, { id: B_ACCOUNT, name: "On My Mac" });
  assert.deepEqual(target.folder, { id: B_WORK, name: "Work" });
});

test("read resolver accepts one exact full note id", () => {
  const { Notes } = mockNotes(ACCOUNTS);
  const target = resolveNoteForRead(Notes, A_UNIQUE, "");

  assert.equal(target.id, A_UNIQUE);
  assert.equal(target.note.name(), "Cloud unique");
});

test("read resolver rejects a note in a configured trash folder by stable identity", () => {
  const { Notes } = mockNotes(ACCOUNTS);
  assert.throws(
    () => resolveNoteForRead(Notes, A_UNIQUE, "", [A_NOTES]),
    /stable folder ID is configured as Recently Deleted/i,
  );
});

test("title and short-id resolution ignore matching trash candidates before uniqueness", () => {
  const liveId = "x-coredata://A/ICNote/collision";
  const trashId = "x-coredata://B/ICNote/collision";
  const trashFolderId = "x-coredata://B/ICFolder/trash";
  const { Notes } = mockNotes([
    {
      id: A_ACCOUNT,
      name: "iCloud",
      folders: [
        {
          id: A_NOTES,
          name: "Notes",
          notes: [{ id: liveId, name: "Same title" }],
        },
      ],
    },
    {
      id: B_ACCOUNT,
      name: "On My Mac",
      folders: [
        {
          id: trashFolderId,
          name: "Localized trash label",
          notes: [{ id: trashId, name: "Same title" }],
        },
      ],
    },
  ]);

  assert.equal(resolveNoteForRead(Notes, "", "Same title", [trashFolderId]).id, liveId);
  assert.equal(resolveNoteForRead(Notes, "collision", "", [trashFolderId]).id, liveId);
  assert.throws(
    () => resolveNoteForRead(Notes, trashId, "", [trashFolderId]),
    /NOTE_IN_RECENTLY_DELETED|stable folder ID is configured as Recently Deleted/i,
  );
});

test("ambiguity diagnostics omit configured-trash candidate identities", () => {
  const aLive = "x-coredata://A/ICNote/collision";
  const bTrash = "x-coredata://B/ICNote/collision";
  const cLive = "x-coredata://C/ICNote/collision";
  const trashFolderId = "x-coredata://B/ICFolder/trash";
  const { Notes } = mockNotes([
    {
      id: A_ACCOUNT,
      name: "iCloud",
      folders: [
        {
          id: A_NOTES,
          name: "Notes",
          notes: [{ id: aLive, name: "Collision" }],
        },
      ],
    },
    {
      id: B_ACCOUNT,
      name: "On My Mac",
      folders: [
        {
          id: trashFolderId,
          name: "Bin",
          notes: [{ id: bTrash, name: "Collision" }],
        },
      ],
    },
    {
      id: "x-coredata://C/ICAccount/p1",
      name: "Work account",
      folders: [
        {
          id: "x-coredata://C/ICFolder/notes",
          name: "Notes",
          notes: [{ id: cLive, name: "Collision" }],
        },
      ],
    },
  ]);

  assert.throws(
    () => resolveNoteForRead(Notes, "collision", "", [trashFolderId]),
    (error: Error) => {
      assert.match(error.message, new RegExp(aLive));
      assert.match(error.message, new RegExp(cLive));
      assert.doesNotMatch(error.message, new RegExp(bTrash));
      return true;
    },
  );
});

test("read resolver rejects a short id shared across accounts with both full candidates", () => {
  const { Notes } = mockNotes(ACCOUNTS);
  assert.throws(
    () => resolveNoteForRead(Notes, "same", ""),
    (error: Error) => {
      assert.match(error.message, /id 'same'.*ambiguous.*full note id/i);
      for (const value of [A_DUPLICATE_SUFFIX, B_DUPLICATE_SUFFIX, A_ACCOUNT, B_ACCOUNT, A_NOTES, B_NOTES]) {
        assert.ok(error.message.includes(value), `candidate error omitted ${value}`);
      }
      return true;
    },
  );
});

test("read resolver rejects duplicate titles with account/folder candidate identities", () => {
  const { Notes } = mockNotes(ACCOUNTS);
  assert.throws(
    () => resolveNoteForRead(Notes, "", "Duplicate title"),
    (error: Error) => {
      assert.match(error.message, /title 'Duplicate title'.*ambiguous/i);
      assert.ok(error.message.includes(A_DUPLICATE_SUFFIX));
      assert.ok(error.message.includes(B_DUPLICATE_SUFFIX));
      assert.ok(error.message.includes("iCloud"));
      assert.ok(error.message.includes("On My Mac"));
      return true;
    },
  );
});

test("read resolver rejects unknown and wrong-kind ids", () => {
  const { Notes } = mockNotes(ACCOUNTS);
  assert.throws(() => resolveNoteForRead(Notes, "missing", ""), /Note id not found/);
  assert.throws(() => resolveNoteForRead(Notes, A_WORK, ""), /not a note id/);
});

test("mutation resolver requires a full note id and validates existence before byId", () => {
  const short = mockNotes(ACCOUNTS);
  assert.throws(() => resolveNoteForMutation(short.Notes, "unique"), /full.*ICNote.*short ids and titles/i);
  assert.equal(short.byIdCalls(), 0);

  const wrongKind = mockNotes(ACCOUNTS);
  assert.throws(() => resolveNoteForMutation(wrongKind.Notes, A_WORK), /full.*ICNote/i);
  assert.equal(wrongKind.byIdCalls(), 0);

  const unknown = mockNotes(ACCOUNTS);
  assert.throws(() => resolveNoteForMutation(unknown.Notes, "x-coredata://A/ICNote/missing"), /Note id not found/);
  assert.equal(unknown.byIdCalls(), 0);
});

test("mutation resolver preserves the exact full note id and stable location", () => {
  const { Notes, byIdCalls } = mockNotes(ACCOUNTS);
  const target = resolveNoteForMutation(Notes, A_UNIQUE);

  assert.equal(target.id, A_UNIQUE);
  assert.equal(target.note.name(), "Cloud unique");
  assert.deepEqual(target.account, { id: A_ACCOUNT, name: "iCloud" });
  assert.deepEqual(target.folder, { id: A_NOTES, name: "Notes" });
  assert.equal(byIdCalls(), 1);
});
