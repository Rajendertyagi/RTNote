# Backups

The notes database (`data/notes.db`) is backed up automatically using
SQLite's built-in **online backup API** — snapshots are consistent even
while the app is writing, and normal note operations are never blocked.

## Where backups live

```
data/backups/notes-YYYYMMDD-HHMMSS.db
```

`data/` is gitignored, so backups never reach GitHub.

## When backups happen

- At app startup, if the newest backup is older than the interval.
- An hourly check keeps long-running servers covered.

| Setting (env var) | Default | Meaning |
|---|---|---|
| `NOTES_BACKUP_DIR` | `data/backups` | Backup folder |
| `NOTES_BACKUP_KEEP` | `7` | Recent backups kept; older ones pruned |
| `NOTES_BACKUP_INTERVAL_HOURS` | `24` | Minimum time between backups |

A failed backup is logged loudly and never crashes the app — but check the
logs: until a backup succeeds, your notes are running unguarded.

## How to restore manually

1. Stop the app.
2. Copy the chosen backup over the live database:
   ```
   copy /Y data\backups\notes-YYYYMMDD-HHMMSS.db data\notes.db
   ```
3. Delete `data\notes.db-wal` and `data\notes.db-shm` if they exist
   (stale WAL files from the old database).
4. Start the app. Migrations run automatically and are idempotent.

To restore a single note instead of the whole database: open the backup
file read-only with any SQLite browser (e.g. `sqlite3 data\backups\notes-...db`
or the DB Browser for SQLite app), find the note row, and re-create it in
the app. Attachments live in the `attachments` table of the same file.
