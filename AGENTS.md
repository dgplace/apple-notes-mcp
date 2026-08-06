# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Commands

```bash
npm install                # installs + builds via the `prepare` hook
npm run build              # tsc → dist/, then chmod +x dist/index.js
npm run dev                # tsc --watch
npm test                   # unit tests — no Notes.app, no automation permission, ~250ms
npm start                  # run the built server on stdio
```

Single test file / single test:

```bash
node --import tsx --test test/cache.test.ts
node --import tsx --test --test-name-pattern="factorIds" test/helpers.test.ts
```

Integration test — **touches the real Notes library** (creates, edits, and trashes one note).
Opt-in via the `APPLE_NOTES_IT=1` gate that the script sets:

```bash
npm run test:integration
```

Smoke-test the built server directly:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js
```

## Architecture

An MCP server (stdio transport) exposing 7 Apple Notes tools. `src/index.ts` wires the
transport and calls `registerReadTools` / `registerWriteTools`; there is no other
orchestration layer.

**Every tool is a TypeScript wrapper around one JXA script string.** `runJxa()`
(`src/jxa.ts`) spawns `osascript -l JavaScript -e <script> -- <args>` through `execFile`
(no shell) and JSON-parses stdout. Tools do their filtering, sorting, caching, and
truncation in TypeScript — the JXA side only bulk-fetches raw data and returns JSON.

Reusable JXA fragments live in `src/snippets.ts` (`JXA_HTML_HELPERS`, `JXA_RESOLVE_NOTE`,
`JXA_FOLDER_MAP`) and are template-concatenated into scripts. Because JXA is plain
JavaScript, these snippets are unit-tested by evaluating them in Node with `new Function`
against mock `Notes` objects (see `test/snippets.test.ts`) — that is why the test suite
needs no macOS permission. Keep snippets free of JXA-only syntax so this keeps working.

### Invariants to preserve

**User input never enters script text.** It flows only through `argv`, read inside
`function run(argv)`. Interpolating a value into the script string is a script-injection
bug, even for values that look safe. This is the single most important rule in the repo.

**Bulk Apple Events, never per-note loops.** Each JXA property access is an IPC round
trip to Notes.app (tens of ms). `Notes.notes.name()` returns *every* name in one event;
a loop calling `note.name()` per note costs `notes × properties` round trips (measured:
1,784ms for 25 notes vs 47ms for all 436). Fetch parallel arrays (`ids`, `names`,
`modified`) and zip them by index in TypeScript.

**Cache invalidation is implicit, by modification date.** `plaintextCache`
(`src/cache.ts`) is keyed by full note id and an entry is reused only while the note's
`modificationDate` is unchanged, so edits and deletes self-invalidate. Do not add
explicit cache-busting hooks to the write tools — that would defeat the design and
introduce staleness. `search_notes` re-fetches only stale ids (bulk fetch when the cache
is cold or >20 changed, per-id otherwise) and evicts ids that are no longer live.

**Responses are optimized for token cost.** Compact `JSON.stringify` (no pretty-print),
empty `folder` fields omitted, dates truncated to seconds, plaintext never raw HTML.
Note ids share a ~55-char `x-coredata://UUID/ICNote/` prefix, so list/search return it
once as `idPrefix` with short per-note ids (`p634`); `factorIds` falls back to full ids
when the prefix isn't shared across all results (i.e. multiple accounts). All tools
accept either form. `get_note` caps bodies at `max_chars` with a truncation marker
telling the model how to re-fetch. New tools should follow these conventions, and new
tool schemas should stay lean — they load into context every session.

### Notes.app behaviors that shape the code

- **Note bodies are HTML.** `toHtml` treats a body starting with `<` as raw HTML and
  otherwise escapes it and wraps lines in `<div>`. The title is written as a leading
  `<h1>`, which is what Notes uses as the note name.
- **`Notes.notes` includes Recently Deleted.** Read tools subtract the trash folder's
  ids explicitly; `resolveNote` does not.
- **The trash folder is matched by localized name**, defaulting to `Recently Deleted`
  and overridable with `APPLE_NOTES_TRASH_FOLDER`.
- **Bulk `Notes.notes.container.name()` returns nulls**, so the id → folder map is built
  by iterating folders (`JXA_FOLDER_MAP`) and cached separately in `folderMapCache`.
- **Folders are resolved by name and take the first match**, so duplicate folder names
  across accounts are not currently disambiguated.

## Gotchas

- The server version is hardcoded in `src/index.ts` *and* `package.json` — update both.
- `.github/workflows/ci.yml` triggers on `main`, but the repository's default branch is
  `master`, so CI currently never runs.
- `dist/` is the published artifact (`bin: apple-notes-mcp`); `tsconfig.json` excludes
  `test/`, so tests are type-checked only by `tsx` at runtime, not by `npm run build`.
