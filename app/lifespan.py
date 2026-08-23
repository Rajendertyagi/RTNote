"""Application startup/shutdown hooks."""
import asyncio
import logging
from contextlib import asynccontextmanager

from app.database.backup import backup_if_due
from app.database.notes_db import init_db as init_notes_db
from app.database.migrations import run_migrations
from app.chat.db import init_db as init_chat_db, dispose_engine

log = logging.getLogger(__name__)

_BACKUP_CHECK_SECONDS = 3600  # hourly due-check; the interval itself is
                              # NOTES_BACKUP_INTERVAL_HOURS (default 24h)


async def _backup_loop():
    """Hourly backup-due check for long-running servers. Failures are logged,
    never fatal — a backup problem must not take notes offline."""
    while True:
        await asyncio.sleep(_BACKUP_CHECK_SECONDS)
        try:
            backup_if_due()
        except Exception:
            log.exception("Backup loop iteration failed")


@asynccontextmanager
async def lifespan(app):
    log.info("application starting")
    init_notes_db()
    run_migrations()
    await init_chat_db()
    backup_if_due()  # snapshot at startup if the last one is stale
    task = asyncio.create_task(_backup_loop())
    log.info("application started")
    yield
    task.cancel()
    await dispose_engine()
    log.info("application stopped")
