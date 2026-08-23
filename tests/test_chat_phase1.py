"""Phase-1 chat fixes: history windowing, disconnect-safe partial saves,
provider-aware memory extraction, clear-field credentials, and the shared
chat-core contract between the mini and full adapters."""
import json
import re
from pathlib import Path

from app.chat.db import AsyncSessionLocal
from app.chat.connections import save_connections
from app.chat.memory import ChatSession, MemoryManager
from app.config import CHAT_HISTORY_LIMIT


def _patch(monkeypatch):
    async def _noop(self, recent):
        pass
    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _noop)


# ---------- History windowing ----------
async def test_window_trims_llm_payload_but_keeps_full_history(client, chat_db, fake_llm, monkeypatch):
    _patch(monkeypatch)
    calls = fake_llm(["ok"])

    res = await client.post("/api/chat/send", json={"message": "first"})
    sid = res.json()["session_id"]
    for i in range(CHAT_HISTORY_LIMIT + 5):
        await client.post("/api/chat/send", json={"message": f"turn {i}", "session_id": sid})

    sent = calls[-1]["messages"]
    assert len(sent) <= CHAT_HISTORY_LIMIT  # wire payload is windowed
    assert sent[0]["role"] == "system"  # system prompt always survives trimming
    assert sent[-1]["content"].endswith(f"turn {CHAT_HISTORY_LIMIT + 4}")

    async with AsyncSessionLocal() as db:
        row = await db.get(ChatSession, sid)
        stored = json.loads(row.messages)
    assert len(stored) > CHAT_HISTORY_LIMIT  # DB keeps everything
    assert stored[1]["content"] == "first"


# ---------- Disconnect-safe partial save ----------
async def test_stream_persists_partial_reply_on_disconnect(client, chat_db, monkeypatch):
    class _Delta:
        def __init__(self, text):
            self.choices = [type("C", (), {"delta": type("D", (), {"content": text})()})()]

    async def _streaming_llm(**kwargs):
        async def _gen():
            for part in ["Hel", "lo ", "wor", "ld"]:
                yield _Delta(part)
        return _gen()

    monkeypatch.setattr("app.chat.memory.acompletion", _streaming_llm)

    async with AsyncSessionLocal() as db:
        m = MemoryManager(db=db)
        await m.load_session()
        await m.add_user_message("hi")
        sid = await m.ensure_session()

        gen = m.stream_response()
        deltas = []
        async for d in gen:
            deltas.append(d)
            if "".join(deltas).strip() == "Hello":
                break  # simulate the user closing the tab mid-stream
        await gen.aclose()

        row = await db.get(ChatSession, sid)
        stored = json.loads(row.messages)

    assert "".join(deltas) == "Hello "
    # partial reply persisted exactly once — no duplicates, no error text
    assert stored[-1] == {"role": "assistant", "content": "Hello "}
    assert sum(1 for x in stored if x["role"] == "assistant") == 1

    # session remains valid: the conversation continues normally afterwards
    async def _noop(self, recent):
        pass

    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _noop)

    async def _canned(**kwargs):
        resp = type("R", (), {})()
        resp.choices = [type("C", (), {})()]
        resp.choices[0].message = type("M", (), {})()
        resp.choices[0].message.content = "continued"
        return resp

    monkeypatch.setattr("app.chat.memory.acompletion", _canned)
    res = await client.post("/api/chat/send", json={"message": "keep going", "session_id": sid})
    assert res.status_code == 200
    assert res.json()["session_id"] == sid

    async with AsyncSessionLocal() as db:
        row = await db.get(ChatSession, sid)
        stored2 = json.loads(row.messages)
    assert [x["role"] for x in stored2] == [
        "system", "user", "assistant", "user", "assistant",
    ]
    assert stored2[2]["content"] == "Hello "  # partial untouched by the continuation


# ---------- Provider-aware memory extraction ----------
async def test_extraction_skipped_when_provider_unconfigured(chat_db, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    async with AsyncSessionLocal() as db:
        m = MemoryManager(db=db, model="gpt-4o-mini")
        assert m._resolve_memory_model() is None
        # must be a silent no-op, never a doomed LLM call
        await m._extract_memories_background([{"role": "user", "content": "x"}])


async def test_extraction_uses_cheap_model_from_same_provider(chat_db):
    save_connections({"anthropic": {"api_key": "ant-key-12345678"}})
    async with AsyncSessionLocal() as db:
        m = MemoryManager(db=db, model="anthropic/claude-opus-4-6")
        assert m._resolve_memory_model() == "anthropic/claude-sonnet-4-6"


async def test_keyless_provider_counts_as_configured_for_extraction(chat_db):
    async with AsyncSessionLocal() as db:
        m = MemoryManager(db=db, model="ollama/llama3")
        assert m._resolve_memory_model() == "ollama/llama3.2"


# ---------- Shared chat-core contract (mini vs full adapters) ----------
def test_chat_adapters_use_shared_core_and_no_duplicate_logic():
    repo = Path(__file__).resolve().parent.parent
    ui = (repo / "frontend" / "static" / "js" / "ui.js").read_text(encoding="utf-8")
    full = (repo / "frontend" / "static" / "js" / "chat.js").read_text(encoding="utf-8")
    core = (repo / "frontend" / "static" / "js" / "chat-core.js").read_text(encoding="utf-8")

    # both adapters consume the shared layer
    assert "ChatCore." in ui and "ChatCore." in full
    # the canonical default prompt lives in exactly one place
    assert core.count('DEFAULT_SYSTEM_PROMPT = "') == 1
    assert 'DEFAULT_SYSTEM_PROMPT = "' not in ui and 'DEFAULT_SYSTEM_PROMPT = "' not in full
    # no duplicated attachment-extension regex in the adapters
    ext_re = re.compile(r"\.\(txt\|md\|markdown")
    assert not ext_re.search(ui) and not ext_re.search(full)
    # intentional transports preserved: mini blocks on /send, full streams
    assert "ChatCore.send(" in ui and "ChatCore.stream(" not in ui
    assert "ChatCore.stream(" in full and "ChatCore.send(" not in full
    # the transports themselves live in exactly one place (the shared core)
    assert core.count('"/api/chat/send"') == 1 and core.count('"/api/chat/stream"') == 1
