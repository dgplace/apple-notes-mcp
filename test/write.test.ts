import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JXA_DELETE_NOTE,
  JXA_HTML_HELPERS,
  JXA_UPDATE_NOTE,
} from "../src/snippets.js";
import { prepareContent } from "../src/content.js";

const { richContentKinds, updateNoteContent } = new Function(
  `${JXA_HTML_HELPERS}\n${JXA_UPDATE_NOTE}; return { richContentKinds, updateNoteContent };`
)();

interface Fixture {
  kind: "attachment" | "drawing" | "table" | "checklist";
  html: string;
  attachmentNames?: string[];
}

const FIXTURES: Fixture[] = [
  {
    kind: "attachment",
    html:
      '<div><h1>Files</h1></div><object type="application/x-apple-msg-attachment" data="cid:file"></object>',
    attachmentNames: ["report.pdf"],
  },
  {
    kind: "drawing",
    html:
      '<div><h1>Sketch</h1></div><object type="com.apple.notes.drawing" data-attachment-identifier="drawing-1"></object>',
    attachmentNames: ["Drawing"],
  },
  {
    kind: "table",
    html: "<div><h1>Grid</h1></div><table><tr><td>value</td></tr></table>",
  },
  {
    kind: "checklist",
    html:
      '<div><h1>Tasks</h1></div><ul class="com-apple-note-checklist"><li data-checked="false">item</li></ul>',
  },
];

function mockNote(fixture: Fixture, title = "Original title") {
  let nameCalls = 0;
  const attachments = Object.assign([] as object[], {
    name: () => fixture.attachmentNames ?? [],
  });
  if (fixture.attachmentNames) {
    attachments.push(...fixture.attachmentNames.map(() => ({})));
  }

  const note: {
    body: (() => string) | string;
    name: () => string;
    attachments: typeof attachments;
  } = {
    body: () => fixture.html,
    name: () => {
      nameCalls++;
      return title;
    },
    attachments,
  };

  return { note, nameCalls: () => nameCalls };
}

for (const fixture of FIXTURES) {
  test(`replace rejects ${fixture.kind} content and names it`, () => {
    const { note } = mockNote(fixture);

    assert.throws(
      () => updateNoteContent(note, "<div>replacement</div>", "replace", "", false),
      new RegExp(`rich content.*${fixture.kind}.*allow_rich_content_loss`, "i")
    );
    assert.equal(typeof note.body, "function", "rejection must happen before mutation");
  });

  test(`replace permits intentional ${fixture.kind} loss with per-call override`, () => {
    const { note } = mockNote(fixture);

    updateNoteContent(note, "<div>replacement</div>", "replace", "", true);

    assert.equal(
      note.body,
      "<div><h1>Original title</h1></div><div>replacement</div>"
    );
  });

  test(`append preserves ${fixture.kind} HTML and the title`, () => {
    const { note, nameCalls } = mockNote(fixture);

    updateNoteContent(note, "<div>added</div>", "append", "", false);

    assert.equal(note.body, fixture.html + "<div>added</div>");
    assert.equal(nameCalls(), 0, "append must not reconstruct or query the title");
  });
}

test("replace preserves the existing title when new_title is absent", () => {
  const fixture: Fixture = {
    kind: "attachment",
    html: "<div><h1>Original &amp; exact</h1></div><div>plain body</div>",
  };
  const { note, nameCalls } = mockNote(fixture, "Original & exact");

  updateNoteContent(note, "<div>new body</div>", "replace", "", false);

  assert.equal(
    note.body,
    "<div><h1>Original &amp; exact</h1></div><div>new body</div>"
  );
  assert.equal(nameCalls(), 1);
});

test("raw HTML append adds only its sanitized fragment to exact existing HTML", () => {
  const fixture: Fixture = {
    kind: "attachment",
    html: '<div><h1>Exact title</h1></div><object data-internal="opaque"></object>',
    attachmentNames: ["report.pdf"],
  };
  const { note, nameCalls } = mockNote(fixture, "Exact title");
  const fragment = prepareContent(
    "<P>trusted &amp; <STRONG>new</STRONG><BR /></P>",
    "html",
    true
  ).html;

  updateNoteContent(note, fragment, "append", "", false);

  assert.equal(
    note.body,
    fixture.html + "<p>trusted &amp; <strong>new</strong><br></p>"
  );
  assert.equal(nameCalls(), 0);
});

test("rich-content detection combines all present kinds", () => {
  const fixture: Fixture = {
    kind: "drawing",
    html:
      '<object class="drawing"></object><table></table><input type="checkbox">',
    attachmentNames: ["sketch"],
  };
  const { note } = mockNote(fixture);

  assert.deepEqual(richContentKinds(note, fixture.html), [
    "attachment",
    "drawing",
    "table",
    "checklist",
  ]);
});

const deleteNoteSafely = new Function(
  `${JXA_DELETE_NOTE}; return deleteNoteSafely;`
)();

interface DeleteFixture {
  id: string;
  name: string;
  folder: string;
}

function mockNotesForDelete(fixtures: DeleteFixture[]) {
  const deleted: string[] = [];
  const byId = (id: string) => {
    const fixture = fixtures.find((candidate) => candidate.id === id);
    return {
      id: () => {
        if (!fixture) throw new Error("invalid id");
        return fixture.id;
      },
      name: () => {
        if (!fixture) throw new Error("invalid id");
        return fixture.name;
      },
    };
  };

  const folderNames = [...new Set(fixtures.map((fixture) => fixture.folder))];
  return {
    folders: {
      whose: ({ name }: { name: string }) =>
        folderNames
          .filter((folderName) => folderName === name)
          .map((folderName) => ({
            notes: {
              id: () =>
                fixtures
                  .filter((fixture) => fixture.folder === folderName)
                  .map((fixture) => fixture.id),
            },
          })),
    },
    delete: (note: { id: () => string }) => deleted.push(note.id()),
    deleted,
    target: (id: string) => ({
      note: byId(id),
      id,
      account: { id: "x-coredata://A/ICAccount/p1", name: "iCloud" },
      folder: {
        id: `x-coredata://A/ICFolder/${fixtures.find((fixture) => fixture.id === id)?.folder}`,
        name: fixtures.find((fixture) => fixture.id === id)?.folder,
      },
    }),
  };
}

const DELETE_FIXTURES: DeleteFixture[] = [
  { id: "x-coredata://A/ICNote/live", name: "Live note", folder: "Notes" },
  {
    id: "x-coredata://A/ICNote/trashed",
    name: "Trashed note",
    folder: "Recently Deleted",
  },
];

test("delete rejects an already-trashed note resolved by full id before mutation", () => {
  const Notes = mockNotesForDelete(DELETE_FIXTURES);

  assert.throws(
    () =>
      deleteNoteSafely(
        Notes,
        Notes.target("x-coredata://A/ICNote/trashed"),
        "Recently Deleted"
      ),
    /already in Recently Deleted.*permanently erase/i
  );
  assert.deepEqual(Notes.deleted, []);
});

test("delete allows an ordinary note and returns its mutation result", () => {
  const Notes = mockNotesForDelete(DELETE_FIXTURES);

  const target = Notes.target("x-coredata://A/ICNote/live");
  const result = deleteNoteSafely(Notes, target, "Recently Deleted");

  assert.deepEqual(result, {
    deleted: true,
    id: "x-coredata://A/ICNote/live",
    name: "Live note",
    account: target.account,
    folder: target.folder,
  });
  assert.deepEqual(Notes.deleted, ["x-coredata://A/ICNote/live"]);
});

test("delete honors a localized configured trash-folder name", () => {
  const fixtures: DeleteFixture[] = [
    {
      id: "x-coredata://A/ICNote/norsk",
      name: "Slettet notat",
      folder: "Nylig slettet",
    },
  ];
  const Notes = mockNotesForDelete(fixtures);

  assert.throws(
    () =>
      deleteNoteSafely(
        Notes,
        Notes.target("x-coredata://A/ICNote/norsk"),
        "Nylig slettet"
      ),
    /already in Nylig slettet/i
  );
  assert.deepEqual(Notes.deleted, []);
});
