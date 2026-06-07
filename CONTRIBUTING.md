# Contributing

Thanks for your interest in improving apple-notes-mcp.

## Development setup

```bash
git clone https://github.com/simantaturja/apple-notes-mcp.git
cd apple-notes-mcp
npm install        # runs the build via the `prepare` hook
```

## Workflow

- `npm test` — fast unit tests. No Notes.app, no macOS automation permission needed.
- `npm run dev` — `tsc --watch` for incremental builds.
- `npm run build` — type-check and emit `dist/`.
- `npm run test:integration` — full lifecycle against the **real** Notes.app
  (creates and deletes one test note). macOS only; opt-in.

## Pull requests

1. Open an issue first for anything non-trivial so we can agree on the approach.
2. Keep changes focused. One concern per PR.
3. Add or update tests. Unit tests must pass on Node 18, 20, and 22 (CI enforces).
4. Run `npm test` and `npm run build` before pushing.
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
