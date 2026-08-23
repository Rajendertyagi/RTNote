"""Automatic backups of the notes database.

Why: the notes DB is the user's knowledge base; disk failure or a bad
migration must never mean total loss. Uses SQLite's built-in *online
backup API* (`Connection.backup`), which copies a consistent snapshot
even while the app is writing (WAL-safe) — no locking of normal operations.

Storage & retention
-------------------
Backups live in `data/backups/` as `notes-YYYYMMDD-HHMMSS.db`.
Keep the most recent `NOTES_BACKUP_KEEP` (default 7); older ones are deleted.
A backup is taken at most once per `NOTES_BACKUP_INTERVAL_HOURS` (default 24);
lifespan runs a small hourly loop so a long-running server still gets its
daily snapshot. All knobs are env-overridable for tests.

Manual restore
--------------
1. Stop the app.
2. Copy the chosen backup over the live database:
     copy /Y data\backups\notes-YYYYMMDD-HHMMSS.db data\notes.db
3. Delete `data\notes.db-wal` and `data\notes.db-shm` if present.
4. Start the app (migrations run automatically and are idempotent).
See docs/BACKUPS.md for the full guide.
"""
import logging
import os
import sqlite3
from datetime import datetime
from pathlib import Path

from app.config import DATA_DIR, NOTES_DB_PATH

log = logging.getLogger(__name__)

BACKUP_DIR = Path(os.getenv("NOTES_BACKUP_DIR", str(DATA_DIR / "backups")))
KEEP = int(os.getenv("NOTES_BACKUP_KEEP", "7"))
INTERVAL_HOURS = float(os.getenv("NOTES_BACKUP_INTERVAL_HOURS", "24"))


def _newest_backup() -> Path | None:
    """Newest valid-looking backup file, or None."""
    if not BACKUP_DIR.exists():
        return None
    files = sorted(BACKUP_DIR.glob("notes-*.db"))
    return files[-1] if files else None


def backup_now() -> Path | None:
    """Take one backup snapshot. Returns the backup path, or None on failure.

    Never raises into the caller: a failed backup must not take the app
    down — it is logged loudly instead.
    """
    try:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        # %f (microseconds) keeps rapid successive backups from colliding
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        dest_path = BACKUP_DIR / f"notes-{stamp}.db"

        src = sqlite3.connect(NOTES_DB_PATH)
        try:
            dest = sqlite3.connect(dest_path)
            try:
                src.backup(dest)  # online backup API: consistent under writes
                dest.execute("PRAGMA integrity_check").fetchone()
            finally:
                dest.close()
        finally:
            src.close()

        _apply_retention()
        log.info("Backup written: %s", dest_path)
        return dest_path
    except Exception:
        log.exception("Database backup FAILED — notes are running unguarded "
                      "until a backup succeeds")
        return None


def _apply_retention() -> None:
    """Keep only the newest KEEP backups."""
    files = sorted(BACKUP_DIR.glob("notes-*.db"))
    for old in files[:-KEEP] if len(files) > KEEP else []:
        try:
            old.unlink()
            log.info("Pruned old backup: %s", old.name)
        except OSError:
            log.warning("Could not prune old backup %s", old)


def backup_if_due() -> Path | None:
    """Backup only when the newest snapshot is older than INTERVAL_HOURS."""
    newest = _newest_backup()
    if newest is not None:
        age_h = (datetime.now().timestamp() - newest.stat().st_mtime) / 3600
        if age_h < INTERVAL_HOURS:
            return None
    return backup_now()
