/* outline.js — right-panel "Outline" tab (h1/h2/h3 jump list).
 *
 * Contract with the rest of the app:
 *  - editor.js's openNoteInEditor calls Outline.onNoteOpened(note) after
 *    every note activation; scheduleSave calls Outline.onContentChanged().
 *  - Tab activation (ui.js) calls Outline.refresh(), which re-extracts
 *    from the LIVE editor content — so a stale marker set while hidden
 *    resolves itself there.
 *
 * Only 'text' and 'html' notes have outlines. Clicking an item scrolls
 * the live wysiwyg editor to the matching heading (matched by index:
 * querySelectorAll order is stable between our detached parse and the
 * live DOM because both walk h1/h2/h3 in document order). No history
 * pushes, no tab switches.
 */
const Outline = (() => {
  "use strict";

  const SUPPORTED = { text: true, html: true };
  const DEBOUNCE_MS = 500;
  const MAX_HEADING_CHARS = 80;
  const FLASH_MS = 1200;

  let debounceTimer = null;
  let stale = false;           // panel was hidden during a change → refresh on next activation
  let currentType = null;      // type of the note currently shown

  function listEl() {
    return document.getElementById("outline-list");
  }

  function panelEl() {
    return document.getElementById("outline-panel");
  }

  function panelVisible() {
    try {
      const p = panelEl();
      return !!p && !p.classList.contains("hidden");
    } catch (e) {
      return false;
    }
  }

  function emptyState(msg) {
    const div = document.createElement("div");
    div.className = "empty-state-small";
    div.textContent = msg;
    return div;
  }

  /* Extract headings from an HTML string using a DETACHED element so the
     parse never touches or perturbs the live DOM. Returns
     [{level, text}] in document order, text trimmed to ~80 chars. */
  function extractHeadings(htmlContent) {
    if (!htmlContent || typeof htmlContent !== "string") return [];
    const holder = document.createElement("div");
    holder.innerHTML = htmlContent; // detached — scripts don't run here
    const nodes = holder.querySelectorAll("h1, h2, h3");
    const out = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      let text = "";
      try { text = (node.textContent || "").trim(); } catch (e) { text = ""; }
      if (!text) continue;
      if (text.length > MAX_HEADING_CHARS) text = text.slice(0, MAX_HEADING_CHARS - 1) + "\u2026";
      out.push({
        level: Number(node.tagName.charAt(1)),
        text: text
      });
    }
    return out;
  }

  /* Render [{level,text}] into #outline-list as flat indented buttons. */
  function render(headings) {
    const list = listEl();
    if (!list) return;
    list.innerHTML = "";

    if (!headings.length) {
      list.appendChild(emptyState("No headings in this note."));
      return;
    }

    for (let i = 0; i < headings.length; i++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "outline-item outline-h" + headings[i].level;
      btn.setAttribute("data-idx", String(i));
      btn.setAttribute("data-testid", "outline-item");
      btn.textContent = headings[i].text;
      list.appendChild(btn);
    }
  }

  /* Full pipeline: extract from html string then render. Any parse error
     degrades to the empty-state message rather than throwing upward. */
  function extractAndRender(htmlContent) {
    try {
      render(extractHeadings(htmlContent));
    } catch (e) {
      const list = listEl();
      if (list) {
        list.innerHTML = "";
        list.appendChild(emptyState("No headings in this note."));
      }
    }
  }

  /* Locate heading #idx in the LIVE wysiwyg DOM and scroll to it. The
     index mapping is safe: we always query h1,h2,h3 in order and skip
     nothing, same as extractHeadings does. */
  function scrollToHeading(idx) {
    try {
      const editorRoot = document.querySelector(".editor-wrap .se-wrapper-wysiwyg");
      if (!editorRoot) return;
      const nodes = editorRoot.querySelectorAll("h1, h2, h3");
      if (!nodes || idx < 0 || idx >= nodes.length) return;
      nodes[idx].scrollIntoView({ block: "start" });
      nodes[idx].classList.add("outline-flash");
      setTimeout(function () {
        try { nodes[idx].classList.remove("outline-flash"); } catch (e2) {}
      }, FLASH_MS);
    } catch (e) { /* jump is best-effort */ }
  }

  /* Single delegated click listener for all outline items. */
  function bindClicks() {
    const list = listEl();
    if (!list || list.dataset.outlineBound) return;
    list.dataset.outlineBound = "1";
    list.addEventListener("click", function (ev) {
      try {
        const btn = ev.target.closest ? ev.target.closest(".outline-item") : null;
        if (!btn || !list.contains(btn)) return;
        const idx = Number(btn.getAttribute("data-idx"));
        if (!isNaN(idx)) scrollToHeading(idx);
      } catch (e) { /* never break the click handler */ }
    });
  }

  function currentEditorHtml() {
    try {
      return typeof editorGetContent === "function" ? (editorGetContent() || "") : "";
    } catch (e) {
      return "";
    }
  }

  /* Debounced hook called by scheduleSave on every keystroke-driven save.
     Skips entirely when the panel is hidden (stale flag covers it later)
     or the note type isn't outlinable. */
  function onContentChanged() {
    if (!SUPPORTED[currentType]) return;
    if (!panelVisible()) { stale = true; return; }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      if (!panelVisible()) { stale = true; return; }
      extractAndRender(currentEditorHtml());
    }, DEBOUNCE_MS);
  }

  /* Called by openNoteInEditor after every note activation. Refreshes
     immediately when visible; otherwise marks stale for next activation. */
  function onNoteOpened(note) {
    try {
      currentType = note && note.type ? note.type : null;
      if (!SUPPORTED[currentType]) {
        currentType = null;
        const list = listEl();
        if (list) {
          list.innerHTML = "";
          list.appendChild(emptyState("Outline unavailable for this note type."));
        }
        return;
      }
      if (panelVisible()) {
        stale = false;
        refresh();
      } else {
        stale = true;
      }
    } catch (e) { /* outline must never break note opening */ }
  }

  /* Re-extract from the LIVE editor content. Safe to call anytime; used
     on tab activation and right after onNoteOpened. */
  function refresh() {
    try {
      bindClicks();
      if (!SUPPORTED[App.currentNoteType]) {
        currentType = null;
        const list = listEl();
        if (list) {
          list.innerHTML = "";
          list.appendChild(emptyState("Outline unavailable for this note type."));
        }
        return;
      }
      currentType = App.currentNoteType;
      stale = false;
      extractAndRender(currentEditorHtml());
    } catch (e) { /* best-effort */ }
  }

  return {
    onNoteOpened: onNoteOpened,
    onContentChanged: onContentChanged,
    refresh: refresh
  };
})();
