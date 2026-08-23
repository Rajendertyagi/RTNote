"""Connection manager: CRUD, masking, provider mapping, test endpoint."""
import json

import pytest

from app.chat import connections as conn_mod
from app.chat.connections import (
    PROVIDERS,
    get_creds,
    load_connections,
    mask_key,
    provider_for_model,
    save_connections,
)


# ---------- Provider mapping ----------
def test_provider_mapping_prefixes():
    assert provider_for_model("gpt-4o-mini") == "openai"
    assert provider_for_model("openai/gpt-5.4") == "openai"
    assert provider_for_model("anthropic/claude-opus-4-6") == "anthropic"
    assert provider_for_model("deepseek/deepseek-v4-pro") == "deepseek"
    assert provider_for_model("gemini/gemini-2.0-flash") == "google"
    assert provider_for_model("openrouter/openai/gpt-4o-mini") == "openrouter"
    assert provider_for_model("ollama/llama3.2") == "ollama"


def test_mask_key():
    assert mask_key(None) is None
    assert mask_key("") is None
    masked = mask_key("sk-1234567890abcdef")
    assert masked.startswith("sk-") and masked.endswith("cdef")
    assert "1234567890" not in masked


# ---------- Storage ----------
def test_save_and_load_roundtrip(connections_store):
    save_connections({"openai": {"api_key": "sk-test"}})
    assert load_connections()["openai"]["api_key"] == "sk-test"
    assert connections_store.exists()


def test_atomic_write_leaves_no_tmp(connections_store):
    save_connections({"ollama": {"base_url": "http://x"}})
    assert not connections_store.with_suffix(".tmp").exists()


# ---------- API ----------
async def test_list_connections_all_providers(client):
    res = await client.get("/api/connections")
    providers = res.json()
    assert {p["id"] for p in providers} == set(PROVIDERS.keys())
    ollama = next(p for p in providers if p["id"] == "ollama")
    assert ollama["needs_key"] is False


async def test_put_masks_key_and_persists(client, connections_store):
    res = await client.put("/api/connections/openai", json={"api_key": "sk-secret-123456789"})
    body = res.json()
    assert body["saved"] is True and body["configured"] is True
    assert "sk-secret-123456789" not in json.dumps(body)

    listed = (await client.get("/api/connections")).json()
    openai = next(p for p in listed if p["id"] == "openai")
    assert openai["configured"] is True
    assert "sk-secret" not in json.dumps(listed)  # never leaks full key
    # raw value IS on disk for the app to use
    assert get_creds("openai")["api_key"] == "sk-secret-123456789"


async def test_put_unknown_provider_404(client):
    assert (await client.put("/api/connections/nope", json={"api_key": "x"})).status_code == 404


async def test_delete_connection(client):
    await client.put("/api/connections/deepseek", json={"api_key": "dk-12345678901234"})
    assert (await client.delete("/api/connections/deepseek")).json() == {"deleted": True}
    assert get_creds("deepseek") == {}
    assert (await client.delete("/api/connections/deepseek")).status_code == 200  # idempotent


async def test_env_fallback_counts_as_configured(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "env-key")
    listed = (await client.get("/api/connections")).json()
    anthropic = next(p for p in listed if p["id"] == "anthropic")
    assert anthropic["configured"] is True
    assert anthropic["api_key_masked"] is None  # env key not exposed


# ---------- Test endpoint ----------
async def test_test_endpoint_ok(client, monkeypatch):
    await client.put("/api/connections/openai", json={"api_key": "sk-live-key-123456"})
    calls = {}

    async def fake_ac(**kwargs):
        calls.update(kwargs)
        return object()

    monkeypatch.setattr(conn_mod, "acompletion", fake_ac)
    body = (await client.post("/api/connections/openai/test")).json()
    assert body["ok"] is True and isinstance(body["latency_ms"], int)
    assert calls["model"] == "gpt-4o-mini"
    assert calls["api_key"] == "sk-live-key-123456"


async def test_test_endpoint_reports_failure(client, monkeypatch):
    async def boom(**kwargs):
        raise RuntimeError("invalid api key")

    monkeypatch.setattr(conn_mod, "acompletion", boom)
    await client.put("/api/connections/openai", json={"api_key": "bad"})
    body = (await client.post("/api/connections/openai/test")).json()
    assert body["ok"] is False and "invalid api key" in body["error"]


async def test_test_endpoint_without_any_key(client, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    body = (await client.post("/api/connections/openai/test")).json()
    assert body["ok"] is False and "OPENAI_API_KEY" in body["error"]


async def test_ollama_uses_base_url_not_key(client, monkeypatch):
    await client.put("/api/connections/ollama", json={"base_url": "http://localhost:11434"})
    calls = {}

    async def fake_ac(**kwargs):
        calls.update(kwargs)
        return object()

    monkeypatch.setattr(conn_mod, "acompletion", fake_ac)
    body = (await client.post("/api/connections/ollama/test")).json()
    assert body["ok"] is True
    assert calls["base_url"] == "http://localhost:11434"
    assert "api_key" not in calls


# ---------- Integration with chat ----------
async def test_models_endpoint_flags_configured(client, monkeypatch):
    models = (await client.get("/api/chat/models")).json()
    by_id = {m["id"]: m for m in models}
    assert all(m["configured"] is False for m in models)  # nothing saved yet

    await client.put("/api/connections/anthropic", json={"api_key": "ant-key-12345678"})
    models = (await client.get("/api/chat/models")).json()
    by_id = {m["id"]: m for m in models}
    assert by_id["anthropic/claude-opus-4-6"]["configured"] is True
    assert by_id["gpt-4o-mini"]["configured"] is False


async def test_memory_manager_passes_saved_key(chat_db, fake_llm, monkeypatch):
    from app.chat.db import AsyncSessionLocal
    from app.chat.memory import MemoryManager

    async def _noop(self, recent):
        pass

    monkeypatch.setattr(MemoryManager, "_extract_memories_background", _noop)
    save_connections({"anthropic": {"api_key": "ant-saved-key"}})
    calls = fake_llm(["ok"])

    async with AsyncSessionLocal() as db:
        m = MemoryManager(db=db, model="anthropic/claude-opus-4-6")
        await m.load_session()
        await m.add_user_message("hi")
        await m.get_response()

    assert calls[0]["api_key"] == "ant-saved-key"


async def test_memory_manager_no_key_when_unconfigured(chat_db, fake_llm):
    from app.chat.db import AsyncSessionLocal
    from app.chat.memory import MemoryManager

    calls = fake_llm(["ok"])

    async with AsyncSessionLocal() as db:
        m = MemoryManager(db=db, model="gpt-4o-mini")
        await m.load_session()
        await m.add_user_message("hi")
        await m.get_response()

    assert "api_key" not in calls[0]
