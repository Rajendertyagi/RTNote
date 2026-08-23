"""Options: generic key/value store for persisted app state.

Trilium persists open tabs the same way — an `openNoteContexts` option row
replayed at startup. We store `open-tabs` as a JSON string.
"""
from fastapi import APIRouter, HTTPException

from app.database.notes_db import get_db

router = APIRouter(prefix="/api/options", tags=["options"])


@router.get("/{key}")
async def get_option(key: str):
    conn = get_db()
    row = conn.execute("SELECT value FROM options WHERE key=?", (key,)).fetchone()
    conn.close()
    return {"key": key, "value": row["value"] if row else None}


@router.put("/{key}")
async def put_option(key: str, data: dict):
    if "value" not in data:
        raise HTTPException(status_code=400, detail="'value' required")
    conn = get_db()
    conn.execute(
        "INSERT INTO options (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP",
        (key, str(data["value"])),
    )
    conn.commit()
    conn.close()
    return {"key": key, "saved": True}
