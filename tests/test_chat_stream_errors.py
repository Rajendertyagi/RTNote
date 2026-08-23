"""Stream error paths: LLM failure and timeout must degrade to a friendly
fallback delta (never a 500), and the session must still be persisted."""
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


async def test_stream_llm_failure_yields_fallback_not_500(client, chat_db, monkeypatch):
    async def _boom(**kwargs):
        raise RuntimeError("provider exploded")

    monkeypatch.setattr("app.chat.memory.acompletion", _boom)
    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _no_background)

    res = await client.post("/api/chat/stream", json={"message": "hi"})
    assert res.status_code == 200  # SSE contract: errors ride the stream
    assert "text/event-stream" in res.headers["content-type"]

    events = _parse_sse(res.text)
    assert events[0]["type"] == "meta"
    deltas = "".join(e["text"] for e in events if e["type"] == "delta")
    assert "trouble generating" in deltas
    assert events[-1] == {"type": "done"}

    # The fallback reply is persisted so history stays coherent
    sid = events[0]["session_id"]
    async with AsyncSessionLocal() as db:
        row = await db.get(ChatSession, sid)
        stored = json.loads(row.messages)
    assert stored[-1]["role"] == "assistant"
    assert "trouble generating" in stored[-1]["content"]


async def test_stream_timeout_yields_timeout_fallback(client, chat_db, monkeypatch):
    import asyncio

    async def _timeout(**kwargs):
        # Same exception asyncio.wait_for raises on the real 120s deadline,
        # raised immediately so the test stays fast and deterministic.
        raise asyncio.TimeoutError()

    monkeypatch.setattr("app.chat.memory.acompletion", _timeout)
    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _no_background)

    res = await client.post("/api/chat/stream", json={"message": "hi"})
    assert res.status_code == 200
    deltas = "".join(
        e["text"] for e in _parse_sse(res.text) if e["type"] == "delta"
    )
    assert "timeout" in deltas
