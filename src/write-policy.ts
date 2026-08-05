export interface WritePolicy {
  allowSharedWrites: boolean;
}

/** Parse the separate, exact shared-write capability gate. */
export function parseAllowSharedWrites(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(
    `Invalid APPLE_NOTES_ALLOW_SHARED_WRITES ${JSON.stringify(value)}. Expected exactly "true" or "false" when present.`
  );
}
