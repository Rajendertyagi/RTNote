"""Reasoning effort, attachments, and SSE streaming."""
import json

from app.chat.db import AsyncSessionLocal
from app.chat.memory import ChatSession, MemoryManager


async def _no_background(self, recent):
    pass


def _patch(monkeypatch):
    async def _noop(self, recent):
        pass
    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _noop)


async def test_send_forwards_reasoning_effort_to_llm(client, chat_db, fake_llm, monkeypatch):
    _patch(monkeypatch)
    calls = fake_llm(["ok"])
    res = await client.post("/api/chat/send", json={
        "message": "think hard",
        "model": "anthropic/claude-opus-4-6",
        "reasoning_effort": "high",
    })
    assert res.status_code == 200
    assert calls[0]["reasoning_effort"] == "high"


async def test_send_without_effort_omits_kwarg(client, chat_db, fake_llm, monkeypatch):
    _patch(monkeypatch)
    calls = fake_llm(["ok"])
    await client.post("/api/chat/send", json={"message": "plain"})
    assert "reasoning_effort" not in calls[0]


async def test_attachments_are_injected_into_user_message(client, chat_db, fake_llm, monkeypatch):
    _patch(monkeypatch)
    calls = fake_llm(["ok"])
    res = await client.post("/api/chat/send", json={
        "message": "summarize",
        "attachments": [
            {"filename": "notes.md", "content": "# Plan\nDo the thing."},
            {"filename": "data.csv", "content": "a,b\n1,2"},
        ],
    })
    assert res.status_code == 200
    sent_user = calls[0]["messages"][-1]
    assert sent_user["role"] == "user"
    assert "--- Attached file: notes.md ---" in sent_user["content"]
    assert "a,b\n1,2" in sent_user["content"]
    # attachments persisted with the session
    sid = res.json()["session_id"]
    async with AsyncSessionLocal() as db:
        row = await db.get(ChatSession, sid)
        stored = json.loads(row.messages)
    assert "Attached file: data.csv" in stored[-2]["content"]  # last user msg


def _parse_sse(raw: str):
    events = []
    for block in raw.split("\n\n"):
        for line in block.split("\n"):
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


class _FakeDelta:
    def __init__(self, text):
        self.delta = type("D", (), {"content": text})()


class _FakeChunk:
    def __init__(self, text):
        self.choices = [_FakeDelta(text)]


async def test_stream_endpoint_emits_sse_events(client, chat_db, monkeypatch):
    _patch(monkeypatch)

    async def _streaming_llm(**kwargs):
        assert kwargs.get("stream") is True
        async def _gen():
            for part in ["Hel", "lo ", "world"]:
                yield _FakeChunk(part)
        return _gen()

    monkeypatch.setattr("app.chat.memory.acompletion", _streaming_llm)

    res = await client.post("/api/chat/stream", json={"message": "hi"})
    assert res.status_code == 200
    assert "text/event-stream" in res.headers["content-type"]

    events = _parse_sse(res.text)
    assert events[0] == {"type": "meta", "session_id": events[0]["session_id"]}
    deltas = [e["text"] for e in events if e["type"] == "delta"]
    assert "".join(deltas) == "Hello world"
    assert events[-1] == {"type": "done"}

    # session persisted with the full reply
    sid = events[0]["session_id"]
    async with AsyncSessionLocal() as db:
        row = await db.get(ChatSession, sid)
        stored = json.loads(row.messages)
    assert stored[-1]["role"] == "assistant"
    assert stored[-1]["content"] == "Hello world"


async def test_stream_continues_existing_session(client, chat_db, monkeypatch):
    _patch(monkeypatch)

    async def _streaming_llm(**kwargs):
        async def _gen():
            yield _FakeChunk("two")
        return _gen()

    monkeypatch.setattr("app.chat.memory.acompletion", _streaming_llm)

    first = (await client.post("/api/chat/stream", json={"message": "one"}))
    sid = _parse_sse(first.text)[0]["session_id"]
    second = await client.post("/api/chat/stream", json={"message": "two", "session_id": sid})
    sid2 = _parse_sse(second.text)[0]["session_id"]
    assert sid2 == sid

    async with AsyncSessionLocal() as db:
        row = await db.get(ChatSession, sid)
        stored = json.loads(row.messages)
    assert [m["role"] for m in stored] == ["system", "user", "assistant", "user", "assistant"]


async def test_stream_empty_message_422(client):
    assert (await client.post("/api/chat/stream", json={"message": ""})).status_code == 422
