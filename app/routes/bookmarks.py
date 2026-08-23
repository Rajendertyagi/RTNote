"""Bookmarks: ordered shortcuts to notes.

Our equivalent of Trilium's hidden `_lbBookmarks` container — since we have
no multi-parent cloning, ordering lives in a dedicated table instead of
branch positions.
"""
from fastapi import APIRouter, HTTPException

from app.database.notes_db import get_db

router = APIRouter(prefix="/api/bookmarks", tags=["bookmarks"])


@router.get("")
async def list_bookmarks():
    conn = get_db()
    rows = conn.execute(
        "SELECT n.id, n.title, n.type, b.position FROM bookmarks b "
        "JOIN notes n ON n.id = b.note_id "
        "WHERE n.deleted_at IS NULL ORDER BY b.position"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.post("")
async def add_bookmark(data: dict):
    note_id = data.get("note_id")
    if not isinstance(note_id, int):
        raise HTTPException(status_code=400, detail="note_id (int) required")

    conn = get_db()
    try:
        note = conn.execute(
            "SELECT id FROM notes WHERE id=? AND deleted_at IS NULL", (note_id,)
        ).fetchone()
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")

        already = conn.execute(
            "SELECT 1 FROM bookmarks WHERE note_id=?", (note_id,)
        ).fetchone()
        if already:
            return {"bookmarked": True, "already": True}

        max_pos = conn.execute(
            "SELECT COALESCE(MAX(position), -1) AS p FROM bookmarks"
        ).fetchone()["p"]
        conn.execute(
            "INSERT INTO bookmarks (note_id, position) VALUES (?, ?)",
            (note_id, max_pos + 1),
        )
        conn.commit()
        return {"bookmarked": True}
    finally:
        conn.close()


@router.delete("/{note_id}")
async def remove_bookmark(note_id: int):
    conn = get_db()
    conn.execute("DELETE FROM bookmarks WHERE note_id=?", (note_id,))
    conn.commit()
    conn.close()
    return {"bookmarked": False}
