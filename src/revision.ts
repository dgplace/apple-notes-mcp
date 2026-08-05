/**
 * Build a lossless revision token from the complete stable note location and
 * the full-precision timestamp supplied by the Notes scripting API.
 *
 * The encoding intentionally uses only primitives also available in JXA. A
 * percent-encoded component cannot contain the `|` delimiter, so the mapping
 * is collision-free and reversible without depending on a hash library.
 */
export function revisionToken(noteId: string, accountId: string, folderId: string, modificationTime: string): string {
  return ["r2", noteId, accountId, folderId, modificationTime]
    .map((component) => encodeURIComponent(component))
    .join("|");
}

/** Plain-JavaScript companion injected into JXA scripts. */
export const JXA_REVISION = `
  function fullModificationTime(value) {
    return value.toISOString();
  }

  function revisionToken(noteId, accountId, folderId, modificationTime) {
    return ["r2", noteId, accountId, folderId, modificationTime]
      .map(component => encodeURIComponent(component))
      .join("|");
  }

  function noteRevision(note, id, location) {
    return revisionToken(
      id,
      location.account.id,
      location.folder.id,
      fullModificationTime(note.modificationDate())
    );
  }

  function consistentReadRevision(
    id,
    initialLocation,
    initialModified,
    finalLocation,
    finalModified,
    excludedFolderIds
  ) {
    if (!finalLocation || excludedFolderIds.indexOf(finalLocation.folder.id) !== -1) {
      throw safeError("NOTE_CHANGED_DURING_READ", "The note moved while it was being read. Retry get_note.");
    }
    if (
      initialModified !== finalModified ||
      initialLocation.account.id !== finalLocation.account.id ||
      initialLocation.folder.id !== finalLocation.folder.id
    ) {
      throw safeError("NOTE_CHANGED_DURING_READ", "The note changed while it was being read. Retry get_note.");
    }
    return revisionToken(
      id,
      finalLocation.account.id,
      finalLocation.folder.id,
      finalModified
    );
  }
`;
