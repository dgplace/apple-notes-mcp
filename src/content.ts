import { safeError } from "./errors.js";

export type ContentFormat = "plain" | "html";

export const CONTENT_LIMITS = {
  maxInputChars: 100_000,
  maxProjectedHtmlChars: 500_000,
} as const;

export interface PreparedContent {
  format: ContentFormat;
  inputChars: number;
  html: string;
}

const ALLOWED_CONTAINER_TAGS = new Set([
  "div",
  "p",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "li",
]);
const ALLOWED_INLINE_TAGS = new Set([
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "code",
]);
const ALLOWED_TAGS = new Set([
  ...ALLOWED_CONTAINER_TAGS,
  ...ALLOWED_INLINE_TAGS,
  "br",
]);
const INLINE_OR_PARAGRAPH = new Set(["p", ...ALLOWED_INLINE_TAGS]);

function assertInputBound(value: string): void {
  if (value.length > CONTENT_LIMITS.maxInputChars) {
    throw safeError(
      "CONTENT_TOO_LARGE",
      `Content exceeds the ${CONTENT_LIMITS.maxInputChars}-character hard limit.`
    );
  }
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function assertOutputBound(value: string): string {
  if (value.length > CONTENT_LIMITS.maxProjectedHtmlChars) {
    throw safeError(
      "CONTENT_TOO_LARGE",
      `Projected HTML exceeds the ${CONTENT_LIMITS.maxProjectedHtmlChars}-character hard limit.`
    );
  }
  return value;
}

/** Convert only plain text. There is deliberately no markup auto-detection. */
export function plainTextToHtml(value: string): string {
  assertInputBound(value);
  const normalized = value.replace(/\r\n?/g, "\n");
  return assertOutputBound(
    normalized
      .split("\n")
      .map((line) => `<div>${escapeText(line) || "<br>"}</div>`)
      .join("")
  );
}

function decodeEntity(entity: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  if (entity in named) return named[entity];

  const decimal = /^#([0-9]+)$/.exec(entity);
  const hexadecimal = /^#[xX]([0-9a-fA-F]+)$/.exec(entity);
  if (!decimal && !hexadecimal) {
    throw safeError(
      "INVALID_HTML",
      "Raw HTML contains an unsupported or malformed character entity."
    );
  }
  const codePoint = Number.parseInt(decimal?.[1] ?? hexadecimal![1], hexadecimal ? 16 : 10);
  if (
    !Number.isSafeInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
  ) {
    throw safeError("INVALID_HTML", "Raw HTML contains an invalid character entity.");
  }
  return String.fromCodePoint(codePoint);
}

function canonicalizeText(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; ) {
    if (value[index] !== "&") {
      decoded += value[index];
      index++;
      continue;
    }
    const semicolon = value.indexOf(";", index + 1);
    if (semicolon === -1) {
      throw safeError("INVALID_HTML", "Raw HTML contains an unterminated character entity.");
    }
    decoded += decodeEntity(value.slice(index + 1, semicolon));
    index = semicolon + 1;
  }
  return escapeText(decoded);
}

function assertAllowedNesting(tag: string, stack: string[]): void {
  const parent = stack.at(-1);
  if (tag === "li" && parent !== "ul" && parent !== "ol") {
    throw safeError("INVALID_HTML", "Raw HTML list items must be direct children of ul or ol.");
  }
  if ((parent === "ul" || parent === "ol") && tag !== "li") {
    throw safeError("INVALID_HTML", "Raw HTML lists may contain only direct li children.");
  }
  if (ALLOWED_CONTAINER_TAGS.has(tag) && INLINE_OR_PARAGRAPH.has(parent ?? "")) {
    throw safeError("INVALID_HTML", "Raw HTML contains invalid block-level nesting.");
  }
}

/**
 * Parse and canonicalize a deliberately tiny HTML fragment grammar.
 *
 * Tags have no attributes, comments, declarations, URLs, or media. Requiring
 * balanced syntax and parsing each token is intentional: a regex deny-list
 * cannot safely sanitize HTML.
 */
export function sanitizeNotesHtml(value: string): string {
  assertInputBound(value);
  const input = value.replace(/\r\n?/g, "\n");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(input)) {
    throw safeError("INVALID_HTML", "Raw HTML contains a disallowed control character.");
  }
  const stack: string[] = [];
  let output = "";

  for (let index = 0; index < input.length; ) {
    if (input[index] !== "<") {
      const nextTag = input.indexOf("<", index);
      const end = nextTag === -1 ? input.length : nextTag;
      const text = input.slice(index, end);
      const parent = stack.at(-1);
      if ((parent === "ul" || parent === "ol") && /\S/.test(text)) {
        throw safeError("INVALID_HTML", "Raw HTML lists may contain only li elements and whitespace.");
      }
      output += canonicalizeText(text);
      index = end;
      continue;
    }

    const end = input.indexOf(">", index + 1);
    if (end === -1) {
      throw safeError("INVALID_HTML", "Raw HTML contains an unterminated tag.");
    }
    const token = input.slice(index, end + 1);
    if (/^<!|^<\?/.test(token)) {
      throw safeError("INVALID_HTML", "Raw HTML comments and declarations are not allowed.");
    }
    const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9]*)\s*(\/?)\s*>$/.exec(token);
    if (!match) {
      throw safeError("INVALID_HTML", "Raw HTML attributes and malformed tags are not allowed.");
    }
    const closing = match[1] === "/";
    const selfClosing = match[3] === "/";
    const tag = match[2].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      throw safeError("INVALID_HTML", `Raw HTML element <${tag}> is not supported.`);
    }

    if (closing) {
      if (selfClosing || tag === "br" || stack.at(-1) !== tag) {
        throw safeError("INVALID_HTML", "Raw HTML tags are malformed or unbalanced.");
      }
      stack.pop();
      output += `</${tag}>`;
    } else if (tag === "br") {
      output += "<br>";
    } else {
      if (selfClosing) {
        throw safeError("INVALID_HTML", "Only br may use a self-closing raw HTML tag.");
      }
      assertAllowedNesting(tag, stack);
      stack.push(tag);
      output += `<${tag}>`;
    }
    if (output.length > CONTENT_LIMITS.maxProjectedHtmlChars) assertOutputBound(output);
    index = end + 1;
  }

  if (stack.length > 0) {
    throw safeError("INVALID_HTML", "Raw HTML tags are unbalanced.");
  }
  return assertOutputBound(output);
}

/** Runtime policy boundary, independent of schema validation/defaults. */
export function prepareContent(
  body: unknown,
  format: unknown,
  allowRawHtml: boolean
): PreparedContent {
  if (typeof body !== "string") {
    throw safeError("INVALID_ARGUMENT", "body must be a string.");
  }
  if (format !== "plain" && format !== "html") {
    throw safeError("INVALID_CONTENT_FORMAT", 'content_format must be exactly "plain" or "html".');
  }
  if (format === "html" && !allowRawHtml) {
    throw safeError(
      "RAW_HTML_DISABLED",
      "Raw HTML is disabled. Set APPLE_NOTES_ALLOW_RAW_HTML=true at server startup and explicitly pass content_format=html only for trusted content."
    );
  }
  return {
    format,
    inputChars: body.length,
    html: format === "plain" ? plainTextToHtml(body) : sanitizeNotesHtml(body),
  };
}
