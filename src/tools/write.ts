import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJxa } from "../jxa.js";
import {
  JXA_HTML_HELPERS,
  JXA_IDENTITY_HELPERS,
  JXA_SAFE_ERRORS,
  JXA_UPDATE_NOTE,
  JXA_WRITE_SAFETY,
} from "../snippets.js";
import { JXA_REVISION } from "../revision.js";
import { ok, fail } from "../helpers.js";
import { safeError } from "../errors.js";
import { parseTrashFolderIds, requireTrashFolderIds } from "../read-policy.js";
import type { WritePolicy } from "../write-policy.js";
import {
  CONTENT_LIMITS,
  prepareContent,
} from "../content.js";

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

const expectedRevision = z
  .string()
  .max(8_192)
  .regex(/^r2\|/, "expected_revision must be the revision returned by a read tool");

interface VerifiedWriteResult {
  id: string;
  name: string;
  account: { id: string; name: string };
  folder: { id: string; name: string };
  modified: string;
  revision: string;
  post_write: {
    verified: true;
    id: string;
    name: string;
    account: { id: string; name: string };
    folder: { id: string; name: string };
    modified: string;
    revision: string;
    body_html_chars?: number;
  };
}

const scriptPreamble = `${JXA_SAFE_ERRORS}
  ${JXA_HTML_HELPERS}
  ${JXA_IDENTITY_HELPERS}
  ${JXA_REVISION}
  ${JXA_WRITE_SAFETY}`;

export function requireTrashConfirmation(value: unknown): asserts value is true {
  if (value !== true) {
    throw safeError(
      "TRASH_CONFIRMATION_REQUIRED",
      "trash_note requires confirm: true. No Apple Notes automation was launched."
    );
  }
}

export function registerWriteTools(server: McpServer, policy: WritePolicy): void {
  const trashFolderIds = parseTrashFolderIds(
    process.env.APPLE_NOTES_TRASH_FOLDER_IDS
  );

  server.registerTool(
    "create_note",
    {
      description:
        "Create in one full stable folder id. Content defaults to escaped plain text; raw HTML requires two explicit gates.",
      inputSchema: {
        title: z.string().min(1).describe("Note title"),
        body: z.string().max(CONTENT_LIMITS.maxInputChars).default("").describe("Note body"),
        content_format: z.enum(["plain", "html"]).default("plain").describe(
          "plain always escapes markup; html also requires APPLE_NOTES_ALLOW_RAW_HTML=true"
        ),
        folder_id: fullFolderId.describe("Full stable folder id from list_folders"),
        dry_run: z.boolean().default(false),
        allow_shared_note: z.boolean().default(false).describe(
          "Per-call shared-write confirmation; also requires APPLE_NOTES_ALLOW_SHARED_WRITES=true"
        ),
      },
    },
    async ({ title, body, content_format, folder_id, dry_run, allow_shared_note }) => {
      try {
        const content = prepareContent(body, content_format, policy.allowRawHtml);
        requireTrashFolderIds(trashFolderIds);
        const result = await runJxa<VerifiedWriteResult | object>(`${scriptPreamble}
          function run(argv) {
            return runSafely(() => {
              const Notes = Application("Notes");
              const folderId = argv[2];
              const trashIds = JSON.parse(argv[3]);
              const serverAllowsShared = argv[4] === "true";
              const callAllowsShared = argv[5] === "true";
              const dryRun = argv[6] === "true";
              const context = writeCatalogContext(Notes, trashIds);
              const target = resolveFolderForMutation(Notes, folderId);
              if (trashIds.indexOf(target.id) !== -1) {
                throw safeError("FOLDER_IN_RECENTLY_DELETED", "Refusing to create a note in a configured Recently Deleted folder.");
              }
              const shared = assertWritableFolder(
                target.folder,
                serverAllowsShared,
                callAllowsShared
              );
              const html = "<div><h1>" + escapeHtml(argv[0]) + "</h1></div>" + argv[1];

              const preview = {
                  dry_run: true,
                  preview: {
                    operation: "create",
                    target: { account: target.account, folder: { id: target.id, name: target.name } },
                    projected: {
                      title: argv[0],
                      content_format: argv[7],
                      body_input_chars: Number(argv[8]),
                      body_html_fragment_chars: argv[1].length,
                      body_html_chars: html.length,
                    },
                    loss_flags: { rich_content_loss: false, shared: shared },
                  },
                };
              return executeWritePlan(dryRun, preview, () => {
                const attempt = { id: "" };
                return attemptCreateMutation(target.id, argv[0], attempt, () => {
                  const note = Notes.Note({ body: html });
                  target.folder.notes.push(note);
                  attempt.id = note.id();
                  const state = verifyPostWrite(attempt.id, () => authoritativeNoteState(Notes, attempt.id, true));
                  if (state.name !== argv[0] || state.body !== html || state.folder.id !== target.id) {
                    postWriteVerificationFailure(attempt.id, "The created note did not match its requested title, body, and destination.");
                  }
                  return Object.assign(publicVerifiedState(state), {
                    post_write: publicVerifiedState(state),
                  });
                });
              });
            });
          }`, [
          title,
          content.html,
          folder_id,
          JSON.stringify(trashFolderIds),
          String(policy.allowSharedWrites),
          String(allow_shared_note),
          String(dry_run),
          content.format,
          String(content.inputChars),
        ]);
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "update_note",
    {
      description:
        "Conflict-safe replace or append by full note id. Content defaults to escaped plain text; raw HTML requires two explicit gates.",
      inputSchema: {
        id: fullNoteId,
        expected_revision: expectedRevision,
        body: z.string().min(1).max(CONTENT_LIMITS.maxInputChars).describe("Content to write"),
        content_format: z.enum(["plain", "html"]).default("plain").describe(
          "plain always escapes markup; html also requires APPLE_NOTES_ALLOW_RAW_HTML=true"
        ),
        mode: z.enum(["replace", "append"]).default("replace"),
        new_title: z.string().optional().describe("Rename the note (replace mode only)"),
        allow_rich_content_loss: z.boolean().default(false),
        allow_shared_note: z.boolean().default(false),
        dry_run: z.boolean().default(false),
      },
    },
    async ({
      id,
      expected_revision,
      body,
      content_format,
      mode,
      new_title,
      allow_rich_content_loss,
      allow_shared_note,
      dry_run,
    }) => {
      try {
        const content = prepareContent(body, content_format, policy.allowRawHtml);
        requireTrashFolderIds(trashFolderIds);
        const result = await runJxa<VerifiedWriteResult | object>(`${scriptPreamble}
          ${JXA_UPDATE_NOTE}
          function run(argv) {
            return runSafely(() => {
              const Notes = Application("Notes");
              const trashIds = JSON.parse(argv[6]);
              const context = writeCatalogContext(Notes, trashIds);
              const target = resolveNoteForMutation(Notes, argv[0]);
              const note = target.note;
              assertLiveMutationTarget(target, context);
              const shared = assertWritableNote(note, argv[7] === "true", argv[8] === "true");
              const existingName = note.name();
              if (argv[3] === "append" && argv[4] !== "") {
                throw safeError("INVALID_ARGUMENT", "new_title is supported only in replace mode.");
              }
              const plan = planNoteUpdate(note, argv[2], argv[3], argv[4], argv[5] === "true");
              const projectedTitle = plan.projectedTitle === null ? existingName : plan.projectedTitle;
              const current = assertExpectedRevision(Notes, note, target.id, argv[1], context);
              const preview = {
                  dry_run: true,
                  preview: {
                    operation: argv[3],
                    target: { id: target.id, name: existingName, account: current.location.account, folder: current.location.folder },
                    current_revision: current.revision,
                    projected: {
                      title: projectedTitle,
                      content_format: argv[10],
                      body_input_chars: Number(argv[11]),
                      body_html_fragment_chars: argv[2].length,
                      body_html_chars_before: plan.existingBody.length,
                      body_html_chars_after: plan.nextBody.length,
                      body_html_chars_change: plan.nextBody.length - plan.existingBody.length,
                    },
                    loss_flags: {
                      rich_content_loss: argv[3] === "replace" && plan.richKinds.length > 0,
                      rich_content_kinds: plan.richKinds,
                      shared: shared,
                    },
                  },
                };
              return executeWritePlan(argv[9] === "true", preview, () => {
                return attemptMutation(target.id, () => {
                  applyNoteUpdate(note, plan);
                  const state = verifyPostWrite(target.id, () => authoritativeNoteState(Notes, target.id, true));
                  assertPostWriteRevisionChanged(target.id, current.revision, state.revision);
                  if (
                    state.body !== plan.nextBody ||
                    state.name !== projectedTitle ||
                    state.folder.id !== current.location.folder.id
                  ) {
                    postWriteVerificationFailure(target.id, "The updated note did not match the projected title, body, location, and new revision.");
                  }
                  return Object.assign(publicVerifiedState(state), {
                    operation: argv[3],
                    post_write: publicVerifiedState(state),
                  });
                });
              });
            });
          }`, [
          id,
          expected_revision,
          content.html,
          mode,
          new_title ?? "",
          String(allow_rich_content_loss),
          JSON.stringify(trashFolderIds),
          String(policy.allowSharedWrites),
          String(allow_shared_note),
          String(dry_run),
          content.format,
          String(content.inputChars),
        ]);
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "move_note",
    {
      description:
        "Move one live note to a full stable destination folder. Requires the latest revision and verifies the destination.",
      inputSchema: {
        id: fullNoteId,
        folder_id: fullFolderId,
        expected_revision: expectedRevision,
        allow_shared_note: z.boolean().default(false),
        dry_run: z.boolean().default(false),
      },
    },
    async ({ id, folder_id, expected_revision, allow_shared_note, dry_run }) => {
      try {
        requireTrashFolderIds(trashFolderIds);
        const result = await runJxa<VerifiedWriteResult | object>(`${scriptPreamble}
          function run(argv) {
            return runSafely(() => {
              const Notes = Application("Notes");
              const trashIds = JSON.parse(argv[3]);
              const context = writeCatalogContext(Notes, trashIds);
              const target = resolveNoteForMutation(Notes, argv[0]);
              const destination = resolveFolderForMutation(Notes, argv[1]);
              assertLiveMutationTarget(target, context);
              if (trashIds.indexOf(destination.id) !== -1) {
                throw safeError("FOLDER_IN_RECENTLY_DELETED", "Use trash_note, not move_note, for a Recently Deleted destination.");
              }
              const sharedNote = assertWritableNote(target.note, argv[4] === "true", argv[5] === "true");
              const sharedFolder = assertWritableFolder(destination.folder, argv[4] === "true", argv[5] === "true");
              const existingName = target.note.name();
              const current = assertExpectedRevision(Notes, target.note, target.id, argv[2], context);
              const preview = {
                  dry_run: true,
                  preview: {
                    operation: "move",
                    target: { id: target.id, name: existingName, account: current.location.account, folder: current.location.folder },
                    current_revision: current.revision,
                    projected: { destination: { account: destination.account, folder: { id: destination.id, name: destination.name } } },
                    loss_flags: { rich_content_loss: false, shared: sharedNote || sharedFolder },
                  },
                };
              return executeWritePlan(argv[6] === "true", preview, () => {
                if (current.location.folder.id === destination.id) {
                  throw safeError("NO_CHANGE", "The note is already in the requested destination folder.");
                }
                return attemptMutation(target.id, () => {
                  moveNoteToFolder(Notes, target.note, destination.folder);
                  const state = verifyPostWrite(target.id, () => authoritativeNoteState(Notes, target.id, false));
                  assertPostWriteRevisionChanged(target.id, current.revision, state.revision);
                  if (state.folder.id !== destination.id) {
                    postWriteVerificationFailure(target.id, "The moved note's destination and new revision could not be verified.");
                  }
                  return Object.assign(publicVerifiedState(state), {
                    operation: "move",
                    post_write: publicVerifiedState(state),
                  });
                });
              });
            });
          }`, [
          id,
          folder_id,
          expected_revision,
          JSON.stringify(trashFolderIds),
          String(policy.allowSharedWrites),
          String(allow_shared_note),
          String(dry_run),
        ]);
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    }
  );

  server.registerTool(
    "trash_note",
    {
      description:
        "Confirmed, conflict-safe request to move one live note to its account's configured stable Recently Deleted folder. Never permanently deletes; supports dry-run and verifies recoverable placement.",
      inputSchema: {
        id: fullNoteId,
        expected_revision: expectedRevision,
        confirm: z.literal(true).describe("Must be literal true for every trash request"),
        allow_shared_trash: z.boolean().default(false).describe(
          "Dedicated per-call shared-trash gate; also requires the server shared-write capability"
        ),
        confirm_shared_impact: z.boolean().default(false).describe(
          "For a shared note, acknowledge unknown ownership and possible collaborator impact"
        ),
        dry_run: z.boolean().default(false),
      },
    },
    async ({
      id,
      expected_revision,
      confirm,
      allow_shared_trash,
      confirm_shared_impact,
      dry_run,
    }) => {
      try {
        // This check is intentionally independent of the schema boundary so
        // direct/internal invocation cannot launch JXA without confirmation.
        requireTrashConfirmation(confirm);
        requireTrashFolderIds(trashFolderIds);
        const result = await runJxa<VerifiedWriteResult | object>(`${scriptPreamble}
          function run(argv) {
            return runSafely(() => {
              const Notes = Application("Notes");
              const trashIds = JSON.parse(argv[2]);
              const context = writeCatalogContext(Notes, trashIds);
              const target = resolveNoteForMutation(Notes, argv[0]);
              assertLiveMutationTarget(target, context);
              const accountMetadata = publicAccountMetadata(Notes, target.account.id);
              const sharedImpact = assertTrashableNote(
                target.note,
                argv[3] === "true",
                argv[4] === "true",
                argv[5] === "true"
              );
              const existingName = target.note.name();
              const trash = resolveRecoverableTrashDestination(
                Notes,
                context,
                target.account.id,
                target.folder.id
              );
              // This is the final Notes property read before a real mutation.
              const current = assertExpectedRevision(Notes, target.note, target.id, argv[1], context);
              if (
                current.location.account.id !== target.account.id ||
                current.location.folder.id !== target.folder.id ||
                trash.account.id !== current.location.account.id
              ) {
                throw safeError("CONFLICT", "The note location changed during trash preflight. Re-read it before retrying.");
              }
              const recoverability = {
                policy: "configured_stable_recently_deleted",
                evidence: "APPLE_NOTES_TRASH_FOLDER_IDS",
                account_match: true,
                recovery_guarantee: "unavailable_from_notes_automation",
                destination: { account: trash.account, folder: { id: trash.id, name: trash.name } },
              };
              const preview = {
                  dry_run: true,
                  preview: {
                    operation: "trash",
                    target: { id: target.id, name: existingName, account: current.location.account, folder: current.location.folder },
                    current_revision: current.revision,
                    account_metadata: accountMetadata,
                    recoverability: recoverability,
                    shared_impact: sharedImpact,
                    confirmation: { trash: true, shared_impact: argv[5] === "true" },
                    projected: { state: "trashed", destination: recoverability.destination },
                    loss_flags: { rich_content_loss: false, shared: sharedImpact.is_shared, permanent_deletion: false },
                  },
                };
              return executeWritePlan(argv[6] === "true", preview, () => {
                return attemptMutation(target.id, () => {
                  moveNoteToConfiguredTrash(Notes, target.note, trash.folder);
                  const state = verifyPostWrite(target.id, () => authoritativeNoteState(Notes, target.id, false));
                  assertPostTrashState(target.id, current.revision, trash.id, state);
                  return Object.assign(publicVerifiedState(state), {
                    operation: "trash",
                    trashed: true,
                    account_metadata: accountMetadata,
                    recoverability: Object.assign({ destination_verified: true }, recoverability),
                    shared_impact: sharedImpact,
                    post_write: publicVerifiedState(state),
                  });
                });
              });
            });
          }`, [
          id,
          expected_revision,
          JSON.stringify(trashFolderIds),
          String(policy.allowSharedWrites),
          String(allow_shared_trash),
          String(confirm_shared_impact),
          String(dry_run),
        ]);
        return ok(result);
      } catch (error) {
        return fail(error);
      }
    }
  );
}
