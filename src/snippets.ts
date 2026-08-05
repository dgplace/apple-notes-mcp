// Shared JXA snippets injected into scripts. These are static strings — user
// input only ever flows into scripts via argv, never into script text.

// Only deliberately marked domain errors cross the process boundary. Raw JXA
// and osascript failures remain unmarked and are replaced by a generic error in
// runJxa(), preventing stderr/stdout/script/argv disclosure.
export const JXA_SAFE_ERRORS = `
  function safeError(code, message) {
    const error = new Error(message);
    error.appleNotesSafe = true;
    error.appleNotesSafeCode = code;
    return error;
  }

  function runSafely(operation) {
    try {
      return JSON.stringify(operation());
    } catch (error) {
      if (error && error.appleNotesSafe === true) {
        return JSON.stringify({
          __appleNotesSafeError: true,
          code: error.appleNotesSafeCode,
          message: error.message,
        });
      }
      throw error;
    }
  }
`;

export const JXA_HTML_HELPERS = `
  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Notes bodies are HTML. If body doesn't look like HTML, escape and
  // convert line breaks so plain text renders correctly.
  const toHtml = (body) =>
    /^\\s*</.test(body)
      ? body
      : body
          .split("\\n")
          .map(line => "<div>" + (escapeHtml(line) || "<br>") + "</div>")
          .join("");
`;

// Rich-content inspection for one explicitly selected note. Read summaries do
// not call this: they use public bulk attachment properties and represent
// table/checklist/drawing classification as unknown instead of fetching every
// body. get_note and mutation safety may inspect the one selected body.
export const JXA_RICH_CONTENT = `
  function richContentKinds(note, html) {
    const kinds = [];
    const attachments = note.attachments;
    const attachmentCount = attachments.length;
    const attachmentNames = attachmentCount > 0 ? attachments.name() : [];

    const hasAttachmentMarkup =
      /<(?:object|img|attachment)\\b/i.test(html) ||
      /Apple-string-attachment|data-attachment(?:-identifier)?/i.test(html);
    const hasDrawingMarkup =
      /<[^>]*(?:drawing|sketch|pkdrawing|com\\.apple\\.(?:notes\\.)?drawing)[^>]*>/i.test(html);
    const hasDrawingName = attachmentNames.some(name =>
      /(?:drawing|sketch)/i.test(String(name))
    );

    if (attachmentCount > 0 || hasAttachmentMarkup) kinds.push("attachment");
    if (hasDrawingMarkup || hasDrawingName) kinds.push("drawing");
    if (/<table(?:\\s|>)/i.test(html)) kinds.push("table");
    if (
      /<input\\b[^>]*type\\s*=\\s*["']?checkbox/i.test(html) ||
      /(?:Apple-dash-list|com-apple-note-checklist|data-checked|class\\s*=\\s*["'][^"']*checklist)/i.test(html)
    ) kinds.push("checklist");

    return kinds;
  }
`;

// One bulk Apple Event per public attachment property. container.id() maps
// each attachment back to its note without a per-note or per-attachment IPC
// loop. If Notes cannot supply the projection, callers report uncertainty.
export const JXA_BULK_RICH_METADATA = `
  function bulkRichContentMetadata(Notes) {
    try {
      const attachments = Notes.attachments;
      const noteIds = attachments.container.id();
      const names = attachments.name();
      if (!Array.isArray(noteIds) || !Array.isArray(names) || noteIds.length !== names.length) {
        return { available: false, byNote: {} };
      }
      const byNote = {};
      for (let i = 0; i < noteIds.length; i++) {
        const noteId = noteIds[i];
        const entry = byNote[noteId] || { attachment: true, possibleDrawing: false };
        if (/(?:drawing|sketch)/i.test(String(names[i]))) entry.possibleDrawing = true;
        byNote[noteId] = entry;
      }
      return { available: true, byNote: byNote };
    } catch (_) {
      return { available: false, byNote: {} };
    }
  }
`;

// Mutate one already-resolved note while preserving its existing HTML for
// append operations and refusing destructive whole-body rewrites by default.
// Kept as plain JavaScript so the behavior can be exercised with mock Notes
// objects in Node without Automation permission.
export const JXA_UPDATE_NOTE = `
  ${JXA_RICH_CONTENT}

  function safeError(code, message) {
    const error = new Error(message);
    error.appleNotesSafe = true;
    error.appleNotesSafeCode = code;
    return error;
  }

  function updateNoteContent(note, body, mode, newTitle, allowRichContentLoss) {
    const existingBody = note.body();

    if (mode === "append") {
      // Keep the complete Notes-supplied HTML, including embedded-object
      // references, and add only the requested suffix.
      note.body = existingBody + toHtml(body);
      return;
    }

    const kinds = richContentKinds(note, existingBody);
    if (kinds.length > 0 && !allowRichContentLoss) {
      throw safeError("RICH_CONTENT_REFUSED",
        "Refusing to replace a note containing rich content (" + kinds.join(", ") +
        "). Replacing the whole body would discard those items. Back up the note, " +
        "then retry with allow_rich_content_loss: true only if that loss is intended."
      );
    }

    const heading = newTitle !== "" ? newTitle : note.name();
    note.body = "<div><h1>" + escapeHtml(heading) + "</h1></div>" + toHtml(body);
  }
`;

// Stable identity and target resolution. Accounts and folders form a bounded
// tree, so walking them costs bulk property accesses per account/folder rather
// than one Apple Event per note. Note properties themselves stay bulk fetched.
// These helpers deliberately keep read and mutation resolution separate:
// reads may prove a short id or name unique, while mutations require a full id.
export const JXA_IDENTITY_HELPERS = `
  function safeError(code, message) {
    const error = new Error(message);
    error.appleNotesSafe = true;
    error.appleNotesSafeCode = code;
    return error;
  }

  function isFullEntityId(id, kind) {
    return id.startsWith("x-coredata://") && id.indexOf("/" + kind + "/") !== -1;
  }

  function folderCatalog(Notes, includeCounts) {
    const result = [];
    const seen = {};
    const accounts = Notes.accounts;
    const accountIds = accounts.id();
    const accountNames = accounts.name();

    function walk(folders, account) {
      const ids = folders.id();
      const names = folders.name();
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (seen[id]) continue;
        seen[id] = true;
        const folder = folders[i];
        const item = {
          id: id,
          name: names[i],
          account: { id: account.id, name: account.name },
          folder: folder,
        };
        if (includeCounts) item.count = folder.notes.length;
        result.push(item);
        walk(folder.folders, account);
      }
    }

    for (let i = 0; i < accountIds.length; i++) {
      walk(accounts[i].folders, { id: accountIds[i], name: accountNames[i] });
    }
    return result;
  }

  function noteIdentityMap(Notes) {
    const map = {};
    const folders = folderCatalog(Notes, false);
    for (let i = 0; i < folders.length; i++) {
      const folder = folders[i];
      const noteIds = folder.folder.notes.id();
      for (let j = 0; j < noteIds.length; j++) {
        map[noteIds[j]] = {
          account: folder.account,
          folder: { id: folder.id, name: folder.name },
        };
      }
    }
    return map;
  }

  function folderCandidateLabel(candidate) {
    return candidate.id + " [account " + candidate.account.name +
      " (" + candidate.account.id + "), folder " + candidate.name + "]";
  }

  function noteCandidateLabel(id, location) {
    if (!location) return id + " [account/folder identity unavailable]";
    return id + " [account " + location.account.name +
      " (" + location.account.id + "), folder " + location.folder.name +
      " (" + location.folder.id + ")]";
  }

  function boundedIdentityList(ids) {
    const displayed = ids.slice(0, 8).map(id => String(id).slice(0, 2048));
    const remainder = ids.length - displayed.length;
    return displayed.join(", ") + (remainder > 0 ? " (and " + remainder + " more)" : "");
  }

  function validateTrashFolderIdsForRead(catalog, accountIds, configuredIds) {
    if (configuredIds.length === 0) {
      throw safeError(
        "TRASH_CONFIG_REQUIRED",
        "Reads are disabled until APPLE_NOTES_TRASH_FOLDER_IDS contains exactly one stable Recently Deleted folder ID for every Notes account."
      );
    }
    const folderById = {};
    for (let i = 0; i < catalog.length; i++) folderById[catalog[i].id] = catalog[i];
    const unknown = configuredIds.filter(id => !folderById[id]);
    if (unknown.length > 0) {
      throw safeError(
        "TRASH_CONFIG_STALE",
        "Configured trash folder IDs are no longer present: " + boundedIdentityList(unknown) +
        ". Re-run list_folders and update APPLE_NOTES_TRASH_FOLDER_IDS."
      );
    }
    const countByAccount = {};
    for (let i = 0; i < configuredIds.length; i++) {
      const accountId = folderById[configuredIds[i]].account.id;
      countByAccount[accountId] = (countByAccount[accountId] || 0) + 1;
    }
    const duplicateAccounts = Object.keys(countByAccount).filter(id => countByAccount[id] > 1);
    if (duplicateAccounts.length > 0) {
      throw safeError(
        "TRASH_CONFIG_INVALID",
        "More than one configured trash folder belongs to these account IDs: " +
        boundedIdentityList(duplicateAccounts) + ". Configure exactly one per account."
      );
    }
    const uniqueAccounts = Array.from(new Set(accountIds));
    const missingAccounts = uniqueAccounts.filter(id => !countByAccount[id]);
    if (missingAccounts.length > 0) {
      throw safeError(
        "TRASH_CONFIG_INCOMPLETE",
        "No configured trash folder covers these Notes account IDs: " +
        boundedIdentityList(missingAccounts) +
        ". Re-run list_folders and configure exactly one Recently Deleted folder per account."
      );
    }
  }

  function resolveFolderForRead(Notes, id, name) {
    if (id !== "" && name !== "") {
      throw safeError("INVALID_ARGUMENT", "Provide either folder_id or folder, not both.");
    }
    const catalog = folderCatalog(Notes, false);
    let matches;
    if (id !== "") {
      if (!isFullEntityId(id, "ICFolder")) {
        throw safeError("INVALID_FOLDER_ID", "folder_id must be a full x-coredata://.../ICFolder/... id from list_folders.");
      }
      matches = catalog.filter(candidate => candidate.id === id);
      if (matches.length === 0) throw safeError("FOLDER_NOT_FOUND", "Folder id not found: " + id);
    } else {
      matches = catalog.filter(candidate => candidate.name === name);
      if (matches.length === 0) throw safeError("FOLDER_NOT_FOUND", "Folder not found: " + name);
      if (matches.length > 1) {
        throw safeError("AMBIGUOUS_FOLDER",
          "Folder name '" + name + "' is ambiguous. Retry with folder_id. Candidates: " +
          matches.map(folderCandidateLabel).join("; ")
        );
      }
    }
    const [match] = matches;
    return match;
  }

  function resolveFolderForMutation(Notes, id) {
    if (!isFullEntityId(id, "ICFolder")) {
      throw safeError("INVALID_FOLDER_ID", "folder_id must be a full x-coredata://.../ICFolder/... id from list_folders.");
    }
    const matches = folderCatalog(Notes, false).filter(candidate => candidate.id === id);
    if (matches.length === 0) throw safeError("FOLDER_NOT_FOUND", "Folder id not found: " + id);
    if (matches.length > 1) throw safeError("AMBIGUOUS_FOLDER", "Folder id is not unique: " + id);
    const [match] = matches;
    return match;
  }

  function resolveNoteForRead(Notes, id, title) {
    if (id !== "" && title !== "") {
      throw safeError("INVALID_ARGUMENT", "Provide either id or title, not both.");
    }
    const ids = Notes.notes.id();
    const names = Notes.notes.name();
    let candidateIds = [];

    if (id !== "") {
      if (id.startsWith("x-coredata://") && !isFullEntityId(id, "ICNote")) {
        throw safeError("INVALID_NOTE_ID", "id is not a note id: " + id);
      }
      candidateIds = isFullEntityId(id, "ICNote")
        ? ids.filter(candidate => candidate === id)
        : ids.filter(candidate => candidate.endsWith("/" + id));
      if (candidateIds.length === 0) throw safeError("NOTE_NOT_FOUND", "Note id not found: " + id);
    } else {
      for (let i = 0; i < ids.length; i++) {
        if (names[i] === title) candidateIds.push(ids[i]);
      }
      if (candidateIds.length === 0) throw safeError("NOTE_NOT_FOUND", "Note not found: " + title);
    }

    const identities = noteIdentityMap(Notes);
    const excludedFolderIds = arguments.length > 3 ? arguments[3] : [];
    for (let i = 0; i < candidateIds.length; i++) {
      if (!identities[candidateIds[i]]) {
        throw safeError(
          "IDENTITY_UNAVAILABLE",
          "Stable account/folder identity unavailable for note: " + candidateIds[i]
        );
      }
    }

    // A caller explicitly naming a full trashed ID gets a precise refusal.
    // Read-only selectors otherwise behave as if trash does not exist, so
    // deleted candidate identities cannot cause or appear in ambiguity errors.
    if (
      id !== "" && isFullEntityId(id, "ICNote") &&
      excludedFolderIds.indexOf(identities[candidateIds[0]].folder.id) !== -1
    ) {
      throw safeError(
        "NOTE_IN_RECENTLY_DELETED",
        "Refusing to read the selected note because its stable folder ID is configured as Recently Deleted."
      );
    }
    candidateIds = candidateIds.filter(candidateId =>
      excludedFolderIds.indexOf(identities[candidateId].folder.id) === -1
    );
    if (candidateIds.length === 0) {
      throw safeError(
        "NOTE_NOT_FOUND",
        id !== "" ? "Note id not found: " + id : "Note not found: " + title
      );
    }
    if (candidateIds.length > 1) {
      const selector = id !== "" ? "Note id '" + id + "'" : "Note title '" + title + "'";
      throw safeError("AMBIGUOUS_NOTE",
        selector + " is ambiguous. Retry with a full note id. Candidates: " +
        candidateIds.map(candidate => noteCandidateLabel(candidate, identities[candidate])).join("; ")
      );
    }

    const fullId = candidateIds[0];
    const location = identities[fullId];
    return {
      note: Notes.notes.byId(fullId),
      id: fullId,
      account: location.account,
      folder: location.folder,
    };
  }

  function resolveNoteForMutation(Notes, id) {
    if (!isFullEntityId(id, "ICNote")) {
      throw safeError("INVALID_NOTE_ID", "id must be a full x-coredata://.../ICNote/... id; short ids and titles are read-only selectors.");
    }
    const ids = Notes.notes.id();
    if (ids.indexOf(id) === -1) throw safeError("NOTE_NOT_FOUND", "Note id not found: " + id);
    const location = noteIdentityMap(Notes)[id];
    if (!location) {
      throw safeError("IDENTITY_UNAVAILABLE", "Stable account/folder identity unavailable for note: " + id);
    }
    return {
      note: Notes.notes.byId(id),
      id: id,
      account: location.account,
      folder: location.folder,
    };
  }
`;

// Resolve one mutation target and refuse to issue a second delete when the
// note is already in a folder matching the configured Recently Deleted name.
// Folder note ids are fetched in bulk so detection does not add per-note Apple
// Events. Kept as plain JavaScript for mocked Node tests.
export const JXA_DELETE_NOTE = `
  function safeError(code, message) {
    const error = new Error(message);
    error.appleNotesSafe = true;
    error.appleNotesSafeCode = code;
    return error;
  }

  function deleteNoteSafely(Notes, target, trashFolderName) {
    const note = target.note;
    const noteId = target.id;
    const trashFolders = Notes.folders.whose({ name: trashFolderName });

    for (let i = 0; i < trashFolders.length; i++) {
      const trashedIds = trashFolders[i].notes.id();
      if (trashedIds.indexOf(noteId) !== -1) {
        throw safeError("ALREADY_TRASHED",
          "Refusing to delete note '" + note.name() +
          "': it is already in " + trashFolderName +
          " and deleting it again could permanently erase it."
        );
      }
    }

    const info = {
      deleted: true,
      id: noteId,
      name: note.name(),
      account: target.account,
      folder: target.folder,
    };
    Notes.delete(note);
    return info;
  }
`;
