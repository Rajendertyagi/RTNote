"""MemoryManager: session persistence, extraction filters, dedupe, search."""
import json

from sqlalchemy import select, text

from app.chat.db import AsyncSessionLocal
from app.chat.memory import ChatSession, Memory, MemoryManager


def _mgr(db, **kw):
    return MemoryManager(db=db, **kw)


# ---------- Session loading ----------
async def test_load_new_session_gets_system_prompt(chat_db):
    async with AsyncSessionLocal() as db:
        m = _mgr(db)
        await m.load_session()
        assert m.messages == [{"role": "system", "content": "You are a helpful assistant."}]


async def test_load_existing_session_restores_messages(chat_db):
    async with AsyncSessionLocal() as db:
        db.add(ChatSession(id=7, messages=json.dumps([
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ])))
        await db.commit()

        m = _mgr(db, session_id=7)
        await m.load_session()
        # system prompt prepended ahead of stored turns
        assert m.messages[0]["role"] == "system"
        assert [x["content"] for x in m.messages[1:]] == ["hi", "hello"]


async def test_load_session_with_corrupt_json_resets_messages(chat_db):
    async with AsyncSessionLocal() as db:
        db.add(ChatSession(id=8, messages="not-json{"))
        await db.commit()
        m = _mgr(db, session_id=8)
        await m.load_session()
        assert m.messages == [{"role": "system", "content": "You are a helpful assistant."}]


async def test_load_missing_session_behaves_like_new(chat_db):
    async with AsyncSessionLocal() as db:
        m = _mgr(db, session_id=999)
        await m.load_session()
        assert m.session_id == 999
        assert m.messages[0]["role"] == "system"


# ---------- Saving ----------
async def test_save_creates_session_with_truncated_title(chat_db):
    long_msg = "x" * 80
    async with AsyncSessionLocal() as db:
        m = _mgr(db)
        await m.load_session()
        await m.add_user_message(long_msg)
        m.messages.append({"role": "assistant", "content": "reply"})
        await m._save()
        assert isinstance(m.session_id, int)

        row = await db.get(ChatSession, m.session_id)
        assert row.title == "x" * 50
        assert json.loads(row.messages)[-1]["role"] == "assistant"


async def test_save_updates_existing_session(chat_db):
    async with AsyncSessionLocal() as db:
        m = _mgr(db)
        await m.load_session()
        await m.add_user_message("first")
        m.messages.append({"role": "assistant", "content": "r1"})
        await m._save()
        sid = m.session_id

        await m.add_user_message("second")
        m.messages.append({"role": "assistant", "content": "r2"})
        await m._save()

        row = await db.get(ChatSession, sid)
        assert len(json.loads(row.messages)) == 5

    # count rows: update must not have created a second session
    async with AsyncSessionLocal() as db:
        rows = (await db.execute(select(ChatSession))).scalars().all()
        assert len(rows) == 1


# ---------- Memory storage & extraction ----------
async def test_maybe_add_memory_dedupes_on_unique_constraint(chat_db):
    async with AsyncSessionLocal() as db:
        m = _mgr(db)
        await m._maybe_add_memory("User likes dark themes.")
        await m._maybe_add_memory("  User   likes dark themes.  ")  # normalized duplicate
        rows = (await db.execute(select(Memory))).scalars().all()
        assert len(rows) == 1


async def test_extract_filters_pii_and_short_fragments(chat_db, fake_llm):
    fake_llm([json.dumps({"memories": [
        "my password is hunter2",
        "too short",
        {"not": "a string"},
        "User prefers morning meetings.",
    ]})])
    msgs = [
        {"role": "user", "content": "By the way my password is hunter2"},
        {"role": "assistant", "content": "Noted."},
    ]
    async with AsyncSessionLocal() as db:
        m = _mgr(db)
        await m._extract_memories(msgs)
        rows = (await db.execute(select(Memory))).scalars().all()
    assert [r.memory_text for r in rows] == ["User prefers morning meetings."]


async def test_extract_parses_json_embedded_in_prose(chat_db, fake_llm):
    fake_llm(['Sure! Here you go: {"memories": ["User drives a red car."]} done'])
    async with AsyncSessionLocal() as db:
        m = _mgr(db)
        await m._extract_memories([
            {"role": "user", "content": "I drive a red car"},
            {"role": "assistant", "content": "Cool"},
        ])
        rows = (await db.execute(select(Memory))).scalars().all()
    assert rows[0].memory_text == "User drives a red car."


async def test_extract_without_json_stores_nothing(chat_db, fake_llm):
    fake_llm(["no json here at all"])
    async with AsyncSessionLocal() as db:
        m = _mgr(db)
        await m._extract_memories([
            {"role": "user", "content": "a"},
            {"role": "assistant", "content": "b"},
        ])
        rows = (await db.execute(select(Memory))).scalars().all()
    assert rows == []


async def test_extract_needs_two_messages(chat_db, fake_llm):
    calls = fake_llm([])
    async with AsyncSessionLocal() as db:
        m = _mgr(db)
        await m._extract_memories([{"role": "user", "content": "only one"}])
    assert calls == []


# ---------- Search ----------
async def test_search_memories_via_fts(chat_db):
    async with AsyncSessionLocal() as db:
        m = _mgr(db)
        await m._maybe_add_memory("User enjoys hiking in the mountains.")
        await m._maybe_add_memory("User works with databases.")
        hits = await m._search_memories("hiking mountains")
        assert hits == ["User enjoys hiking in the mountains."]


async def test_search_memories_like_fallback_when_fts_broken(chat_db):
    async with AsyncSessionLocal() as db:
        m = _mgr(db)
        await m._maybe_add_memory("User enjoys hiking in the mountains.")
        # Break FTS to force the LIKE fallback branch
        await db.execute(text("DROP TABLE memories_fts"))
        await db.commit()
        hits = await m._search_memories("hiking mountains")
        assert hits == ["User enjoys hiking in the mountains."]


async def test_search_empty_query_returns_empty(chat_db):
    async with AsyncSessionLocal() as db:
        assert await _mgr(db)._search_memories("") == []


async def test_list_memories_scoped_to_user(chat_db):
    async with AsyncSessionLocal() as db:
        db.add(Memory(user_id="alice", memory_text="Alice fact"))
        db.add(Memory(user_id="bob", memory_text="Bob fact"))
        await db.commit()
        alice = await _mgr(db, user_id="alice").list_memories()
        assert alice == ["Alice fact"]
