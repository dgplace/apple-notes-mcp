# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Explicit `content_format=plain|html` on create, replace, and append. Plain is
  the default and always escapes markup. Raw HTML requires the separate exact
  `APPLE_NOTES_ALLOW_RAW_HTML=true` startup capability.
- Collision-free revision tokens covering stable note/account/folder identity
  and full-precision modification time. Update,
  append, move, and delete now require `expected_revision`, support `dry_run`,
  and perform authoritative post-write verification.
- `move_note`, addressed only by full stable note and destination-folder IDs.
- A separate `APPLE_NOTES_ALLOW_SHARED_WRITES=true` capability gate; every
  shared mutation also requires `allow_shared_note=true` on that call.

### Security
- Removed body-prefix HTML auto-detection. Enabled raw HTML is parsed into a
  balanced, attribute-free Notes-compatible subset; scripts, remote resources,
  event handlers, links, media, tables/checklists, unsupported elements, and
  malformed markup fail before mutation. Appends preserve the exact existing
  body and add only the escaped or sanitized fragment.
- Stale revisions fail with `CONFLICT` immediately before mutation. Locked
  notes, configured-trash targets, and shared writes without both gates fail
  closed.
- Delete verification now uses configured stable Recently Deleted folder IDs,
  not a localized folder name.
- Errors after a mutation attempt conservatively warn that the change may have
  occurred and require re-reading/listing before any retry.

## [2.0.0] - 2026-08-05

### Added
- `APPLE_NOTES_MODE=read-only|read-write` with a secure read-only default.
- MCP server instructions covering the local-server, MCP-client/model-provider,
  approval, recoverability, shared-note, locked-note, and rich-content boundaries.
- Stable `APPLE_NOTES_TRASH_FOLDER_IDS` configuration so Recently Deleted is
  identified independently of its localized display name.
- Graceful shutdown on `SIGINT`/`SIGTERM`.
- MIT `LICENSE` file, contribution guide, code of conduct, and issue/PR templates.
- GitHub Actions CI (build + unit tests on Node 18/20/22).

### Changed
- **Breaking:** the server now defaults to read-only and exposes only
  `list_folders`, `list_notes`, `search_notes`, and `get_note`. Write handlers
  are not registered, so direct calls using a stale schema are also rejected.
- Read-write mode preserves the 1.x seven-tool surface.
- The MCP server and npm package versions are now `2.0.0`.
- `npm run build` now marks `dist/index.js` executable so the `bin` entry works
  after a git install.

### Security

- Missing `APPLE_NOTES_MODE` fails safely to read-only. Invalid, empty, padded,
  or case-mismatched values prevent startup.
- Automated protocol tests verify the advertised tool sets, invalid-mode startup
  failure, and that stale read-only write calls do not launch JXA.

### Migration

- To restore the 1.x write capability, set exactly
  `APPLE_NOTES_MODE=read-write` in the MCP server environment.
- Enabling server write mode does not approve a mutation. Configure the MCP
  client to prompt separately for every advertised write tool.

## [1.0.0]

### Added
- Initial release: `list_folders`, `list_notes`, `search_notes`, `get_note`,
  `create_note`, `update_note`, `delete_note` tools over JXA/osascript.
- In-process plaintext and folder-map caches with modification-date invalidation.
- Bulk Apple Event fetching, factored id prefixes, and bounded responses.
