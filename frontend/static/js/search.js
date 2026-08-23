/* search.js — Ctrl+K quick search overlay + sidebar inline search */

let quickSearchDebounce = null;
let quickSearchResults = [];
let quickSearchIndex = -1;

function openQuickSearch() {
    const overlay = document.getElementById('quickSearchOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    const inp = document.getElementById('quickSearchInput');
    if (inp) { inp.value = ''; inp.focus(); }
    renderRecentNotes();
    quickSearchResults = [];
    quickSearchIndex = -1;
}

/* Empty-query state: recently visited notes (jump-to-note, Trilium's
   Ctrl+J pattern merged into our existing Ctrl+K overlay). */
function renderRecentNotes() {
    const container = document.getElementById('quickSearchResults');
    if (!container) return;
    const ids = (typeof NavHistory !== 'undefined') ? NavHistory.recent(8) : [];
    if (!ids.length) {
        container.innerHTML = '<div class="qs-empty">Type to search notes…</div>';
        return;
    }
    container.innerHTML = ids.map((id) => {
        const title = (typeof noteTitleById === 'function') ? noteTitleById(id) : ('Note ' + id);
        const path = (typeof notePathParts === 'function')
            ? notePathParts(id).map((p) => p.title).join(' › ') : '';
        return '<div class="qs-result" data-id="' + id + '">' +
            '<div class="qs-result-title">' + escapeHtml(title) + '</div>' +
            '<div class="qs-result-path">' + escapeHtml(path) + '</div></div>';
    }).join('');
    container.querySelectorAll('.qs-result').forEach((el) => {
        el.addEventListener('click', () => {
            openNoteInTab(parseInt(el.dataset.id, 10));
            closeQuickSearch();
        });
    });
}

function closeQuickSearch() {
    const overlay = document.getElementById('quickSearchOverlay');
    if (overlay) overlay.classList.add('hidden');
    quickSearchResults = [];
    quickSearchIndex = -1;
}

function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const regex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return escaped.replace(regex, '<mark>$1</mark>');
}

function resultHtml(r, query, withIndex) {
    return '<div class="qs-result"' + (withIndex ? ' data-index="' + r._i + '"' : '') + ' data-id="' + r.id + '">' +
        '<div class="qs-result-title">' + highlightMatch(r.title, query) + '</div>' +
        '<div class="qs-result-path">' + escapeHtml(r.path || '') + '</div>' +
        '<div class="qs-result-snippet">' + escapeHtml(r.snippet || '') + '</div>' +
        '</div>';
}

function renderQuickResults(results, query) {
    const container = document.getElementById('quickSearchResults');
    if (!results.length) { container.innerHTML = '<div class="qs-empty">No notes found</div>'; return; }
    container.innerHTML = results
        .map((r, i) => { r._i = i; return resultHtml(r, query, true); })
        .join('');
    container.querySelectorAll('.qs-result').forEach((el) => {
        el.addEventListener('click', () => {
            openNoteInTab(parseInt(el.dataset.id, 10));
            closeQuickSearch();
        });
    });
}

function highlightQuickResult() {
    const items = document.querySelectorAll('.quick-search-results .qs-result');
    items.forEach((el) => el.classList.remove('qs-active'));
    if (quickSearchIndex >= 0 && items[quickSearchIndex]) {
        items[quickSearchIndex].classList.add('qs-active');
        items[quickSearchIndex].scrollIntoView({ block: 'nearest' });
    }
}

function renderSidebarResults(results, query) {
    const container = document.getElementById('searchResults');
    if (!results.length) { container.innerHTML = '<div class="qs-empty">No results</div>'; return; }
    container.innerHTML = results.map((r) => resultHtml(r, query, false)).join('');
    container.querySelectorAll('.qs-result').forEach((el) => {
        el.addEventListener('click', () => {
            openNoteInTab(parseInt(el.dataset.id, 10));
            document.getElementById('searchInput').value = '';
            container.classList.add('hidden');
            document.getElementById('note-tree').classList.remove('hidden');
        });
    });
}

function initSearch() {
    /* Quick search input */
    const qsInput = document.getElementById('quickSearchInput');
    if (qsInput) {
        qsInput.addEventListener('input', function () {
            clearTimeout(quickSearchDebounce);
            const q = this.value.trim();
            if (!q) {
                renderRecentNotes(); // back to the recent-notes jump list
                quickSearchResults = [];
                quickSearchIndex = -1;
                return;
            }
            quickSearchDebounce = setTimeout(async () => {
                try {
                    const results = await apiSearch(q);
                    // Title matches first — jump-to-note intent outranks
                    // content matches (small client-side ranking only).
                    const ql = q.toLowerCase();
                    results.sort((a, b) =>
                        (b.title.toLowerCase().includes(ql) ? 1 : 0) -
                        (a.title.toLowerCase().includes(ql) ? 1 : 0));
                    quickSearchResults = results;
                    quickSearchIndex = -1;
                    renderQuickResults(quickSearchResults, q);
                } catch (e) {
                    document.getElementById('quickSearchResults').innerHTML = '<div class="qs-empty">Search failed</div>';
                }
            }, 150);
        });

        qsInput.addEventListener('keydown', (e) => {
            if (!quickSearchResults.length) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                quickSearchIndex = Math.min(quickSearchIndex + 1, quickSearchResults.length - 1);
                highlightQuickResult();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                quickSearchIndex = Math.max(quickSearchIndex - 1, 0);
                highlightQuickResult();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                // Enter with no explicit selection opens the first result
                const idx = quickSearchIndex >= 0 ? quickSearchIndex : 0;
                if (quickSearchResults[idx]) {
                    openNoteInTab(parseInt(quickSearchResults[idx].id, 10));
                    closeQuickSearch();
                }
            }
        });
    }

    /* Overlay click-outside closes */
    const overlay = document.getElementById('quickSearchOverlay');
    if (overlay) {
        overlay.addEventListener('click', function (e) {
            if (e.target === this) closeQuickSearch();
        });
    }

    /* Sidebar search */
    const sidebarInput = document.getElementById('searchInput');
    if (sidebarInput) {
        let sd = null;
        sidebarInput.addEventListener('input', function () {
            clearTimeout(sd);
            const q = this.value.trim();
            const resultsEl = document.getElementById('searchResults');
            const treeEl = document.getElementById('note-tree');
            if (!q) { resultsEl.classList.add('hidden'); treeEl.classList.remove('hidden'); return; }
            resultsEl.classList.remove('hidden');
            treeEl.classList.add('hidden');
            sd = setTimeout(async () => {
                try {
                    renderSidebarResults(await apiSearch(q), q);
                } catch (e) {
                    resultsEl.innerHTML = '<div class="qs-empty">Error</div>';
                }
            }, 200);
        });
    }

    /* Global keyboard shortcuts */
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            openQuickSearch();
        }
        if (e.key === 'Escape') closeQuickSearch();
    });
}
