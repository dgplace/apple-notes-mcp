import { test } from "node:test";
import assert from "node:assert/strict";
import { JXA_HTML_HELPERS } from "../src/snippets.js";

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
