#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAppleNotesServer, parseAppleNotesMode } from "./server.js";

async function main() {
  const mode = parseAppleNotesMode(process.env.APPLE_NOTES_MODE);
  const server = createAppleNotesServer(mode);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`apple-notes MCP server running on stdio (${mode})`);

  const shutdown = async () => {
    try {
      await server.close();
    } catch {
      // best effort — we are exiting anyway
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
