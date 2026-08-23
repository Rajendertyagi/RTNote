# Implementation Plan — F4+F2 Code Notes, F3 Webview, P4a Revisions, P4b Export

> Study source: TriliumNext/Trilium monorepo (`packages/trilium-core`, `apps/client`), verified 2026-08-23.
> Decisions locked with user: **skip P4c protected notes for now** · editor = **CodeMirror 6** (esm.sh ESM) ·
> MD export = **server-side markdownify** · order: code → webview → revisions → export.

---

## Phase 0 — Cleanups

1. `frontend/static/js/editor.js`: replace `plugins: SUNEDITOR.plugins` with an explicit whitelist
   matching our `buttonList` (undo/redo, font, align/list/lineHeight, table/link/image,
   codeView/fullScreen) — silences the 5 console warnings (exportPDF/fileUpload/layout/template/math).
2. Restart server; confirm `GET /api/chat/models` returns 200 (route is correctly wired in
   `app/chat/models.py` + registered in `app/routes/__init__.py`; earlier 404 was a stale process).

## Phase 1 — F4+F2: Code notes (CodeMirror 6)

Trilium fact: "HTML code note" is just a code note with `mime=text/html` — F2 folds into F4.

### Backend
- `app/routes/notes.py`: add `"code"` to `NOTE_TYPES`; accept `mime` on create/update when
  type=code, validated against a curated list ported from Trilium's `codeNotesMimeTypes`
  (python, javascript/typescript, json, css, html, markdown, sql, xml, yaml, sh, c/cpp/csharp/
  java/go/rust…). Default mime `text/plain`.

### Frontend
- `index.html`: `<script type="module">` importing `EditorView` + `basicSetup` from
  `https://esm.sh/codemirror@6` (verified reachable), exposing `window.CodeMirror6`;
  language packages imported lazily per mime (`@codemirror/lang-python`, `-javascript`,
  `-json`, `-css`, `-html`, `-markdown`, `-sql`, `-xml`, `-yaml`; legacy-modes for sh/c-family);
  theme = oneOf(vscodeDark, vscodeLight) matched to app theme.
- New `#view-code` container: CM host + toolbar (mime badge, wrap toggle, **Preview** button only
  when mime=text/html).
- HTML preview reuses F1's sandboxed iframe pattern (`srcdoc`,
  `sandbox="allow-scripts allow-modals allow-forms"`, no allow-same-origin).
- `editor.js`: dispatch branches in `showTypeView` / `openNoteInEditor` / `getContentForType`;
  autosave via CM update listener → existing debounced `scheduleSave`.
- Type picker entry "Code note"; tree icon `bx-code`.

### Tests
Create/update code notes; mime validation (400 on unknown); html preview raw route unchanged.

## Phase 2 — F3: Webview notes

Trilium reference: URL stored as label `webViewSrc`, setup form validates with `new URL()`,
browser mode renders `<iframe sandbox="allow-same-origin allow-scripts allow-popups">`
(safe because embedded page is a remote origin).

- Add `"webview"` to `NOTE_TYPES`. Content stores the URL.
- Frontend: setup form shown when content empty → validate http(s) URL → save as content →
  render sandboxed iframe + "Edit URL" button back to form.
- Type picker entry "Web view"; tree icon `bx-globe`.
- Tests: webview CRUD; URL validation.

## Phase 3 — P4a: Revisions

Trilium verified rule (`saveRevisionIfNeeded` in `services/notes.ts`): on every content/title save,
snapshot **only if** no revision exists within `revisionSnapshotTimeInterval` (default **600 s**)
AND note age ≥ interval. Manual snapshots carry description + `source="manual"`. Restore first
snapshots current state (reversible), then copies title/type/mime/content back.
Retention option `revisionSnapshotNumberLimit` (-1 = keep all).

### Migration M009 (`app/database/migrations.py`)
```sql
CREATE TABLE note_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id INTEGER NOT NULL,
  title TEXT, content TEXT, type TEXT, mime TEXT,
  description TEXT DEFAULT '', source TEXT DEFAULT 'auto',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_revisions_note ON note_revisions(note_id, created_at DESC);
```

### Hook
`_save_revision_if_needed(conn, existing)` in `update_note` before the UPDATE; interval read from
options table key `revision_snapshot_time_interval` (default 600). Title-only changes qualify too.

### Routes (new `app/routes/revisions.py`)
- `GET    /notes/{id}/revisions` — list (id, title, created_at, description, source, length(content))
- `POST   /notes/{id}/revisions` — manual snapshot `{description}` (source='manual')
- `GET    /revisions/{rid}` — full content
- `POST   /revisions/{rid}/restore` — snapshot current first, then copy title/type/mime/content back
- `DELETE /revisions/{rid}` and `DELETE /notes/{id}/revisions`

### Frontend
Topbar history button → revisions modal (list w/ time+description+size, view read-only, restore,
delete, "Save snapshot now"). Interval editable via existing options API.

### Tests
Auto-revision interval rule (backdated `created_at` as fake clock), manual snapshot, restore
round-trip, erase, list ordering.

## Phase 4 — P4b: Export

Trilium reference (`services/export/single.ts`): text → HTML with attachments inlined as base64
data URIs + `<html>` skeleton wrap; or Markdown; code → raw content w/ mime-derived extension;
Content-Disposition attachment header.

- **Dependency**: add `markdownify` to `requirements.txt`.
- **Route** in `notes.py`: `GET /notes/{id}/export?format=html|md|raw`
  - `html`: inline image attachments as base64 data URIs (BLOBs already in `attachments`),
    wrap in `<html>` skeleton, filename `{title}.html`
  - `md`: `markdownify(content)` for text/page types; raw content for code/mermaid/mindMap
  - `raw`: content with proper extension/mime
  - 404 for deleted/nonexistent; safe filename sanitization.
- **Frontend**: topbar download dropdown (HTML / Markdown / Source).
- **Tests**: formats, attachment inlining, filename header, 404s.

## Verification (each phase)

- Full local pytest run stays green (currently 96 passing) + new tests.
- Live browser check via openchamber_web for each UI surface.
- Commit + push per phase; confirm GitHub CI green before starting next phase.

## Deferred

- **P4c protected notes**: Trilium two-key scheme fully mapped (scrypt N=16384,r=8,p=1 password key
  wraps random AES-128-CBC data key; digest-prefixed ciphertext; in-memory session w/ timeout).
  Python port cheap: stdlib `hashlib.scrypt` + `cryptography` (installed v50, needs requirements.txt).
