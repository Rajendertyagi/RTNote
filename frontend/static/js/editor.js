/* editor.js — note views by type: SunEditor (text), Mermaid source+preview,
   MindElixir canvas. Includes debounced auto-save with per-type serializers.
   (Trilium renders each note type through its own widget; our equivalent is
   the view switch below.) */

let saveTimeout = null;

/* ── View switching ───────────────────────────────────────────── */
const TYPE_VIEWS = ['editor-wrap', 'view-mermaid', 'view-mindmap', 'view-page'];

function showTypeView(viewId) {
    TYPE_VIEWS.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', id !== viewId);
    });
}

function initEditor() {
    if (typeof SUNEDITOR === 'undefined') {
        console.error('SunEditor unavailable');
        return;
    }
    App.editor = SUNEDITOR.create('#note-editor', {
        plugins: SUNEDITOR.plugins,
        mode: 'classic',
        toolbar_sticky: 0,
        height: '100%',
        placeholder: 'Start writing your note...',
        buttonList: [
            ['undo', 'redo'],
            ['bold', 'italic', 'underline', 'strike'],
            ['fontColor', 'backgroundColor'],
            ['align', 'list', 'lineHeight'],
            ['table', 'link', 'image'],
            ['codeView', 'fullScreen'],
        ],
        // P3: pasted/dropped/picked images upload to the current note and are
        // embedded as <img src="/api/attachments/{id}/image"> — Trilium's flow.
        onImageUpload: async function (files, uploadHandler) {
            if (!App.currentNoteId) {
                uploadHandler({ errorMessage: 'Open a note before adding images' });
                showToast('Open a note first', 'error');
                return;
            }
            try {
                const result = [];
                for (const f of files) {
                    const att = await apiUploadAttachment(App.currentNoteId, f);
                    if (!att.inline) throw new Error(att.filename + ' is not an image');
                    result.push({ url: att.url, name: att.filename, size: att.size });
                }
                uploadHandler({ result: result });
                showToast('Image uploaded', 'success');
            } catch (err) {
                uploadHandler({ errorMessage: err.message });
                showToast(err.message, 'error');
            }
        },
    });

    // Debounced auto-save on any typing inside the rich-text area
    const wrap = document.getElementById('editor-wrap');
    if (wrap) {
        wrap.addEventListener('input', () => scheduleSave());
    }

    fitEditorToPane();
    if (typeof ResizeObserver !== 'undefined' && wrap) {
        new ResizeObserver(fitEditorToPane).observe(wrap);
    }
    window.addEventListener('resize', fitEditorToPane);

    initMermaidView();
    initMindMapView();
    initPageView();
}

/* Size SunEditor's content wrapper to exactly fill the pane below the toolbar,
   independent of SunEditor's internal DOM structure. */
function fitEditorToPane() {
    const wrap = document.getElementById('editor-wrap');
    if (!wrap || wrap.classList.contains('hidden')) return;
    const w = wrap.querySelector('.se-wrapper');
    if (!w) return;
    const offset = w.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
    const h = Math.max(200, wrap.clientHeight - offset);
    w.style.height = h + 'px';
}

/* ── Content serialization per type ──────────────────────────── */
function getContentForType(type) {
    if (type === 'mermaid') {
        const src = document.getElementById('mermaid-src');
        return src ? src.value : '';
    }
    if (type === 'mindMap') {
        return getMindMapData();
    }
    if (type === 'page') {
        const src = document.getElementById('page-src');
        return src ? src.value : '';
    }
    return editorGetContent(); // text/html/webview
}

/* ── Defensive content access — works even if instance API differs */
function editorGetContent() {
    if (!App.editor) return '';
    try { return App.editor.getContents(); } catch (e) { /* fall through */ }
    const wysiwyg = document.querySelector('.editor-wrap .se-wrapper-wysiwyg');
    return wysiwyg ? wysiwyg.innerHTML : '';
}

function editorSetContent(html) {
    if (!App.editor) return;
    try { App.editor.setContents(html || ''); return; } catch (e) { /* fall through */ }
    const wysiwyg = document.querySelector('.editor-wrap .se-wrapper-wysiwyg');
    if (wysiwyg) wysiwyg.innerHTML = html || '';
}

function setTopbar(title) {
    const t = document.getElementById('topbar-title');
    const b = document.getElementById('topbar-breadcrumb');
    if (t) t.textContent = title;
    if (b) b.textContent = title;
}

async function openNoteInEditor(noteId) {
    try {
        const note = await apiGetNote(noteId);
        App.currentNoteId = note.id;
        App.currentNoteType = note.type || 'text';
        setTopbar(note.title);
        updateTabTitle(note.id, note.title);
        updateBookmarkStar();

        if (App.currentNoteType === 'mermaid') {
            showTypeView('view-mermaid');
            loadMermaid(note.content || '');
        } else if (App.currentNoteType === 'mindMap') {
            showTypeView('view-mindmap');
            loadMindMap(note.content || '');
        } else if (App.currentNoteType === 'page') {
            showTypeView('view-page');
            loadPage(note.content || '');
        } else {
            showTypeView('editor-wrap');
            editorSetContent(note.content || '');
            fitEditorToPane();
        }
    } catch (err) {
        console.error('Failed to load note:', err);
        showToast('Failed to load note', 'error');
    }
}

function scheduleSave() {
    if (!App.currentNoteId) return;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveNoteNow, 800);
}

async function saveNoteNow() {
    if (!App.currentNoteId) return;
    const content = getContentForType(App.currentNoteType || 'text');
    try {
        await apiUpdateNote(App.currentNoteId, { content: content });
        showToast('Note saved', 'success');
    } catch (err) {
        console.error('Save failed:', err);
        showToast('Save failed', 'error');
    }
}

async function createNewNote(type) {
    try {
        const note = await apiCreateNote('Untitled Note', null, type || 'text');
        await refreshTree();
        await openNoteInTab(note.id);
        showToast('New note created', 'success');
    } catch (e) {
        console.error(e);
        alert('Failed to create note: ' + e.message);
    }
}

/* ═══════════════════════════════════════════════════════════════
   F15 — Mermaid diagrams: source textarea + live SVG preview.
   (Trilium: mermaid note type, mime text/vnd.mermaid)
   ═══════════════════════════════════════════════════════════════ */
let _mermaidReady = false;
let _mermaidRenderTimer = null;

function initMermaidView() {
    const src = document.getElementById('mermaid-src');
    if (!src) return;
    src.addEventListener('input', () => {
        scheduleSave();
        clearTimeout(_mermaidRenderTimer);
        _mermaidRenderTimer = setTimeout(renderMermaidPreview, 500);
    });
}

function ensureMermaid() {
    if (typeof mermaid === 'undefined') return false;
    if (!_mermaidReady) {
        const theme = String(document.documentElement.dataset.theme || '').includes('light')
            ? 'default' : 'dark';
        mermaid.initialize({ startOnLoad: false, theme: theme, securityLevel: 'strict' });
        _mermaidReady = true;
    }
    return true;
}

function loadMermaid(content) {
    const src = document.getElementById('mermaid-src');
    if (src) src.value = content;
    clearTimeout(_mermaidRenderTimer);
    _mermaidRenderTimer = setTimeout(renderMermaidPreview, 200);
}

async function renderMermaidPreview() {
    const preview = document.getElementById('mermaid-preview');
    const src = document.getElementById('mermaid-src');
    if (!preview || !src) return;
    const code = src.value.trim();
    if (!code) { preview.innerHTML = '<div class="empty-state-small">Diagram source is empty</div>'; return; }
    if (!ensureMermaid()) {
        preview.innerHTML = '<div class="empty-state-small">Mermaid library unavailable</div>';
        return;
    }
    try {
        const { svg } = await mermaid.render('mmd-' + Date.now(), code);
        preview.innerHTML = svg;
    } catch (err) {
        preview.innerHTML = '<div class="mermaid-error">' + escapeHtml(String(err.message || err)) + '</div>';
    }
}

/* ═══════════════════════════════════════════════════════════════
   F16 — Mind maps via MindElixir; content = its JSON document.
   (Trilium: mindMap note type, mime application/json)
   ═══════════════════════════════════════════════════════════════ */
let _mindMap = null;

function initMindMapView() {
    /* instance created lazily on first open (needs visible container) */
}

function loadMindMap(content) {
    const el = document.getElementById('mindmap-el');
    if (!el || typeof MindElixir === 'undefined') {
        showToast('Mind map library unavailable', 'error');
        return;
    }

    let data;
    try {
        data = content ? JSON.parse(content) : null;
    } catch (e) {
        console.warn('Corrupt mind map content, starting fresh');
        data = null;
    }
    if (!data || !data.nodeData) {
        data = MindElixir.new('Central idea');
    }

    if (_mindMap) {
        try { _mindMap.destroy?.(); } catch (e) { /* older builds: drop reference */ }
        _mindMap = null;
    }

    _mindMap = new MindElixir({
        el: el,
        direction: MindElixir.SIDE,
        draggable: true,
        contextMenu: true,
        toolbars: true,
        nodeMenu: true,
        keypress: true,
        locale: 'en',
    });
    _mindMap.init(data);

    // Any structural/edit operation → schedule save (v4 bus event: 'operation')
    _mindMap.bus.addListener('operation', () => scheduleSave());
}

function getMindMapData() {
    if (!_mindMap) return '';
    try {
        return JSON.stringify({
            nodeData: _mindMap.nodeData,
            arrows: _mindMap.arrows || [],
            summaries: _mindMap.summaries || [],
        });
    } catch (e) {
        console.error('Mind map serialize failed:', e);
        return '';
    }
}

/* ═══════════════════════════════════════════════════════════════
   F1 — Custom HTML pages: source editor + sandboxed live preview.
   (Trilium's render note, simplified: content IS the HTML.)
   Preview loads /api/notes/{id}/raw inside an iframe whose `sandbox`
   attribute (opaque origin) blocks all access to app data/DOM while
   still allowing scripts, CDN libraries, modals and forms.
   ═══════════════════════════════════════════════════════════════ */
let _pageRenderTimer = null;

function initPageView() {
    const src = document.getElementById('page-src');
    if (!src) return;
    src.addEventListener('input', () => {
        scheduleSave();
        clearTimeout(_pageRenderTimer);
        _pageRenderTimer = setTimeout(refreshPagePreview, 600);
    });
}

function loadPage(content) {
    const src = document.getElementById('page-src');
    if (src) src.value = content;
    clearTimeout(_pageRenderTimer);
    _pageRenderTimer = setTimeout(refreshPagePreview, 200);
}

function refreshPagePreview() {
    const frame = document.getElementById('page-preview');
    const src = document.getElementById('page-src');
    if (!frame || !src) return;
    if (!src.value.trim()) {
        frame.src = 'about:blank';
        return;
    }
    // Cache-bust so every edit cycle reloads fresh HTML
    frame.src = '/api/notes/' + App.currentNoteId + '/raw?v=' + Date.now();
}
