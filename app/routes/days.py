"""Day notes (Journal): get-or-create a Year/Month/Day hierarchy.

Simplified port of Trilium's date_notes service: a top-level "Journal" note
holds year children ("2026"), which hold month children ("2026-08"), which
hold day notes ("2026-08-23"). Every level is found-or-created on demand.
"""
from datetime import datetime

from fastapi import APIRouter, HTTPException

from app.database.notes_db import get_db

router = APIRouter(prefix="/api/days", tags=["days"])


def _find_child(conn, parent_id, title):
    return conn.execute(
        "SELECT * FROM notes WHERE parent_id=? AND title=? AND deleted_at IS NULL LIMIT 1",
        (parent_id, title),
    ).fetchone()


def _create(conn, title, parent_id):
    cur = conn.execute(
        "INSERT INTO notes (title, content, parent_id, type) VALUES (?, '', ?, 'text')",
        (title, parent_id),
    )
    return conn.execute("SELECT * FROM notes WHERE id=?", (cur.lastrowid,)).fetchone()


@router.get("/{date_str}")
async def get_day_note(date_str: str):
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Date must be YYYY-MM-DD")

    conn = get_db()
    try:
        # Journal root (top-level)
        journal = conn.execute(
            "SELECT * FROM notes WHERE title='Journal' AND parent_id IS NULL AND deleted_at IS NULL LIMIT 1"
        ).fetchone()
        if not journal:
            journal = _create(conn, "Journal", None)

        year_title = f"{dt.year}"
        month_title = f"{dt.year}-{dt.month:02d}"
        day_title = date_str

        year = _find_child(conn, journal["id"], year_title) or _create(conn, year_title, journal["id"])
        month = _find_child(conn, year["id"], month_title) or _create(conn, month_title, year["id"])
        day = _find_child(conn, month["id"], day_title) or _create(conn, day_title, month["id"])

        conn.commit()

        return {
            "id": day["id"],
            "title": day["title"],
            "content": day["content"],
            "parent_id": day["parent_id"],
            "type": day["type"],
            "created": day["created_at"] == day["updated_at"],
        }
    finally:
        conn.close()
