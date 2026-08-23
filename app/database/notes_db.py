"""Notes database (sync SQLite with WAL mode for concurrent access).

Connection discipline (root-cause fix for the lock-cascade bug):
- Always use `with db() as conn:` in routes — it guarantees commit on
  success, rollback on error, and close in every case. A connection that
  dies mid-transaction otherwise holds the write lock forever.
"""
import sqlite3
from contextlib import contextmanager

from app.config import NOTES_DB_PATH

# Canonical FTS sync triggers — the documented external-content pattern
# from https://www.sqlite.org/fts5.html §4.4.3. UPDATE is NOT a valid
# operation on external-content tables; use 'delete' command + insert.
FTS_TRIGGERS = [
    """
    CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END;
    """,
    """
    CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content)
            VALUES('delete', old.id, old.title, old.content);
    END;
    """,
    """
    CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content)
            VALUES('delete', old.id, old.title, old.content);
        INSERT INTO notes_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END;
    """,
]


def get_db():
    conn = sqlite3.connect(NOTES_DB_PATH, timeout=10.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def db():
    """Transactional connection scope: commit / rollback / always close."""
    conn = get_db()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT 'Untitled',
                content TEXT DEFAULT '',
                parent_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (parent_id) REFERENCES notes(id)
            )
        ''')
        conn.execute('''
            CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
                title, content,
                content='notes',
                content_rowid='id'
            )
        ''')
        for ddl in FTS_TRIGGERS:
            name = ddl.split("TRIGGER ")[1].split(" ")[0]
            conn.execute(f"DROP TRIGGER IF EXISTS {name}")
            conn.execute(ddl)
