/* tree.js — Wunderbaum built from real /api/notes data.
   Includes the "edit" extension for inline rename (F2 / double-click-delay),
   mirroring Trilium's inline title editing. */

const NOTE_TYPE_ICONS = {
    text: 'bx bx-file',
    html: 'bx bx-code-alt',
    page: 'bx bx-window-open',
    webview: 'bx bx-link-external',
    mermaid: 'bx bx-git-branch',
    mindMap: 'bx bx-network-chart',
    code: 'bx bx-code',
};

function buildTreeSource(notes) {
    const byParent = new Map();
    notes.forEach((n) => {
        const pid = n.parent_id == null ? 'root' : n.parent_id;
        if (!byParent.has(pid)) byParent.set(pid, []);
        byParent.get(pid).push(n);
    });

    function toNodes(parentId) {
        const children = byParent.get(parentId) || [];
        return children.map((n) => {
            const kids = toNodes(n.id);
            const isFolder = kids.length > 0;
            return {
                title: n.title,
                key: String(n.id),
                type: isFolder ? 'folder' : 'doc',
                icon: isFolder ? 'bx bx-folder' : (NOTE_TYPE_ICONS[n.type] || NOTE_TYPE_ICONS.text),
                expanded: parentId === 'root',
                children: kids.length ? kids : undefined,
            };
        });
    }
    return toNodes('root');
}

/* Fetch notes first, then build the tree with a real source — no races */
let _notesCache = []; // flat rows; powers breadcrumb paths without refetching

/* Ancestors of a note as [{id, title}], nearest parent first. Missing
   (deleted) ancestors simply end the walk — graceful by construction. */
function notePathParts(noteId) {
    const byId = new Map(_notesCache.map((n) => [n.id, n]));
    const parts = [];
    let cur = byId.get(Number(noteId));
    let guard = 0;
    while (cur && cur.parent_id != null && guard++ < 32) {
        cur = byId.get(cur.parent_id);
        if (cur) parts.unshift({ id: cur.id, title: cur.title });
    }
    return parts;
}

function noteTitleById(noteId) {
    const n = _notesCache.find((r) => r.id === Number(noteId));
    return n ? n.title : '';
}

/* Expand ancestors, scroll to, and select the active note's tree node.
   Called from openNoteInEditor so EVERY entry path (tree click, search,
   breadcrumb, history, tab restore) keeps the tree synchronized. */
function revealNoteInTree(noteId) {
    const tree = mar10.Wunderbaum.getTree('note-tree');
    if (!tree) return;
    const node = tree.findKey(String(Number(noteId)));
    if (!node) return;
    _treeReloadGuard = true; // programmatic selection must not re-open the note
    try {
        // Expand ancestors first — a collapsed node has no row to select.
        if (typeof node.getParentList === 'function') {
            node.getParentList(false).forEach((p) => {
                if (typeof p.setExpanded === 'function') {
                    try { p.setExpanded(true); } catch (err) { /* ignore */ }
                }
            });
        }
        if (typeof node.reveal === 'function') node.reveal();
        if (typeof node.setSelected === 'function') node.setSelected(true);
    } catch (e) { /* older builds: best effort */ }
    setTimeout(() => { _treeReloadGuard = false; }, 250);
}

function notePath(noteId) {
    const byId = new Map(_notesCache.map((n) => [n.id, n]));
    const parts = [];
    let cur = byId.get(Number(noteId));
    let guard = 0;
    while (cur && cur.parent_id != null && guard++ < 32) {
        cur = byId.get(cur.parent_id);
        if (cur) parts.unshift(cur.title);
    }
    return parts;
}

async function initTree() {
    const el = document.getElementById('note-tree');
    if (!el || typeof mar10 === 'undefined' || !mar10.Wunderbaum) {
        console.error('Wunderbaum unavailable');
        return;
    }

    let source = [];
    try {
        _notesCache = await apiListNotes();
        source = buildTreeSource(_notesCache);
    } catch (err) {
        console.error('Failed to load notes for tree:', err);
    }

    // Backspace with tree focus → jump to the parent note (Trilium pattern).
    // Root-level notes are a no-op; never fires while typing elsewhere
    // because the listener is scoped to the tree container.
    el.addEventListener('keydown', (e) => {
        if (e.key !== 'Backspace') return;
        const t = mar10.Wunderbaum.getTree('note-tree');
        const node = t && typeof t.getActiveNode === 'function' ? t.getActiveNode() : null;
        if (!node) return;
        const id = Number(node.key);
        const meta = _notesCache.find((n) => n.id === id);
        if (!meta || meta.parent_id == null) return; // root-level: no-op
        e.preventDefault();
        openNoteInTab(meta.parent_id);
    });

    new mar10.Wunderbaum({
        id: 'note-tree',
        element: el,
        source: source,
        checkbox: false,
        selectMode: 1,
        icon: (e) => e.node.data.icon || 'bx bx-file',
        extensions: ['edit'],
        edit: {
            trigger: ['F2'],
            applyEdit: async (e) => {
                const node = e.node;
                const input = e.inputElem;
                const newTitle = input ? input.value.trim() : '';
                if (!newTitle || newTitle === node.title) return false;
                const ok = await applyRename(Number(node.key), newTitle);
                if (!ok) return false;
                if (typeof node.setTitle === 'function') node.setTitle(newTitle);
                refreshTree();
            },
        },
        activate: (e) => {
            // Ignore programmatic activations (tree reload restores the active
            // node and re-fires this) — only respond to real user clicks/keys.
            // Wunderbaum exposes the originating UI event as `originalEvent`.
            const ev = e.originalEvent || e.event;
            if (!ev || _treeReloadGuard) return;
            const id = parseInt(e.node.key, 10);
            if (!isNaN(id)) openNoteInTab(id);
        },
    });
}

/* Guard: Wunderbaum's reload() re-fires `activate` for the restored node,
   sometimes carrying an event object — which would race whatever the user
   just opened. Ignore activations while this flag is set. */
let _treeReloadGuard = false;

async function refreshTree() {
    const tree = mar10.Wunderbaum.getTree('note-tree');
    if (!tree) return;
    try {
        _notesCache = await apiListNotes();
        _treeReloadGuard = true;
        tree.reload(buildTreeSource(_notesCache));
        setTimeout(() => { _treeReloadGuard = false; }, 250);
    } catch (err) {
        console.error('Tree refresh failed:', err);
    }
}
