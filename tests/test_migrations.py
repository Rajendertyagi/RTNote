"""Migrations: fresh apply of all versions, idempotent re-run."""
import sqlite3

from app.config import NOTES_DB_PATH
from app.database.migrations import MIGRATIONS, run_migrations


def _table_cols(path, table):
    conn = sqlite3.connect(path)
    try:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
    finally:
        conn.close()


def test_all_migrations_applied_on_fresh_db(notes_db):
    conn = sqlite3.connect(NOTES_DB_PATH)
    try:
        versions = {r[0] for r in conn.execute("SELECT version FROM schema_migrations")}
    finally:
        conn.close()
    expected = {v for v, _, _ in MIGRATIONS}
    assert versions == expected


def test_expected_schema_columns_exist(notes_db):
    notes_cols = _table_cols(NOTES_DB_PATH, "notes")
    assert {"type", "mime", "deleted_at", "delete_id", "start_date", "end_date"} <= notes_cols
    assert _table_cols(NOTES_DB_PATH, "options") >= {"key", "value", "updated_at"}
    assert _table_cols(NOTES_DB_PATH, "bookmarks") >= {"note_id", "position"}
    att = _table_cols(NOTES_DB_PATH, "attachments")
    assert {"id", "note_id", "filename", "mime", "size", "content"} <= att


def test_rerun_migrations_is_noop(notes_db):
    run_migrations()  # must not raise or duplicate rows
    conn = sqlite3.connect(NOTES_DB_PATH)
    try:
        rows = conn.execute("SELECT version, COUNT(*) FROM schema_migrations GROUP BY version").fetchall()
    finally:
        conn.close()
    assert all(count == 1 for _, count in rows)


def test_fts_triggers_recreated_and_index_works(notes_db):
    conn = sqlite3.connect(NOTES_DB_PATH)
    try:
        triggers = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='trigger'")}
        assert {"notes_ai", "notes_ad", "notes_au"} <= triggers
        conn.execute("INSERT INTO notes (title, content) VALUES ('Alpha', 'searchable-xyz')")
        conn.commit()
        # 'searchable-xyz' must be quoted: bare hyphen is invalid FTS5 query syntax
        hits = conn.execute(
            "SELECT rowid FROM notes_fts WHERE notes_fts MATCH '\"searchable-xyz\"'"
        ).fetchall()
        assert len(hits) == 1
    finally:
        conn.close()


def test_migration_functions_are_guarded_against_double_apply(notes_db):
    from app.database.migrations import (
        _m001_notes_type_mime, _m002_notes_soft_delete, _m005_notes_event_dates,
    )
    conn = sqlite3.connect(NOTES_DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        # Columns already exist — guards must skip the ALTERs (no error).
        _m001_notes_type_mime(conn)
        _m002_notes_soft_delete(conn)
        _m005_notes_event_dates(conn)
        conn.commit()
    finally:
        conn.close()
