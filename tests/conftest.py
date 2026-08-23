"""Shared fixtures.

Env overrides are set BEFORE any app import so app.config and
app.chat.db bind to throwaway temp databases — never data/*.db.
"""
import os
import tempfile

_TMP_DIR = tempfile.mkdtemp(prefix="rtw-tests-")
os.environ["NOTES_DB_PATH"] = os.path.join(_TMP_DIR, "notes.db")
os.environ["CHAT_DATABASE_URL"] = (
    "sqlite+aiosqlite:///" + os.path.join(_TMP_DIR, "chat.db").replace("\\", "/")
)

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.config import NOTES_DB_PATH
from app.database.notes_db import init_db as init_notes_db
from app.database.migrations import run_migrations
from app.chat.db import init_db as init_chat_db, dispose_engine


# ---------- Notes DB ----------
@pytest.fixture(autouse=True)
def notes_db():
    """Fresh notes DB (schema + all migrations) for every test."""
    if NOTES_DB_PATH.exists():
        NOTES_DB_PATH.unlink()
    init_notes_db()
    run_migrations()
    yield NOTES_DB_PATH


@pytest_asyncio.fixture
async def client():
    """HTTP client talking directly to the ASGI app (no live server)."""
    from main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ---------- Chat DB ----------
@pytest_asyncio.fixture
async def chat_db():
    """Fresh chat DB (SQLAlchemy models + FTS table/triggers) per test."""
    await dispose_engine()
    path = NOTES_DB_PATH.parent / "chat.db"
    if path.exists():
        path.unlink()
    await init_chat_db()
    yield
    await dispose_engine()


# ---------- Fake LLM ----------
class _FakeMessage:
    def __init__(self, content):
        self.content = content


class _FakeChoice:
    def __init__(self, content):
        self.message = _FakeMessage(content)


class FakeLLMResponse:
    def __init__(self, content):
        self.choices = [_FakeChoice(content)]


@pytest.fixture
def fake_llm(monkeypatch):
    """Patch litellm acompletion inside memory.py with a canned responder.

    Returns a recorder list; append dicts to it to queue responses in order.
    """

    def _install(responses):
        calls = []
        queue = list(responses)

        async def _fake_acompletion(**kwargs):
            calls.append(kwargs)
            content = queue.pop(0) if queue else "ok"
            return FakeLLMResponse(content)

        monkeypatch.setattr("app.chat.memory.acompletion", _fake_acompletion)
        return calls

    return _install
