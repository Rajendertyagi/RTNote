"""Ordered, append-only schema migrations.

Rules (industry-standard practice):
- Never edit a migration that may have been applied already.
- Always append new migrations with the next version number.
- Each migration must be idempotent-guarded (check before ALTER) because
  SQLite has no `ADD COLUMN IF NOT EXISTS`.
"""
import logging

from app.database.notes_db import get_db

log = logging.getLogger(__name__)


def _m001_notes_type_mime(conn):
    """Add note-type foundation: type ('text'|'html'|'page'|'webview') + mime."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(notes)")}
    if "type" not in cols:
        conn.execute("ALTER TABLE notes ADD COLUMN type TEXT NOT NULL DEFAULT 'text'")
    if "mime" not in cols:
        conn.execute("ALTER TABLE notes ADD COLUMN mime TEXT")


# (version, name, function) — append only
MIGRATIONS = [
    (1, "notes_add_type_mime", _m001_notes_type_mime),
]


def _m002_notes_soft_delete(conn):
    """Soft-delete foundation (Trilium-style): deleted_at marks trash,
    delete_id groups a deleted subtree so it can be restored atomically."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(notes)")}
    if "deleted_at" not in cols:
        conn.execute("ALTER TABLE notes ADD COLUMN deleted_at TEXT")
    if "delete_id" not in cols:
        conn.execute("ALTER TABLE notes ADD COLUMN delete_id TEXT")


def _m003_options_table(conn):
    """Key/value store for app state (e.g. open tabs) — Trilium stores
    openNoteContexts the same way."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS options (
            key        TEXT PRIMARY KEY,
            value      TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )


def _m004_bookmarks_table(conn):
    """Ordered bookmarks — our equivalent of Trilium's _lbBookmarks container."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS bookmarks (
            note_id  INTEGER PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
            position INTEGER NOT NULL DEFAULT 0
        )
        """
    )


def _m005_notes_event_dates(conn):
    """P3 calendar support: optional event window on any note
    (Trilium equivalent: #startDate/#endDate labels — we use columns)."""
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(notes)")}
    if "start_date" not in cols:
        conn.execute("ALTER TABLE notes ADD COLUMN start_date TEXT")
    if "end_date" not in cols:
        conn.execute("ALTER TABLE notes ADD COLUMN end_date TEXT")


def _m006_attachments_table(conn):
    """Inline-BLOB attachments (Trilium keeps bytes in a separate blobs
    table for dedup/sync — unnecessary at our scale)."""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS attachments (
            id         INTEGER PRIMARY KEY,
            note_id    INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            filename   TEXT NOT NULL,
            mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
            size       INTEGER NOT NULL DEFAULT 0,
            content    BLOB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id)")


def _m007_fix_fts_triggers(conn):
    """Root-cause fix: UPDATE is not a valid operation on external-content
    FTS5 tables — it desyncs the index and later throws 'database disk image
    is malformed'. Replace all sync triggers with the documented
    delete-command + insert pattern, then rebuild the index."""
    conn.execute("DROP TRIGGER IF EXISTS notes_ai")
    conn.execute("DROP TRIGGER IF EXISTS notes_ad")
    conn.execute("DROP TRIGGER IF EXISTS notes_au")
    conn.execute("""
        CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
            INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
        END;
    """)
    conn.execute("""
        CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, content)
                VALUES('delete', old.id, old.title, old.content);
        END;
    """)
    conn.execute("""
        CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
            INSERT INTO notes_fts(notes_fts, rowid, title, content)
                VALUES('delete', old.id, old.title, old.content);
            INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
        END;
    """)
    # Resync the index from the content table (also heals any existing desync)
    conn.execute("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')")


MIGRATIONS.extend([
    (2, "notes_soft_delete", _m002_notes_soft_delete),
    (3, "options_table", _m003_options_table),
    (4, "bookmarks_table", _m004_bookmarks_table),
    (5, "notes_event_dates", _m005_notes_event_dates),
    (6, "attachments_table", _m006_attachments_table),
    (7, "fix_fts_triggers", _m007_fix_fts_triggers),
])


def run_migrations() -> None:
    """Apply pending migrations in order. Safe to call on every startup."""
    conn = get_db()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version    INTEGER PRIMARY KEY,
                name       TEXT NOT NULL,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        applied = {r["version"] for r in conn.execute("SELECT version FROM schema_migrations")}

        for version, name, migrate in MIGRATIONS:
            if version in applied:
                continue
            log.info("Applying migration %03d_%s", version, name)
            migrate(conn)
            conn.execute(
                "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
                (version, name),
            )
            conn.commit()
            log.info("Applied migration %03d_%s", version, name)
    finally:
        conn.close()
