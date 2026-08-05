import { safeError, safeErrorText } from "./errors.js";
import { READ_LIMITS, serializedToolResultBytes } from "./read-policy.js";

export function ok(data: unknown) {
  const result = {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
  if (serializedToolResultBytes(data) > READ_LIMITS.maxResponseBytes) {
    throw safeError("RESULT_TOO_LARGE", `Tool result exceeds the ${READ_LIMITS.maxResponseBytes}-byte hard limit.`);
  }
  return result;
}

export function fail(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: safeErrorText(error),
      },
    ],
    isError: true,
  };
}

// Factor the shared "x-coredata://UUID/ICNote/" prefix out of ids — returned
// once as idPrefix instead of repeated per note.
export function factorIds(ids: string[]) {
  const prefix = ids.length ? ids[0].slice(0, ids[0].lastIndexOf("/") + 1) : "";
  const shared = prefix !== "" && ids.every((id) => id.startsWith(prefix));
  return {
    idPrefix: shared ? prefix : "",
    shorten: (id: string) => (shared ? id.slice(prefix.length) : id),
  };
}

// Retained for API compatibility with 1.x consumers. Read tools now page the
// body inside JXA and return structured continuation metadata instead.
export function truncateBody(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const total = text.length;
  return (
    text.slice(0, maxChars) + `\n…[truncated ${total - maxChars} of ${total} chars — re-call with max_chars=${total}]`
  );
}
