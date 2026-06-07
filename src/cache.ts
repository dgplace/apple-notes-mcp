import { runJxa } from "./jxa.js";
import { JXA_FOLDER_MAP } from "./snippets.js";

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

type FolderMapFetcher = () => Promise<Record<string, string>>;

const defaultFetcher: FolderMapFetcher = () =>
  runJxa<Record<string, string>>(`${JXA_FOLDER_MAP}
    function run() {
      return JSON.stringify(noteFolderMap(Application("Notes")));
    }`);

// Cached id → folder-name map (bulk container.name() returns nulls in JXA, so
// the map is built by iterating folders — ~1 Apple Event per folder). Refreshed
// only when an unknown note id appears or note content changed; a stale label
// is cosmetic, while Recently-Deleted exclusion never relies on this cache.
let folderMapCache: Record<string, string> = {};

export async function getFolderMap(
  liveIds: string[],
  force = false,
  fetcher: FolderMapFetcher = defaultFetcher
): Promise<Record<string, string>> {
  if (force || liveIds.some((id) => !(id in folderMapCache))) {
    folderMapCache = await fetcher();
  }
  return folderMapCache;
}

export function resetFolderMapCache(): void {
  folderMapCache = {};
}
