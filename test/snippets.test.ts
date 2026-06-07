import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_HTML_HELPERS, JXA_RESOLVE_NOTE } from "../src/snippets.js";

// JXA is plain JavaScript — evaluate the snippets in Node and test them
// directly, with mock Notes objects standing in for the JXA bridge.

const { escapeHtml, toHtml } = new Function(
  `${JXA_HTML_HELPERS}; return { escapeHtml, toHtml };`
)();

test("escapeHtml escapes &, <, >", () => {
  assert.equal(escapeHtml("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
});

test("toHtml wraps plain-text lines in divs", () => {
  assert.equal(toHtml("a\nb"), "<div>a</div><div>b</div>");
});

test("toHtml renders empty lines as <br>", () => {
  assert.equal(toHtml("a\n\nb"), "<div>a</div><div><br></div><div>b</div>");
});

test("toHtml passes HTML bodies through untouched", () => {
  assert.equal(toHtml("<p>hi</p>"), "<p>hi</p>");
  assert.equal(toHtml("  <div>x</div>"), "  <div>x</div>");
});

test("toHtml escapes HTML injection in plain text", () => {
  assert.equal(toHtml("x<script>y"), "<div>x&lt;script&gt;y</div>");
});

const resolveNote = new Function(`${JXA_RESOLVE_NOTE}; return resolveNote;`)();

function mockNotes(notes: { id: string; name: string }[]) {
  const byId = (id: string) => {
    const n = notes.find((x) => x.id === id);
    return {
      name: () => {
        if (!n) throw new Error("invalid id");
        return n.name;
      },
    };
  };
  return {
    notes: {
      id: () => notes.map((n) => n.id),
      byId,
      whose: ({ name }: { name: string }) =>
        notes.filter((n) => n.name === name).map((n) => byId(n.id)),
    },
  };
}

const FIXTURES = [
  { id: "x-coredata://A/ICNote/p1", name: "one" },
  { id: "x-coredata://A/ICNote/p2", name: "two" },
  { id: "x-coredata://A/ICNote/p3", name: "two" },
];

test("resolveNote resolves a full id", () => {
  const note = resolveNote(mockNotes(FIXTURES), "x-coredata://A/ICNote/p1", "");
  assert.equal(note.name(), "one");
});

test("resolveNote resolves a short id by suffix", () => {
  const note = resolveNote(mockNotes(FIXTURES), "p1", "");
  assert.equal(note.name(), "one");
});

test("resolveNote throws on unknown short id", () => {
  assert.throws(() => resolveNote(mockNotes(FIXTURES), "p9", ""), /Note id not found/);
});

test("resolveNote resolves a unique title", () => {
  const note = resolveNote(mockNotes(FIXTURES), "", "one");
  assert.equal(note.name(), "one");
});

test("resolveNote throws on unknown title", () => {
  assert.throws(() => resolveNote(mockNotes(FIXTURES), "", "missing"), /Note not found/);
});

test("resolveNote refuses ambiguous titles", () => {
  assert.throws(() => resolveNote(mockNotes(FIXTURES), "", "two"), /Multiple notes titled/);
});
