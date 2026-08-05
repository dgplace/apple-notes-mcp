import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJxa } from "../jxa.js";
import {
  JXA_DELETE_NOTE,
  JXA_HTML_HELPERS,
  JXA_IDENTITY_HELPERS,
  JXA_SAFE_ERRORS,
  JXA_UPDATE_NOTE,
} from "../snippets.js";
import { ok, fail } from "../helpers.js";
import type { EntityIdentity } from "../types.js";

// The special "Recently Deleted" folder is matched by name, which is localized
// by macOS. Override it for non-English locales via APPLE_NOTES_TRASH_FOLDER,
// matching the existing read-tool behavior.
const TRASH_FOLDER = process.env.APPLE_NOTES_TRASH_FOLDER || "Recently Deleted";

const fullFolderId = z
  .string()
  .regex(
    /^x-coredata:\/\/.+\/ICFolder\/.+$/,
    "folder_id must be a full x-coredata://.../ICFolder/... id from list_folders"
  );

const fullNoteId = z
  .string()
  .regex(
    /^x-coredata:\/\/.+\/ICNote\/.+$/,
    "id must be a full x-coredata://.../ICNote/... id; short ids and titles are not accepted for mutations"
  );

export function registerWriteTools(server: McpServer): void {
  server.registerTool(
    "create_note",
    {
      description:
        "Create a note in one explicitly selected folder. Requires the full stable folder_id returned by list_folders.",
      inputSchema: {
        title: z.string().min(1).describe("Note title"),
        body: z.string().default("").describe("Note body — plain text or HTML"),
        folder_id: fullFolderId.describe("Full stable folder id from list_folders"),
      },
    },
    async ({ title, body, folder_id }) => {
      try {
        const created = await runJxa<{
          id: string;
          name: string;
          account: EntityIdentity;
          folder: EntityIdentity;
        }>(
          `${JXA_SAFE_ERRORS}
          ${JXA_HTML_HELPERS}
          ${JXA_IDENTITY_HELPERS}
          function run(argv) {
            return runSafely(() => {
              const title = argv[0];
              const body = argv[1];
              const folderId = argv[2];
              const Notes = Application("Notes");

              // Resolve and validate identity before constructing or pushing a note.
              const target = resolveFolderForMutation(Notes, folderId);
              const html = "<div><h1>" + escapeHtml(title) + "</h1></div>" + toHtml(body);
              const note = Notes.Note({ body: html });
              target.folder.notes.push(note);

              return {
                id: note.id(),
                name: note.name(),
                account: target.account,
                folder: { id: target.id, name: target.name },
              };
            });
          }
        `,
          [title, body, folder_id]
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
        "Update one Apple Note by its full stable id. Short ids and titles are not accepted for mutations.",
      inputSchema: {
        id: fullNoteId.describe(
          "Full note id. If a list response factored idPrefix, concatenate idPrefix and the displayed id."
        ),
        body: z.string().min(1).describe("Content to write — plain text or HTML"),
        mode: z
          .enum(["replace", "append"])
          .default("replace")
          .describe("'replace' the whole body, or 'append' to the end"),
        new_title: z
          .string()
          .optional()
          .describe("Rename the note (replace mode only)"),
        allow_rich_content_loss: z
          .boolean()
          .default(false)
          .describe(
            "Allow replace to discard attachments and other rich content (per-call, default false)"
          ),
      },
    },
    async ({ id, body, mode, new_title, allow_rich_content_loss }) => {
      try {
        const updated = await runJxa<{
          id: string;
          name: string;
          account: EntityIdentity;
          folder: EntityIdentity;
          modified: string;
        }>(
          `${JXA_SAFE_ERRORS}
          ${JXA_HTML_HELPERS}
          ${JXA_IDENTITY_HELPERS}
          ${JXA_UPDATE_NOTE}
          function run(argv) {
            return runSafely(() => {
              const Notes = Application("Notes");
              const target = resolveNoteForMutation(Notes, argv[0]);
              const note = target.note;
              const body = argv[1];
              const mode = argv[2];
              const newTitle = argv[3];
              const allowRichContentLoss = argv[4] === "true";

              updateNoteContent(note, body, mode, newTitle, allowRichContentLoss);

              return {
                id: target.id,
                name: note.name(),
                account: target.account,
                folder: target.folder,
                modified: note.modificationDate().toISOString().slice(0, 19) + "Z",
              };
            });
          }`,
          [
            id,
            body,
            mode,
            new_title ?? "",
            String(allow_rich_content_loss),
          ]
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
        "Ask Notes to move one ordinary note to Recently Deleted, addressed only by its full stable note id.",
      inputSchema: {
        id: fullNoteId.describe(
          "Full note id. If a list response factored idPrefix, concatenate idPrefix and the displayed id."
        ),
      },
    },
    async ({ id }) => {
      try {
        const deleted = await runJxa<{
          deleted: boolean;
          id: string;
          name: string;
          account: EntityIdentity;
          folder: EntityIdentity;
        }>(
          `${JXA_SAFE_ERRORS}
          ${JXA_IDENTITY_HELPERS}
          ${JXA_DELETE_NOTE}
          function run(argv) {
            return runSafely(() => {
              const Notes = Application("Notes");
              const target = resolveNoteForMutation(Notes, argv[0]);
              return deleteNoteSafely(Notes, target, argv[1]);
            });
          }`,
          [id, TRASH_FOLDER]
        );
        return ok(deleted);
      } catch (e) {
        return fail(e);
      }
    }
  );
}
