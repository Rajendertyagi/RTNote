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
async function initTree() {
    const el = document.getElementById('note-tree');
    if (!el || typeof mar10 === 'undefined' || !mar10.Wunderbaum) {
        console.error('Wunderbaum unavailable');
        return;
    }

    let source = [];
    try {
        source = buildTreeSource(await apiListNotes());
    } catch (err) {
        console.error('Failed to load notes for tree:', err);
    }

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
            if (!e.event || _treeReloadGuard) return;
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
        const notes = await apiListNotes();
        _treeReloadGuard = true;
        tree.reload(buildTreeSource(notes));
        setTimeout(() => { _treeReloadGuard = false; }, 250);
    } catch (err) {
        console.error('Tree refresh failed:', err);
    }
}
