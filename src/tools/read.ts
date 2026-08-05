import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJxa, type JxaRunner } from "../jxa.js";
import { JXA_BULK_RICH_METADATA, JXA_IDENTITY_HELPERS, JXA_RICH_CONTENT, JXA_SAFE_ERRORS } from "../snippets.js";
import { ok, fail, factorIds } from "../helpers.js";
import {
  READ_LIMITS,
  assertCompleteTrashConfiguration,
  normalizeBodyPageRequest,
  normalizePageRequest,
  normalizeSearchQuery,
  normalizeSelector,
  paginateBySerializedSize,
  parseTrashFolderIds,
  requireTrashFolderIds,
  serializedToolResultBytes,
  trashConfigurationStatus,
  type PageMetadata,
  type PageRequest,
} from "../read-policy.js";
import { safeError } from "../errors.js";
import { JXA_REVISION, revisionToken } from "../revision.js";
import type { EntityIdentity, NoteDetail, NoteLocation, NoteSummary, SummaryRichContent } from "../types.js";

interface FolderSummary {
  id: string;
  name: string;
  account: EntityIdentity;
  count: number;
}

interface FolderCatalogResult {
  folders: FolderSummary[];
  accountIds: string[];
}

interface BulkRichMetadata {
  available: boolean;
  byNote: Record<string, { attachment: true; possibleDrawing: boolean }>;
}

interface NoteMetadata {
  ids: string[];
  names: string[];
  modified: string[];
  revisionModified: string[];
  locked: boolean[];
  shared: boolean[];
  folderIds: string[];
  folderAccounts: { id: string; accountId: string }[];
  accountIds: string[];
  location: NoteLocation | null;
  locations: Record<string, NoteLocation> | null;
  rich: BulkRichMetadata;
}

function validateMetadata(meta: NoteMetadata): void {
  const expected = meta.ids.length;
  for (const [label, values] of [
    ["names", meta.names],
    ["modified", meta.modified],
    ["revisionModified", meta.revisionModified],
    ["locked", meta.locked],
    ["shared", meta.shared],
  ] as const) {
    if (!Array.isArray(values) || values.length !== expected) {
      throw new Error(`Malformed bulk note metadata: ${label}`);
    }
  }
}

export function summaryRichContent(noteId: string, bulk: BulkRichMetadata): SummaryRichContent {
  if (!bulk.available) {
    return {
      status: "unknown",
      unknown_kinds: ["attachment", "drawing", "table", "checklist"],
    };
  }
  const attachment = bulk.byNote[noteId];
  if (!attachment) {
    return {
      status: "unknown",
      unknown_kinds: ["drawing", "table", "checklist"],
    };
  }
  return {
    status: "present",
    kinds: ["attachment"],
    ...(attachment.possibleDrawing ? { possible_kinds: ["drawing" as const] } : {}),
    unknown_kinds: ["table", "checklist"],
  };
}

function stableSummarySort(a: NoteSummary, b: NoteSummary): number {
  return b.modified.localeCompare(a.modified) || a.id.localeCompare(b.id);
}

export function buildNotePage(items: NoteSummary[], request: PageRequest): unknown {
  const stable = [...items].sort(stableSummarySort);
  const { idPrefix, shorten } = factorIds(stable.map((item) => item.id));
  const display = stable.map((item) => ({ ...item, id: shorten(item.id) }));
  return paginateBySerializedSize(display, request, (notes, page) => ({
    idPrefix,
    notes,
    page,
  }));
}

function noteSummaries(meta: NoteMetadata, trashIds: ReadonlySet<string>): NoteSummary[] {
  validateMetadata(meta);
  const notes: NoteSummary[] = [];
  for (let index = 0; index < meta.ids.length; index++) {
    const id = meta.ids[index];
    const location = meta.location ?? meta.locations?.[id];
    if (!location) throw new Error("Bulk note identity map is incomplete");
    if (trashIds.has(location.folder.id)) continue;
    notes.push({
      id,
      name: meta.names[index],
      account: location.account,
      folder: location.folder,
      modified: meta.modified[index],
      revision: revisionToken(id, location.account.id, location.folder.id, meta.revisionModified[index]),
      locked: Boolean(meta.locked[index]),
      shared: Boolean(meta.shared[index]),
      rich_content: summaryRichContent(id, meta.rich),
    });
  }
  return notes;
}

function noteMetadataScript(): string {
  return `${JXA_SAFE_ERRORS}
    ${JXA_IDENTITY_HELPERS}
    ${JXA_BULK_RICH_METADATA}
    ${JXA_REVISION}
    function run(argv) {
      return runSafely(() => {
        const folderId = argv[0];
        const folderName = argv[1];
        const trashIds = JSON.parse(argv[2]);
        const query = argv[3] || "";
        const scope = argv[4] || "title";
        const Notes = Application("Notes");
        const catalog = folderCatalog(Notes, false);
        const folderIds = catalog.map(folder => folder.id);
        const accountIds = Notes.accounts.id();
        validateTrashFolderIdsForRead(catalog, accountIds, trashIds);

        let container = Notes;
        let selected = null;
        if (folderId !== "" || folderName !== "") {
          selected = resolveFolderForRead(Notes, folderId, folderName);
          if (trashIds.indexOf(selected.id) !== -1) {
            throw safeError(
              "FOLDER_IN_RECENTLY_DELETED",
              "Refusing to list a folder whose stable ID is configured as Recently Deleted."
            );
          }
          container = selected.folder;
        }

        const ids = container.notes.id();
        const names = container.notes.name();
        const modified = container.notes.modificationDate();
        const locked = container.notes.passwordProtected();
        const shared = container.notes.shared();
        let indexes = ids.map((_, index) => index);
        if (query !== "") {
          // Notes evaluates these predicates and returns IDs only. Plaintext
          // never crosses the automation boundary during search.
          const matching = new Set(container.notes.whose({ name: { _contains: query } }).id());
          if (scope === "all") {
            const bodyIds = container.notes.whose({ plaintext: { _contains: query } }).id();
            for (let i = 0; i < bodyIds.length; i++) matching.add(bodyIds[i]);
          }
          indexes = indexes.filter(index => matching.has(ids[index]));
        }

        return {
          ids: indexes.map(index => ids[index]),
          names: indexes.map(index => names[index]),
          modified: indexes.map(index => modified[index].toISOString().slice(0, 19) + "Z"),
          revisionModified: indexes.map(index => fullModificationTime(modified[index])),
          locked: indexes.map(index => locked[index]),
          shared: indexes.map(index => shared[index]),
          folderIds: folderIds,
          folderAccounts: catalog.map(folder => ({ id: folder.id, accountId: folder.account.id })),
          accountIds: accountIds,
          location: selected === null ? null : {
            account: selected.account,
            folder: { id: selected.id, name: selected.name },
          },
          locations: selected === null ? noteIdentityMap(Notes) : null,
          rich: bulkRichContentMetadata(Notes),
        };
      });
    }
  `;
}

export function fitNoteDetailToResult(note: NoteDetail): NoteDetail {
  const make = (length: number): NoteDetail => {
    if (note.plaintext === undefined) return note;
    const plaintext = note.plaintext.slice(0, length);
    const truncated = note.page.truncated || length < note.plaintext.length;
    const next = note.page.offset + plaintext.length;
    return {
      ...note,
      plaintext,
      page: {
        ...note.page,
        returned_chars: plaintext.length,
        truncated,
        ...(truncated ? { next_offset: next } : { next_offset: undefined }),
      },
    };
  };

  if (note.plaintext === undefined) {
    if (serializedToolResultBytes(note) > READ_LIMITS.maxResponseBytes) {
      throw safeError("RESULT_TOO_LARGE", "Selected note metadata cannot fit in one tool result.");
    }
    return note;
  }

  let low = 0;
  let high = note.plaintext.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedToolResultBytes(make(middle)) <= READ_LIMITS.maxResponseBytes) low = middle;
    else high = middle - 1;
  }
  const fitted = make(low);
  if (serializedToolResultBytes(fitted) > READ_LIMITS.maxResponseBytes) {
    throw safeError("RESULT_TOO_LARGE", "Selected note metadata cannot fit in one tool result.");
  }
  return fitted;
}

export function registerReadTools(server: McpServer, jxaRunner: JxaRunner = runJxa): void {
  // Invalid explicit configuration prevents startup. Absence intentionally
  // enters discovery-only mode: list_folders works, note-bearing reads do not.
  const trashFolderIds = parseTrashFolderIds(process.env.APPLE_NOTES_TRASH_FOLDER_IDS);

  server.registerTool(
    "list_folders",
    {
      description:
        "Discover stable folder/account ids. Configure every Recently Deleted folder id before using note-bearing read tools. Supports offset pagination.",
      inputSchema: {
        limit: z.number().int().min(1).max(READ_LIMITS.maxResults).default(READ_LIMITS.defaultFolderResults),
        offset: z.number().int().min(0).max(READ_LIMITS.maxOffset).default(0),
      },
    },
    async ({ limit, offset }) => {
      try {
        const request = normalizePageRequest(limit, offset, READ_LIMITS.defaultFolderResults);
        const catalog = await jxaRunner<FolderCatalogResult>(`${JXA_SAFE_ERRORS}
          ${JXA_IDENTITY_HELPERS}
          function run() {
            return runSafely(() => {
              const Notes = Application("Notes");
              return {
                accountIds: Notes.accounts.id(),
                folders: folderCatalog(Notes, true).map(folder => ({
                  id: folder.id,
                  name: folder.name,
                  account: folder.account,
                  count: folder.count,
                })),
              };
            });
          }
        `);
        const status = trashConfigurationStatus(
          trashFolderIds,
          catalog.folders.map((folder) => ({
            id: folder.id,
            accountId: folder.account.id,
          })),
          catalog.accountIds,
        );
        const visible = catalog.folders
          .map((folder) => ({
            ...folder,
            ...(trashFolderIds.includes(folder.id) ? { configured_as_trash: true } : {}),
          }))
          .sort((a, b) => a.account.id.localeCompare(b.account.id) || a.id.localeCompare(b.id));
        const payload = paginateBySerializedSize(visible, request, (pageFolders, page: PageMetadata) => ({
          trash_configuration: {
            ready: status.ready,
            variable: "APPLE_NOTES_TRASH_FOLDER_IDS",
            ...(status.unknownFolderIds.length > 0
              ? {
                  stale_ids: status.unknownFolderIds.slice(0, READ_LIMITS.maxTrashFolders),
                }
              : {}),
            ...(status.missingAccountIds.length > 0
              ? {
                  missing_account_ids: status.missingAccountIds.slice(0, READ_LIMITS.maxTrashFolders),
                }
              : {}),
            ...(status.duplicateAccountIds.length > 0
              ? {
                  duplicate_account_ids: status.duplicateAccountIds.slice(0, READ_LIMITS.maxTrashFolders),
                }
              : {}),
          },
          folders: pageFolders,
          page,
        }));
        return ok(payload);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "list_notes",
    {
      description:
        "List live notes with stable identity and privacy metadata, newest first. Requires stable trash-folder configuration and supports offset pagination.",
      inputSchema: {
        folder_id: z.string().max(READ_LIMITS.maxSelectorChars).optional(),
        folder: z.string().max(READ_LIMITS.maxSelectorChars).optional(),
        limit: z.number().int().min(1).max(READ_LIMITS.maxResults).default(READ_LIMITS.defaultNoteResults),
        offset: z.number().int().min(0).max(READ_LIMITS.maxOffset).default(0),
      },
    },
    async ({ folder_id, folder, limit, offset }) => {
      try {
        requireTrashFolderIds(trashFolderIds);
        const folderId = normalizeSelector(folder_id, "folder_id");
        const folderName = normalizeSelector(folder, "folder");
        if (folderId && folderName) {
          throw safeError("INVALID_ARGUMENT", "Provide either folder_id or folder, not both.");
        }
        const request = normalizePageRequest(limit, offset, READ_LIMITS.defaultNoteResults);
        const meta = await jxaRunner<NoteMetadata>(noteMetadataScript(), [
          folderId ?? "",
          folderName ?? "",
          JSON.stringify(trashFolderIds),
        ]);
        assertCompleteTrashConfiguration(trashFolderIds, meta.folderAccounts, meta.accountIds);
        return ok(buildNotePage(noteSummaries(meta, new Set(trashFolderIds)), request));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "search_notes",
    {
      description:
        "Search live note titles or plaintext and return metadata summaries only. Requires stable trash-folder configuration; bodies are never returned.",
      inputSchema: {
        query: z.string().min(1).max(READ_LIMITS.maxQueryChars),
        limit: z.number().int().min(1).max(READ_LIMITS.maxResults).default(READ_LIMITS.defaultSearchResults),
        offset: z.number().int().min(0).max(READ_LIMITS.maxOffset).default(0),
        scope: z.enum(["all", "title"]).default("all"),
      },
    },
    async ({ query, limit, offset, scope }) => {
      try {
        requireTrashFolderIds(trashFolderIds);
        const q = normalizeSearchQuery(query);
        const request = normalizePageRequest(limit, offset, READ_LIMITS.defaultSearchResults);
        if (scope !== "all" && scope !== "title") {
          throw safeError("INVALID_ARGUMENT", "scope must be exactly 'all' or 'title'.");
        }
        const meta = await jxaRunner<NoteMetadata>(noteMetadataScript(), [
          "",
          "",
          JSON.stringify(trashFolderIds),
          q,
          scope,
        ]);
        assertCompleteTrashConfiguration(trashFolderIds, meta.folderAccounts, meta.accountIds);
        validateMetadata(meta);

        const trash = new Set(trashFolderIds);
        const summaries = noteSummaries(meta, trash);
        return ok(buildNotePage(summaries, request));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_note",
    {
      description:
        "Read one live note by unique selector. Returns at most 20000 plaintext characters; continue with page.next_offset. Locked notes return metadata without content.",
      inputSchema: {
        id: z.string().max(READ_LIMITS.maxSelectorChars).optional(),
        title: z.string().max(READ_LIMITS.maxSelectorChars).optional(),
        max_chars: z
          .number()
          .int()
          .min(1)
          .default(READ_LIMITS.defaultBodyPageChars)
          .describe(`Requested characters; values above ${READ_LIMITS.maxBodyPageChars} are clamped`),
        offset: z.number().int().min(0).max(READ_LIMITS.maxOffset).default(0),
      },
    },
    async ({ id, title, max_chars, offset }) => {
      try {
        requireTrashFolderIds(trashFolderIds);
        const noteId = normalizeSelector(id, "id");
        const noteTitle = normalizeSelector(title, "title");
        if (!noteId && !noteTitle) throw safeError("INVALID_ARGUMENT", "Provide either id or title.");
        if (noteId && noteTitle) throw safeError("INVALID_ARGUMENT", "Provide either id or title, not both.");
        const pageRequest = normalizeBodyPageRequest(max_chars, offset);
        const note = await jxaRunner<NoteDetail>(
          `${JXA_SAFE_ERRORS}
          ${JXA_IDENTITY_HELPERS}
          ${JXA_RICH_CONTENT}
          ${JXA_REVISION}
          function run(argv) {
            return runSafely(() => {
              const Notes = Application("Notes");
              const trashIds = JSON.parse(argv[2]);
              const catalog = folderCatalog(Notes, false);
              validateTrashFolderIdsForRead(catalog, Notes.accounts.id(), trashIds);
              const target = resolveNoteForRead(Notes, argv[0], argv[1], trashIds);
              const selected = target.note;
              const initialModified = fullModificationTime(selected.modificationDate());
              const locked = Boolean(selected.passwordProtected());
              const shared = Boolean(selected.shared());
              const name = selected.name();
              const created = selected.creationDate().toISOString().slice(0, 19) + "Z";
              let content;
              if (locked) {
                content = {
                  content_available: false,
                  unavailable_reason: "locked",
                  rich_content: {
                    status: "unknown",
                    unknown_kinds: ["attachment", "drawing", "table", "checklist"],
                  },
                  page: { offset: Number(argv[3]), returned_chars: 0, truncated: false },
                };
              } else {
                // Inspect and page only the explicitly selected note. The full
                // plaintext/body never appears in osascript stdout.
                const start = Number(argv[3]);
                const maxChars = Number(argv[4]);
                const plaintext = selected.plaintext() || "";
                const html = selected.body() || "";
                const kinds = richContentKinds(selected, html);
                const pageText = plaintext.slice(start, start + maxChars);
                const next = start + pageText.length;
                const truncated = next < plaintext.length;
                content = {
                  content_available: true,
                  plaintext: pageText,
                  rich_content: {
                    status: kinds.length > 0 ? "present" : "none",
                    ...(kinds.length > 0 ? { kinds: kinds } : {}),
                  },
                  page: {
                    offset: start,
                    returned_chars: pageText.length,
                    total_chars: plaintext.length,
                    truncated: truncated,
                    ...(truncated ? { next_offset: next } : {}),
                  },
                };
              }

              // Re-observe location and modification time after content. If
              // either changed, refuse to pair stale content with a newer
              // revision; the caller can retry the read conservatively.
              const finalLocation = noteIdentityMap(Notes)[target.id];
              const finalModified = fullModificationTime(selected.modificationDate());
              const observedRevision = consistentReadRevision(
                target.id,
                { account: target.account, folder: target.folder },
                initialModified,
                finalLocation,
                finalModified,
                trashIds
              );
              return Object.assign({
                id: target.id,
                name: name,
                account: finalLocation.account,
                folder: finalLocation.folder,
                created: created,
                modified: finalModified.slice(0, 19) + "Z",
                revision: observedRevision,
                locked: locked,
                shared: shared,
              }, content);
            });
          }
        `,
          [
            noteId ?? "",
            noteTitle ?? "",
            JSON.stringify(trashFolderIds),
            String(pageRequest.offset),
            String(pageRequest.maxChars),
          ],
        );
        return ok(fitNoteDetailToResult(note));
      } catch (error) {
        return fail(error);
      }
    },
  );
}
