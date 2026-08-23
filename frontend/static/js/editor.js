/* editor.js — note views by type: SunEditor (text), Mermaid source+preview,
   MindElixir canvas. Includes debounced auto-save with per-type serializers.
   (Trilium renders each note type through its own widget; our equivalent is
   the view switch below.) */

let saveTimeout = null;

/* ── View switching ───────────────────────────────────────────── */
/* TYPE_VIEWS is the SINGLE owner of main-pane visibility. Every view
   (including table-view) must route through showTypeView so views stay
   mutually exclusive. */
const TYPE_VIEWS = ['editor-wrap', 'view-mermaid', 'view-mindmap', 'view-page', 'view-code', 'table-view'];

function showTypeView(viewId) {
    TYPE_VIEWS.forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', id !== viewId);
    });
}

/* Map a note type to its view container id. */
function viewIdForType(type) {
    switch (type) {
        case 'mermaid': return 'view-mermaid';
        case 'mindMap': return 'view-mindmap';
        case 'page': return 'view-page';
        case 'code': return 'view-code';
        default: return 'editor-wrap'; // text/html/webview
    }
}

function initEditor() {
    if (typeof SUNEDITOR === 'undefined') {
        console.error('SunEditor unavailable');
        return;
    }
    App.editor = SUNEDITOR.create('#note-editor', {
        // Keep the full registry but drop the five plugins whose required
        // options we never provide (exportPDF/fileUpload/layout/template/math)
        // — they log a warning each on every load otherwise.
        plugins: SUNEDITOR.plugins,
        excludedPlugins: ['exportPDF', 'fileUpload', 'layout', 'template', 'math'],
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
    initCodeView();
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
    if (type === 'code') {
        return getCodeContent();
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
    if (t) t.textContent = title;
}

async function openNoteInEditor(noteId) {
    try {
        const note = await apiGetNote(noteId);
        App.currentNoteId = note.id;
        App.currentNoteType = note.type || 'text';
        tableViewOn = false; // opening a note always returns to its own view
        setTopbar(note.title);
        setSaveState('ready');
        updateTabTitle(note.id, note.title);
        updateBookmarkStar();

        /* Navigation coordination (GUI-2): openNoteInEditor is the single
           choke point every entry path flows through — tree click, search,
           breadcrumb, history, tab restore — so history recording and tree
           sync live here and nowhere else. */
        if (typeof NavHistory !== 'undefined') NavHistory.push(note.id);
        if (typeof navUpdateButtons === 'function') navUpdateButtons();
        if (typeof renderBreadcrumb === 'function') renderBreadcrumb(note.id);
        if (typeof revealNoteInTree === 'function') revealNoteInTree(note.id);
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
        } else if (App.currentNoteType === 'code') {
            showTypeView('view-code');
            loadCodeNote(note);
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
    setSaveState('dirty');
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveNoteNow, 800);
}

/* ── Save-state feedback (status bar, not toasts) ───────────────
   dirty → saving → saved | error. The error state is clickable
   (retries the save); success never fires a toast — autosave runs
   constantly and toasts would be noise. */
function setSaveState(state) {
    const el = document.getElementById('status-left');
    if (!el) return;
    el.classList.remove('st-dirty', 'st-saving', 'st-saved', 'st-error');
    /* Tab modified indicator shares the same lifecycle (GUI-3) */
    if (typeof markTabDirty === 'function') {
        markTabDirty(App.currentNoteId, state === 'dirty' || state === 'error' || state === 'saving');
    }
    switch (state) {
        case 'dirty':  el.textContent = 'Unsaved changes'; el.classList.add('st-dirty'); break;
        case 'saving': el.textContent = 'Saving…'; el.classList.add('st-saving'); break;
        case 'saved':  el.textContent = 'Saved ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); el.classList.add('st-saved'); break;
        case 'error':  el.textContent = 'Save failed — click to retry'; el.classList.add('st-error'); break;
        default:       el.textContent = 'Ready';
    }
}

async function saveNoteNow() {
    if (!App.currentNoteId) return;
    setSaveState('saving');
    const content = getContentForType(App.currentNoteType || 'text');
    try {
        await apiUpdateNote(App.currentNoteId, { content: content });
        setSaveState('saved');
    } catch (err) {
        console.error('Save failed:', err);
        setSaveState('error');
        showToast('Save failed', 'error');
    }
}

async function createNewNote(type) {
    await App.bootReady; // never race the boot-time tab restore
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

/* MindElixir is an async ESM CDN import — wait for its ready event like
   CodeMirror's cm6-ready handshake, with a timeout so a failed CDN load
   produces a controlled error instead of an empty canvas forever. */
function ensureMindElixir() {
    if (window.MindElixir) return Promise.resolve(true);
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 10000);
        window.addEventListener('mindelixir-ready', () => {
            clearTimeout(timer);
            resolve(true);
        }, { once: true });
    });
}

async function loadMindMap(content) {
    const el = document.getElementById('mindmap-el');
    if (!el) return;

    if (!(await ensureMindElixir())) {
        el.innerHTML = '<div class="empty-state-small">Mind map library failed to load — check your connection and reopen the note.</div>';
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

/* ═══════════════════════════════════════════════════════════════
   F4/F2 — Code notes via CodeMirror 6 (loaded as ES modules in
   index.html; language modes imported lazily per mime).
   mime text/html gets a sandboxed live preview (F2 html code notes,
   same isolation model as F1 pages: no allow-same-origin).
   ═══════════════════════════════════════════════════════════════ */
const CODE_MIMES = [
    'text/plain', 'text/x-python', 'text/javascript', 'application/typescript',
    'application/json', 'text/css', 'text/html', 'text/x-markdown',
    'text/x-sql', 'text/xml', 'text/x-yaml', 'text/x-sh',
    'text/x-csrc', 'text/x-c++src', 'text/x-csharp', 'text/x-java',
    'text/x-go', 'text/x-rust',
];
const MIME_LABELS = {
    'text/plain': 'Plain text', 'text/x-python': 'Python', 'text/javascript': 'JavaScript',
    'application/typescript': 'TypeScript', 'application/json': 'JSON', 'text/css': 'CSS',
    'text/html': 'HTML', 'text/x-markdown': 'Markdown', 'text/x-sql': 'SQL',
    'text/xml': 'XML', 'text/x-yaml': 'YAML', 'text/x-sh': 'Shell',
    'text/x-csrc': 'C', 'text/x-c++src': 'C++', 'text/x-csharp': 'C#',
    'text/x-java': 'Java', 'text/x-go': 'Go', 'text/x-rust': 'Rust',
};

let _cmView = null;
let _cmMime = null;
let _cmWrap = false;
/* Compartments let us hot-swap language/wrapping without rebuilding the view */
let _cmLangCompartment = null;
let _cmWrapCompartment = null;

function initCodeView() {
    const sel = document.getElementById('code-mime');
    if (!sel) return;

    for (const m of CODE_MIMES) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = MIME_LABELS[m] || m;
        sel.appendChild(opt);
    }

    sel.addEventListener('change', async () => {
        _cmMime = sel.value;
        await applyCodeLanguage();
        updateCodePreviewButton();
        scheduleSaveMime();
    });

    document.getElementById('code-wrap').addEventListener('change', (e) => {
        _cmWrap = e.target.checked;
        rebuildCodeEditor();
    });

    document.getElementById('code-preview-btn').addEventListener('click', () => {
        const frame = document.getElementById('code-preview');
        frame.classList.toggle('hidden');
        document.getElementById('code-editor-host').classList.toggle('split');
        refreshCodePreview();
    });
}

/* CodeMirror 6 is loaded LAZILY on first code-note open — never at boot.
   (Module scripts delay DOMContentLoaded until their import graph resolves;
   boot-time CDN imports would stall the whole app on a slow network.)
   The `codemirror` meta-package resolves to a UMD build on esm.sh, so
   basicSetup is composed from the scoped packages instead. */
let _cm6Promise = null;

function ensureCM6() {
    if (window.CodeMirror6) return Promise.resolve();
    if (!_cm6Promise) _cm6Promise = _loadCM6();
    return _cm6Promise;
}

async function _loadCM6() {
    const { EditorView } = await import('https://esm.sh/@codemirror/view@6');
    const { EditorState, Compartment } = await import('https://esm.sh/@codemirror/state@6');
    const { defaultKeymap, history, historyKeymap } = await import('https://esm.sh/@codemirror/commands@6');
    const { foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle,
            bracketMatching, StreamLanguage } = await import('https://esm.sh/@codemirror/language@6');
    const { closeBrackets } = await import('https://esm.sh/@codemirror/autocomplete@6');
    const { searchKeymap, highlightSelectionMatches } = await import('https://esm.sh/@codemirror/search@6');
    const { oneDark } = await import('https://esm.sh/@codemirror/theme-one-dark@6');

    const basicSetup = [
        lineNumbers(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        bracketMatching(), closeBrackets(),
        highlightSelectionMatches(), rectangularSelection(), crosshairCursor(),
        foldGutter(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    ];
    const langs = {
        'text/x-python':     () => import('https://esm.sh/@codemirror/lang-python@6').then(m => m.python()),
        'text/javascript':   () => import('https://esm.sh/@codemirror/lang-javascript@6').then(m => m.javascript()),
        'application/typescript': () => import('https://esm.sh/@codemirror/lang-javascript@6').then(m => m.javascript({ typescript: true })),
        'application/json':  () => import('https://esm.sh/@codemirror/lang-json@6').then(m => m.json()),
        'text/css':          () => import('https://esm.sh/@codemirror/lang-css@6').then(m => m.css()),
        'text/html':         () => import('https://esm.sh/@codemirror/lang-html@6').then(m => m.html()),
        'text/x-markdown':   () => import('https://esm.sh/@codemirror/lang-markdown@6').then(m => m.markdown()),
        'text/x-sql':        () => import('https://esm.sh/@codemirror/lang-sql@6').then(m => m.sql()),
        'text/xml':          () => import('https://esm.sh/@codemirror/lang-xml@6').then(m => m.xml()),
        'text/x-yaml':       () => import('https://esm.sh/@codemirror/lang-yaml@6').then(m => m.yaml()),
        'text/x-sh':         () => import('https://esm.sh/@codemirror/legacy-modes@6/mode/shell').then(m => StreamLanguage.define(m.shell)),
        'text/x-csrc':       async () => _clike('c'),
        'text/x-c++src':     async () => _clike('c++'),
        'text/x-csharp':     async () => _clike('csharp'),
        'text/x-java':       async () => _clike('java'),
        'text/x-go':         () => import('https://esm.sh/@codemirror/legacy-modes@6/mode/go').then(m => StreamLanguage.define(m.go)),
        'text/x-rust':       () => import('https://esm.sh/@codemirror/legacy-modes@6/mode/rust').then(m => StreamLanguage.define(m.rust)),
    };
    async function _clike(dialect) {
        const { c, cpp, csharp, java } = await import('https://esm.sh/@codemirror/legacy-modes@6/mode/clike');
        return StreamLanguage.define({ c, 'c++': cpp, csharp, java }[dialect]);
    }
    window.CodeMirror6 = { EditorView, EditorState, Compartment, basicSetup, oneDark, langs };
}

function isDarkTheme() {
    return !String(document.documentElement.dataset.theme || '').includes('light');
}

async function loadCodeNote(note) {
    const sel = document.getElementById('code-mime');
    _cmMime = note.mime && CODE_MIMES.includes(note.mime) ? note.mime : 'text/plain';
    sel.value = _cmMime;
    updateCodePreviewButton();
    await ensureCM6();
    await buildCodeEditor(note.content || '');
}

async function buildCodeEditor(docText) {
    const { EditorView, EditorState, Compartment, basicSetup, oneDark } = window.CodeMirror6;
    const host = document.getElementById('code-editor-host');

    if (_cmView) { _cmView.destroy(); _cmView = null; }

    _cmLangCompartment = new Compartment();
    _cmWrapCompartment = new Compartment();

    const extensions = [
        basicSetup,
        _cmWrapCompartment.of(_cmWrap ? EditorView.lineWrapping : []),
        ...(isDarkTheme() ? [oneDark] : []),
        _cmLangCompartment.of((await loadCodeLanguage(_cmMime)) || []),
        EditorView.updateListener.of((update) => {
            if (update.docChanged) scheduleSave();
        }),
    ];

    _cmView = new EditorView({
        state: EditorState.create({ doc: docText, extensions }),
        parent: host,
    });
}

/* Swap only the language extension via its compartment */
async function applyCodeLanguage() {
    if (!_cmView) return;
    const langExt = (await loadCodeLanguage(_cmMime)) || [];
    _cmView.dispatch({ effects: _cmLangCompartment.reconfigure(langExt) });
}

function rebuildCodeEditor() {
    if (!_cmView) return;
    const doc = getCodeContent();
    _cmView.dispatch({
        effects: _cmWrapCompartment.reconfigure(_cmWrap ? window.CodeMirror6.EditorView.lineWrapping : []),
    });
}

async function loadCodeLanguage(mime) {
    const loader = window.CodeMirror6.langs[mime];
    if (!loader) return null;
    try { return await loader(); } catch (e) { console.warn('CM6 language load failed:', e); return null; }
}

function getCodeContent() {
    return _cmView ? _cmView.state.doc.toString() : '';
}

function updateCodePreviewButton() {
    const btn = document.getElementById('code-preview-btn');
    if (!btn) return;
    btn.classList.toggle('hidden', _cmMime !== 'text/html');
    if (_cmMime !== 'text/html') {
        document.getElementById('code-preview').classList.add('hidden');
        document.getElementById('code-editor-host').classList.remove('split');
    }
}

function refreshCodePreview() {
    const frame = document.getElementById('code-preview');
    if (!frame || frame.classList.contains('hidden')) return;
    // srcdoc keeps everything self-contained; the sandbox attribute (no
    // allow-same-origin) is the security boundary, exactly like F1 pages.
    frame.srcdoc = getCodeContent();
}

let _mimeSaveTimer = null;
function scheduleSaveMime() {
    if (!App.currentNoteId) return;
    clearTimeout(_mimeSaveTimer);
    _mimeSaveTimer = setTimeout(async () => {
        try {
            await apiUpdateNote(App.currentNoteId, { mime: _cmMime });
            showToast('Language saved', 'success');
        } catch (err) {
            showToast('Failed to save language', 'error');
        }
    }, 400);
}
