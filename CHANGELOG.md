# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `APPLE_NOTES_TRASH_FOLDER` environment variable to override the
  "Recently Deleted" folder name on non-English macOS locales.
- Graceful shutdown on `SIGINT`/`SIGTERM`.
- MIT `LICENSE` file, contribution guide, code of conduct, and issue/PR templates.
- GitHub Actions CI (build + unit tests on Node 18/20/22).

### Changed
- `npm run build` now marks `dist/index.js` executable so the `bin` entry works
  after a git install.

## [1.0.0]

### Added
- Initial release: `list_folders`, `list_notes`, `search_notes`, `get_note`,
  `create_note`, `update_note`, `delete_note` tools over JXA/osascript.
- In-process plaintext and folder-map caches with modification-date invalidation.
- Bulk Apple Event fetching, factored id prefixes, and bounded responses.
