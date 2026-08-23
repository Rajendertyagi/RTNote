/* ui.js — toasts, escaping, note tabs, right sidebar, theme, context menu,
   bookmarks strip, trash panel, chat panel */

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showToast(msg, type = 'info') {
    const c = document.getElementById('toastContainer');
    if (!c) return;
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.innerHTML = '<span>' + escapeHtml(msg) + '</span><button class="toast-close" onclick="this.parentElement.remove()">✕</button>';
    c.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

/* ═══════════════════════════════════════════════════════════════
   Note tabs — one tab per note (VSCode-style), persisted server-side
   in the options table as "open-tabs" (Trilium persists openNoteContexts
   the same way). State: TabState.open = [{id,title}], activeId.
   ═══════════════════════════════════════════════════════════════ */
const TabState = { open: [], activeId: null };

let _persistTabsTimer = null;
function persistTabs() {
    clearTimeout(_persistTabsTimer);
    _persistTabsTimer = setTimeout(() => {
        const payload = JSON.stringify({
            tabs: TabState.open.map((t) => t.id),
            active: TabState.activeId,
        });
        apiPutOption('open-tabs', payload).catch(() => {});
    }, 300);
}

function renderTabs() {
    const tabsEl = document.getElementById('tabs');
    if (!tabsEl) return;
    tabsEl.querySelectorAll('.tab').forEach((el) => el.remove());
    const addBtn = tabsEl.querySelector('.add-tab');
    TabState.open.forEach((t) => {
        const div = document.createElement('div');
        div.className = 'tab' + (t.id === TabState.activeId ? ' active' : '') + (t._dirty ? ' modified' : '');
        div.dataset.noteId = t.id;
        div.title = t.title;
        div.innerHTML =
            '<span>' + escapeHtml(t.title) + '</span>' +
            '<span class="close"><i class="bx bx-x"></i></span>';
        tabsEl.insertBefore(div, addBtn);
    });
    // Keep the active tab reachable when many tabs overflow the row
    const activeEl = tabsEl.querySelector('.tab.active');
    if (activeEl && activeEl.scrollIntoView) {
        activeEl.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
}

/* Dirty indicator (GUI-3): derived from the editor save lifecycle —
   set on first unsaved keystroke, cleared only by a successful save
   (or note switch to a clean note). Never persisted. */
function markTabDirty(noteId, dirty) {
    const t = TabState.open.find((x) => x.id === Number(noteId));
    if (!t || !!t._dirty === !!dirty) return;
    t._dirty = !!dirty;
    const el = document.querySelector('#tabs .tab[data-note-id="' + noteId + '"]');
    if (el) el.classList.toggle('modified', t._dirty);
}

async function activateTab(noteId, opts = {}) {
    TabState.activeId = noteId;
    renderTabs();
    persistTabs();
    /* Tab mechanics (clicking a tab, Ctrl+Tab cycling, close-neighbor
       activation) are workspace operations, not note navigation — they must
       not pollute GUI-2 history. opts.fromTabs suppresses recording. */
    if (opts.fromTabs && typeof NavHistory !== 'undefined' && NavHistory.beginSuppress) {
        NavHistory.beginSuppress();
    }
    try {
        await openNoteInEditor(noteId);
    } finally {
        if (opts.fromTabs && typeof NavHistory !== 'undefined' && NavHistory.endNavigate) {
            NavHistory.endNavigate();
        }
    }
}

async function openNoteInTab(noteId) {
    await App.bootReady; // never race the boot-time tab restore
    noteId = Number(noteId);
    if (isNaN(noteId)) return;
    if (!TabState.open.some((t) => t.id === noteId)) {
        try {
            const n = await apiGetNote(noteId);
            if (n.deleted_at) { showToast('Note is in the trash', 'error'); return; }
            TabState.open.push({ id: n.id, title: n.title });
        } catch (err) {
            showToast('Cannot open note', 'error');
            return;
        }
    }
    await activateTab(noteId);
}

function closeTabByNoteId(noteId) {
    const idx = TabState.open.findIndex((t) => t.id === Number(noteId));
    if (idx === -1) return;
    const wasActive = TabState.activeId === Number(noteId);
    TabState.open.splice(idx, 1);

    if (wasActive) {
        const next = TabState.open[Math.min(idx, TabState.open.length - 1)];
        if (next) {
            activateTab(next.id, { fromTabs: true });
        } else {
            TabState.activeId = null;
            App.currentNoteId = null;
            editorSetContent('');
            setTopbar('No note selected');
            renderTabs();
        }
    } else {
        renderTabs();
    }
    persistTabs();
}

function updateTabTitle(noteId, title) {
    const t = TabState.open.find((x) => x.id === Number(noteId));
    if (t) t.title = title;
    const el = document.querySelector('#tabs .tab[data-note-id="' + noteId + '"] span');
    if (el) el.textContent = title;
    persistTabs();
}

async function loadPersistedTabs() {
    try {
        const opt = await apiGetOption('open-tabs');
        if (!opt.value) return;
        const parsed = JSON.parse(opt.value);
        const valid = [];
        for (const id of parsed.tabs || []) {
            try {
                const n = await apiGetNote(id);
                if (!n.deleted_at) valid.push({ id: n.id, title: n.title });
            } catch (e) { /* note gone — drop it */ }
        }
        TabState.open = valid;
        TabState.activeId = valid.some((t) => t.id === parsed.active)
            ? parsed.active
            : (valid.length ? valid[0].id : null);
        renderTabs();
        if (TabState.activeId != null) await activateTab(TabState.activeId);
    } catch (err) {
        console.error('Failed to restore tabs:', err);
    }
}

function initTabs() {
    const tabsEl = document.getElementById('tabs');
    if (!tabsEl) return;
    tabsEl.addEventListener('click', (e) => {
        if (e.target.closest('.add-tab')) { createNewNote(); return; }
        const tab = e.target.closest('.tab');
        if (!tab || !tab.dataset.noteId) return;
        if (e.target.closest('.close')) { closeTabByNoteId(tab.dataset.noteId); return; }
        activateTab(Number(tab.dataset.noteId), { fromTabs: true });
    });
    /* Middle-click closes a tab without touching the active note */
    tabsEl.addEventListener('mousedown', (e) => {
        if (e.button !== 1) return;
        const tab = e.target.closest('.tab');
        if (!tab || !tab.dataset.noteId) return;
        e.preventDefault(); // stop middle-click autoscroll
        closeTabByNoteId(tab.dataset.noteId);
    });

    /* Desktop tab keyboard model.
       Ctrl+W / Ctrl+Tab are browser-reserved in some environments; Alt+W and
       Ctrl+PageUp/PageDown are wired as always-available equivalents. */
    document.addEventListener('keydown', (e) => {
        const closeActive = () => {
            if (TabState.activeId != null) closeTabByNoteId(TabState.activeId);
        };
        if (e.ctrlKey && !e.shiftKey && (e.key === 'w' || e.key === 'W')) {
            e.preventDefault();
            closeActive();
        } else if (e.altKey && (e.key === 'w' || e.key === 'W')) {
            e.preventDefault();
            closeActive();
        } else if (e.ctrlKey && e.key === 'Tab') {
            e.preventDefault();
            cycleTab(e.shiftKey ? -1 : 1);
        } else if (e.ctrlKey && e.key === 'PageDown') {
            e.preventDefault();
            cycleTab(1);
        } else if (e.ctrlKey && e.key === 'PageUp') {
            e.preventDefault();
            cycleTab(-1);
        }
    });
}

/* Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+PageUp/Down: cycle through open tabs.
   Wraps at both ends; no-op with fewer than two tabs. Tab cycling is a
   workspace operation — history stays untouched. */
function cycleTab(dir) {
    const n = TabState.open.length;
    if (n < 2) return;
    const idx = TabState.open.findIndex((t) => t.id === TabState.activeId);
    const next = TabState.open[(idx + dir + n) % n];
    activateTab(next.id, { fromTabs: true });
}

/* Open a note in its own tab WITHOUT switching to it (Ctrl+click /
   middle-click on tree rows). No-op when it already has a tab. */
async function openNoteInBackground(noteId) {
    await App.bootReady;
    noteId = Number(noteId);
    if (isNaN(noteId)) return;
    if (TabState.open.some((t) => t.id === noteId)) return;
    try {
        const n = await apiGetNote(noteId);
        if (n.deleted_at) return;
        TabState.open.push({ id: n.id, title: n.title });
        renderTabs();
        persistTabs();
    } catch (err) { /* missing note → ignore */ }
}

/* ── Navigation (GUI-2): history stepping + clickable breadcrumbs ── */
function navUpdateButtons() {
    const b = document.getElementById('navBackBtn');
    const f = document.getElementById('navFwdBtn');
    if (b) b.disabled = !NavHistory.canBack();
    if (f) f.disabled = !NavHistory.canForward();
}

async function navStep(dir) {
    await App.bootReady; // never race the boot-time tab restore
    // Skip dead entries (deleted/missing notes) until one opens or the
    // stack ends in that direction.
    while (dir < 0 ? NavHistory.canBack() : NavHistory.canForward()) {
        const id = NavHistory.peek(dir);
        if (id == null) return;
        let alive = false;
        try {
            const n = await apiGetNote(id);
            alive = !n.deleted_at;
        } catch (err) { /* missing → skip */ }
        if (!alive) { NavHistory.skip(dir); continue; }
        const target = NavHistory.step(dir);
        try { await openNoteInTab(target); } finally { NavHistory.endNavigate(); }
        return;
    }
}

function renderBreadcrumb(noteId) {
    const b = document.getElementById('topbar-breadcrumb');
    if (!b) return;
    const parts = (typeof notePathParts === 'function') ? notePathParts(noteId) : [];
    b.innerHTML = parts.map((p) =>
        '<span class="crumb" data-id="' + p.id + '" title="' + escapeHtml(p.title) + '">' +
        escapeHtml(p.title) + '</span>'
    ).join('<span class="crumb-sep">›</span>');
    b.classList.toggle('hidden', !parts.length);
}

function initNavigation() {
    NavHistory.onChange = navUpdateButtons;

    const back = document.getElementById('navBackBtn');
    const fwd = document.getElementById('navFwdBtn');
    if (back) back.addEventListener('click', () => navStep(-1));
    if (fwd) fwd.addEventListener('click', () => navStep(1));

    const b = document.getElementById('topbar-breadcrumb');
    if (b) {
        b.addEventListener('click', async (e) => {
            const crumb = e.target.closest('.crumb');
            if (!crumb) return;
            await openNoteInTab(Number(crumb.dataset.id));
        });
    }

    /* Global keyboard: Alt+←/→ history, Ctrl+. tree escape */
    document.addEventListener('keydown', (e) => {
        if (e.altKey && e.key === 'ArrowLeft') {
            e.preventDefault(); // RTNote history, not browser history
            navStep(-1);
        } else if (e.altKey && e.key === 'ArrowRight') {
            e.preventDefault();
            navStep(1);
        } else if (e.ctrlKey && e.key === '.') {
            e.preventDefault();
            if (App.currentNoteId != null && typeof revealNoteInTree === 'function') {
                revealNoteInTree(App.currentNoteId);
            }
            const treeEl = document.getElementById('note-tree');
            if (treeEl) treeEl.focus();
        }
    });

    navUpdateButtons();
}

/* ── Move-to dialog (GUI-4): simple destination picker ── */
let _moveDialogNoteId = null;

function openMoveDialog(noteId) {
    const overlay = document.getElementById('moveModal');
    const sel = document.getElementById('moveDestSelect');
    if (!overlay || !sel) return;
    _moveDialogNoteId = Number(noteId);

    // Candidate destinations: every note except the moved note and its own
    // descendants (server rejects those anyway — this keeps the list honest).
    const byId = new Map(_notesCache.map((n) => [n.id, n]));
    const excluded = new Set([_moveDialogNoteId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const n of _notesCache) {
            if (excluded.has(n.id)) continue;
            if (n.parent_id != null && excluded.has(n.parent_id)) {
                excluded.add(n.id);
                changed = true;
            }
        }
    }

    const depth = (id) => {
        let d = 0, cur = byId.get(id);
        while (cur && cur.parent_id != null) { d++; cur = byId.get(cur.parent_id); }
        return d;
    };

    sel.innerHTML = '<option value="">(top level)</option>' + _notesCache
        .filter((n) => !excluded.has(n.id))
        .sort((x, y) => x.id - y.id)
        .map((n) => {
            const label = '— '.repeat(depth(n.id)) + n.title;
            return `<option value="${n.id}">${escapeHtml(label)}</option>`;
        })
        .join('');
    overlay.classList.remove('hidden');
}

function initMoveDialog() {
    const overlay = document.getElementById('moveModal');
    if (!overlay) return;
    const close = () => { overlay.classList.add('hidden'); _moveDialogNoteId = null; };
    document.getElementById('moveCancel').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === this) close(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
    });
    document.getElementById('moveConfirm').addEventListener('click', async () => {
        const sel = document.getElementById('moveDestSelect');
        const parent = sel.value === '' ? null : Number(sel.value);
        const noteId = _moveDialogNoteId;
        close();
        if (noteId == null) return;
        await moveNoteFlow(noteId, parent, 9999); // append as last child of destination
    });
}

/* ── New Note type picker (topbar + button) ── */
function initNewNoteMenu() {
    const btn = document.getElementById('newNoteBtn');
    const menu = document.getElementById('newNoteMenu');
    if (!btn || !menu) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = btn.getBoundingClientRect();
        menu.style.left = r.left + 'px';
        menu.style.top = (r.bottom + 4) + 'px';
        menu.classList.add('open');
    });

    menu.addEventListener('click', async (e) => {
        const item = e.target.closest('.context-menu-item');
        if (!item) return;
        menu.classList.remove('open');
        await createNewNote(item.dataset.type);
    });

    document.addEventListener('click', () => menu.classList.remove('open'));
}

/* ── ⋯ note-actions menu (secondary per-note operations) ── */
function initNoteMenu() {
    const btn = document.getElementById('noteMenuBtn');
    const menu = document.getElementById('noteMenu');
    if (!btn || !menu) return;

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Anchored via CSS (.note-menu { position:absolute; right:0 }) inside
        // .note-menu-wrap — no offsetWidth math (it reads 0 while hidden).
        menu.classList.toggle('open');
    });

    menu.addEventListener('click', async (e) => {
        const item = e.target.closest('.context-menu-item');
        if (!item) return;
        menu.classList.remove('open');
        const noteId = App.currentNoteId != null ? Number(App.currentNoteId) : null;
        if (noteId == null) { showToast('Open a note first', 'error'); return; }
        if (item.dataset.action === 'duplicate') await duplicateNoteFlow(noteId);
        if (item.dataset.action === 'delete') {
            const title = TabState.open.find((t) => t.id === noteId)?.title || '';
            await deleteNoteFlow(noteId, title);
        }
    });

    document.addEventListener('click', () => menu.classList.remove('open'));
}

/* ── Right sidebar ── */
function switchRightTab(name) {
    document.querySelectorAll('.right-sidebar .tab').forEach((t) => t.classList.remove('active'));
    const activeTab = document.querySelector('.right-sidebar .tab[data-tab="' + name + '"]');
    if (activeTab) activeTab.classList.add('active');
    document.getElementById('chat-panel').classList.toggle('hidden', name !== 'chat');
    document.getElementById('outline-panel').classList.toggle('hidden', name !== 'outline');
    document.getElementById('memories-panel').classList.toggle('hidden', name !== 'memories');
    document.getElementById('files-panel').classList.toggle('hidden', name !== 'files');
    if (name === 'memories') loadMemories();
    if (name === 'files') loadFiles();
}

function toggleRightSidebar() {
    const sidebar = document.getElementById('rightSidebar');
    if (sidebar) sidebar.classList.toggle('hidden');
}

/* ── Theme ── */
function initTheme() {
    const themeSelect = document.getElementById('themeSelect');
    if (!themeSelect) return;
    const saved = localStorage.getItem('theme') || 'catppuccin-mocha';
    document.documentElement.dataset.theme = saved;
    themeSelect.value = saved;
    // Sync status bar with the restored theme (not just on change)
    const statusEl = document.getElementById('status-right');
    if (statusEl && themeSelect.selectedIndex >= 0) {
        statusEl.textContent = 'UTF-8 | ' + themeSelect.options[themeSelect.selectedIndex].text;
    }
    themeSelect.addEventListener('change', (e) => {
        document.documentElement.dataset.theme = e.target.value;
        localStorage.setItem('theme', e.target.value);
        const statusEl = document.getElementById('status-right');
        if (statusEl) statusEl.textContent = 'UTF-8 | ' + e.target.options[e.target.selectedIndex].text;
        showToast('Theme: ' + e.target.options[e.target.selectedIndex].text, 'info');
    });
}

/* ═══════════════════════════════════════════════════════════════
   Context menu — New child / Rename / Duplicate / Bookmark / Delete
   ═══════════════════════════════════════════════════════════════ */
let ctxNodeId = null;

const CTX_MENU_HTML =
    '<div class="context-menu-item" data-action="new-child"><i class="bx bx-plus icon"></i> New child note</div>' +
    '<div class="context-menu-item" data-action="rename"><i class="bx bx-edit icon"></i> Rename <span class="shortcut">F2</span></div>' +
    '<div class="context-menu-item" data-action="duplicate"><i class="bx bx-copy icon"></i> Duplicate</div>' +
    '<div class="context-menu-sep"></div>' +
    '<div class="context-menu-item" data-action="move-up"><i class="bx bx-arrow-to-top icon"></i> Move up <span class="shortcut">Ctrl+↑</span></div>' +
    '<div class="context-menu-item" data-action="move-down"><i class="bx bx-arrow-to-bottom icon"></i> Move down <span class="shortcut">Ctrl+↓</span></div>' +
    '<div class="context-menu-item" data-action="move-to"><i class="bx bx-transfer icon"></i> Move to…</div>' +
    '<div class="context-menu-sep"></div>' +
    '<div class="context-menu-item" data-action="bookmark"><i class="bx bx-bookmark-star icon"></i> <span id="ctx-bookmark-label">Bookmark</span></div>' +
    '<div class="context-menu-sep"></div>' +
    '<div class="context-menu-item danger" data-action="delete"><i class="bx bx-trash icon"></i> Delete</div>';

function hideContextMenu() {
    const m = document.getElementById('ctxMenu');
    if (m) m.classList.remove('open');
}

async function applyRename(noteId, newTitle) {
    newTitle = (newTitle || '').trim();
    if (!newTitle) return false;
    try {
        await apiUpdateNote(noteId, { title: newTitle });
        updateTabTitle(noteId, newTitle);
        if (Number(App.currentNoteId) === Number(noteId)) setTopbar(newTitle);
        showToast('Renamed', 'success');
        return true;
    } catch (err) {
        showToast('Rename failed', 'error');
        return false;
    }
}

function startRename(node) {
    if (!node) return;
    if (typeof node.startEditTitle === 'function') {
        try { node.startEditTitle(); return; } catch (e) { /* fall through to prompt */ }
    }
    const t = prompt('Rename note', node.title);
    if (t !== null) {
        applyRename(Number(node.key), t).then((ok) => { if (ok) refreshTree(); });
    }
}

async function deleteNoteFlow(noteId, title) {
    if (!confirm('Delete "' + (title || 'this note') + '" and its sub-notes?\nYou can restore it from Trash.')) return;
    try {
        await apiDeleteNote(noteId);
        closeTabByNoteId(noteId);
        await refreshTree();
        await refreshBookmarks();
        showToast('Moved to trash', 'success');
    } catch (err) {
        showToast('Delete failed', 'error');
    }
}

async function duplicateNoteFlow(noteId) {
    try {
        const copy = await apiDuplicateNote(noteId);
        await refreshTree();
        showToast('Duplicated as "' + copy.title + '"', 'success');
    } catch (err) {
        showToast('Duplicate failed', 'error');
    }
}

function initContextMenu() {
    const menu = document.getElementById('ctxMenu');

    document.addEventListener('contextmenu', (e) => {
        const row = e.target.closest('.wb-row');
        if (!row) return;
        e.preventDefault();

        let node = null;
        try { node = mar10.Wunderbaum.getNode(row); } catch (err) { /* ignore */ }
        if (!node) return;

        ctxNodeId = Number(node.key);
        menu.innerHTML = CTX_MENU_HTML;
        const label = menu.querySelector('#ctx-bookmark-label');
        if (label) label.textContent = App.bookmarks.has(ctxNodeId) ? 'Remove bookmark' : 'Bookmark';

        menu.style.left = Math.min(e.pageX, window.innerWidth - 230) + 'px';
        menu.style.top = Math.min(e.pageY, window.innerHeight - 210) + 'px';
        menu.classList.add('open');
    });

    menu.addEventListener('click', async (e) => {
        const item = e.target.closest('.context-menu-item');
        if (!item || ctxNodeId == null) return;
        const action = item.dataset.action;
        hideContextMenu();

        let node = null;
        const tree = mar10.Wunderbaum.getTree('note-tree');
        if (tree) { try { node = tree.findKey(String(ctxNodeId)); } catch (err) { /* ignore */ } }

        if (action === 'move-up') {
            await treeMoveRelative(ctxNodeId, -1);
        } else if (action === 'move-down') {
            await treeMoveRelative(ctxNodeId, 1);
        } else if (action === 'move-to') {
            openMoveDialog(ctxNodeId);
        } else if (action === 'new-child') {
            const n = await apiCreateNote('New Note', ctxNodeId);
            await refreshTree();
            await openNoteInTab(n.id);
            showToast('Child note created', 'success');
        } else if (action === 'rename') {
            startRename(node);
        } else if (action === 'duplicate') {
            await duplicateNoteFlow(ctxNodeId);
        } else if (action === 'bookmark') {
            await toggleBookmark(ctxNodeId);
        } else if (action === 'delete') {
            await deleteNoteFlow(ctxNodeId, node ? node.title : '');
        }
    });

    document.addEventListener('click', hideContextMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
}

/* ═══════════════════════════════════════════════════════════════
   Bookmarks — ordered strip above the tree + star toggle in topbar
   ═══════════════════════════════════════════════════════════════ */
async function refreshBookmarks() {
    try {
        App.bookmarkList = await apiListBookmarks();
        App.bookmarks = new Set(App.bookmarkList.map((b) => b.id));
        renderBookmarks();
        updateBookmarkStar();
    } catch (err) {
        console.error('Bookmarks load failed:', err);
    }
}

function renderBookmarks() {
    const strip = document.getElementById('bookmarksStrip');
    if (!strip) return;
    if (!App.bookmarkList.length) {
        strip.classList.add('hidden');
        strip.innerHTML = '';
        return;
    }
    strip.classList.remove('hidden');
    strip.innerHTML = App.bookmarkList
        .map((b) =>
            '<div class="bookmark-chip" data-id="' + b.id + '" title="' + escapeHtml(b.title) + '">' +
            '<i class="bx bx-bookmark-star"></i><span>' + escapeHtml(b.title) + '</span></div>'
        )
        .join('');
}

function initBookmarks() {
    const strip = document.getElementById('bookmarksStrip');
    if (strip) {
        strip.addEventListener('click', (e) => {
            const chip = e.target.closest('.bookmark-chip');
            if (chip) openNoteInTab(Number(chip.dataset.id));
        });
    }
    const star = document.getElementById('bookmarkBtn');
    if (star) {
        star.addEventListener('click', () => {
            if (App.currentNoteId != null) toggleBookmark(Number(App.currentNoteId));
        });
    }
    refreshBookmarks();
}

async function toggleBookmark(noteId) {
    try {
        if (App.bookmarks.has(noteId)) {
            await apiRemoveBookmark(noteId);
            showToast('Bookmark removed');
        } else {
            await apiAddBookmark(noteId);
            showToast('Bookmarked', 'success');
        }
        await refreshBookmarks();
    } catch (err) {
        showToast('Bookmark failed', 'error');
    }
}

function updateBookmarkStar() {
    const btn = document.getElementById('bookmarkBtn');
    if (!btn) return;
    const active = App.currentNoteId != null && App.bookmarks.has(Number(App.currentNoteId));
    const icon = btn.querySelector('i');
    if (icon) icon.className = active ? 'bx bxs-star star-active' : 'bx bx-star';
    btn.title = active ? 'Remove bookmark' : 'Bookmark this note';
}

/* ═══════════════════════════════════════════════════════════════
   Trash panel — list / restore / empty soft-deleted notes
   ═══════════════════════════════════════════════════════════════ */
async function toggleTrashPanel() {
    const panel = document.getElementById('trashPanel');
    if (!panel) return;
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) await renderTrash();
}

async function renderTrash() {
    const itemsEl = document.getElementById('trashItems');
    if (!itemsEl) return;
    try {
        const rows = await apiListTrash();
        if (!rows.length) {
            itemsEl.innerHTML = '<div class="empty-state-small">Trash is empty</div>';
            return;
        }
        itemsEl.innerHTML = rows
            .map((r) =>
                '<div class="trash-item">' +
                '<div class="trash-info"><span class="trash-title">' + escapeHtml(r.title) + '</span>' +
                '<span class="trash-date">' + escapeHtml(String(r.deleted_at || '').replace('T', ' ')) + '</span></div>' +
                '<button class="btn-sm" data-restore="' + r.id + '">Restore</button>' +
                '</div>'
            )
            .join('');
    } catch (err) {
        itemsEl.innerHTML = '<div class="empty-state-small">Failed to load trash</div>';
    }
}

function initTrash() {
    const toggleBtn = document.getElementById('trashToggle');
    if (toggleBtn) toggleBtn.addEventListener('click', toggleTrashPanel);

    const closeBtn = document.getElementById('closeTrashBtn');
    if (closeBtn) closeBtn.addEventListener('click', toggleTrashPanel);

    const itemsEl = document.getElementById('trashItems');
    if (itemsEl) {
        itemsEl.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-restore]');
            if (!btn) return;
            try {
                const res = await apiRestoreNote(Number(btn.dataset.restore));
                await renderTrash();
                await refreshTree();
                showToast(res.reparented_to_root
                    ? 'Restored to top level (parent still deleted)'
                    : 'Restored', 'success');
            } catch (err) {
                showToast('Restore failed', 'error');
            }
        });
    }

    const emptyBtn = document.getElementById('emptyTrashBtn');
    if (emptyBtn) {
        emptyBtn.addEventListener('click', async () => {
            if (!confirm('Permanently erase ALL notes in the trash? This cannot be undone.')) return;
            try {
                const res = await apiEmptyTrash();
                await renderTrash();
                showToast('Erased ' + res.erased + ' note(s)', 'success');
            } catch (err) {
                showToast('Empty trash failed', 'error');
            }
        });
    }
}

/* ── Day notes (Journal) ── */
async function openToday() {
    const d = new Date();
    const ds = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    try {
        const day = await apiGetDayNote(ds);
        await refreshTree();      // tree first, so reload can't steal focus back
        await openNoteInTab(day.id);
        showToast(day.created ? 'New day note created' : "Opened today's note", 'info');
    } catch (err) {
        showToast('Day note failed', 'error');
    }
}

/* ═══════════════════════════════════════════════════════════════
   Calendar — FullCalendar month view of notes with start_date.
   Day click opens/creates that day's Journal note (F8 tie-in);
   event click opens the note in a tab. (Trilium: collections/calendar)
   ═══════════════════════════════════════════════════════════════ */
let _calendar = null;

function toggleCalendar() {
    const overlay = document.getElementById('calendarOverlay');
    if (!overlay) return;
    const willShow = overlay.classList.contains('hidden');
    overlay.classList.toggle('hidden');
    if (willShow) {
        if (typeof FullCalendar === 'undefined') {
            showToast('Calendar library unavailable', 'error');
            return;
        }
        if (!_calendar) {
            const calEl = document.getElementById('calendarEl');
            _calendar = new FullCalendar.Calendar(calEl, {
                initialView: 'dayGridMonth',
                height: 'auto',
                headerToolbar: { left: 'prev,next today', center: 'title', right: '' },
                events: async function (info, successCallback, failureCallback) {
                    try {
                        const rows = await apiGetCalendarEvents(
                            info.startStr.slice(0, 10), info.endStr.slice(0, 10));
                        successCallback(rows.map((r) => ({
                            id: String(r.id),
                            title: r.title,
                            start: r.start_date,
                            end: r.end_date || null,
                        })));
                    } catch (err) {
                        failureCallback(err);
                    }
                },
                // Tag rendered event elements so our delegated click handler
                // can resolve them (FullCalendar's own eventClick/dateClick
                // don't fire for programmatic clicks).
                eventDidMount: function (info) {
                    info.el.dataset.noteId = String(info.event.id);
                },
            });
            _calendar.render();

            // Native delegated clicks: event chip → open note; day cell →
            // open/create that day's Journal note.
            calEl.addEventListener('click', async (e) => {
                const evEl = e.target.closest('.fc-event');
                if (evEl && evEl.dataset.noteId) {
                    openNoteInTab(Number(evEl.dataset.noteId));
                    return;
                }
                const cell = e.target.closest('.fc-daygrid-day');
                if (!cell || !cell.dataset.date) return;
                try {
                    const day = await apiGetDayNote(cell.dataset.date);
                    await refreshTree();
                    await openNoteInTab(day.id);
                } catch (err) {
                    showToast('Day note failed', 'error');
                }
            });
        } else {
            _calendar.refetchEvents();
        }
    }
}

/* ═══════════════════════════════════════════════════════════════
   Table view — editable grid of the current note's children.
   (Trilium uses Tabulator; v1 here is a hand-rolled table.)
   ═══════════════════════════════════════════════════════════════ */
let tableViewOn = false;

async function renderTableView() {
    const body = document.getElementById('tv-body');
    const header = document.getElementById('tv-header');
    if (!body) return;
    if (App.currentNoteId == null) {
        body.innerHTML = '<tr><td colspan="5" class="empty-state-small">Open a folder note first</td></tr>';
        return;
    }
    try {
        const all = await apiListNotes();
        const kids = all.filter((n) => n.parent_id === Number(App.currentNoteId));
        if (header) header.textContent = '"' + (TabState.open.find((t) => t.id === Number(App.currentNoteId))?.title || '') + '" — children (' + kids.length + ')';
        if (!kids.length) {
            body.innerHTML = '<tr><td colspan="5" class="empty-state-small">No child notes</td></tr>';
            return;
        }
        body.innerHTML = kids.map((n) =>
            '<tr data-id="' + n.id + '">' +
            '<td><input class="tv-input tv-title" value="' + escapeHtml(n.title) + '"></td>' +
            '<td>' + escapeHtml(n.type) + '</td>' +
            '<td><input class="tv-input tv-date" type="date" value="' + escapeHtml(n.start_date || '') + '"></td>' +
            '<td class="tv-muted">' + escapeHtml(String(n.updated_at || '').replace('T', ' ').slice(0, 16)) + '</td>' +
            '<td><button class="btn-sm" data-open="' + n.id + '">Open</button></td>' +
            '</tr>'
        ).join('');
    } catch (err) {
        body.innerHTML = '<tr><td colspan="5" class="empty-state-small">Failed to load children</td></tr>';
    }
}

function initTableView() {
    const btn = document.getElementById('tableViewBtn');
    if (btn) {
        btn.addEventListener('click', () => {
            tableViewOn = !tableViewOn;
            // Route through the view router so views stay mutually exclusive
            showTypeView(tableViewOn ? 'table-view' : viewIdForType(App.currentNoteType));
            if (tableViewOn) renderTableView();
        });
    }
    const body = document.getElementById('tv-body');
    if (body) {
        body.addEventListener('click', (e) => {
            const openBtn = e.target.closest('[data-open]');
            if (openBtn) openNoteInTab(Number(openBtn.dataset.open));
        });
        body.addEventListener('change', async (e) => {
            const tr = e.target.closest('tr');
            if (!tr) return;
            const id = Number(tr.dataset.id);
            const fields = {};
            if (e.target.classList.contains('tv-title')) fields.title = e.target.value.trim();
            if (e.target.classList.contains('tv-date')) fields.start_date = e.target.value || null;
            if (!Object.keys(fields).length) return;
            try {
                await apiUpdateNote(id, fields);
                if (fields.title) updateTabTitle(id, fields.title);
                showToast('Saved', 'success');
                if (_calendar) _calendar.refetchEvents();
            } catch (err) {
                showToast('Save failed', 'error');
            }
        });
    }
}

/* ═══════════════════════════════════════════════════════════════
   Files — attachments of the current note (right sidebar tab)
   ═══════════════════════════════════════════════════════════════ */
async function loadFiles() {
    const listEl = document.getElementById('files-list');
    if (!listEl) return;
    if (App.currentNoteId == null) {
        listEl.innerHTML = '<div class="empty-state-small">Open a note first</div>';
        return;
    }
    try {
        const files = await apiListAttachments(App.currentNoteId);
        if (!files.length) {
            listEl.innerHTML = '<div class="empty-state-small">No attachments — use the paperclip or paste images into the editor</div>';
            return;
        }
        listEl.innerHTML = files.map((f) => {
            const href = f.url || (f.mime.startsWith('image/')
                ? '/api/attachments/' + f.id + '/image'
                : '/api/attachments/' + f.id + '/download');
            const dl = href.replace('/image', '/download');
            return '<div class="file-item">' +
                '<i class="bx ' + (f.mime.startsWith('image/') ? 'bx-image' : 'bx-file') + '"></i>' +
                '<a href="' + dl + '" download="' + escapeHtml(f.filename) + '" class="file-name">' + escapeHtml(f.filename) + '</a>' +
                '<span class="file-size">' + Math.max(1, Math.round(f.size / 1024)) + ' KB</span>' +
                '<button class="btn-sm danger" data-del="' + f.id + '"><i class="bx bx-trash"></i></button>' +
                '</div>';
        }).join('');
    } catch (err) {
        console.error('loadFiles failed:', err);
        listEl.innerHTML = '<div class="empty-state-small">Failed to load attachments</div>';
    }
}

function pickAndUploadFiles() {
    if (App.currentNoteId == null) { showToast('Open a note first', 'error'); return; }
    const input = document.getElementById('fileInput');
    if (!input) return;
    input.value = '';
    input.click();
}

async function uploadPickedFiles(files) {
    for (const f of files) {
        try {
            const att = await apiUploadAttachment(App.currentNoteId, f);
            showToast(att.inline ? 'Image attached' : 'File attached: ' + att.filename, 'success');
        } catch (err) {
            showToast(err.message, 'error');
        }
    }
    loadFiles();
}

function initFiles() {
    const btn1 = document.getElementById('uploadFileBtn');
    const btn2 = document.getElementById('uploadFileBtn2');
    if (btn1) btn1.addEventListener('click', pickAndUploadFiles);
    if (btn2) btn2.addEventListener('click', pickAndUploadFiles);
    const input = document.getElementById('fileInput');
    if (input) input.addEventListener('change', () => uploadPickedFiles(Array.from(input.files || [])));
    const listEl = document.getElementById('files-list');
    if (listEl) {
        listEl.addEventListener('click', async (e) => {
            const del = e.target.closest('[data-del]');
            if (!del) return;
            try {
                await apiDeleteAttachment(Number(del.dataset.del));
                loadFiles();
                showToast('Attachment deleted', 'success');
            } catch (err) {
                showToast('Delete failed', 'error');
            }
        });
    }
}

/* ── Mini chat panel (thin adapter over ChatCore) ──
   Transport: blocking POST /api/chat/send (intentional difference from the
   full page's SSE stream). All shared behavior lives in chat-core.js. */
const miniChat = ChatCore.createChatState();

function initChatMiniToolbar() {
    const modelSel = document.getElementById('chatModelMini');
    if (!modelSel) return;

    ChatCore.loadModels().then((models) => {
        miniChat.models = models;
        ChatCore.populateModelSelect(modelSel, models);
    });

    const effortSel = document.getElementById('chatEffortMini');
    if (effortSel) {
        const saved = localStorage.getItem(ChatCore.LS.effort);
        if (saved && [...effortSel.options].some((o) => o.value === saved)) effortSel.value = saved;
        effortSel.addEventListener('change', () => localStorage.setItem(ChatCore.LS.effort, effortSel.value));
    }

    document.getElementById('chatAttachMini').addEventListener('click',
        () => document.getElementById('chatFileMini').click());
    document.getElementById('chatFileMini').addEventListener('change', async (e) => {
        await ChatCore.addFiles(miniChat, [...e.target.files]);
        ChatCore.renderAttachmentChips(document.getElementById('chatAttChipsMini'), miniChat);
        e.target.value = '';
    });
}

async function sendMessage() {
    if (miniChat.generating) return;
    const input = document.getElementById('chat-input');
    const container = document.getElementById('chat-messages');
    const message = input ? input.value.trim() : '';
    if (!message || !container) return;

    ChatCore.appendMessage(container, 'user', message, { noCopy: true });
    input.value = '';
    ChatCore.clearAttachments(miniChat, document.getElementById('chatAttChipsMini'));

    const bubble = ChatCore.appendMessage(container, 'assistant', '', { typing: true, noCopy: true });
    miniChat.generating = true;
    try {
        const modelSel = document.getElementById('chatModelMini');
        const effortSel = document.getElementById('chatEffortMini');
        const data = await ChatCore.send(ChatCore.buildPayload(miniChat, message, {
            modelId: modelSel ? modelSel.value : 'gpt-4o-mini',
            effort: effortSel && effortSel.value ? effortSel.value : null,
            systemPrompt: ChatCore.MINI_SYSTEM_PROMPT,
        }));
        miniChat.sessionId = data.session_id;
        if (data.error) {
            bubble.closest('.msg').classList.add('msg-error');
            ChatCore.setBubbleContent(bubble, '⚠ ' + data.error, 'assistant');
        } else {
            ChatCore.setBubbleContent(bubble, data.reply || '(empty response)', 'assistant');
            ChatCore.addCopyButton(bubble);
        }
    } catch (err) {
        bubble.closest('.msg').classList.add('msg-error');
        ChatCore.setBubbleContent(bubble, '⚠ Connection lost: ' + err.message, 'assistant');
    } finally {
        bubble.classList.remove('typing');
        miniChat.generating = false;
        ChatCore.scrollToBottom(container);
    }
}

async function loadMemories() {
    const container = document.getElementById('memories-list');
    if (!container) return;
    try {
        const data = await ChatCore.listMemories();
        if (!data.memories || data.memories.length === 0) {
            container.innerHTML = '<div class="empty-state-small">No memories yet. Chat with the AI to extract memories.</div>';
        } else {
            container.innerHTML = data.memories.map((m) => '<div class="memory-item">' + escapeHtml(m) + '</div>').join('');
        }
    } catch (err) {
        container.innerHTML = '<div class="empty-state-small">Error loading memories</div>';
    }
}
