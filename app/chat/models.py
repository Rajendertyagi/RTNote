"""Curated model catalog for the chat UI.

`efforts` lists the reasoning levels a model accepts (LiteLLM normalizes
`reasoning_effort` per provider). Models without `efforts` hide the
Thinking control in the UI. Users can still type any LiteLLM model string
(e.g. "ollama/llama3") into the custom field.
"""
from fastapi import APIRouter

router = APIRouter(prefix="/api/chat", tags=["chat-models"])

MODELS = [
    {
        "id": "gpt-4o-mini",
        "name": "GPT-4o mini",
        "provider": "OpenAI",
        "description": "Fast and cheap default",
        "efforts": [],
    },
    {
        "id": "gpt-5.4-mini",
        "name": "GPT-5.4 Mini",
        "provider": "OpenAI",
        "description": "Fast reasoning model",
        "efforts": ["low", "medium", "high", "xhigh"],
    },
    {
        "id": "gpt-5.4",
        "name": "GPT-5.4",
        "provider": "OpenAI",
        "description": "Flagship general model",
        "efforts": ["low", "medium", "high", "xhigh"],
    },
    {
        "id": "anthropic/claude-sonnet-4-6",
        "name": "Claude Sonnet 4.6",
        "provider": "Anthropic",
        "description": "Balanced quality/speed",
        "efforts": ["low", "medium", "high"],
    },
    {
        "id": "anthropic/claude-opus-4-6",
        "name": "Claude Opus 4.6",
        "provider": "Anthropic",
        "description": "Most capable Claude",
        "efforts": ["low", "medium", "high", "max"],
    },
    {
        "id": "deepseek/deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "provider": "DeepSeek",
        "description": "Strong reasoning, low cost",
        "efforts": ["high", "max"],
    },
]

EFFORT_LABELS = {
    "minimal": "Minimal",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Max+",
    "max": "Max",
}


@router.get("/models")
async def list_models():
    """Curated catalog + valid effort levels + connection status for the UI."""
    from app.chat.connections import is_configured, provider_for_model

    result = []
    for m in MODELS:
        pid = provider_for_model(m["id"])
        configured = bool(pid and is_configured(pid))
        result.append({
            **m,
            "configured": configured,
            "effort_labels": {e: EFFORT_LABELS[e] for e in m["efforts"]},
        })
    return result
