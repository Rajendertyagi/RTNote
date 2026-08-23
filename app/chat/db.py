"""
Async SQLAlchemy database setup for chat functionality.
Uses aiosqlite with SQLite for async operations.
"""
import os
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    create_async_engine,
    async_sessionmaker,
    AsyncSession,
)
from sqlalchemy.orm import declarative_base
from sqlalchemy import text

from app.config import CHAT_DATABASE_URL

DATABASE_URL = os.getenv("CHAT_DATABASE_URL", CHAT_DATABASE_URL)

# Create async engine
engine: AsyncEngine = create_async_engine(
    DATABASE_URL,
    echo=bool(os.getenv("SQL_ECHO", False)),
    future=True,
)

# Async session factory
AsyncSessionLocal: async_sessionmaker[AsyncSession] = async_sessionmaker(
    bind=engine,
    expire_on_commit=False,
    class_=AsyncSession,
)

# Declarative base for models
Base = declarative_base()


async def init_db():
    """Create database tables from SQLAlchemy models."""
    async with engine.begin() as conn:
        # Create tables
        await conn.run_sync(Base.metadata.create_all)
        
        # Create FTS5 virtual table for memories
        await conn.execute(text("""
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                memory_text,
                content='memories',
                content_rowid='id'
            )
        """))
        
        # Create triggers for FTS5 sync
        await conn.execute(text("""
            CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
                INSERT INTO memories_fts(rowid, memory_text) VALUES (new.id, new.memory_text);
            END;
        """))
        
        await conn.execute(text("""
            CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
                DELETE FROM memories_fts WHERE rowid = old.id;
            END;
        """))
        
        await conn.execute(text("""
            CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
                UPDATE memories_fts SET memory_text=new.memory_text WHERE rowid=new.id;
            END;
        """))


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Async dependency that yields a DB session."""
    async with AsyncSessionLocal() as session:
        yield session


async def dispose_engine():
    """Gracefully dispose the engine."""
    await engine.dispose()

