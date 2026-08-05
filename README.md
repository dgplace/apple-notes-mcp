# apple-notes-mcp

[![npm version](https://img.shields.io/npm/v/@simantaturja/apple-notes-mcp)](https://www.npmjs.com/package/@simantaturja/apple-notes-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@simantaturja/apple-notes-mcp)](https://www.npmjs.com/package/@simantaturja/apple-notes-mcp)
[![license](https://img.shields.io/npm/l/@simantaturja/apple-notes-mcp)](./LICENSE)
[![platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](https://www.apple.com/macos/)

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that lets AI assistants like Claude read, search, and create notes in **Apple Notes** on macOS.

Published on npm as [`@simantaturja/apple-notes-mcp`](https://www.npmjs.com/package/@simantaturja/apple-notes-mcp) — no clone or build needed, your MCP client runs the explicitly versioned package via `npx`.

It talks to Notes.app via JXA (JavaScript for Automation) through `osascript` — no private APIs, no database hacks, and it works with iCloud-synced notes.

> [!IMPORTANT]
> **2.0.0 is a breaking, security-first release.** The server now defaults to
> read-only and exposes only `list_folders`, `list_notes`, `search_notes`, and
> `get_note` unless
> `APPLE_NOTES_MODE=read-write` is set explicitly. Existing 1.x users who need
> the previous tool surface must add that exact environment variable to their
> MCP server configuration. Client approval rules are still required: enabling
> write mode is capability, not approval for a particular mutation.

## Requirements

- macOS (tested on macOS 14+)
- Node.js >= 18.14.1
- Apple Notes.app

## Setup

No clone, no build. Your MCP client downloads and runs the explicitly versioned
server package on demand via `npx`. Do not omit the `@2.0.0` version in the
examples: an unversioned package request can silently select a different release.
Start read-only, verify what the four read tools expose, and enable writes only
if you need them.

> [!WARNING]
> Local Apple automation is only one part of the data path. Tool schemas,
> requests, note metadata, and requested note content pass through the connected
> AI client and may be sent off the Mac to its configured model provider under
> that client's settings and policies. Do not connect this server to a client or
> provider that is not allowed to receive the notes you may select.

### Codex (recommended: read-only)

Codex reads personal MCP configuration from `~/.codex/config.toml`; a trusted
project may instead use `.codex/config.toml`. The ChatGPT desktop app, Codex CLI,
and Codex IDE extension on the same host share these configuration layers. This
does not apply to ChatGPT web, which does not read local Codex configuration.

Start with discovery only. Add this entry without a trash-folder setting,
restart the client, call `list_folders`, and record the full stable ID of the
localized Recently Deleted folder in every discovered account:

```toml
[mcp_servers.apple-notes-discovery]
command = "npx"
args = ["-y", "@simantaturja/apple-notes-mcp@2.0.0"]
env = { APPLE_NOTES_MODE = "read-only" }
enabled_tools = ["list_folders"]
default_tools_approval_mode = "auto"
```

Then delete or disable the discovery entry and add the read-only profile below,
supplying exactly one comma-separated trash folder ID per account. The server
enforces read-only mode and Codex allowlists only the four read tools:

```toml
[mcp_servers.apple-notes-read-only]
command = "npx"
args = ["-y", "@simantaturja/apple-notes-mcp@2.0.0"]
env = { APPLE_NOTES_MODE = "read-only", APPLE_NOTES_TRASH_FOLDER_IDS = "x-coredata://ACCOUNT/ICFolder/TRASH" }
enabled_tools = ["list_folders", "list_notes", "search_notes", "get_note"]
default_tools_approval_mode = "auto"
```

If writes are required, disable the read-only entry and use this separate
configuration instead. Reads remain automatic, while every currently available
mutation receives an explicit Codex prompt. Take a current backup first and
read [Secure write operation](#secure-write-operation):

```toml
[mcp_servers.apple-notes-read-write]
command = "npx"
args = ["-y", "@simantaturja/apple-notes-mcp@2.0.0"]
env = { APPLE_NOTES_MODE = "read-write", APPLE_NOTES_TRASH_FOLDER_IDS = "x-coredata://ACCOUNT/ICFolder/TRASH" }
enabled_tools = ["list_folders", "list_notes", "search_notes", "get_note", "create_note", "update_note", "move_note", "trash_note"]
default_tools_approval_mode = "auto"

[mcp_servers.apple-notes-read-write.tools.create_note]
approval_mode = "prompt"

[mcp_servers.apple-notes-read-write.tools.update_note]
approval_mode = "prompt"

[mcp_servers.apple-notes-read-write.tools.move_note]
approval_mode = "prompt"

[mcp_servers.apple-notes-read-write.tools.trash_note]
approval_mode = "prompt"
```

`enabled_tools` is an allowlist. The per-tool `approval_mode = "prompt"`
settings override the automatic default for mutations, so each write requires a
separate decision without prompting unnecessarily for reads.

Official references: [configure MCP servers](https://learn.chatgpt.com/docs/extend/mcp)
and [agent approvals and security](https://learn.chatgpt.com/docs/agent-approvals-security).

### ChatGPT desktop (recommended: read-only)

1. Open **Settings > MCP servers**.
2. Select **Add server**.
3. Enter `apple-notes-discovery`, choose **STDIO**, set the command to `npx`, and
   set its arguments to `-y` and `@simantaturja/apple-notes-mcp@2.0.0`.
4. Save the server, then select **Restart**.

Use the same two-phase discovery and read-only configuration shown above. For
the exact allowlist and environment settings, open the shared
`~/.codex/config.toml` (in the desktop app: **Settings > Configuration > Open
config.toml**), add the profile, and restart. Do not configure the local server
through ChatGPT web: ChatGPT web does not read this file or launch local STDIO
servers. If write access is necessary, use the separate read-write profile
above; do not widen the read-only profile in place, and leave each write tool at
`approval_mode = "prompt"`.

See OpenAI's [MCP setup documentation](https://learn.chatgpt.com/docs/extend/mcp)
for the current desktop and shared-configuration behavior.

### Claude Code

```bash
claude mcp add apple-notes -- npx -y @simantaturja/apple-notes-mcp@2.0.0
```

With no `APPLE_NOTES_MODE` setting this starts securely in read-only mode.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "npx",
      "args": ["-y", "@simantaturja/apple-notes-mcp@2.0.0"],
      "env": {
        "APPLE_NOTES_MODE": "read-only",
        "APPLE_NOTES_TRASH_FOLDER_IDS": "x-coredata://ACCOUNT/ICFolder/TRASH"
      }
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
npm ci --ignore-scripts  # install exactly package-lock.json; skips prepare
npm run build            # mandatory: produces dist/ after scripts were disabled
```

Then point your client at the built entry, e.g. for Claude Code:

```bash
claude mcp add apple-notes -- node /absolute/path/to/apple-notes-mcp/dist/index.js
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `APPLE_NOTES_MODE` | `read-only` | Server-enforced capability mode. The only accepted values are exactly `read-only` and `read-write`; any other present value prevents startup. |
| `APPLE_NOTES_TRASH_FOLDER_IDS` | unset | Comma-separated full stable `ICFolder` IDs, with exactly one Recently Deleted folder for every currently discovered Notes account. Until the mapping is complete, only `list_folders` is usable. |
| `APPLE_NOTES_ALLOW_SHARED_WRITES` | `false` | Separate shared-write capability gate. Accepts exactly `true` or `false`; an ordinary shared mutation also needs `allow_shared_note=true`. Shared trashing instead needs dedicated `allow_shared_trash=true` and `confirm_shared_impact=true` gates. Any other present value prevents startup. |
| `APPLE_NOTES_ALLOW_RAW_HTML` | `false` | Separate raw-HTML capability gate. Accepts exactly `true` or `false`; HTML content also needs `content_format=html` on that call and is restricted to the documented attribute-free subset. Any other present value prevents startup. |

Keep raw HTML disabled unless a client genuinely needs it. To enable only the
server capability, add the exact value to that server's environment; calls
still default to escaped plain text:

```text
APPLE_NOTES_ALLOW_RAW_HTML=true
```

Set it in your MCP client config, e.g. for Claude Desktop:

```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "npx",
      "args": ["-y", "@simantaturja/apple-notes-mcp@2.0.0"],
      "env": {
        "APPLE_NOTES_MODE": "read-only",
        "APPLE_NOTES_TRASH_FOLDER_IDS": "x-coredata://ACCOUNT/ICFolder/TRASH"
      }
    }
  }
}
```

### Automation permission

Grant Notes automation only when the first tool call actually needs it. The
first time the local host process tries to control Notes, macOS normally prompts
with wording similar to:

> "node" wants access to control "Notes".

Select **Allow** only if you recognize the MCP client and intended the call. To
review, grant after an earlier denial, or revoke access, open **System Settings
> Privacy & Security > Automation**, find the terminal, desktop client, IDE, or
other host that launches `node`/`/usr/bin/osascript`, and toggle its Notes access.
The permission is associated with the launching host's identity, not simply
this package name; macOS releases may label the host or path differently. If you
change how the server is launched, macOS may prompt again under a different
entry.

Revocation blocks later Apple Events from that host. It does not undo writes,
recall tool results already disclosed to a client or model provider, or delete
copies retained outside Notes. Remove the MCP entry as well if you no longer
want the client to launch the server.

### Migrating from 1.x

1.x always registered write tools. To restore that capability after upgrading,
set this exact server environment variable:

```text
APPLE_NOTES_MODE=read-write
```

For example, a JSON-based MCP configuration uses
`"env": { "APPLE_NOTES_MODE": "read-write" }`. Also configure the client to
prompt separately for `create_note`, `update_note`, `move_note`, and `trash_note`; server
write mode alone does not express user intent for an individual operation.

## Tools

| Tool | Mode | Description |
|------|------|-------------|
| `list_folders` | read-only, read-write | List every folder as a distinct stable `id`/`name`, its stable account `id`/`name`, and note count |
| `list_notes` | read-only, read-write | List metadata newest first. Params: `folder_id?`, unique `folder?`, `limit` (hard-capped at 100), `offset`; returns continuation metadata. |
| `search_notes` | read-only, read-write | Notes-side case-insensitive title/body matching that returns metadata only; plaintext is never returned by search. Query length is capped at 256. Params: `query`, `limit`, `offset`, `scope`. |
| `get_note` | read-only, read-write | Read one selected live note. `max_chars` defaults to 10000 and clamps at 20000; use `offset`/`page.next_offset` to continue. |
| `create_note` | read-write | Create in an explicitly selected full `folder_id`; `content_format` defaults to `plain`; supports `dry_run` and verifies real writes. |
| `update_note` | read-write | Conflict-safe replace or append by full `id` plus required `expected_revision`; `content_format` defaults to `plain`; supports `dry_run`, `new_title?`, and the rich/shared per-call gates. |
| `move_note` | read-write | Conflict-safe move by full note `id`, full destination `folder_id`, and required `expected_revision`; supports `dry_run`. |
| `trash_note` | read-write | Confirmed request to explicitly move one live note to the one configured stable Recently Deleted folder for its account. Requires full `id`, current `expected_revision`, and literal `confirm=true`; supports zero-mutation `dry_run` and verifies the exact destination/new revision. It never invokes Notes' delete command. |

### Stable identities

On first start, call `list_folders` and identify the localized Recently Deleted
folder in each Notes account. Set exactly one full folder ID per account in
`APPLE_NOTES_TRASH_FOLDER_IDS`, comma-separated, then restart. This bootstrap is
intentional: Notes' scripting dictionary exposes no stable trash role, so using
a guessed English folder name would silently leak deleted notes on other
locales. Note-bearing reads fail closed when the setting is absent or stale;
they also fail when any newly discovered account is uncovered or multiple
configured folders belong to one account. `list_folders` remains available for
discovery and reports missing or duplicate account IDs.

Every successful tool result is capped at 64 KiB including its MCP content
wrapper. Lists use deterministic offsets, and note bodies are paged inside the
Notes automation process so an unselected remainder never appears in stdout or
an error message. Locked notes return metadata with content marked unavailable;
shared and rich-content state is reported without per-note library scans.

Folder and account names are labels, not mutation targets. Different accounts
often contain folders with the same name, so `list_folders` keeps those entries
distinct:

```json
[
  {"id":"x-coredata://A/ICFolder/p2","name":"Work","account":{"id":"x-coredata://A/ICAccount/p1","name":"iCloud"},"count":12},
  {"id":"x-coredata://B/ICFolder/p7","name":"Work","account":{"id":"x-coredata://B/ICAccount/p1","name":"On My Mac"},"count":3}
]
```

Pass the selected full folder `id` as `folder_id` to `create_note`. A folder
name is still accepted by `list_notes` for discovery, but only when it has one
match; duplicate names return an error listing the full candidate IDs and
their accounts.

Note summaries and details carry the same identity context:

```json
{"idPrefix":"x-coredata://A/ICNote/","notes":[{"id":"p42","name":"Plan","account":{"id":"x-coredata://A/ICAccount/p1","name":"iCloud"},"folder":{"id":"x-coredata://A/ICFolder/p2","name":"Work"},"modified":"2026-08-05T01:02:03Z","revision":"r2|..."}]}
```

`idPrefix` is only a compact display encoding. For a mutation, reconstruct the
full note ID by concatenating `idPrefix` and the displayed `id` (the example is
`x-coredata://A/ICNote/p42`). When results span accounts, `idPrefix` is empty
and each note already carries its full ID. `get_note` may use a short ID only
when it uniquely matches one note; mutations never accept shortened IDs or
titles.

Every note summary/detail includes a `revision` built from the full stable note,
account, and folder IDs plus Notes' millisecond-precision modification date. Pass it back unchanged as
`expected_revision` for update/append, move, or trash. The automation re-reads
that value immediately before mutation and returns `CONFLICT` without changing
the note if it is stale. Use `dry_run=true` to validate the same revision and
see the stable target, projected title/body-size change or destination, and loss
flags without issuing a Notes mutation. Every real write is then read back and
must match its projected state; the response carries the authoritative new
`revision` and `post_write.verified=true`.

If Notes reports an error after a mutation was attempted, the server returns
`POST_WRITE_VERIFICATION_FAILED` and explicitly warns that the change may have
already occurred. Re-read or list the stable target before deciding what to do;
never blindly retry, especially after `create_note`, where that could duplicate
a note.

Locked notes always fail closed. Shared-note writes, and creates in shared
folders, require both `APPLE_NOTES_ALLOW_SHARED_WRITES=true` at startup and
`allow_shared_note=true` on the individual call. Leaving either gate off makes
no change. Folder identity is part of the token, so a move conflicts even when
Notes does not advance the note's modification date.

Trashing is stricter. `trash_note` always requires literal `confirm=true`; a
shared target additionally requires the startup capability,
`allow_shared_trash=true`, and `confirm_shared_impact=true`. Its dry-run/result
reports current stable account/folder identity, the configured recoverability
evidence and destination, shared state, confirmation state, and collaborator
impact. Notes' public scripting dictionary exposes account ID, name, default
folder, and `upgraded`, but no trustworthy account type or shared-note owner. The server
therefore reports `account_type="unavailable"` and `ownership="unknown"`
instead of inferring them from localized names or Core Data IDs. Configuration
is evidence only of a stable trash-and-restore workflow; Notes automation does
not expose a recovery guarantee. Stale, absent, duplicate,
cross-account, shared, or already-current trash destinations fail before the
single explicit move-to-trash request. If Notes refuses that move, the server
fails safely and never falls back to its potentially permanent delete command.

### Example prompts

- *"List my Apple Notes folders"*
- *"Show my 10 most recent notes"*
- *"Search my notes for 'tax return'"*
- *"Read the note titled 'Meeting agenda'"*
- *"List my folders, then create a note called 'Groceries' in the Shopping folder I select"*
- *"Find my Groceries note, then add 'butter' using its full ID"*
- *"Find Old draft, show me its account and folder, preview trashing that exact note, then ask me to confirm"*

### Notes on written content

- Call `list_folders` first and pass the intended entry's full `id` as
  `folder_id`. There is no default-account or folder-name fallback.
- `content_format` defaults to `plain`. Plain bodies are always HTML-escaped and
  line breaks are preserved; text beginning with `<` remains literal text.
- Raw HTML requires both `APPLE_NOTES_ALLOW_RAW_HTML=true` at startup and
  `content_format=html` on the individual create, replace, or append call.
  Enabling the server flag does not change the per-call default.
- Accepted HTML is parsed and canonicalized to an attribute-free subset:
  `div`, `p`, `blockquote`, `pre`, `ul`, `ol`, `li`, `strong`, `em`, `b`, `i`,
  `u`, `s`, `code`, and `br`. Tags must be balanced and validly nested. Scripts,
  styles, comments, declarations, headings, tables, checklists, media, links,
  embedded objects, every attribute/event handler/URL, unsupported entities,
  and malformed markup are rejected before Notes automation runs.
- Append adds only the escaped or sanitized fragment to the exact existing
  Notes HTML. It does not reconstruct the title or existing rich content.
- The title is rendered as the note's first line (`<h1>`), which Notes uses as the note name.

### Secure write operation

Before enabling `APPLE_NOTES_MODE=read-write`:

1. Make a current backup or export appropriate to the Notes accounts you will
   touch and verify that you can restore it. iCloud synchronization and Recently
   Deleted are not substitutes for a tested backup.
2. Use the separate read-write client profile above. Keep every write tool at
   `approval_mode = "prompt"`; inspect the full stable account, folder, and note
   IDs and the operation preview before approval.
3. Keep shared writes and raw HTML disabled unless the specific workflow needs
   them. Use `dry_run=true` before a consequential mutation.
4. Re-read after any `MUTATION_OUTCOME_UNKNOWN` or post-write verification error.
   Never blindly retry an uncertain create, update, move, or trash request.

The following Notes limitations remain even with these controls:

- **Accounts and trash:** Notes' public scripting interface does not expose a
  reliable account type, trash role, recovery guarantee, or shared-note owner.
  Exactly one full stable Recently Deleted folder ID must be configured for
  every discovered account. This is evidence of an intended recoverable
  workflow, not proof that a given account will retain or restore the note.
- **Names and identity:** Duplicate account, folder, or note names are normal.
  Names are discovery labels; mutations require full stable IDs. Stable IDs are
  identifiers, not secrets or authorization tokens, and may change if Notes
  recreates an object or an account is removed and added again.
- **Shared notes:** The scripting interface reports shared state but not
  ownership or exact collaborator impact. A move or trash may affect other
  people. Shared writes and shared trash therefore require extra startup and
  per-call gates, but the server cannot predict every synchronization or
  collaboration consequence.
- **Locked notes:** Locked content is unavailable and every locked-note write is
  rejected. Unlocking a note in Notes changes the risk; it does not make its
  contents safe to send to a model provider.
- **Rich content:** Attachments, drawings, scans, tables, checklists, audio, and
  other rich structures are not faithfully representable through the public
  scripting interface. Whole-body replacement fails closed when supported rich
  markers are detected unless that call sets `allow_rich_content_loss=true`.
  Detection is conservative, not a complete Notes document-model parser, so
  make a backup before any override. Appending preserves the existing body
  rather than rebuilding it.
- **HTML:** HTML writes accept only the documented sanitized, attribute-free
  subset. It cannot preserve arbitrary Notes formatting and is intentionally
  unsuitable for tables, checklists, media, links, embedded content, or a
  lossless rich-note round trip.
- **Integration tests:** The opt-in real-Notes integration test creates a UUID
  fixture folder in the explicitly selected account and trashes its one fixture
  note at most once. Notes scripting has no approved recoverable folder-delete
  operation, so an empty UUID-named folder remains for manual inspection and
  removal.

## Development

```bash
npm run dev    # tsc --watch
npm start      # run the built server (stdio transport)
```

### Project layout

```
src/
  index.ts          entry point — wires transport, registers tools
  server.ts         security-mode parser, instructions, tool policy
  jxa.ts            runs JXA via fixed /usr/bin/osascript with bounded process policy
  snippets.ts       shared JXA code (HTML escaping, note resolution, folder map)
  helpers.ts        result wrappers, id-prefix factoring, body truncation
  read-policy.ts    hard input/output bounds and pagination
  types.ts          NoteSummary / NoteDetail
  tools/read.ts     list_folders, list_notes, search_notes, get_note
  tools/write.ts    create_note, update_note, move_note, trash_note
test/               node:test suites (see below)
```

### Tests

```bash
npm test               # fast unit tests — no Notes.app, no permissions needed
npm run format:check   # deterministic code/config formatting check
npm run typecheck      # type-check src/ and test/
npm run audit:prod     # fail on high/critical production dependency findings
APPLE_NOTES_IT_ACCOUNT_ID='x-coredata://.../ICAccount/...' \
APPLE_NOTES_TRASH_FOLDER_IDS='x-coredata://.../ICFolder/...' \
  npm run test:integration
                       # real isolated lifecycle in the selected test account
```

Unit tests cover pure logic — id factoring, body truncation, JXA snippets
evaluated directly in Node, cache invalidation, and the injected process seam.
A non-Notes JXA test proves a manipulated `PATH` cannot replace
`/usr/bin/osascript`. They need neither Notes.app access nor macOS Automation
permission.

The integration test drives the built server over real JSON-RPC and exercises
create → search → update → get → trash. It is opt-in (gated on
`APPLE_NOTES_IT=1`, with `APPLE_NOTES_MODE=read-write` set by the script) because
it touches your real Notes library. It requires a full stable ID for an
explicitly dedicated test account, creates a UUID-named temporary folder and
note there, and trashes only that exact note ID. Cleanup makes at most one trash
attempt and never retries when the note is already trashed or the outcome is
unknown. Notes scripting has no approved recoverable fixture-folder deletion,
so the test prints the exact folder ID and whether note cleanup was verified for
manual inspection.

You can also smoke-test by piping JSON-RPC to the server:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node dist/index.js
```

## Security

See [SECURITY.md](./SECURITY.md) for supported versions, vulnerability
reporting, safe testing, and the dependency-advisory policy.

### Threat model and trust boundaries

The end-to-end path is:

`Notes data` → `Notes.app` → `local MCP/JXA process` → `MCP client` → `configured model provider`

- **Notes.app and Notes data:** Notes enforces its own accounts, synchronization,
  locking, and Apple Event behavior. Note titles and bodies are untrusted data.
  A note can contain malicious prompt text such as instructions to reveal other
  notes or approve a write. The client and model must treat retrieved content as
  data, never as authority to call another tool, widen scope, disclose data, or
  bypass approval. This server bounds results and requires stable IDs, but it
  cannot make a model immune to prompt injection.
- **Local MCP/JXA process:** The server is a local STDIO child with the privileges
  of the user who launched it and whatever Notes Automation permission macOS has
  granted to that host. It validates untrusted MCP arguments, passes values to
  fixed JXA programs through `argv`, invokes only `/usr/bin/osascript`, opens no
  network listener, and does not intentionally perform telemetry. This is not a
  sandbox around Notes: once authorized, Apple automation may expose notes that
  the same local user can access. Other processes running as that user, a
  compromised MCP package/client, or a compromised account are outside this
  server's protection.
- **MCP client:** The client is trusted to launch the intended pinned package,
  preserve the configured tool allowlist, show meaningful approval prompts, and
  route STDIO without exposing it to other users. Tool schemas, requests, and
  results are visible to the client. Client history, diagnostics, crash reports,
  or extensions may create additional copies under that client's own settings.
  The server avoids logging complete note bodies and gives its automation child
  a minimal environment, but it cannot control client-side logging.
- **Model provider:** The client may send tool definitions, arguments, note
  metadata, and requested content off the Mac to its configured model provider.
  Local JXA execution does **not** mean the result remains on-device. Provider
  processing, storage, access, and deletion are governed by the client/provider
  configuration and policies you selected; this project makes no training or
  retention promise on their behalf.
- **Identifiers and outputs:** Full account, folder, and note IDs reduce
  ambiguity; they do not authenticate a caller and should be treated as metadata
  that may correlate library objects across results. Notes output, automation
  errors, and all client arguments remain untrusted at each parser boundary.

Security goals are bounded reads, server-enforced read-only defaults,
conflict-aware explicit writes, and recoverability-aware trash moves. Non-goals
include defending a compromised Mac or local user account, providing end-to-end
encryption through the AI client, guaranteeing provider deletion, replacing
Notes backups, proving shared-note ownership or collaborator impact, guaranteeing
Recently Deleted recovery, and losslessly editing every proprietary Notes rich
content type.

- The server is read-only by default. In that mode write handlers are not
  registered, so stale direct `tools/call` requests are rejected before JXA can run.
- User input is passed to JXA via `argv`, never interpolated into the script — no script injection.
- Scripts run through the fixed `/usr/bin/osascript` executable using `execFile`
  (no shell), a 30-second timeout, a 1 MiB stdout/stderr cap, and a minimal child
  environment containing only `HOME`, `TMPDIR`, and a fixed UTF-8 locale. `PATH`,
  dynamic-loader variables, Node options, MCP settings, and unrelated secrets
  are not inherited.
- If a non-dry write loses its bounded automation response, the server reports
  `MUTATION_OUTCOME_UNKNOWN`: the change may already have occurred, so re-read
  or list the stable target and do not retry blindly. A failed dry-run instead
  states explicitly that its mutation branch did not run.
- Note titles and plain-text bodies are HTML-escaped before being written to Notes.
- There is no HTML auto-detection. Raw HTML is disabled by default, requires two
  explicit gates, and passes through a strict balanced no-attribute allowlist.
- Replacing detected attachment, drawing, table, or checklist content is rejected
  unless `allow_rich_content_loss=true` is supplied for that individual call.
- Every update/move/trash requires the last read `revision`; stale revisions
  fail before mutation. Dry runs make no change, and real writes are read back
  and verified before success is returned.
- `trash_note` requires literal confirmation, refuses locked or already-trashed
  notes, and fails closed unless one current stable configured destination
  covers the target account. It issues one explicit move to that resolved
  folder and verifies the exact destination plus a changed revision. It never
  invokes `Notes.delete`, including when another actor wins a location race.
- Folder-name and note-title reads reject multiple matches and return compact
  candidate full IDs with account/folder identities. Update/trash accept only
  full stable note IDs, and create accepts only a full stable folder ID.
- Short note IDs are display/read conveniences only. A read must prove the
  suffix unique; mutations require the reconstructed full `x-coredata` ID.
- Note-bearing reads require configured stable Recently Deleted folder IDs and
  exclude those IDs from every locale. `get_note` rejects a selected trashed
  note; there is no folder-name override that can bypass this boundary.
- Locked-note writes are always rejected. Shared writes require the exact
  server capability flag plus explicit per-call confirmation.
- Notes access and automation run locally over stdio, but tool results are sent
  to the connected MCP client and may then be sent to its model provider.
- Production dependency advisories are reviewed by installed path and reachable
  surface rather than by a zero-count rule; see [DEPENDENCY_AUDIT.md](./DEPENDENCY_AUDIT.md).

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

**2. Notes-side search without body export.**
Search predicates execute in Notes.app and return matching IDs. The server then
bulk-fetches metadata for those matches; it does not retrieve, cache, log, or
return note plaintext during search.

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

Fit guidance: designed for libraries up to a few thousand notes. At many
thousands of notes, an indexed/semantic-search server may answer complex searches
faster, in exchange for indexing machinery and a separate stale-data boundary.

## Why it consumes few tokens

Tool schemas load into the model's context every session; tool results enter it on
every call. Both are kept deliberately small:

- **Lean schema** — 4 tools by default (8 in read-write mode). Feature-heavy servers
  ship 15–20+ tools and several times that on every single session.
- **Compact JSON** — no pretty-printing (~18% smaller).
- **Factored id prefix** — note ids share a 55-char `x-coredata://UUID/ICNote/`
  prefix; list/search return it once as `idPrefix` with short per-note ids (`p634`).
  Read resolution accepts a uniquely matching short form; mutations require the
  reconstructed full form.
- **Bounded responses** — every complete result wrapper is at most 64 KiB.
  `get_note` clamps `max_chars` to 20,000 and returns `page.next_offset`; list
  tools return the same deterministic continuation metadata.
- **No noise** — stable identity is represented by compact `id`/`name` objects,
  dates omit milliseconds, and bodies are plaintext rather than raw HTML.

Stable account/folder identity adds necessary metadata to each note summary; the
factored note-ID prefix avoids compounding that cost with repeated full note IDs.

## License

MIT
