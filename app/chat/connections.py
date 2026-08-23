"""Provider connection manager: API keys + base URLs in data/connections.json.

Keys are stored locally (data/ is gitignored) and only ever returned
masked by the API. At request time MemoryManager resolves the selected
model's provider and passes api_key/base_url to LiteLLM; env vars remain
the fallback when nothing is saved.
"""
import json
import os
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from litellm import acompletion
from pydantic import BaseModel

from app.config import CONNECTIONS_PATH

router = APIRouter(prefix="/api/connections", tags=["connections"])

# provider id -> display + LiteLLM mapping metadata
PROVIDERS = {
    "openai": {
        "label": "OpenAI",
        "model_prefixes": ("", "openai/"),
        "test_model": "gpt-4o-mini",
        "needs_key": True,
        "env_var": "OPENAI_API_KEY",
    },
    "anthropic": {
        "label": "Anthropic (Claude)",
        "model_prefixes": ("anthropic/",),
        "test_model": "anthropic/claude-sonnet-4-6",
        "needs_key": True,
        "env_var": "ANTHROPIC_API_KEY",
    },
    "deepseek": {
        "label": "DeepSeek",
        "model_prefixes": ("deepseek/",),
        "test_model": "deepseek/deepseek-chat",
        "needs_key": True,
        "env_var": "DEEPSEEK_API_KEY",
    },
    "google": {
        "label": "Google (Gemini)",
        "model_prefixes": ("gemini/",),
        "test_model": "gemini/gemini-2.0-flash",
        "needs_key": True,
        "env_var": "GEMINI_API_KEY",
    },
    "openrouter": {
        "label": "OpenRouter",
        "model_prefixes": ("openrouter/",),
        "test_model": "openrouter/openai/gpt-4o-mini",
        "needs_key": True,
        "env_var": "OPENROUTER_API_KEY",
    },
    "ollama": {
        "label": "Ollama (local)",
        "model_prefixes": ("ollama/",),
        "test_model": "ollama/llama3.2",
        "needs_key": False,
        "env_var": None,
    },
}

# Longest prefix wins so "openai/x" doesn't match the bare "" fallback.
_PREFIX_TO_PROVIDER = sorted(
    ((p, pid) for pid, p in ((pid, pref) for pid, meta in PROVIDERS.items() for pref in meta["model_prefixes"])),
    key=lambda kv: len(kv[0]),
    reverse=True,
)


def provider_for_model(model_id: str) -> str | None:
    """Map a LiteLLM model string to a provider id from the registry."""
    for prefix, pid in _PREFIX_TO_PROVIDER:
        if model_id.startswith(prefix):
            return pid
    return None


# ---------- Storage ----------
def load_connections() -> dict:
    try:
        return json.loads(CONNECTIONS_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_connections(cfg: dict) -> None:
    CONNECTIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = CONNECTIONS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    tmp.replace(CONNECTIONS_PATH)


def get_creds(provider: str) -> dict:
    return load_connections().get(provider, {})


def mask_key(key: str | None) -> str | None:
    if not key:
        return None
    return key[:3] + "…" + key[-4:] if len(key) > 10 else "…"


def is_configured(provider: str) -> bool:
    meta = PROVIDERS[provider]
    creds = get_creds(provider)
    if creds.get("api_key") or creds.get("base_url"):
        return True
    env_name = meta.get("env_var")
    return bool(env_name and os.getenv(env_name))


# ---------- Schemas ----------
class ConnectionIn(BaseModel):
    api_key: str | None = None
    base_url: str | None = None


# ---------- Routes ----------
@router.get("")
async def list_connections():
    out = []
    for pid, meta in PROVIDERS.items():
        creds = get_creds(pid)
        out.append({
            "id": pid,
            "label": meta["label"],
            "needs_key": meta["needs_key"],
            "env_var": meta["env_var"],
            "api_key_masked": mask_key(creds.get("api_key")),
            "base_url": creds.get("base_url"),
            "configured": is_configured(pid),
        })
    return out


@router.put("/{provider}")
async def update_connection(provider: str, body: ConnectionIn):
    if provider not in PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown provider")
    cfg = load_connections()
    entry = cfg.get(provider, {})
    if body.api_key is not None:
        entry["api_key"] = body.api_key.strip() or None
    if body.base_url is not None:
        entry["base_url"] = body.base_url.strip() or None
    cfg[provider] = {k: v for k, v in entry.items() if v}
    save_connections(cfg)
    creds = get_creds(provider)
    return {
        "id": provider,
        "api_key_masked": mask_key(creds.get("api_key")),
        "base_url": creds.get("base_url"),
        "configured": is_configured(provider),
        "saved": True,
    }


@router.delete("/{provider}")
async def delete_connection(provider: str):
    if provider not in PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown provider")
    cfg = load_connections()
    cfg.pop(provider, None)
    save_connections(cfg)
    return {"deleted": True}


@router.post("/{provider}/test")
async def test_connection(provider: str):
    if provider not in PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown provider")
    meta = PROVIDERS[provider]
    creds = get_creds(provider)

    kwargs = {"model": meta["test_model"]}
    if creds.get("api_key"):
        kwargs["api_key"] = creds["api_key"]
    elif meta["needs_key"] and not os.getenv(meta["env_var"] or "", ""):
        return {"ok": False, "error": f"No API key saved and {meta['env_var']} not set"}
    if creds.get("base_url"):
        kwargs["base_url"] = creds["base_url"]

    start = time.monotonic()
    try:
        await acompletion(
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=5,
            timeout=20,
            **kwargs,
        )
        return {"ok": True, "latency_ms": int((time.monotonic() - start) * 1000)}
    except Exception as exc:  # provider errors are user-facing here
        return {"ok": False, "error": str(exc)[:300]}
