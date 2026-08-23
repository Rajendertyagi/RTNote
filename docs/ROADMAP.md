# ROADMAP — Custom HTML Pages & Trilium Feature Porting Plan

> Generated after deep audit of (a) our codebase and (b) the TriliumNext/Trilium repository
> (monorepo: `apps/server`, `apps/client`, `packages/trilium-core`).
> Sources: Trilium docs (Render Note, Web View), repo source inspection
> (`note_types.ts`, `routes/`, `services/`, client `widgets/`).

---

## Part 0 — Where We Are Today

| Layer | What exists | What's missing |
|---|---|---|
| Backend | FastAPI (`app/routes/notes.py`): CRUD + FTS5 search; SQLite WAL; chat module | **No `type` column** on notes (every note is implicitly "text"); no raw-HTML serving; no migration framework |
| Frontend | Wunderbaum tree (real DB data), SunEditor classic, quick search Ctrl+K, themes, chat panel | No note-type concept in UI; editor is hardwired to SunEditor for every note |
| Data | `notes(id, title, content, parent_id, created_at, updated_at)` + FTS5 | No `type`, no `mime`, no attributes/labels, no revisions |

**The single biggest architectural gap:** Trilium's entire feature set hangs off
`note.type` (18 types in source). We cannot port ANY Trilium feature (HTML pages,
code notes, mermaid, webview, collections…) until notes have a `type` column.
That is Phase 0 below and everything depends on it.

---

## Part 1 — Custom HTML Pages: Deep Audit & Design

### 1.1 How Trilium does it (verified from repo/docs)

Two distinct mechanisms:

**A. Render Note** (`type: "render"`)
- A render note itself has NO content. It holds a **relation** `~renderNote` pointing at a Code note containing HTML (or JSX/Preact component).
- When viewed, the client fetches the target HTML and renders it inside a **sandboxed iframe**; JS inside may use a limited `api` object.
- Use case: dashboards, custom editors, mini-apps stored as notes.

**B. Web View** (`type: "webView"`)
- Note has label `#webViewSrc="https://..."`; client renders `<iframe src>` of the external site.
- Server adds sandboxing constraints; many sites block framing via `X-Frame-Options`/CSP `frame-ancestors` (unfixable, documented behavior).

### 1.2 Our design (Python/vanilla-JS equivalent)

We simplify Trilium's relation-indirection into something more direct for v1,
while keeping the door open for the indirection model later.

**New note types for us:**

| `type` value | Meaning | Content column holds |
|---|---|---|
| `text` (default) | Rich text via SunEditor | HTML from SunEditor |
| `html` | Editable raw HTML source (Code-note equivalent) | Raw HTML source |
| `page` | **Custom HTML page** — rendered live | Full HTML doc or fragment |
| `webview` | External URL embed | The URL string |

`page` = what you asked for ("custom html pages"): author writes HTML (+CSS/JS),
app renders it as a live page inside the note pane.

### 1.3 Security model (critical)

Rendering user-authored HTML+JS is XSS-by-design. The browser gives us the exact tool:

```
<iframe sandbox="allow-scripts" src="/api/notes/{id}/raw"></iframe>
```

- `sandbox` WITHOUT `allow-same-origin` → content runs in an opaque origin:
  it CANNOT touch our cookies, localStorage, DOM, or call our API with credentials.
- Serve raw content from its own response with hardened headers:

```
Content-Type: text/html; charset=utf-8
Content-Security-Policy: default-src 'self' 'unsafe-inline' data: https://cdn.jsdelivr.net https://unpkg.com;
                         frame-ancestors 'self'
Cache-Control: no-store
```

- No server-side sanitization needed (and none attempted — sanitizer bypasses are a treadmill). The sandbox IS the boundary.
- For `webview`: same iframe but `src=<user URL>`; document the X-Frame-Options limitation (same as Trilium).

### 1.4 Implementation steps (ordered, each independently testable)

| # | Step | File(s) | Test |
|---|------|---------|------|
| 1 | Migration framework + add columns: `ALTER TABLE notes ADD COLUMN type TEXT NOT NULL DEFAULT 'text'; ADD COLUMN mime TEXT;` + `schema_migrations` table | new `app/database/migrations.py`, called from `lifespan.py` | restart → `PRAGMA table_info(notes)` shows `type` |
| 2 | CRUD accepts/returns `type`; `create_note` takes `type` param | `app/routes/notes.py` | POST `{"type":"page"}` round-trips |
| 3 | Raw serving route: `GET /api/notes/{id}/raw` → HTMLResponse with CSP/no-store headers; 404 if type not in (`page`,`html`) | `app/routes/notes.py` | curl -I shows headers |
| 4 | Type switcher UI: dropdown in topbar (Text / HTML / Page / Web View); disabled options per current type; switching asks confirm when content exists | `index.html`, `editor.js`, `ui.js` | dropdown changes `type` via PUT |
| 5 | Editor branching in `openNoteInEditor`: `text`→SunEditor visible; `html`→plain `<textarea class="code-editor">` monospace; `page`→hide editor, show `<iframe sandbox="allow-scripts" src=".../raw">`; `webview`→iframe `src=content` | `editor.js`, small CSS | click through all 4 types |
| 6 | Editing surfaces: `html` edits textarea → PUT saves raw; `page` gets "Edit source" toggle (switches to textarea view of same content); `webview` shows URL input | `editor.js` | edit page source → refresh → renders |
| 7 | Tree icons per type (`bx bx-code-alt` html, `bx bx-window-open` page, `bx bx-link-external` webview) | `tree.js` buildTreeSource | icons differ per type |

**Acceptance criteria (definition of done):**
1. Create note of type `page` with `<h1>Hi</h1><script>document.body.style.color='red'</script>` → renders red heading in pane.
2. That page's script CANNOT read `localStorage` of the main app (sandbox opaque origin) — verify in console.
3. Switching back to `text` keeps content; FTS5 still indexes all types (search finds words inside page HTML).
4. All existing features (tree, search, themes, auto-save for `text`) unaffected.

Effort: **M** (~half session). Depends on: nothing. Blocks: everything type-related in Part 3.

---

## Part 2 — Trilium Architecture Audit (what we're porting FROM)

### 2.1 Repo map (verified)

```
TriliumNext/Trilium (pnpm monorepo, TypeScript)
├── apps/server        Express + better-sqlite3 HTTP server
│   └── src/routes/    api/ · custom.ts (user request handlers) · login/logout ·
│                      mcp.ts (Model Context Protocol!) · assets · csrf · sessions
├── apps/client        Preact (.tsx) widget tree — NOT jQuery anymore
│   └── src/widgets/   NoteDetail · FloatingButtons · PromotedAttributes ·
│                      collections/ · dialogs/ · launch_bar/ · layout/ ·
│                      attribute_widgets/ · find_in_* · highlights_list
└── packages/
    ├── trilium-core   becca/ (data layer) · migrations/ · routes/ · services/
    │                  └── services/note_types.ts ← canonical 18-type registry
    ├── ckeditor5      rich text (patched fork)
    ├── codemirror     code editing
    ├── highlightjs, pdfjs-viewer, splitjs, turndown-plugin-gfm (MD↔HTML)
    └── share-theme    public sharing skin
```

### 2.2 Canonical note types (from `note_types.ts` — verbatim registry)

```text
text · code · render · file · image · search · relationMap · book · noteMap ·
mermaid · canvas · webView · launcher · doc · contentWidget · mindMap ·
spreadsheet · llmChat
```

Notable: even AI chat is a note TYPE (`llmChat`) in Trilium — mirrors our chat sidebar;
later we can promote chat history into real notes.

### 2.3 How Trilium adds a feature (the pattern we copy)

1. Register type/options in shared core (`note_types.ts` equivalent → our `config.py` constant).
2. DB migration in `packages/trilium-core/src/migrations/` → our `app/database/migrations.py`.
3. Entity + service in `trilium-core/src/services/` → our `app/database/notes_db.py` / new service modules.
4. Route in `apps/server/src/routes/api/` → our `app/routes/<feature>.py`, registered in `routes/__init__.py`.
5. Client widget in `apps/client/src/widgets/` mounted by layout → our `frontend/static/js/<feature>.js` + `main.js` init.
6. Spec tests colocated (`*.spec.ts`) → our manual acceptance checklists per feature (below).

### 2.4 Port / adapt / skip matrix

| Trilium feature | Verdict | Why / our angle |
|---|---|---|
| render + webView notes | **PORT** | = Part 1 custom HTML pages |
| code notes | PORT (Phase 1) | textarea + optional highlight.js CDN |
| note icons & colors | PORT (Phase 1) | `icon`/`color` columns; tree.js already supports icon field |
| tree context-menu actions | PORT (Phase 2) | menu exists; wire rename/delete/new-child to API |
| tabs bound to real notes | PORT (Phase 2) | tabs currently cosmetic |
| day notes / Journal | PORT (Phase 2) | `date_notes.ts` pattern; calendar feeds it later |
| bookmarks | PORT (Phase 2) | `is_bookmarked` flag + sidebar section |
| Calendar collection | PORT (Phase 3) | FullCalendar CDN; events = notes with `start_date` column |
| image/file attachments | PORT (Phase 3) | `attachments` table + `/attachments` upload route |
| note revisions | PORT (Phase 4) | `note_revisions` table; snapshot on PUT when content changed |
| export MD/HTML | PORT (Phase 4) | turndown equivalent: markdown lib server-side |
| protected notes | ADAPT (Phase 4) | Fernet per-note encrypt at rest; unlock prompt |
| mermaid / mindmap / canvas / spreadsheet | LATER (Phase 5) | each = CDN lib + one more editor branch; cheap once Part 1 lands |
| sync server, ETAPI, scripting engine, MCP | SKIP for now | single-user local app; revisit much later |
| Electron desktop | SKIP | we are the web app |

---

## Part 3 — Phased Roadmap (one feature per step)

Dependency rule: **nothing starts before P0.** Within a phase, order = listed order.

### P0 — Foundation: note types + migrations ⚠ BLOCKS ALL
- Migrations framework (`schema_migrations` table, ordered runners)
- `notes.type` + `notes.mime` columns; CRUD plumbing; tree icons per type
- Effort S · Accepts: restart-safe migration; old notes become `text`

### P1 — Custom HTML pages (= Part 1) + code notes
- F1 `page` type: sandboxed iframe render + raw route + CSP (steps 1–7 above)
- F2 `html` type: source editing surface
- F3 `webview` type: URL embed with known X-Frame-Options caveat
- F4 code notes: language tag column reuse (`mime`), mono editor
- Effort M · Accepts: Part 1 checklist green

### P2 — Real navigation & organization
- F5 Context menu wired: New child / Rename (inline) / Delete (confirm + cascade)
- F6 Tabs ↔ notes: open-in-tab from tree/search, tab state = note id, close = release
- F7 Bookmarks: flag + "Bookmarks" pinned section atop tree
- F8 Day notes: `/api/days/YYYY-MM-DD` get-or-create; launcher calendar icon opens today
- Effort M

### P3 — Collections & media
- F9 Attachments: `attachments(id, note_id, filename, mime, blob)` + upload/download routes; drag-drop into SunEditor inserts `/api/attachments/{id}` URL
- F10 Calendar collection: FullCalendar month view; notes with `start_date` render as events; click-day → F8 day note
- F11 Table/Grid view of children (simple first pass)
- Effort L

### P4 — History, safety, export
- F12 Revisions: snapshot row on every content-changing PUT; viewer + restore
- F13 Export: single note → Markdown (server-side html2md) and standalone HTML file
- F14 Protected notes: Fernet-encrypted content at rest, per-session unlock
- Effort M

### P5 — Rich types (cheap after P1's editor-branch pattern)
- F15 Mermaid (mermaid CDN), F16 Mind map (mind-elixir), F17 Canvas (Excalidraw),
  F18 `llmChat` note type (persist chat sessions as notes; reuses chat/ module)
- Effort S each, independent

---

## Part 4 — House Convention: Adding ANY Future Feature

1. **Backend**: new `app/routes/<feature>.py` with `router = APIRouter(prefix="/api/<feature>")`
   → one line registration in `app/routes/__init__.py`. Never touch `main.py`.
2. **Schema change**: append numbered migration function in `app/database/migrations.py`;
   never ALTER ad-hoc elsewhere.
3. **Frontend**: new `frontend/static/js/<feature>.js` exposing `init<Feature>()`
   → script tag in `index.html` (before `main.js`) + call in `main.js` DOMContentLoaded.
4. **Styling**: theme-aware only via CSS variables; third-party overrides go UNLAYERED
   at end of `style.css` (layered rules always lose to library CSS — proven twice).
5. **Definition of done**: feature works after full page reload · theme switch safe ·
   FTS5 still returns it where relevant · acceptance bullets written here in ROADMAP ticked.

---

*Next action proposed: execute P0 then P1 (they are exactly Part 1's 7 steps plus the migration groundwork).*
