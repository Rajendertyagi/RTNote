"""Trash: list / restore / empty soft-deleted notes.

Mirrors Trilium: deletion is reversible until erasure. A restore brings back
the whole delete-group (the subtree deleted together); if the restored root's
old parent chain is itself in the trash, the note is re-parented to top level.
"""
from fastapi import APIRouter, HTTPException

from app.database.notes_db import db

router = APIRouter(prefix="/api/trash", tags=["trash"])


@router.get("")
async def list_trash():
    with db() as conn:
        rows = conn.execute(
            "SELECT id, title, deleted_at, delete_id FROM notes "
            "WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/{note_id}/restore")
async def restore_note(note_id: int):
    with db() as conn:
        note = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")
        if not note["deleted_at"]:
            raise HTTPException(status_code=400, detail="Note is not in trash")

        # Restore the whole group that was deleted together
        group = conn.execute(
            "SELECT id FROM notes WHERE delete_id=?", (note["delete_id"],)
        ).fetchall()
        ids = [r["id"] for r in group]
        placeholders = ",".join("?" * len(ids))
        conn.execute(
            f"UPDATE notes SET deleted_at=NULL, delete_id=NULL WHERE id IN ({placeholders})",
            ids,
        )

        # If an ancestor is still in trash, re-parent to top level (orphan rule)
        reparented = False
        pid = note["parent_id"]
        while pid:
            parent = conn.execute(
                "SELECT id, parent_id, deleted_at FROM notes WHERE id=?", (pid,)
            ).fetchone()
            if not parent:
                break
            if parent["deleted_at"]:
                conn.execute("UPDATE notes SET parent_id=NULL WHERE id=?", (note_id,))
                reparented = True
                break
            pid = parent["parent_id"]

    return {"restored": True, "count": len(ids), "reparented_to_root": reparented}


@router.post("/empty")
async def empty_trash():
    """Physically erase ALL soft-deleted notes. FTS triggers keep the index in sync."""
    with db() as conn:
        roots = conn.execute(
            "SELECT id FROM notes WHERE deleted_at IS NOT NULL"
        ).fetchall()

        frontier = [r["id"] for r in roots]
        seen = set(frontier)
        while frontier:
            placeholders = ",".join("?" * len(frontier))
            rows = conn.execute(
                f"SELECT id FROM notes WHERE parent_id IN ({placeholders})", frontier
            ).fetchall()
            frontier = [r["id"] for r in rows if r["id"] not in seen]
            for nid in frontier:
                seen.add(nid)

        all_ids = list(seen)
        if all_ids:
            placeholders = ",".join("?" * len(all_ids))
            conn.execute(f"DELETE FROM bookmarks WHERE note_id IN ({placeholders})", all_ids)
            conn.execute(f"DELETE FROM notes WHERE id IN ({placeholders})", all_ids)
    return {"erased": len(all_ids)}
