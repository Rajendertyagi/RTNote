"""Application startup/shutdown hooks."""
from contextlib import asynccontextmanager

from app.database.notes_db import init_db as init_notes_db
from app.database.migrations import run_migrations
from app.chat.db import init_db as init_chat_db, dispose_engine


@asynccontextmanager
async def lifespan(app):
    init_notes_db()
    run_migrations()
    await init_chat_db()
    yield
    await dispose_engine()
