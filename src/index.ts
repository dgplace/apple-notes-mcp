#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runJxa } from "./jxa.js";
import { createAppleNotesServer, parseAppleNotesMode } from "./server.js";
import { parseAllowRawHtml, parseAllowSharedWrites } from "./write-policy.js";

async function main() {
  const mode = parseAppleNotesMode(process.env.APPLE_NOTES_MODE);
  const allowSharedWrites = parseAllowSharedWrites(
    process.env.APPLE_NOTES_ALLOW_SHARED_WRITES
  );
  const allowRawHtml = parseAllowRawHtml(process.env.APPLE_NOTES_ALLOW_RAW_HTML);
  // Production always supplies the fixed /usr/bin/osascript runner. The server
  // factory accepts a runner only so unit tests can avoid Notes automation.
  const server = createAppleNotesServer(
    mode,
    { allowSharedWrites, allowRawHtml },
    runJxa
  );
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
