# apple-notes-mcp

[![npm version](https://img.shields.io/npm/v/@simantaturja/apple-notes-mcp)](https://www.npmjs.com/package/@simantaturja/apple-notes-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@simantaturja/apple-notes-mcp)](https://www.npmjs.com/package/@simantaturja/apple-notes-mcp)
[![license](https://img.shields.io/npm/l/@simantaturja/apple-notes-mcp)](./LICENSE)
[![platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](https://www.apple.com/macos/)

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that lets AI assistants like Claude read, search, and create notes in **Apple Notes** on macOS.

Published on npm as [`@simantaturja/apple-notes-mcp`](https://www.npmjs.com/package/@simantaturja/apple-notes-mcp) — no clone or build needed, your MCP client runs it via `npx`.

It talks to Notes.app via JXA (JavaScript for Automation) through `osascript` — no private APIs, no database hacks, and it works with iCloud-synced notes.

## Requirements

- macOS (tested on macOS 14+)
- Node.js >= 18
- Apple Notes.app

## Setup

No clone, no build. Your MCP client downloads and runs the server on demand via `npx`.

### Claude Code

```bash
claude mcp add apple-notes -- npx -y @simantaturja/apple-notes-mcp
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "npx",
      "args": ["-y", "@simantaturja/apple-notes-mcp"]
    }
  }
}
```

Restart your client. The first call pulls the package from npm (cached afterward) — see [Automation permission](#automation-permission) for the one-time macOS prompt.

### Install from source

For development or to run a local build instead of the published package:

```bash
git clone https://github.com/simantaturja/apple-notes-mcp.git
cd apple-notes-mcp
npm install   # builds automatically via the `prepare` hook
```

Then point your client at the built entry, e.g. for Claude Code:

```bash
claude mcp add apple-notes -- node /absolute/path/to/apple-notes-mcp/dist/index.js
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `APPLE_NOTES_TRASH_FOLDER` | `Recently Deleted` | Name of the special trash folder. macOS localizes this name; set it to your locale's name (e.g. `Nylig slettet` on Norwegian) so deleted notes are correctly excluded from `list_notes`/`search_notes`. |

Set it in your MCP client config, e.g. for Claude Desktop:

```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "npx",
      "args": ["-y", "@simantaturja/apple-notes-mcp"],
      "env": { "APPLE_NOTES_TRASH_FOLDER": "Nylig slettet" }
    }
  }
}
```

### Automation permission

The first time a tool runs, macOS will prompt:

> "node" wants access to control "Notes".

Click **Allow**. If you accidentally denied it, re-enable under
**System Settings → Privacy & Security → Automation**.

## Tools

| Tool | Description |
|------|-------------|
| `list_folders` | List all folders with note counts |
| `list_notes` | List notes (most recently modified first), optionally filtered by folder. Params: `folder?`, `limit` (1–200, default 25) |
| `search_notes` | Case-insensitive search in note titles and bodies. Params: `query`, `limit` (1–100, default 20), `scope` (`all`\|`title`, default all) |
| `get_note` | Read a note's content by `id` (short or full, preferred) or exact `title`. Param `max_chars` (default 10000) truncates long bodies |
| `create_note` | Create a note. Params: `title`, `body` (plain text or HTML), `folder?` |
| `update_note` | Replace or append to a note's body, optionally rename. Params: `id`/`title`, `body`, `mode` (`replace`\|`append`, default replace), `new_title?` |
| `delete_note` | Delete a note (moved to Recently Deleted, recoverable ~30 days). Params: `id`/`title` |

### Example prompts

- *"List my Apple Notes folders"*
- *"Show my 10 most recent notes"*
- *"Search my notes for 'tax return'"*
- *"Read the note titled 'Meeting agenda'"*
- *"Create a note called 'Groceries' with milk, eggs, bread in the Shopping folder"*
- *"Add 'butter' to my Groceries note"*
- *"Delete the note titled 'Old draft'"*

### Notes on `create_note`

- Plain-text bodies are HTML-escaped and line breaks are preserved.
- If the body starts with `<`, it is treated as raw HTML (Notes bodies are HTML). Notes.app sanitizes what it stores, but only pass HTML you trust. Bear in mind the body usually comes from the AI model, so treat it as untrusted: a prompt-injected model could emit arbitrary HTML here. Plain-text bodies are always escaped, so this only applies to bodies you (or the model) deliberately start with `<`.
- The title is rendered as the note's first line (`<h1>`), which Notes uses as the note name.

## Development

```bash
npm run dev    # tsc --watch
npm start      # run the built server (stdio transport)
```

### Project layout

```
src/
  index.ts          entry point — wires transport, registers tools
  jxa.ts            runs JXA scripts via osascript (argv-safe)
  snippets.ts       shared JXA code (HTML escaping, note resolution, folder map)
  helpers.ts        result wrappers, id-prefix factoring, body truncation
  cache.ts          in-process plaintext + folder-map caches
  types.ts          NoteSummary / NoteDetail
  tools/read.ts     list_folders, list_notes, search_notes, get_note
  tools/write.ts    create_note, update_note, delete_note
test/               node:test suites (see below)
```

### Tests

```bash
npm test               # fast unit tests — no Notes.app, no permissions needed
npm run test:integration   # full lifecycle against real Notes.app (creates + deletes a test note)
```

Unit tests run pure logic — id factoring, body truncation, the JXA HTML/resolver
snippets (evaluated directly in Node), and cache invalidation with an injected
fetcher — so they need no macOS automation permission and run in ~250 ms.

The integration test drives the built server over real JSON-RPC and exercises
create → search → update → get → delete. It is opt-in (gated on `APPLE_NOTES_IT=1`,
set by the script) because it touches your real Notes library; the test note it
creates is deleted (moved to Recently Deleted) at the end.

You can also smoke-test by piping JSON-RPC to the server:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js
```

## Security

- User input is passed to JXA via `argv`, never interpolated into the script — no script injection.
- Scripts run through `execFile` (no shell), with a 120s timeout and bounded output buffer.
- Note titles and plain-text bodies are HTML-escaped before being written to Notes.
- `delete_note` moves notes to Recently Deleted (recoverable for ~30 days) — it never permanently erases.
- Title-based update/delete refuses to act when multiple notes share the title (use `id`).
- Notes in Recently Deleted are excluded from `list_notes`/`search_notes` (pass `folder: "Recently Deleted"` to list them explicitly). Note: the folder is matched by name (default `Recently Deleted`); on a non-English macOS locale, set `APPLE_NOTES_TRASH_FOLDER` (see [Environment variables](#environment-variables)) so the exclusion applies.
- Everything runs locally; no note content leaves your machine except through the MCP client you connect.

## Why it's fast

All numbers below measured on a real library (436 notes, 28 folders, Apple Silicon).

**1. Bulk Apple Events instead of per-note calls.**
Every JXA property access (`note.name()`) is one Apple Event — an IPC round trip to
Notes.app costing tens of milliseconds. A naive loop over notes pays
`notes × properties` round trips. This server instead fetches each property for *all*
notes in a single event (`Notes.notes.name()` returns every name at once):

| Approach | Measured |
|---|---|
| Naive per-note loop, **25** notes | 1,784 ms |
| Bulk fetch, **all 436** notes | 47 ms |

Per note that is roughly **650× faster**, and it's why end-to-end tool calls stay
in the 300–550 ms range *including* Node and osascript process startup.

**2. Incremental plaintext cache.**
Note bodies are cached in-process, keyed by note id and validated against each
note's `modificationDate` — so a cache entry self-invalidates the moment a note
changes, and deletes are evicted automatically. Each search after the first only
re-fetches notes that actually changed:

| Search | Measured |
|---|---|
| First search of a session (cold cache) | ~430 ms |
| Every following search (warm cache) | ~180 ms |
| Title-only search (`scope: "title"`) | ~160 ms |

There is no staleness window: metadata is checked live on every call, so results
are always current — unlike index-based servers that serve stale results between
re-indexing runs.

**3. No index, no embeddings, no warm-up.**
RAG-based servers (LanceDB + embedding models) need a ~200 MB model download, an
initial indexing pass over every note, and re-indexing when notes change — and can
serve stale results between re-indexes. This server queries Notes.app live: zero
setup, zero warm-up, never stale.

**4. Minimal runtime.**
Two runtime dependencies (MCP SDK, zod). No Bun, no transformers, no vector DB.
Server is up and answering in ~125 ms.

**5. No Full Disk Access / SQLite parsing.**
Servers that read the Notes SQLite database need Full Disk Access and break when
Apple changes the schema. JXA is the supported automation interface.

Fit guidance: designed for libraries up to a few thousand notes. The cold-cache
search grows with library size (one bulk body fetch); warm searches stay flat. At
many thousands of large notes, an indexed/semantic-search server will answer the
*first* search faster — in exchange for the indexing machinery above.

## Why it consumes few tokens

Tool schemas load into the model's context every session; tool results enter it on
every call. Both are kept deliberately small:

- **Lean schema** — 7 tools ≈ 1,050 tokens total (~150/tool). Feature-heavy servers
  ship 15–20+ tools and several times that on every single session.
- **Compact JSON** — no pretty-printing (~18% smaller).
- **Factored id prefix** — note ids share a 55-char `x-coredata://UUID/ICNote/`
  prefix; list/search return it once as `idPrefix` with short per-note ids (`p634`).
  All tools accept either form.
- **Bounded responses** — `get_note` caps bodies at `max_chars` (default 10,000
  chars ≈ 2,500 tokens) with a truncation marker telling the model exactly how to
  fetch the rest. A single huge note can never flood the context.
- **No noise** — empty folder fields omitted, dates without milliseconds, plaintext
  bodies (never raw HTML, which some servers return at 3–10× the token cost).

Measured: `list_notes` of 25 notes ≈ 2,150 chars (~540 tokens) — versus 925 chars for
just 5 notes before these optimizations (~47% reduction at equal content).

## License

MIT
