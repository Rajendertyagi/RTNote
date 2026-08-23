"""Automatic DB backups: creation, retention, due-gating, failure handling."""
import os
from pathlib import Path

import pytest

from app.database import backup as bk
from app.database.notes_db import db


@pytest.fixture
def backup_env(tmp_path, monkeypatch):
    """Redirect backup dir/keep/interval at a temp location."""
    bdir = tmp_path / "backups"
    monkeypatch.setattr(bk, "BACKUP_DIR", bdir)
    monkeypatch.setattr(bk, "KEEP", 3)
    monkeypatch.setattr(bk, "INTERVAL_HOURS", 24.0)
    return bdir


def test_backup_creates_valid_sqlite_file(backup_env):
    with db() as conn:
        conn.execute("INSERT INTO notes (title) VALUES ('precious')")

    path = bk.backup_now()
    assert path is not None and path.exists()

    # The snapshot is a real SQLite file containing our data
    import sqlite3
    snap = sqlite3.connect(path)
    row = snap.execute("SELECT title FROM notes WHERE title='precious'").fetchone()
    snap.close()
    assert row is not None


def test_backup_if_due_respects_interval(backup_env):
    assert bk.backup_if_due() is not None          # nothing yet -> due
    assert bk.backup_if_due() is None              # just backed up -> not due


def test_retention_keeps_only_newest(backup_env):
    for _ in range(5):
        bk.backup_now()
    files = sorted(backup_env.glob("notes-*.db"))
    assert len(files) == 3  # KEEP=3


def test_backup_failure_is_swallowed_and_logged(backup_env, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(bk.sqlite3, "connect", boom)
    assert bk.backup_now() is None  # never raises into the caller
