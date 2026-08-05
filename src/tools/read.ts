import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJxa } from "../jxa.js";
import { JXA_IDENTITY_HELPERS } from "../snippets.js";
import { ok, fail, factorIds, truncateBody } from "../helpers.js";
import { plaintextCache, staleIds } from "../cache.js";
import type { EntityIdentity, NoteLocation, NoteSummary, NoteDetail } from "../types.js";

// The special "Recently Deleted" folder is matched by name, which is localized
// by macOS. Override it for non-English locales via APPLE_NOTES_TRASH_FOLDER
// (e.g. "Nylig slettet" on a Norwegian system).
const TRASH_FOLDER = process.env.APPLE_NOTES_TRASH_FOLDER || "Recently Deleted";

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    "list_folders",
    {
      description:
        "List all Apple Notes folders with stable folder/account ids and note counts. Duplicate names remain separate entries.",
      inputSchema: {},
    },
    async () => {
      try {
        const folders = await runJxa<
          { id: string; name: string; account: EntityIdentity; count: number }[]
        >(`${JXA_IDENTITY_HELPERS}
          function run() {
            const Notes = Application("Notes");
            return JSON.stringify(folderCatalog(Notes, true).map(folder => ({
              id: folder.id,
              name: folder.name,
              account: folder.account,
              count: folder.count,
            })));
          }
        `);
        return ok(folders);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_notes",
    {
      description:
        "List notes with stable account/folder identity, most recently modified first. Filter by folder_id, or by a unique folder name for discovery.",
      inputSchema: {
        folder_id: z
          .string()
          .optional()
          .describe("Full stable folder id from list_folders (preferred)"),
        folder: z
          .string()
          .optional()
          .describe("Exact folder name; rejected when that name exists more than once"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(25)
          .describe("Maximum number of notes to return (default 25)"),
      },
    },
    async ({ folder_id, folder, limit }) => {
      if (folder_id && folder) {
        return fail(new Error("Provide either 'folder_id' or 'folder', not both."));
      }
      try {
        // Bulk property fetch — one Apple Event per property, fast even for many
        // notes. deletedIds (Recently Deleted contents) fetched for exclusion when
        // listing across all folders.
        const meta = await runJxa<{
          ids: string[];
          names: string[];
          modified: string[];
          deletedIds: string[];
          location: NoteLocation | null;
          locations: Record<string, NoteLocation> | null;
        }>(
          `${JXA_IDENTITY_HELPERS}
          function run(argv) {
            const folderId = argv[0];
            const folderName = argv[1];
            const trashName = argv[2];
            const Notes = Application("Notes");

            let container = Notes;
            let selected = null;
            let deletedIds = [];
            if (folderId !== "" || folderName !== "") {
              selected = resolveFolderForRead(Notes, folderId, folderName);
              container = selected.folder;
            } else {
              const trashFolders = Notes.folders.whose({ name: trashName });
              for (let i = 0; i < trashFolders.length; i++) {
                deletedIds = deletedIds.concat(trashFolders[i].notes.id());
              }
            }

            return JSON.stringify({
              ids: container.notes.id(),
              names: container.notes.name(),
              modified: container.notes.modificationDate().map(d => d.toISOString().slice(0, 19) + "Z"),
              deletedIds: deletedIds,
              location: selected === null ? null : {
                account: selected.account,
                folder: { id: selected.id, name: selected.name },
              },
              locations: selected === null ? noteIdentityMap(Notes) : null,
            });
          }
        `,
          [folder_id ?? "", folder ?? "", TRASH_FOLDER]
        );

        const deleted = new Set(meta.deletedIds);
        const liveIds = meta.ids.filter((id) => !deleted.has(id));
        const map = meta.locations;
        const { idPrefix, shorten } = factorIds(liveIds);

        const all: NoteSummary[] = [];
        meta.ids.forEach((id, i) => {
          if (deleted.has(id)) return;
          const location = meta.location ?? map?.[id];
          if (!location) {
            throw new Error(`Stable account/folder identity unavailable for note: ${id}`);
          }
          all.push({
            id: shorten(id),
            name: meta.names[i],
            account: location.account,
            folder: location.folder,
            modified: meta.modified[i],
          });
        });
        all.sort((a, b) => b.modified.localeCompare(a.modified));
        return ok({ idPrefix, notes: all.slice(0, limit) });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "search_notes",
    {
      description:
        "Search note titles/bodies and return matching summaries with stable account/folder identity.",
      inputSchema: {
        query: z.string().min(1).describe("Text to search for (case-insensitive)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Maximum number of results (default 20)"),
        scope: z
          .enum(["all", "title"])
          .default("all")
          .describe("'all' searches titles and bodies; 'title' searches titles only (faster)"),
      },
    },
    async ({ query, limit, scope }) => {
      try {
        // Always one cheap metadata fetch (no bodies).
        const meta = await runJxa<{
          ids: string[];
          names: string[];
          modified: string[];
          deletedIds: string[];
          locations: Record<string, NoteLocation>;
        }>(
          `${JXA_IDENTITY_HELPERS}
          function run(argv) {
            const trashName = argv[0];
            const Notes = Application("Notes");
            const trashFolders = Notes.folders.whose({ name: trashName });
            let deletedIds = [];
            for (let i = 0; i < trashFolders.length; i++) {
              deletedIds = deletedIds.concat(trashFolders[i].notes.id());
            }
            return JSON.stringify({
              ids: Notes.notes.id(),
              names: Notes.notes.name(),
              modified: Notes.notes.modificationDate().map(d => d.toISOString().slice(0, 19) + "Z"),
              deletedIds: deletedIds,
              locations: noteIdentityMap(Notes),
            });
          }
        `,
          [TRASH_FOLDER]
        );

        const deleted = new Set(meta.deletedIds);
        // Refresh the plaintext cache only for notes that are new or changed.
        if (scope === "all") {
          const stale = staleIds(meta.ids, meta.modified, deleted);
          if (stale.length > 0) {
            let fetched: Record<string, string>;
            if (plaintextCache.size > 0 && stale.length <= 20) {
              // Few changes — fetch just those notes by id.
              fetched = await runJxa<Record<string, string>>(
                `
                function run(argv) {
                  const ids = JSON.parse(argv[0]);
                  const Notes = Application("Notes");
                  const out = {};
                  for (const id of ids) out[id] = Notes.notes.byId(id).plaintext() || "";
                  return JSON.stringify(out);
                }
              `,
                [JSON.stringify(stale)]
              );
            } else {
              // Cold cache or many changes — one bulk fetch of all bodies.
              fetched = await runJxa<Record<string, string>>(`
                function run() {
                  const Notes = Application("Notes");
                  const ids = Notes.notes.id();
                  const plaintexts = Notes.notes.plaintext();
                  const out = {};
                  for (let i = 0; i < ids.length; i++) out[ids[i]] = plaintexts[i] || "";
                  return JSON.stringify(out);
                }
              `);
            }
            meta.ids.forEach((id, i) => {
              if (!deleted.has(id) && id in fetched) {
                plaintextCache.set(id, { modified: meta.modified[i], plaintext: fetched[id] });
              }
            });
          }
          // Evict notes that no longer exist (or were moved to Recently Deleted).
          const live = new Set(meta.ids.filter((id) => !deleted.has(id)));
          for (const id of plaintextCache.keys()) if (!live.has(id)) plaintextCache.delete(id);
        }

        // Search in-process; deleted notes excluded.
        const q = query.toLowerCase();
        const liveIds = meta.ids.filter((id) => !deleted.has(id));
        const map = meta.locations;
        const { idPrefix, shorten } = factorIds(liveIds);

        const result: NoteSummary[] = [];
        for (let i = 0; i < meta.ids.length && result.length < limit; i++) {
          const id = meta.ids[i];
          if (deleted.has(id)) continue;
          const inName = meta.names[i].toLowerCase().includes(q);
          const inBody =
            scope === "all" &&
            (plaintextCache.get(id)?.plaintext ?? "").toLowerCase().includes(q);
          if (inName || inBody) {
            const location = map[id];
            if (!location) {
              throw new Error(`Stable account/folder identity unavailable for note: ${id}`);
            }
            result.push({
              id: shorten(id),
              name: meta.names[i],
              account: location.account,
              folder: location.folder,
              modified: meta.modified[i],
            });
          }
        }
        return ok({ idPrefix, notes: result });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "get_note",
    {
      description:
        "Read one Apple Note by full/uniquely matching short id or exact unique title. Ambiguous selectors return full candidate ids and account/folder identities.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe("Note id from list_notes/search_notes (short, e.g. 'p634', or full x-coredata URL)"),
        title: z.string().optional().describe("Exact note title (used if id not given)"),
        max_chars: z
          .number()
          .int()
          .min(100)
          .default(10_000)
          .describe("Max body characters to return (default 10000); raise for long notes"),
      },
    },
    async ({ id, title, max_chars }) => {
      if (!id && !title) {
        return fail(new Error("Provide either 'id' or 'title'."));
      }
      try {
        const note = await runJxa<NoteDetail>(
          `${JXA_IDENTITY_HELPERS}
          function run(argv) {
            const Notes = Application("Notes");
            const target = resolveNoteForRead(Notes, argv[0], argv[1]);
            const note = target.note;

            return JSON.stringify({
              id: target.id,
              name: note.name(),
              account: target.account,
              folder: target.folder,
              created: note.creationDate().toISOString().slice(0, 19) + "Z",
              modified: note.modificationDate().toISOString().slice(0, 19) + "Z",
              plaintext: note.plaintext(),
            });
          }
        `,
          [id ?? "", title ?? ""]
        );
        note.plaintext = truncateBody(note.plaintext, max_chars);
        return ok(note);
      } catch (e) {
        return fail(e);
      }
    }
  );
}
