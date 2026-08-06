# Contributing

Thanks for your interest in improving apple-notes-mcp.

## Development setup

```bash
git clone https://github.com/dgplace/apple-notes-mcp.git
cd apple-notes-mcp
npm ci --ignore-scripts  # install the exact lockfile without lifecycle scripts
npm run build            # required: --ignore-scripts skips prepare/dist generation
```

## Workflow

- `npm test` — fast unit tests. No Notes.app, no macOS automation permission needed.
- `npm run format:check` — deterministic Prettier check for code and configuration.
- `npm run typecheck` — strict type checking for both `src/` and `test/`.
- `npm run audit:prod` — production audit gate; fails on high/critical findings and
  reports the reviewed lower-severity exception recorded in `DEPENDENCY_AUDIT.md`.
- `npm run check:dependency-engines` — verify reviewed transitive Node 18 compatibility.
- `npm run dev` — `tsc --watch` for incremental builds.
- `npm run build` — type-check and emit `dist/`.
- `npm run test:integration` — isolated lifecycle against the **real** Notes.app.
  macOS only; explicitly opt-in and never run by CI. It requires a dedicated test
  account selected by full `APPLE_NOTES_IT_ACCOUNT_ID` plus a complete stable
  `APPLE_NOTES_TRASH_FOLDER_IDS` configuration. Each run creates a UUID-named
  folder and note, trashes the exact created note once, and never retries an
  uncertain trash outcome. Notes scripting has no approved recoverable way to
  remove a fixture folder recoverably, so the test reports its exact ID and
  whether note cleanup was verified for manual inspection instead of invoking a
  delete primitive.

## Pull requests

1. Open an issue first for anything non-trivial so we can agree on the approach.
2. Keep changes focused. One concern per PR.
3. Add or update tests. Unit tests must pass on Node 18, 20, and 22 (CI enforces).
4. Run `npm run format:check`, `npm run typecheck`, `npm test`,
   `npm run audit:prod`, and `npm run build` before pushing.
5. Match the existing code style: TypeScript strict mode, ES modules, no new
   runtime dependencies without discussion (the small dependency surface is a
   deliberate feature).

## Design constraints

- User input is **never** interpolated into JXA script text — it flows only
  through `argv`. Preserve this invariant in any new tool.
- Tool schemas and results are kept small on purpose (token cost). New tools
  should follow the same compact-output conventions.

## Reporting bugs

Use the issue templates. Include your macOS version, Node version, and the
macOS locale if the bug touches folder names (see the localization note in the
README).

Security vulnerabilities are different: do not post exploit details or real
Notes data in a public issue. Follow the live private reporting route in
[SECURITY.md](./SECURITY.md) for the repository that shipped the affected
release.
