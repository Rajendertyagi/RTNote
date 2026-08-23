"""POST /api/chat/send with a mocked LiteLLM backend."""
import asyncio
import json

from app.chat.db import AsyncSessionLocal
from app.chat.memory import ChatSession, MemoryManager


async def test_send_creates_session_and_returns_reply(client, chat_db, fake_llm, monkeypatch):
    async def _no_background(self, recent):
        pass

    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _no_background)
    calls = fake_llm(["Here is your answer."])

    res = await client.post("/api/chat/send", json={"message": "Hello bot"})
    assert res.status_code == 200
    body = res.json()
    assert isinstance(body["session_id"], int)
    assert body["reply"] == "Here is your answer."

    # LLM received system prompt + user message
    sent_messages = calls[0]["messages"]
    assert sent_messages[0]["role"] == "system"
    assert sent_messages[-1] == {"role": "user", "content": "Hello bot"}

    async with AsyncSessionLocal() as db:
        row = await db.get(ChatSession, body["session_id"])
        assert row is not None
        stored = json.loads(row.messages)
        assert [m["role"] for m in stored] == ["system", "user", "assistant"]


async def test_send_continues_existing_session(client, chat_db, fake_llm, monkeypatch):
    async def _no_background(self, recent):
        pass

    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _no_background)
    fake_llm(["first reply", "second reply"])

    first = (await client.post("/api/chat/send", json={"message": "one"})).json()
    second = (await client.post(
        "/api/chat/send",
        json={"message": "two", "session_id": first["session_id"]})).json()

    assert second["session_id"] == first["session_id"]
    assert second["reply"] == "second reply"

    async with AsyncSessionLocal() as db:
        row = await db.get(ChatSession, first["session_id"])
        assert len(json.loads(row.messages)) == 5  # sys + 2x(user, assistant)


async def test_send_with_custom_model_and_system_prompt(client, chat_db, fake_llm, monkeypatch):
    async def _no_background(self, recent):
        pass

    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _no_background)
    calls = fake_llm(["ok"])

    res = await client.post("/api/chat/send", json={
        "message": "hi",
        "model": "gpt-4o",
        "system_prompt": "You are a pirate.",
    })
    assert res.status_code == 200
    assert calls[0]["model"] == "gpt-4o"
    assert calls[0]["messages"][0]["content"] == "You are a pirate."


async def test_send_empty_message_422(client):
    res = await client.post("/api/chat/send", json={"message": ""})
    assert res.status_code == 422


async def test_send_missing_body_422(client):
    assert (await client.post("/api/chat/send", json={})).status_code == 422


async def test_llm_timeout_returns_fallback_text(client, chat_db, monkeypatch):
    async def _no_background(self, recent):
        pass

    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _no_background)

    async def _timeout(**kwargs):
        raise asyncio.TimeoutError()

    monkeypatch.setattr("app.chat.memory.acompletion", _timeout)

    res = await client.post("/api/chat/send", json={"message": "slow"})
    assert res.status_code == 200
    assert "timeout" in res.json()["reply"].lower()


async def test_llm_generic_failure_returns_fallback_text(client, chat_db, monkeypatch):
    async def _no_background(self, recent):
        pass

    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _no_background)

    async def _boom(**kwargs):
        raise RuntimeError("api down")

    monkeypatch.setattr("app.chat.memory.acompletion", _boom)

    res = await client.post("/api/chat/send", json={"message": "hi"})
    assert res.status_code == 200
    assert "trouble" in res.json()["reply"].lower()


async def test_memory_context_injected_into_prompt(client, chat_db, fake_llm, monkeypatch):
    """Relevant memories are appended to the system message before the LLM call."""

    async def _no_background(self, recent):
        pass

    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _no_background)

    from sqlalchemy import select
    from app.chat.memory import Memory

    async with AsyncSessionLocal() as db:
        db.add(Memory(user_id="local_user", memory_text="User likes tea."))
        await db.commit()

    calls = fake_llm(["noted"])
    await client.post("/api/chat/send", json={"message": "tea reminder please"})

    system_content = calls[0]["messages"][0]["content"]
    assert "User likes tea." in system_content

