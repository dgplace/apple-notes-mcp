import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";
import type { WritePolicy } from "./write-policy.js";

export const SERVER_VERSION = "2.0.0";

export type AppleNotesMode = "read-only" | "read-write";

export const SERVER_INSTRUCTIONS = [
  "Apple Notes content is accessed locally by this stdio-only server.",
  "Tool results are returned to the connected MCP client and may be sent to its model provider, so they are not guaranteed to remain on this Mac.",
  "Write tools are available only with APPLE_NOTES_MODE=read-write and every mutation requires explicit user approval in the MCP client.",
  "Mutations require full stable folder or note IDs from discovery; names and shortened note IDs are read-only selectors and ambiguity is rejected.",
  "Note-bearing reads fail closed until APPLE_NOTES_TRASH_FOLDER_IDS contains exactly one full stable Recently Deleted folder ID for every currently discovered account.",
  "Mutations use read revisions, reject stale updates, support dry-run previews, and verify state after every real write.",
  "Write content defaults to escaped plain text. Raw HTML requires both APPLE_NOTES_ALLOW_RAW_HTML=true and content_format=html, and is restricted to a small attribute-free subset.",
  "trash_note requires confirm=true and a current revision, explicitly moves to the validated stable configured Recently Deleted destination, and never invokes Notes' delete command or any permanent-delete operation.",
  "Notes automation exposes account id, name, default-folder id, and upgraded state, but no trustworthy account type or shared-note ownership; trash previews and results report those facts as unavailable or unknown.",
  "Detected rich-content replacement is rejected unless allow_rich_content_loss=true, and trashing a note already in Recently Deleted is rejected to prevent permanent erasure.",
  "Writes to locked notes are refused. Ordinary shared-note writes require APPLE_NOTES_ALLOW_SHARED_WRITES=true plus allow_shared_note=true; shared trashing additionally requires allow_shared_trash=true and confirm_shared_impact=true.",
].join(" ");

/** Parse the complete security configuration. Undefined means the secure default. */
export function parseAppleNotesMode(value: string | undefined): AppleNotesMode {
  if (value === undefined) return "read-only";
  if (value === "read-only" || value === "read-write") return value;

  throw new Error(
    `Invalid APPLE_NOTES_MODE ${JSON.stringify(value)}. Expected exactly "read-only" or "read-write".`
  );
}

export function createAppleNotesServer(
  mode: AppleNotesMode,
  writePolicy: WritePolicy = { allowSharedWrites: false, allowRawHtml: false }
): McpServer {
  const server = new McpServer(
    {
      name: "apple-notes",
      version: SERVER_VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  registerReadTools(server);
  if (mode === "read-write") registerWriteTools(server, writePolicy);

  return server;
}
