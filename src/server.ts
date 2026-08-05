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
  "delete_note requests recoverable placement in configured Recently Deleted, but recovery is not guaranteed for every Notes account.",
  "Detected rich-content replacement is rejected unless allow_rich_content_loss=true, and deleting a note already in Recently Deleted is rejected.",
  "Writes to locked notes are refused. Shared-note writes require both APPLE_NOTES_ALLOW_SHARED_WRITES=true and allow_shared_note=true on the individual call.",
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
