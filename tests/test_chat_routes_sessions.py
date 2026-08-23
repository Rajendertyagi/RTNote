"""Chat routes: sessions list/history/delete and memories endpoints."""
import json

from app.chat.db import AsyncSessionLocal
from app.chat.memory import ChatSession, Memory


async def _add_session(title, messages=None):
    async with AsyncSessionLocal() as db:
        s = ChatSession(title=title, messages=json.dumps(messages or []))
        db.add(s)
        await db.commit()
        return s.id


async def test_list_sessions_empty(client):
    assert (await client.get("/api/chat/sessions")).json() == []


async def test_list_sessions_ordered_most_recent_first(client):
    old = await _add_session("Old")
    new = await _add_session("New")
    async with AsyncSessionLocal() as db:
        row = await db.get(ChatSession, old)
        row.updated_at = row.updated_at.replace(year=2020)
        await db.commit()

    listed = (await client.get("/api/chat/sessions")).json()
    assert [s["id"] for s in listed] == [new, old]
    assert {"id", "title", "updated_at", "created_at"} <= set(listed[0])


async def test_history_unknown_session_404(client):
    assert (await client.get("/api/chat/history/99999")).status_code == 404


async def test_history_returns_messages(client):
    sid = await _add_session("S", [{"role": "user", "content": "hey"}])
    body = (await client.get(f"/api/chat/history/{sid}")).json()
    assert body["session_id"] == sid
    roles = [m["role"] for m in body["messages"]]
    assert roles == ["system", "user"]  # system prompt injected on load


async def test_delete_session_then_history_404(client):
    sid = await _add_session("Doomed")
    res = await client.delete(f"/api/chat/sessions/{sid}")
    assert res.status_code == 204
    assert (await client.get(f"/api/chat/history/{sid}")).status_code == 404
    assert (await client.delete(f"/api/chat/sessions/{sid}")).status_code == 404


async def test_list_memories_for_user(client):
    async with AsyncSessionLocal() as db:
        db.add(Memory(user_id="local_user", memory_text="fact one"))
        db.add(Memory(user_id="other", memory_text="fact two"))
        await db.commit()

    body = (await client.get("/api/chat/memories")).json()
    assert body == {"user_id": "local_user", "memories": ["fact one"]}
    other = (await client.get("/api/chat/memories", params={"user_id": "other"})).json()
    assert other["memories"] == ["fact two"]


async def test_delete_memory_by_id(client):
    async with AsyncSessionLocal() as db:
        mem = Memory(user_id="local_user", memory_text="to delete")
        db.add(mem)
        await db.commit()
        mid = mem.id

    assert (await client.delete(f"/api/chat/memories/{mid}")).status_code == 204
    assert (await client.delete(f"/api/chat/memories/{mid}")).status_code == 404
