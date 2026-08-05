import { safeError } from "./errors.js";

export const READ_LIMITS = Object.freeze({
  defaultFolderResults: 50,
  defaultNoteResults: 25,
  defaultSearchResults: 20,
  maxResults: 100,
  maxQueryChars: 256,
  defaultBodyPageChars: 10_000,
  maxBodyPageChars: 20_000,
  maxResponseBytes: 64 * 1024,
  maxOffset: 10_000_000,
  maxSelectorChars: 2_048,
  maxStableIdChars: 2_048,
  maxTrashFolders: 32,
});

export interface PageRequest {
  limit: number;
  offset: number;
}

export interface PageMetadata {
  offset: number;
  returned: number;
  total: number;
  truncated: boolean;
  next_offset?: number;
}

export interface BodyPageRequest {
  maxChars: number;
  offset: number;
}

export interface TrashFolderAccount {
  id: string;
  accountId: string;
}

export interface TrashConfigurationStatus {
  ready: boolean;
  unknownFolderIds: string[];
  missingAccountIds: string[];
  duplicateAccountIds: string[];
}

export function parseTrashFolderIds(value: string | undefined): string[] {
  if (value === undefined) return [];
  if (value.trim() === "") {
    throw safeError(
      "TRASH_CONFIG_INVALID",
      "APPLE_NOTES_TRASH_FOLDER_IDS is present but empty. Remove it for discovery or provide comma-separated full ICFolder IDs."
    );
  }

  const ids = value.split(",").map((id) => id.trim());
  if (ids.length > READ_LIMITS.maxTrashFolders) {
    throw safeError(
      "TRASH_CONFIG_INVALID",
      `APPLE_NOTES_TRASH_FOLDER_IDS accepts at most ${READ_LIMITS.maxTrashFolders} folder IDs.`
    );
  }
  for (const id of ids) {
    if (id.length > READ_LIMITS.maxStableIdChars) {
      throw safeError(
        "TRASH_CONFIG_INVALID",
        `APPLE_NOTES_TRASH_FOLDER_IDS entries may not exceed ${READ_LIMITS.maxStableIdChars} characters.`
      );
    }
    if (!/^x-coredata:\/\/.+\/ICFolder\/.+$/.test(id)) {
      throw safeError(
        "TRASH_CONFIG_INVALID",
        "Every APPLE_NOTES_TRASH_FOLDER_IDS entry must be a full x-coredata://.../ICFolder/... ID from list_folders."
      );
    }
  }
  if (new Set(ids).size !== ids.length) {
    throw safeError("TRASH_CONFIG_INVALID", "APPLE_NOTES_TRASH_FOLDER_IDS contains a duplicate ID.");
  }
  return ids;
}

export function requireTrashFolderIds(ids: readonly string[]): void {
  if (ids.length === 0) {
    throw safeError(
      "TRASH_CONFIG_REQUIRED",
      "Reads are disabled until Recently Deleted is configured by stable identity. Call list_folders, identify exactly one localized Recently Deleted folder for every currently discovered account, set APPLE_NOTES_TRASH_FOLDER_IDS to their comma-separated full IDs, and restart the server."
    );
  }
}

export function trashConfigurationStatus(
  configured: readonly string[],
  folders: readonly TrashFolderAccount[],
  accountIds: readonly string[]
): TrashConfigurationStatus {
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const unknownFolderIds = configured.filter((id) => !folderById.has(id));
  const configuredByAccount = new Map<string, number>();
  for (const id of configured) {
    const folder = folderById.get(id);
    if (!folder) continue;
    configuredByAccount.set(
      folder.accountId,
      (configuredByAccount.get(folder.accountId) ?? 0) + 1
    );
  }
  const discoveredAccounts = [...new Set(accountIds)];
  const missingAccountIds = discoveredAccounts.filter(
    (accountId) => (configuredByAccount.get(accountId) ?? 0) === 0
  );
  const duplicateAccountIds = [...configuredByAccount.entries()]
    .filter(([, count]) => count > 1)
    .map(([accountId]) => accountId);
  return {
    ready:
      configured.length > 0 &&
      unknownFolderIds.length === 0 &&
      missingAccountIds.length === 0 &&
      duplicateAccountIds.length === 0,
    unknownFolderIds,
    missingAccountIds,
    duplicateAccountIds,
  };
}

function boundedIdList(ids: readonly string[]): string {
  const displayed = ids.slice(0, 8).map((id) => id.slice(0, READ_LIMITS.maxStableIdChars));
  const remainder = ids.length - displayed.length;
  return displayed.join(", ") + (remainder > 0 ? ` (and ${remainder} more)` : "");
}

export function assertCompleteTrashConfiguration(
  configured: readonly string[],
  folders: readonly TrashFolderAccount[],
  accountIds: readonly string[]
): void {
  requireTrashFolderIds(configured);
  const status = trashConfigurationStatus(configured, folders, accountIds);
  if (status.unknownFolderIds.length > 0) {
    throw safeError(
      "TRASH_CONFIG_STALE",
      `Configured trash folder IDs are not present in Notes: ${boundedIdList(status.unknownFolderIds)}. Re-run list_folders and update APPLE_NOTES_TRASH_FOLDER_IDS.`
    );
  }
  if (status.duplicateAccountIds.length > 0) {
    throw safeError(
      "TRASH_CONFIG_INVALID",
      `More than one configured trash folder belongs to these account IDs: ${boundedIdList(status.duplicateAccountIds)}. Configure exactly one Recently Deleted folder per account.`
    );
  }
  if (status.missingAccountIds.length > 0) {
    throw safeError(
      "TRASH_CONFIG_INCOMPLETE",
      `No configured trash folder covers these Notes account IDs: ${boundedIdList(status.missingAccountIds)}. Re-run list_folders and configure exactly one Recently Deleted folder per account.`
    );
  }
}

function integer(value: unknown, fallback: number, label: string): number {
  const resolved = value === undefined ? fallback : value;
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved)) {
    throw safeError("INVALID_ARGUMENT", `${label} must be a safe integer.`);
  }
  return resolved;
}

export function normalizePageRequest(
  limit: unknown,
  offset: unknown,
  defaultLimit: number
): PageRequest {
  const requestedLimit = integer(limit, defaultLimit, "limit");
  const requestedOffset = integer(offset, 0, "offset");
  if (requestedLimit < 1) throw safeError("INVALID_ARGUMENT", "limit must be at least 1.");
  if (requestedOffset < 0 || requestedOffset > READ_LIMITS.maxOffset) {
    throw safeError(
      "INVALID_ARGUMENT",
      `offset must be between 0 and ${READ_LIMITS.maxOffset}.`
    );
  }
  return {
    limit: Math.min(requestedLimit, READ_LIMITS.maxResults),
    offset: requestedOffset,
  };
}

export function normalizeBodyPageRequest(maxChars: unknown, offset: unknown): BodyPageRequest {
  const requested = integer(maxChars, READ_LIMITS.defaultBodyPageChars, "max_chars");
  const requestedOffset = integer(offset, 0, "offset");
  if (requested < 1) throw safeError("INVALID_ARGUMENT", "max_chars must be at least 1.");
  if (requestedOffset < 0 || requestedOffset > READ_LIMITS.maxOffset) {
    throw safeError(
      "INVALID_ARGUMENT",
      `offset must be between 0 and ${READ_LIMITS.maxOffset}.`
    );
  }
  return {
    // Never round this upward: returning more content than the caller asked
    // for would violate the read boundary. Values above the ceiling clamp.
    maxChars: Math.min(requested, READ_LIMITS.maxBodyPageChars),
    offset: requestedOffset,
  };
}

export function normalizeSearchQuery(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw safeError("INVALID_ARGUMENT", "query must be a non-empty string.");
  }
  if (value.length > READ_LIMITS.maxQueryChars) {
    throw safeError(
      "QUERY_TOO_LONG",
      `query exceeds the hard limit of ${READ_LIMITS.maxQueryChars} characters.`
    );
  }
  return value;
}

export function normalizeSelector(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw safeError("INVALID_ARGUMENT", `${label} must be a non-empty string when provided.`);
  }
  if (value.length > READ_LIMITS.maxSelectorChars) {
    throw safeError(
      "INVALID_ARGUMENT",
      `${label} exceeds the hard limit of ${READ_LIMITS.maxSelectorChars} characters.`
    );
  }
  return value;
}

export function serializedToolResultBytes(data: unknown, isError = false): number {
  const text = isError ? String(data) : JSON.stringify(data);
  return Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text }],
      ...(isError ? { isError: true } : {}),
    }),
    "utf8"
  );
}

export function paginateBySerializedSize<T>(
  items: readonly T[],
  request: PageRequest,
  assemble: (page: readonly T[], metadata: PageMetadata) => unknown
): unknown {
  const start = Math.min(request.offset, items.length);
  const countEnd = Math.min(start + request.limit, items.length);
  let page: T[] = [];

  for (let index = start; index < countEnd; index++) {
    const candidate = [...page, items[index]];
    const next = start + candidate.length;
    const metadata: PageMetadata = {
      offset: start,
      returned: candidate.length,
      total: items.length,
      truncated: next < items.length,
      ...(next < items.length ? { next_offset: next } : {}),
    };
    if (serializedToolResultBytes(assemble(candidate, metadata)) > READ_LIMITS.maxResponseBytes) {
      break;
    }
    page = candidate;
  }

  if (page.length === 0 && start < countEnd) {
    throw safeError(
      "RESULT_ITEM_TOO_LARGE",
      `One metadata item cannot fit within the ${READ_LIMITS.maxResponseBytes}-byte tool-result limit.`
    );
  }

  const next = start + page.length;
  const metadata: PageMetadata = {
    offset: start,
    returned: page.length,
    total: items.length,
    truncated: next < items.length,
    ...(next < items.length ? { next_offset: next } : {}),
  };
  const data = assemble(page, metadata);
  if (serializedToolResultBytes(data) > READ_LIMITS.maxResponseBytes) {
    throw safeError(
      "RESULT_TOO_LARGE",
      `Tool result exceeds the ${READ_LIMITS.maxResponseBytes}-byte hard limit.`
    );
  }
  return data;
}
