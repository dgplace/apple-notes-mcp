export interface WritePolicy {
  allowSharedWrites: boolean;
  allowRawHtml: boolean;
}

/** Parse the separate, exact shared-write capability gate. */
export function parseAllowSharedWrites(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(
    `Invalid APPLE_NOTES_ALLOW_SHARED_WRITES ${JSON.stringify(value)}. Expected exactly "true" or "false" when present.`,
  );
}

/** Parse the separate, exact raw-HTML capability gate. */
export function parseAllowRawHtml(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(
    `Invalid APPLE_NOTES_ALLOW_RAW_HTML ${JSON.stringify(value)}. Expected exactly "true" or "false" when present.`,
  );
}
