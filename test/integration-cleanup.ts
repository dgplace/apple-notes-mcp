export interface IntegrationCleanupState {
  trashAttempted: boolean;
  trashVerified: boolean;
}

export type IntegrationCleanupOutcome =
  | "already-attempted"
  | "not-authoritatively-live"
  | "verified"
  | "outcome-unknown";

/**
 * Make at most one recoverable trash request for an exact fixture note ID.
 * The authoritative read must prove that the note is still live and supply a
 * current revision. Once the trash call begins, an unknown response is never
 * retried because the first request may already have moved the note.
 */
export async function cleanupIntegrationNoteOnce(
  state: IntegrationCleanupState,
  observe: () => Promise<{ revision: string } | undefined>,
  trash: (revision: string) => Promise<boolean>,
): Promise<IntegrationCleanupOutcome> {
  if (state.trashAttempted) return "already-attempted";

  const live = await observe();
  if (!live?.revision) return "not-authoritatively-live";

  state.trashAttempted = true;
  state.trashVerified = await trash(live.revision).catch(() => false);
  return state.trashVerified ? "verified" : "outcome-unknown";
}
