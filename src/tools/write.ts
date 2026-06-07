import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJxa } from "../jxa.js";
import { JXA_HTML_HELPERS, JXA_RESOLVE_NOTE } from "../snippets.js";
import { ok, fail } from "../helpers.js";

export function registerWriteTools(server: McpServer): void {
  server.registerTool(
    "create_note",
    {
      description:
        "Create a new note in Apple Notes. Body accepts plain text (line breaks preserved) or HTML.",
      inputSchema: {
        title: z.string().min(1).describe("Note title"),
        body: z.string().default("").describe("Note body — plain text or HTML"),
        folder: z
          .string()
          .optional()
          .describe("Folder to create the note in (default: the default Notes folder)"),
      },
    },
    async ({ title, body, folder }) => {
      try {
        const created = await runJxa<{ id: string; name: string; folder: string }>(
          `${JXA_HTML_HELPERS}
          function run(argv) {
            const title = argv[0];
            const body = argv[1];
            const folderName = argv[2];
            const Notes = Application("Notes");

            const html = "<div><h1>" + escapeHtml(title) + "</h1></div>" + toHtml(body);

            let container = Notes.defaultAccount;
            if (folderName !== "") {
              const matches = Notes.folders.whose({ name: folderName });
              if (matches.length === 0) throw new Error("Folder not found: " + folderName);
              container = matches[0];
            }

            const note = Notes.Note({ body: html });
            container.notes.push(note);

            return JSON.stringify({
              id: note.id(),
              name: note.name(),
              folder: note.container().name(),
            });
          }
        `,
          [title, body, folder ?? ""]
        );
        return ok(created);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "update_note",
    {
      description:
        "Update an Apple Note: replace its body or append to it. Locate by id (preferred) or exact title.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe("Note id from list_notes/search_notes (short or full)"),
        title: z.string().optional().describe("Exact note title (used if id not given)"),
        body: z.string().min(1).describe("Content to write — plain text or HTML"),
        mode: z
          .enum(["replace", "append"])
          .default("replace")
          .describe("'replace' the whole body, or 'append' to the end"),
        new_title: z
          .string()
          .optional()
          .describe("Rename the note (replace mode only)"),
      },
    },
    async ({ id, title, body, mode, new_title }) => {
      if (!id && !title) {
        return fail(new Error("Provide either 'id' or 'title'."));
      }
      try {
        const updated = await runJxa<{ id: string; name: string; modified: string }>(
          `${JXA_HTML_HELPERS}
          ${JXA_RESOLVE_NOTE}
          function run(argv) {
            const Notes = Application("Notes");
            const note = resolveNote(Notes, argv[0], argv[1]);
            const body = argv[2];
            const mode = argv[3];
            const newTitle = argv[4];

            if (mode === "append") {
              note.body = note.body() + toHtml(body);
            } else {
              const heading = newTitle !== "" ? newTitle : note.name();
              note.body = "<div><h1>" + escapeHtml(heading) + "</h1></div>" + toHtml(body);
            }

            return JSON.stringify({
              id: note.id(),
              name: note.name(),
              modified: note.modificationDate().toISOString().slice(0, 19) + "Z",
            });
          }`,
          [id ?? "", title ?? "", body, mode, new_title ?? ""]
        );
        return ok(updated);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "delete_note",
    {
      description:
        "Delete an Apple Note. The note is moved to Recently Deleted (recoverable for ~30 days), not permanently erased. Locate by id (preferred) or exact title.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe("Note id from list_notes/search_notes (short or full)"),
        title: z.string().optional().describe("Exact note title (used if id not given)"),
      },
    },
    async ({ id, title }) => {
      if (!id && !title) {
        return fail(new Error("Provide either 'id' or 'title'."));
      }
      try {
        const deleted = await runJxa<{ deleted: boolean; id: string; name: string }>(
          `${JXA_RESOLVE_NOTE}
          function run(argv) {
            const Notes = Application("Notes");
            const note = resolveNote(Notes, argv[0], argv[1]);
            const info = { deleted: true, id: note.id(), name: note.name() };
            Notes.delete(note);
            return JSON.stringify(info);
          }`,
          [id ?? "", title ?? ""]
        );
        return ok(deleted);
      } catch (e) {
        return fail(e);
      }
    }
  );
}
