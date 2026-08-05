import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTENT_LIMITS,
  plainTextToHtml,
  prepareContent,
  sanitizeNotesHtml,
} from "../src/content.js";

test("plain content is the default projection and never auto-detects markup", () => {
  assert.deepEqual(prepareContent("<p>literal</p>", "plain", false), {
    format: "plain",
    inputChars: 14,
    html: "<div>&lt;p&gt;literal&lt;/p&gt;</div>",
  });
  assert.equal(
    plainTextToHtml("  <div>x</div>"),
    "<div>  &lt;div&gt;x&lt;/div&gt;</div>"
  );
});

test("plain content escapes entities and wraps every line deterministically", () => {
  assert.equal(
    plainTextToHtml("<& already &amp; >\r\n\rline 3"),
    "<div>&lt;&amp; already &amp;amp; &gt;</div><div><br></div><div>line 3</div>"
  );
  assert.equal(plainTextToHtml(""), "<div><br></div>");
});

test("raw HTML accepts and canonicalizes the small balanced subset", () => {
  assert.equal(
    sanitizeNotesHtml(
      "<DIV>Hello &amp; &#x3c; <strong><EM>world</EM></strong><BR /></DIV>" +
        "<blockquote><p><code>x &gt; 1</code></p></blockquote>" +
        "<ul>\n<li><u>one</u></li><li><s>two</s></li>\n</ul>"
    ),
    "<div>Hello &amp; &lt; <strong><em>world</em></strong><br></div>" +
      "<blockquote><p><code>x &gt; 1</code></p></blockquote>" +
      "<ul>\n<li><u>one</u></li><li><s>two</s></li>\n</ul>"
  );
  assert.equal(
    prepareContent("<p>trusted</p>", "html", true).html,
    "<p>trusted</p>"
  );
  assert.equal(
    sanitizeNotesHtml("<p>&quot;quote&quot; &apos;apostrophe&apos; &#62; &#x26;</p>"),
    '<p>"quote" \'apostrophe\' &gt; &amp;</p>'
  );
});

test("raw HTML is denied unless the server capability and call format are explicit", () => {
  assert.throws(
    () => prepareContent("<p>trusted</p>", "html", false),
    (error: any) => error.code === "RAW_HTML_DISABLED"
  );
  assert.equal(
    prepareContent("<p>still literal</p>", "plain", true).html,
    "<div>&lt;p&gt;still literal&lt;/p&gt;</div>"
  );
});

test("runtime validation rejects schema-bypass content formats and non-string bodies", () => {
  for (const format of [undefined, "", "HTML", " html", "markdown", true]) {
    assert.throws(
      () => prepareContent("body", format, true),
      (error: any) => error.code === "INVALID_CONTENT_FORMAT"
    );
  }
  assert.throws(
    () => prepareContent({ body: "x" }, "plain", false),
    (error: any) => error.code === "INVALID_ARGUMENT"
  );
});

for (const [name, html] of Object.entries({
  script: "<script>alert(1)</script>",
  style: "<style>p{color:red}</style>",
  image: '<img src="https://example.test/a.png">',
  audio: '<audio src="https://example.test/a.mp3"></audio>',
  video: "<video></video>",
  iframe: '<iframe src="https://example.test"></iframe>',
  link: '<a href="https://example.test">remote</a>',
  object: '<object data="cid:file"></object>',
  embed: '<embed src="x">',
  event_handler: '<div onclick="alert(1)">x</div>',
  class_attribute: '<div class="Apple-style-span">x</div>',
  comment: "<!-- hidden --><p>x</p>",
  doctype: "<!doctype html><p>x</p>",
  table: "<table><tr><td>x</td></tr></table>",
  checklist: '<input type="checkbox">',
  heading: "<h1>replacement title</h1>",
  malformed_open: "<div",
  malformed_close: "<div>x</p>",
  unbalanced: "<div><strong>x</div></strong>",
  unsupported_entity: "<p>&nbsp;</p>",
  unterminated_entity: "<p>&amp</p>",
  invalid_list: "<ul>text<li>x</li></ul>",
  invalid_nesting: "<p><div>x</div></p>",
  control_character: "<p>x\u0000y</p>",
})) {
  test(`raw HTML rejects ${name}`, () => {
    assert.throws(
      () => sanitizeNotesHtml(html),
      (error: any) => error.code === "INVALID_HTML"
    );
  });
}

test("content input has a hard runtime ceiling independent of schemas", () => {
  const oversized = "x".repeat(CONTENT_LIMITS.maxInputChars + 1);
  for (const format of ["plain", "html"] as const) {
    assert.throws(
      () => prepareContent(oversized, format, true),
      (error: any) => error.code === "CONTENT_TOO_LARGE"
    );
  }
});
