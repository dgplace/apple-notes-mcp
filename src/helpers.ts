export function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

export function fail(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
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

// Cap a note body at maxChars, with a marker telling the model how to fetch
// the rest.
export function truncateBody(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const total = text.length;
  return (
    text.slice(0, maxChars) +
    `\n…[truncated ${total - maxChars} of ${total} chars — re-call with max_chars=${total}]`
  );
}
