"""Stream error paths: LLM failure and timeout must emit a structured
`error` SSE event (never a 500, never a fake assistant message)."""
import json

from app.chat.db import AsyncSessionLocal
from app.chat.memory import ChatSession, MemoryManager


def _parse_sse(raw: str):
    events = []
    for block in raw.split("\n\n"):
        for line in block.split("\n"):
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


async def _no_background(self, recent):
    pass


async def test_stream_llm_failure_emits_error_event_not_500(client, chat_db, monkeypatch):
    async def _boom(**kwargs):
        raise RuntimeError("provider exploded")

    monkeypatch.setattr("app.chat.memory.acompletion", _boom)
    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _no_background)

    res = await client.post("/api/chat/stream", json={"message": "hi"})
    assert res.status_code == 200  # SSE contract: errors ride the stream
    assert "text/event-stream" in res.headers["content-type"]

    events = _parse_sse(res.text)
    assert events[0]["type"] == "meta"
    assert not [e for e in events if e["type"] == "delta"]  # no fake content
    errors = [e for e in events if e["type"] == "error"]
    assert len(errors) == 1 and "failed" in errors[0]["text"].lower()
    assert events[-1] == {"type": "done"}

    # The error text is NOT persisted as an assistant message
    sid = events[0]["session_id"]
    async with AsyncSessionLocal() as db:
        row = await db.get(ChatSession, sid)
        stored = json.loads(row.messages)
    assert stored[-1]["role"] == "user"


async def test_stream_timeout_emits_error_event(client, chat_db, monkeypatch):
    import asyncio

    async def _timeout(**kwargs):
        # Same exception asyncio.wait_for raises on the real 120s deadline,
        # raised immediately so the test stays fast and deterministic.
        raise asyncio.TimeoutError()

    monkeypatch.setattr("app.chat.memory.acompletion", _timeout)
    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _no_background)

    res = await client.post("/api/chat/stream", json={"message": "hi"})
    assert res.status_code == 200
    events = _parse_sse(res.text)
    assert not [e for e in events if e["type"] == "delta"]
    errors = [e for e in events if e["type"] == "error"]
    assert len(errors) == 1 and "too long" in errors[0]["text"]
