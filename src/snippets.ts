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
