import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_HTML_HELPERS, JXA_UPDATE_NOTE } from "../src/snippets.js";

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
      () => updateNoteContent(note, "replacement", "replace", "", false),
      new RegExp(`rich content.*${fixture.kind}.*allow_rich_content_loss`, "i")
    );
    assert.equal(typeof note.body, "function", "rejection must happen before mutation");
  });

  test(`replace permits intentional ${fixture.kind} loss with per-call override`, () => {
    const { note } = mockNote(fixture);

    updateNoteContent(note, "replacement", "replace", "", true);

    assert.equal(
      note.body,
      "<div><h1>Original title</h1></div><div>replacement</div>"
    );
  });

  test(`append preserves ${fixture.kind} HTML and the title`, () => {
    const { note, nameCalls } = mockNote(fixture);

    updateNoteContent(note, "added", "append", "", false);

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

  updateNoteContent(note, "new body", "replace", "", false);

  assert.equal(
    note.body,
    "<div><h1>Original &amp; exact</h1></div><div>new body</div>"
  );
  assert.equal(nameCalls(), 1);
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
