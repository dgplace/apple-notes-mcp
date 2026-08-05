# TODO: Production-safe Apple Notes read/write MCP

## Goal

Deliver a local Apple Notes MCP server that is safe to connect to Codex, ChatGPT desktop, and other MCP clients. Read access must be bounded and transparent. Write access must be disabled by default, explicitly approved, conflict-aware, scoped to the intended account and folder, and unable to silently destroy or permanently delete data.

**Sections are numbered in execution order.** Sections 1–3 are live defects in shipped code, not hardening — they are ordered ahead of the policy work because they can destroy user data today. Total: 44 points.

## Security invariants

- Read-only mode is the default and is enforced by the server, not only by the MCP client.
- No write occurs without an explicit write-enabled configuration and per-operation intent.
- A note is addressed by stable account, folder, and note identifiers; ambiguous names never select the first match.
- Updates never overwrite a newer version of a note without returning a conflict.
- A write never discards note content it did not intend to replace.
- Destructive operations are recoverable by default and fail closed when recoverability is unknown.
- Notes in Recently Deleted are addressable only by operations that explicitly opt into them.
- Shared, locked, deleted, or rich-content notes receive stricter handling than ordinary notes.
- Plain text is the default write format. Raw HTML requires an explicit opt-in.
- The process opens no network listener, performs no telemetry, and invokes only the system Apple automation executable.
- Tool results are size-bounded and disclose only the data requested by the user.

## Delivery plan

### 1. Repair CI so the rest of this plan is enforceable — 1 point

**What:** Changes are actually checked before merge. Every acceptance criterion below phrased as "tests verify…" is currently vacuous: `.github/workflows/ci.yml` triggers on `main`, the repository's default branch is `master`, so CI has never run on a pull request.

- [x] Change the `push` and `pull_request` triggers to `master`.
- [x] Mark the job required for merge.
- [x] Confirm a test pull request reports a status check.

**Acceptance criteria:**

- Required CI runs on every pull request to the default branch.
- A deliberately failing unit test blocks merge.

### 2. Stop rich-content destruction in `update_note` — 3 points

**What:** Editing a note cannot silently delete its attachments. `src/tools/write.ts:101` rebuilds the body as `"<h1>" + title + "</h1>" + toHtml(body)` in `replace` mode, discarding attachments, drawings, scans, tables, checklists, and audio. This is the highest-severity live defect: a documented, advertised tool destroys user content on ordinary use.

- [x] Detect rich content on the target note before any whole-body rewrite.
- [x] Reject `mode: "replace"` on notes carrying rich content by default, with an actionable message naming what would be lost.
- [x] Gate the override behind an explicit per-call field, not a server-wide flag.
- [x] Fail closed on rich-content append: Notes exposes only whole-body assignment, so attachment preservation cannot be guaranteed. Ordinary-note append concatenates the existing HTML and the escaped or sanitized fragment.
- [x] Preserve the existing title when `new_title` is absent.

**Acceptance criteria:**

- Replacing the body of a note containing an attachment fails closed by default.
- Appending to a note containing an attachment fails before body assignment; ordinary-note append remains available.
- Tests cover attachment, drawing, table, and checklist fixtures.

### 3. Close the delete-escalation path — 2 points

**What:** `delete_note` cannot permanently erase a note. `Notes.notes` includes Recently Deleted — proven by read tools having to subtract trash ids explicitly (`src/tools/read.ts:99`) — and `resolveNote` (`src/snippets.ts:18`) does not filter it. Calling `delete_note` on an already-trashed note issues a second `Notes.delete()`, which permanently removes it.

- [x] Determine whether the resolved note is already in Recently Deleted before deleting.
- [x] Reject deletion of a note already in Recently Deleted.
- [x] Apply the same check to title-based resolution, which reaches trashed notes through `Notes.notes.whose()`.

**Acceptance criteria:**

- Repeating `delete_note` on the same note fails on the second call instead of permanently deleting.
- A note in Recently Deleted cannot be deleted by id or by title.
- Tests verify both resolution paths.

### 4. Establish a secure server policy — 5 points

**What:** Users can connect the MCP server without granting it write capability unless they deliberately enable writes.

> **Breaking change.** Defaulting to read-only removes write tools from every existing installation of `@simantaturja/apple-notes-mcp`, which the README currently advertises. Ship as a major version bump with a migration note in `CHANGELOG.md` and README telling existing users which variable restores write access.

- [x] Add `APPLE_NOTES_MODE=read-only|read-write`, defaulting to `read-only`.
- [x] In read-only mode, do not advertise create, update, append, move, or delete tools.
- [x] Fail closed for missing, invalid, or contradictory security configuration.
- [x] Return server instructions explaining privacy, approval, and recoverability boundaries.
- [x] Document a Codex configuration that allowlists read tools and requires approval for every write tool.
- [x] Bump to 2.0.0 and document the upgrade path for existing users.

**Acceptance criteria:**

- A default launch exposes only list, search, and get operations.
- Setting an invalid mode prevents startup with a clear error.
- Read-only mode rejects write calls even if a client invokes a stale tool schema directly.
- Automated tests verify both advertised and directly invoked tool behaviour.
- The changelog states the breaking change and the restoring configuration.

### 5. Introduce stable account and folder identity — 5 points

**What:** Reads and writes always target the account and folder selected by the user, even when names are duplicated. Today folders resolve via `whose({name})[0]` (`src/tools/read.ts:81`, `src/tools/write.ts:37`) and `create_note` falls back to `Notes.defaultAccount` (`src/tools/write.ts:34`).

- [x] Return stable account IDs and folder IDs from discovery tools.
- [x] Include account identity in note summaries and note details.
- [x] Require IDs for mutations; allow names only for discovery.
- [x] Reject ambiguous folder and note names with candidate IDs instead of choosing the first match.
- [x] Preserve full note IDs in mutation requests; treat shortened IDs as display-only unless uniqueness is proven — `resolveNote` currently accepts the first id whose suffix matches (`src/snippets.ts:26`).

**Acceptance criteria:**

- Duplicate `Notes` or `Work` folders across accounts cannot cause cross-account reads or writes.
- A mutation using an unknown or ambiguous identifier makes no change.
- A short id matching notes in two accounts is rejected with both candidates.
- Tests cover iCloud, On My Mac, and duplicate-name fixtures.

### 6. Add bounded, privacy-aware reads — 3 points

**What:** The model receives only the requested note data and cannot request unbounded output. `max_chars` currently has a floor of 100 and no ceiling (`src/tools/read.ts:255`), and `runJxa` allows a 64 MB buffer (`src/jxa.ts:13`).

- [x] Add hard limits for result counts, query length, note size, and total response size.
- [x] Add an explicit upper bound to `max_chars` and clamp rather than trust the caller.
- [x] Return pagination or continuation metadata for truncated lists and notes.
- [x] Exclude Recently Deleted by folder identity rather than a localized folder name.
- [x] Exclude Recently Deleted from `get_note`, which currently reads trashed notes with no filter.
- [x] Mark locked, shared, and rich-content notes in metadata without exposing unavailable content.
- [x] Keep note bodies out of logs and sanitize automation errors before returning them — `fail()` forwards raw `osascript` stderr.

**Acceptance criteria:**

- Oversized requests are rejected or bounded deterministically.
- `max_chars` above the ceiling is clamped, not honoured.
- Recently Deleted notes are excluded across supported locales and from every read tool.
- Search does not return full bodies; `get_note` returns one explicitly selected note.
- Error and debug output never contains complete note bodies.

### 7. Implement conflict-safe create and update — 6 points

**What:** Users can create or edit ordinary notes without overwriting newer changes.

- [x] Return a revision token derived from stable identity and modification time.
- [x] Require `expected_revision` for update, append, move, and delete operations.
- [x] Re-read the revision immediately before mutation and return a conflict on mismatch.
- [x] Add a dry-run/preview response showing the target, operation, and projected change.
- [x] Reject writes to locked notes and gate shared-note writes behind a separate opt-in.
- [x] Return the new revision and verified post-write state after a successful mutation.

**Acceptance criteria:**

- A note changed after it was read cannot be overwritten using the old revision.
- Shared and locked notes are protected by default.
- Every successful mutation is followed by a read-back verification.

### 8. Make content handling explicit and loss-resistant — 4 points

**What:** Plain text, Markdown-like text, and HTML cannot be confused in ways that corrupt a note. `toHtml` currently treats any body starting with `<` as raw HTML (`src/snippets.ts:11`).

- [x] Replace HTML auto-detection with an explicit `content_format=plain|html` field.
- [x] Default to plain text and escape all markup.
- [x] Require a separate configuration flag before accepting raw HTML.
- [x] Sanitize allowed HTML to a small Notes-compatible subset before writing.
- [x] Preserve the title and existing rich content when an operation does not intend to replace them.

**Acceptance criteria:**

- Text beginning with `<` remains literal text unless HTML mode is explicitly selected.
- Script, remote-resource, event-handler, and unsupported HTML constructs are rejected.
- Append operations do not rebuild or discard the existing note body.

### 9. Replace delete with recoverability-aware trashing — 5 points

**What:** A normal delete request cannot permanently remove a note or unexpectedly affect collaborators. Builds on the immediate fix in section 3.

- [x] Rename the default operation to `trash_note` and require `confirm: true` plus `expected_revision`.
- [x] Determine the note's account type, shared state, ownership, and current folder before deletion.
- [x] Reject accounts where Notes does not provide a recoverable Recently Deleted workflow.
- [x] Reject shared-note deletion by default; expose the impact when an override is enabled.
- [x] Do not implement permanent deletion in the initial release.

**Acceptance criteria:**

- No default operation permanently deletes a note.
- Nonrecoverable-account and shared-note cases fail before mutation with actionable messages.
- Tests verify that confirmation and revision checks are mandatory.

### 10. Harden process execution and dependency supply chain — 3 points

**What:** Installation and runtime behaviour are pinned, inspectable, and resistant to path or dependency substitution. `runJxa` currently invokes `osascript` by relative name (`src/jxa.ts:11`), resolved through `PATH`.

- [x] Invoke `/usr/bin/osascript` by absolute path with a minimal environment.
- [x] Cap automation stdout/stderr and execution time at conservative values (currently 64 MB / 120 s).
- [x] Triage `npm audit` findings rather than requiring a zero count — see the release-gate note below.
- [x] Use `npm ci` for reproducible builds. Document that `--ignore-scripts` skips the `prepare` hook that produces `dist/`, so the explicit `npm run build` step is mandatory, not optional.
- [x] Pin release dependencies.
- [x] Avoid unversioned `npx` installation in security-sensitive documentation.
- [x] Derive the server version in `src/index.ts:9` from `package.json` instead of hardcoding it in two places.

**Acceptance criteria:**

- Manipulating `PATH` cannot substitute another `osascript` executable.
- A clean locked install, build, and unit test pass succeeds on supported Node versions.
- `npm ci --ignore-scripts` followed by the documented build step yields a working `dist/`.
- The published version matches `package.json` with no manual step.

### 11. Expand automated verification — 4 points

**What:** Every change is checked against security and data-integrity regressions. CI itself is repaired in section 1.

- [x] Run formatting, type checking, unit tests, and dependency audit in CI.
- [x] Type-check `test/` as well — `tsconfig.json` excludes it, so tests are checked only by `tsx` at runtime.
- [x] Add mocked tests for read-only enforcement, confirmations, revisions, ambiguity, localization, shared notes, locked notes, and rich content.
- [x] Add opt-in macOS integration tests using a dedicated temporary Notes account/folder and uniquely named fixtures.
- [x] Ensure integration cleanup never retries deletion on a note already in Recently Deleted.
- [x] Add tests for oversized input/output and automation timeouts.

**Acceptance criteria:**

- Unit tests do not need Notes access or mutate user data.
- Integration tests are explicitly enabled, use isolated fixtures, and report cleanup limitations.

### 12. Document threat model and secure operation — 3 points

**What:** Users understand what remains local, what may be sent to their model provider, and how to operate writes safely.

- [x] Document trust boundaries among Notes, the local MCP server, the MCP client, and the model provider.
- [x] State that tool results may leave the Mac through the connected AI client.
- [x] Document macOS Automation permission grant and revocation.
- [x] Provide read-only-first setup instructions for Codex and ChatGPT desktop.
- [x] Document backup, shared-note, locked-note, rich-content, and account limitations.
- [x] Add a security policy (`SECURITY.md`) and private vulnerability-reporting route.

**Acceptance criteria:**

- Setup documentation does not claim that data necessarily remains on-device end to end.
- Write mode documentation includes backup and approval prerequisites.
- Known unsupported Notes features are listed explicitly.

## Release gates

- [x] Read-only mode is the default and has direct invocation tests.
- [x] No unresolved high-severity security or data-loss finding remains.
- [x] `npm audit --omit=dev` reports no high or critical vulnerability that is *reachable from this server*, with any excluded advisory recorded and justified in `SECURITY.md`. A blanket zero-count gate is not usable here: the initial 3 high findings were transitive through the MCP SDK (`hono`, `ip-address`) in HTTP, Lambda, and proxy code paths a stdio-only server never executes; compatible lockfile updates removed them, while the accepted residual moderate Windows static-file advisory remains unreachable and documented.
- [x] Build, type checking, and unit tests pass on all supported Node versions.
- [x] Opt-in macOS integration tests pass against isolated ordinary notes.
- [x] Shared, locked, rich-content, nonrecoverable-account, and Recently Deleted cases fail closed.
- [x] A reviewer has inspected every Notes mutation path.
- [x] Documentation accurately describes local processing and model-provider disclosure.
- [x] The release is pinned to a reviewed commit.

## Deferred to a later release

Scoped out of the first secure release as disproportionate to a ~950-line, single-client stdio server. Revisit once sections 1–12 ship.

- **Local pre-write snapshots** with retention and cleanup rules. Section 2's rich-content rejection plus section 7's revision checks cover the realistic loss cases; a snapshot store adds its own retention, cleanup, and disclosure surface.
- **Write serialization.** MCP permits concurrent in-flight calls, so lost updates are possible rather than impossible — but revision checks capture most of the protection. An in-process promise chain is cheap to add later; it does not warrant blocking the release.
- **Provenance attestation and published checksums** for distributed artifacts.

## Explicit non-goals for the first secure release

- Permanent deletion.
- Editing locked notes.
- Lossless editing of drawings, scans, audio, tables, checklists, or arbitrary attachments.
- Collaboration or sharing-management operations.
- Remote/network MCP transport.
- Direct access to the private Notes SQLite or CloudKit stores.
