// Shared JXA snippets injected into scripts. These are static strings — user
// input only ever flows into scripts via argv, never into script text.

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

// Mutate one already-resolved note while preserving its existing HTML for
// append operations and refusing destructive whole-body rewrites by default.
// Kept as plain JavaScript so the behavior can be exercised with mock Notes
// objects in Node without Automation permission.
export const JXA_UPDATE_NOTE = `
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
      throw new Error(
        "Refusing to replace a note containing rich content (" + kinds.join(", ") +
        "). Replacing the whole body would discard those items. Back up the note, " +
        "then retry with allow_rich_content_loss: true only if that loss is intended."
      );
    }

    const heading = newTitle !== "" ? newTitle : note.name();
    note.body = "<div><h1>" + escapeHtml(heading) + "</h1></div>" + toHtml(body);
  }
`;

export const JXA_RESOLVE_NOTE = `
  function resolveNote(Notes, id, title) {
    if (id !== "") {
      let fullId = id;
      if (!id.startsWith("x-coredata://")) {
        // Short id from list_notes/search_notes — resolve against full ids
        const ids = Notes.notes.id();
        fullId = ids.find(x => x.endsWith("/" + id));
        if (!fullId) throw new Error("Note id not found: " + id);
      }
      const note = Notes.notes.byId(fullId);
      note.name(); // throws if id is invalid
      return note;
    }
    const matches = Notes.notes.whose({ name: title });
    if (matches.length === 0) throw new Error("Note not found: " + title);
    if (matches.length > 1)
      throw new Error("Multiple notes titled '" + title + "' — use id instead.");
    return matches[0];
  }
`;

// Bulk Notes.notes.container.name() returns nulls, so folder names are built
// by iterating folders — one Apple Event per folder, still fast.
export const JXA_FOLDER_MAP = `
  function noteFolderMap(Notes) {
    const map = {};
    const folders = Notes.folders;
    const fnames = folders.name();
    for (let i = 0; i < fnames.length; i++) {
      const ids = folders[i].notes.id();
      for (const id of ids) map[id] = fnames[i];
    }
    return map;
  }
`;
