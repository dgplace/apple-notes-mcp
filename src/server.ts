import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

export const SERVER_VERSION = "2.0.0";

export type AppleNotesMode = "read-only" | "read-write";

export const SERVER_INSTRUCTIONS = [
  "Apple Notes content is accessed locally by this stdio-only server.",
  "Tool results are returned to the connected MCP client and may be sent to its model provider, so they are not guaranteed to remain on this Mac.",
  "Write tools are available only with APPLE_NOTES_MODE=read-write and every mutation requires explicit user approval in the MCP client.",
  "delete_note asks Notes to move an ordinary note to Recently Deleted, but recovery is not guaranteed for every account or shared-note case.",
  "Detected rich-content replacement is rejected unless allow_rich_content_loss=true, and deleting a note already in Recently Deleted is rejected.",
  "Locked notes may be rejected by Notes, while shared-note writes are not yet independently gated; do not mutate either without confirming the risk.",
].join(" ");

/** Parse the complete security configuration. Undefined means the secure default. */
export function parseAppleNotesMode(value: string | undefined): AppleNotesMode {
  if (value === undefined) return "read-only";
  if (value === "read-only" || value === "read-write") return value;

  throw new Error(
    `Invalid APPLE_NOTES_MODE ${JSON.stringify(value)}. Expected exactly "read-only" or "read-write".`
  );
}

export function createAppleNotesServer(mode: AppleNotesMode): McpServer {
  const server = new McpServer(
    {
      name: "apple-notes",
      version: SERVER_VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS }
  );

  registerReadTools(server);
  if (mode === "read-write") registerWriteTools(server);

  return server;
}
