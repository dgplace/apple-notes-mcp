export interface CachedNote {
  modified: string;
  plaintext: string;
}

// In-process plaintext cache for search_notes. Keyed by full note id; an entry
// is reused only while the note's modificationDate is unchanged, so updates
// and deletes self-invalidate — no explicit cache hooks needed.
export const plaintextCache = new Map<string, CachedNote>();

// Ids whose cached body is missing or out of date (deleted notes excluded).
export function staleIds(
  ids: string[],
  modified: string[],
  deleted: Set<string>,
  cache: Map<string, CachedNote> = plaintextCache
): string[] {
  return ids.filter((id, i) => !deleted.has(id) && cache.get(id)?.modified !== modified[i]);
}
