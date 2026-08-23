/* noteinfo.js — right-panel "Info" tab (metadata about the open note).
 *
 * Contract with the rest of the app:
 *  - editor.js's openNoteInEditor (the single choke point for note
 *    activation) calls NoteInfo.onNoteOpened(note) with the full row
 *    {id,title,content,parent_id,type,mime,created_at,updated_at,position}.
 *  - Anything that mutates display-relevant state cheaply (e.g. a rename)
 *    may call NoteInfo.refresh() — it rebuilds from caches without an
 *    API round-trip until the next full onNoteOpened fires.
 *
 * Globals consumed (defined by earlier plain scripts): escapeHtml,
 * apiListAttachments, openNoteInTab, App.currentNoteId, App.bookmarks,
 * App.currentNoteType, notePathParts, showToast.
 */
const NoteInfo = (() => {
  "use strict";

  /* boxicons class per note type; unknown types fall back to folder. */
  const TYPE_ICONS = {
    text: "bx bx-file",
    html: "bx bx-code-alt",
    page: "bx bx-window-open",
    webview: "bx bx-link-external",
    mermaid: "bx bx-git-branch",
    mindMap: "bx bx-network-chart",
    code: "bx bx-code"
  };

  function listEl() {
    return document.getElementById("info-list");
  }

  /* Locale date+time, or em-dash for missing/invalid timestamps. */
  function formatDate(value) {
    try {
      if (!value) return "\u2014";
      const d = new Date(value);
      if (isNaN(d.getTime())) return "\u2014";
      return d.toLocaleString();
    } catch (e) {
      return "\u2014";
    }
  }

  /* Build one label/value row. `valueHtml` is pre-escaped / built only
     from escaped fragments — never interpolate raw note data. */
  function row(labelText, valueHtml, testid) {
    const div = document.createElement("div");
    div.className = "info-row";
    const label = document.createElement("span");
    label.className = "info-label";
    label.textContent = labelText;
    const value = document.createElement("span");
    value.className = "info-value";
    if (testid) value.setAttribute("data-testid", testid);
    value.innerHTML = valueHtml;
    div.appendChild(label);
    div.appendChild(value);
    return div;
  }

  /* Parent breadcrumb as clickable crumb-link spans separated by ' › '.
     Root-level notes get a non-clickable "(top level)". */
  function pathValueHtml(noteId) {
    try {
      const parts = typeof notePathParts === "function" ? notePathParts(noteId) : [];
      if (!parts || !parts.length) {
        return '<span class="crumb-empty">(top level)</span>';
      }
      // parts are ancestors nearest-parent-first; render root → parent.
      const ordered = parts.slice().reverse();
      const frags = ordered.map(function (p) {
        return '<span class="crumb-link" data-id="' + Number(p.id) + '">' +
          escapeHtml(p.title || "(untitled)") + "</span>";
      });
      return frags.join(' <span class="crumb-sep">\u203a</span> ');
    } catch (e) {
      return "(top level)";
    }
  }

  /* One delegated listener handles clicks on all crumb links. */
  function bindPathClicks(container) {
    if (!container || container.dataset.pathBound) return;
    container.dataset.pathBound = "1";
    container.addEventListener("click", function (ev) {
      try {
        const target = ev.target.closest ? ev.target.closest(".crumb-link") : null;
        if (!target || !container.contains(target)) return;
        const id = Number(target.getAttribute("data-id"));
        if (!isNaN(id) && typeof openNoteInTab === "function") {
          openNoteInTab(id);
        }
      } catch (e) { /* navigation must never break rendering */ }
    });
  }

  function emptyState(msg) {
    const div = document.createElement("div");
    div.className = "empty-state-small";
    div.textContent = msg;
    return div;
  }

  /* Render everything except attachments from the synchronous row data.
     Returns true if rendered, false if the caller should bail. */
  function renderStatic(note) {
    const list = listEl();
    if (!list) return false;
    list.innerHTML = "";

    if (!note || !note.id) {
      list.appendChild(emptyState("No note selected."));
      return true;
    }

    const iconClass = TYPE_ICONS[note.type] || "bx bx-folder";

    // Title
    const titleVal = escapeHtml(note.title || "(untitled)");
    list.appendChild(row("Title", titleVal, "info-title"));

    // Type (+ mime suffix when present)
    let typeHtml = '<i class="' + iconClass + '" aria-hidden="true"></i> ' +
      escapeHtml(String(note.type || "text"));
    if (note.mime) {
      typeHtml += ' <small class="info-mime">' + escapeHtml(note.mime) + "</small>";
    }
    list.appendChild(row("Type", typeHtml, "info-type"));

    // Location breadcrumb
    list.appendChild(row("Location", pathValueHtml(note.id), "info-path"));

    // Timestamps
    list.appendChild(row("Created", escapeHtml(formatDate(note.created_at)), "info-created"));
    list.appendChild(row("Updated", escapeHtml(formatDate(note.updated_at)), "info-updated"));

    // Attachments placeholder — filled in async by loadAttachments()
    list.appendChild(row("Attachments", "\u2026", "info-attachments"));

    // Bookmark state (App.bookmarks is a Set of ids)
    let bookmarked = false;
    try {
      bookmarked = !!(App.bookmarks && App.bookmarks.has && App.bookmarks.has(Number(note.id)));
    } catch (e) { bookmarked = false; }
    list.appendChild(row(
      "Bookmark",
      bookmarked ? 'Bookmarked <span class="info-star">\u2605</span>' : "Not bookmarked",
      "info-bookmark"
    ));

    bindPathClicks(list);
    return true;
  }

  /* Async attachment count. Stale-response guard: capture the note id at
     call start and ignore results if the active note has changed since. */
  function loadAttachments(noteId, requestedId) {
    if (typeof apiListAttachments !== "function") return;
    Promise.resolve()
      .then(function () { return apiListAttachments(noteId); })
      .then(function (atts) {
        if (App.currentNoteId !== requestedId) return; // stale response
        const el = document.querySelector('[data-testid="info-attachments"]');
        if (!el) return;
        const n = Array.isArray(atts) ? atts.length : 0;
        el.textContent = n + " file(s)";
      })
      .catch(function () {
        if (App.currentNoteId !== requestedId) return;
        const el = document.querySelector('[data-testid="info-attachments"]');
        if (el) el.textContent = "\u2014";
      });
  }

  /* Called by openNoteInEditor after every real note activation. */
  function onNoteOpened(note) {
    try {
      if (!renderStatic(note)) return;
      if (note && note.id) {
        const id = Number(note.id);
        loadAttachments(id, id);
      }
    } catch (e) {
      const list = listEl();
      if (list) { list.innerHTML = ""; list.appendChild(emptyState("Could not load note info.")); }
    }
  }

  /* Cheap re-render from caches (rename etc.) until a full open fires.
     Uses the topbar title + App.currentNoteType as a minimal stub row. */
  function refresh() {
    try {
      const id = Number(App.currentNoteId);
      if (isNaN(id)) { renderStatic(null); return; }
      const topbarTitle = document.getElementById("topbar-title");
      const stub = {
        id: id,
        title: topbarTitle ? topbarTitle.textContent : "",
        type: App.currentNoteType || "text"
      };
      onNoteOpened(stub);
    } catch (e) { /* panel refresh is best-effort */ }
  }

  return { onNoteOpened: onNoteOpened, refresh: refresh };
})();
