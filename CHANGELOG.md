# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-08-05

### Added
- `APPLE_NOTES_MODE=read-only|read-write` with a secure read-only default.
- MCP server instructions covering the local-server, MCP-client/model-provider,
  approval, recoverability, shared-note, locked-note, and rich-content boundaries.
- `APPLE_NOTES_TRASH_FOLDER` environment variable to override the
  "Recently Deleted" folder name on non-English macOS locales.
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
  client to prompt for each of `create_note`, `update_note`, and `delete_note`.

## [1.0.0]

### Added
- Initial release: `list_folders`, `list_notes`, `search_notes`, `get_note`,
  `create_note`, `update_note`, `delete_note` tools over JXA/osascript.
- In-process plaintext and folder-map caches with modification-date invalidation.
- Bulk Apple Event fetching, factored id prefixes, and bounded responses.
