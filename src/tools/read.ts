import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJxa } from "../jxa.js";
import { JXA_RESOLVE_NOTE } from "../snippets.js";
import { ok, fail, factorIds, truncateBody } from "../helpers.js";
import { plaintextCache, staleIds, getFolderMap } from "../cache.js";
import type { NoteSummary, NoteDetail } from "../types.js";

// The special "Recently Deleted" folder is matched by name, which is localized
// by macOS. Override it for non-English locales via APPLE_NOTES_TRASH_FOLDER
// (e.g. "Nylig slettet" on a Norwegian system).
const TRASH_FOLDER = process.env.APPLE_NOTES_TRASH_FOLDER || "Recently Deleted";

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    "list_folders",
    {
      description: "List all folders in Apple Notes with their note counts.",
      inputSchema: {},
    },
    async () => {
      try {
        const folders = await runJxa<{ name: string; count: number }[]>(`
          function run() {
            const Notes = Application("Notes");
            const names = Notes.folders.name();
            const result = [];
            for (let i = 0; i < names.length; i++) {
              result.push({ name: names[i], count: Notes.folders[i].notes.length });
            }
            return JSON.stringify(result);
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
        "List notes in Apple Notes, most recently modified first. Optionally filter by folder name. Returns id, title, folder, and modification date.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Folder name to list notes from (e.g. 'Notes', 'Work')"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(25)
          .describe("Maximum number of notes to return (default 25)"),
      },
    },
    async ({ folder, limit }) => {
      try {
        // Bulk property fetch — one Apple Event per property, fast even for many
        // notes. deletedIds (Recently Deleted contents) fetched for exclusion when
        // listing across all folders.
        const meta = await runJxa<{
          ids: string[];
          names: string[];
          modified: string[];
          deletedIds: string[];
        }>(
          `
          function run(argv) {
            const folderName = argv[0];
            const trashName = argv[1];
            const Notes = Application("Notes");

            let container = Notes;
            let deletedIds = [];
            if (folderName !== "") {
              const matches = Notes.folders.whose({ name: folderName });
              if (matches.length === 0) throw new Error("Folder not found: " + folderName);
              container = matches[0];
            } else {
              const rd = Notes.folders.whose({ name: trashName });
              deletedIds = rd.length > 0 ? rd[0].notes.id() : [];
            }

            return JSON.stringify({
              ids: container.notes.id(),
              names: container.notes.name(),
              modified: container.notes.modificationDate().map(d => d.toISOString().slice(0, 19) + "Z"),
              deletedIds: deletedIds,
            });
          }
        `,
          [folder ?? "", TRASH_FOLDER]
        );

        const deleted = new Set(meta.deletedIds);
        const liveIds = meta.ids.filter((id) => !deleted.has(id));
        const map = folder ? null : await getFolderMap(liveIds);
        const { idPrefix, shorten } = factorIds(meta.ids);

        const all: NoteSummary[] = [];
        meta.ids.forEach((id, i) => {
          if (deleted.has(id)) return;
          all.push({
            id: shorten(id),
            name: meta.names[i],
            folder: folder ?? (map?.[id] || undefined),
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
        "Search Apple Notes by text in the note title or body. Returns matching notes (id, title, folder, modification date).",
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
        }>(
          `
          function run(argv) {
            const trashName = argv[0];
            const Notes = Application("Notes");
            const rd = Notes.folders.whose({ name: trashName });
            return JSON.stringify({
              ids: Notes.notes.id(),
              names: Notes.notes.name(),
              modified: Notes.notes.modificationDate().map(d => d.toISOString().slice(0, 19) + "Z"),
              deletedIds: rd.length > 0 ? rd[0].notes.id() : [],
            });
          }
        `,
          [TRASH_FOLDER]
        );

        const deleted = new Set(meta.deletedIds);
        let foldersDirty = false;

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
            foldersDirty = true; // content changed — folder labels may have too
          }
          // Evict notes that no longer exist (or were moved to Recently Deleted).
          const live = new Set(meta.ids.filter((id) => !deleted.has(id)));
          for (const id of plaintextCache.keys()) if (!live.has(id)) plaintextCache.delete(id);
        }

        // Search in-process; deleted notes excluded.
        const q = query.toLowerCase();
        const liveIds = meta.ids.filter((id) => !deleted.has(id));
        const map = await getFolderMap(liveIds, foldersDirty);
        const { idPrefix, shorten } = factorIds(meta.ids);

        const result: NoteSummary[] = [];
        for (let i = 0; i < meta.ids.length && result.length < limit; i++) {
          const id = meta.ids[i];
          if (deleted.has(id)) continue;
          const inName = meta.names[i].toLowerCase().includes(q);
          const inBody =
            scope === "all" &&
            (plaintextCache.get(id)?.plaintext ?? "").toLowerCase().includes(q);
          if (inName || inBody) {
            result.push({
              id: shorten(id),
              name: meta.names[i],
              folder: map[id] || undefined,
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
        "Read the full content of an Apple Note by its id (preferred, from list_notes/search_notes) or exact title.",
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
          `${JXA_RESOLVE_NOTE}
          function run(argv) {
            const Notes = Application("Notes");
            const note = resolveNote(Notes, argv[0], argv[1]);

            return JSON.stringify({
              id: note.id(),
              name: note.name(),
              folder: note.container().name(),
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
