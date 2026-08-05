import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_HTML_HELPERS } from "../src/snippets.js";

// JXA is plain JavaScript — evaluate the snippets in Node and test them
// directly, with mock Notes objects standing in for the JXA bridge.

const { escapeHtml } = new Function(`${JXA_HTML_HELPERS}; return { escapeHtml };`)();

test("escapeHtml escapes &, <, >", () => {
  assert.equal(escapeHtml("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
});

test("the JXA helper exposes no content auto-detection function", () => {
  assert.doesNotMatch(JXA_HTML_HELPERS, /toHtml/);
});
