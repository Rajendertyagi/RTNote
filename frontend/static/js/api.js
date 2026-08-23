/* api.js — all backend communication + shared app state.

   The `App` object is the ONLY sanctioned cross-file mutable state.
   Keep every property declared here — no dynamic additions. What belongs:
   - currentNoteId / currentNoteType : the note open in the main pane
     (currentNoteType is derived from the API's `type` field on every open)
   - editor                          : the SunEditor instance
   - bookmarks / bookmarkList        : bookmark state for strip + star toggle
   Anything feature-local (tab list, timers, editor internals) stays in its
   own file as a module-level let — do NOT move it here. */
const App = {
    currentNoteId: null,
    currentNoteType: null, // 'text' | 'html' | 'page' | 'webview' | 'mermaid' | 'mindMap' | 'code'
    editor: null,
    bookmarks: new Set(),   // note ids currently bookmarked
    bookmarkList: [],       // ordered bookmark rows for the strip
};

/* ── Notes ── */
async function apiListNotes() {
    const r = await fetch('/api/notes');
    return r.json();
}

async function apiGetNote(id) {
    const r = await fetch('/api/notes/' + id);
    if (!r.ok) throw new Error('Note ' + id + ' not found');
    return r.json();
}

async function apiCreateNote(title, parentId, type) {
    const r = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title || 'Untitled Note', content: '', parent_id: parentId ?? null, type: type || 'text' }),
    });
    return r.json();
}

async function apiUpdateNote(id, fields) {
    const r = await fetch('/api/notes/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
    });
    if (!r.ok) throw new Error('Save failed (' + r.status + ')');
    return r.json();
}

async function apiDeleteNote(id) {
    const r = await fetch('/api/notes/' + id, { method: 'DELETE' });
    if (!r.ok) throw new Error('Delete failed (' + r.status + ')');
    return r.json();
}

async function apiDuplicateNote(id) {
    const r = await fetch('/api/notes/' + id + '/duplicate', { method: 'POST' });
    if (!r.ok) throw new Error('Duplicate failed (' + r.status + ')');
    return r.json();
}

async function apiSearch(q) {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q));
    return r.json();
}

/* ── Trash ── */
async function apiListTrash() {
    return (await fetch('/api/trash')).json();
}

async function apiRestoreNote(id) {
    const r = await fetch('/api/trash/' + id + '/restore', { method: 'POST' });
    if (!r.ok) throw new Error('Restore failed (' + r.status + ')');
    return r.json();
}

async function apiEmptyTrash() {
    const r = await fetch('/api/trash/empty', { method: 'POST' });
    if (!r.ok) throw new Error('Empty trash failed (' + r.status + ')');
    return r.json();
}

/* ── Bookmarks ── */
async function apiListBookmarks() {
    return (await fetch('/api/bookmarks')).json();
}

async function apiAddBookmark(noteId) {
    const r = await fetch('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note_id: noteId }),
    });
    if (!r.ok) throw new Error('Bookmark failed (' + r.status + ')');
    return r.json();
}

async function apiRemoveBookmark(noteId) {
    const r = await fetch('/api/bookmarks/' + noteId, { method: 'DELETE' });
    if (!r.ok) throw new Error('Unbookmark failed (' + r.status + ')');
    return r.json();
}

/* ── Day notes (Journal) ── */
async function apiGetDayNote(dateStr) {
    const r = await fetch('/api/days/' + dateStr);
    if (!r.ok) throw new Error('Day note failed (' + r.status + ')');
    return r.json();
}

/* ── Attachments ── */
async function apiListAttachments(noteId) {
    return (await fetch('/api/notes/' + noteId + '/attachments')).json();
}

async function apiUploadAttachment(noteId, file) {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/notes/' + noteId + '/attachments', { method: 'POST', body: fd });
    if (!r.ok) {
        let msg = 'Upload failed (' + r.status + ')';
        try { msg = (await r.json()).detail || msg; } catch (e) { /* keep default */ }
        throw new Error(msg);
    }
    return r.json();
}

async function apiDeleteAttachment(attId) {
    const r = await fetch('/api/attachments/' + attId, { method: 'DELETE' });
    if (!r.ok) throw new Error('Delete failed (' + r.status + ')');
    return r.json();
}

/* ── Calendar events ── */
async function apiGetCalendarEvents(start, end) {
    const r = await fetch('/api/calendar?start=' + start + '&end=' + end);
    if (!r.ok) throw new Error('Calendar load failed');
    return r.json();
}

/* ── Options (persisted app state) ── */
async function apiGetOption(key) {
    return (await fetch('/api/options/' + encodeURIComponent(key))).json();
}

async function apiPutOption(key, value) {
    const r = await fetch('/api/options/' + encodeURIComponent(key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: value }),
    });
    if (!r.ok) throw new Error('Option save failed (' + r.status + ')');
    return r.json();
}
