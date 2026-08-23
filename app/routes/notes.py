"""Notes CRUD + full-text search routes.

Deletion follows Trilium's model: DELETE is a *soft* delete that marks the
whole subtree with `deleted_at` + a shared `delete_id` (restorable via
/api/trash). Physical erasure happens only through Trash → Empty.

All handlers use `with db() as conn:` — commit/rollback/close guaranteed,
so no failed request can ever leak a lock.
"""
import secrets
from datetime import datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app.database.notes_db import db

router = APIRouter(prefix="/api", tags=["notes"])

# Allowed note types — mirrors docs/ROADMAP.md (P0 + P5)
NOTE_TYPES = {"text", "html", "page", "webview", "mermaid", "mindMap"}


def _note_dict(n) -> dict:
    keys = n.keys()
    return {
        "id": n["id"],
        "title": n["title"],
        "content": n["content"],
        "parent_id": n["parent_id"],
        "type": n["type"] if "type" in keys else "text",
        "mime": n["mime"] if "mime" in keys else None,
        "start_date": n["start_date"] if "start_date" in keys else None,
        "end_date": n["end_date"] if "end_date" in keys else None,
    }


def _subtree_ids(conn, root_id: int) -> list[int]:
    """Collect root_id plus all live descendant ids (BFS)."""
    ids = [root_id]
    frontier = [root_id]
    while frontier:
        placeholders = ",".join("?" * len(frontier))
        rows = conn.execute(
            f"SELECT id FROM notes WHERE parent_id IN ({placeholders}) AND deleted_at IS NULL",
            frontier,
        ).fetchall()
        frontier = [r["id"] for r in rows]
        ids.extend(frontier)
    return ids


@router.get("/notes")
async def list_notes():
    with db() as conn:
        notes = conn.execute(
            "SELECT * FROM notes WHERE deleted_at IS NULL ORDER BY created_at"
        ).fetchall()
    return [_note_dict(n) for n in notes]


@router.post("/notes")
async def create_note(data: dict):
    note_type = data.get("type", "text")
    if note_type not in NOTE_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid note type '{note_type}'")
    with db() as conn:
        cursor = conn.execute(
            "INSERT INTO notes (title, content, parent_id, type, mime, start_date, end_date) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                data.get("title", "Untitled"),
                data.get("content", ""),
                data.get("parent_id"),
                note_type,
                data.get("mime"),
                data.get("start_date"),
                data.get("end_date"),
            ),
        )
        note_id = cursor.lastrowid
        row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    return _note_dict(row)


@router.post("/notes/{note_id}/duplicate")
async def duplicate_note(note_id: int):
    """Deep-copy a subtree. New root title gets ' (copy)' suffix."""
    with db() as conn:
        root = conn.execute(
            "SELECT * FROM notes WHERE id=? AND deleted_at IS NULL", (note_id,)
        ).fetchone()
        if not root:
            raise HTTPException(status_code=404, detail="Note not found")

        id_map: dict[int, int] = {}

        def copy_row(row, new_parent):
            cur = conn.execute(
                "INSERT INTO notes (title, content, parent_id, type, mime) VALUES (?, ?, ?, ?, ?)",
                (
                    row["title"] + " (copy)" if row["id"] == note_id else row["title"],
                    row["content"],
                    new_parent,
                    row["type"],
                    row["mime"],
                ),
            )
            id_map[row["id"]] = cur.lastrowid
            children = conn.execute(
                "SELECT * FROM notes WHERE parent_id=? AND deleted_at IS NULL", (row["id"],)
            ).fetchall()
            for child in children:
                copy_row(child, cur.lastrowid)

        copy_row(root, root["parent_id"])
        new_root = conn.execute("SELECT * FROM notes WHERE id=?", (id_map[note_id],)).fetchone()
    return _note_dict(new_root)


@router.get("/notes/{note_id}")
async def get_note(note_id: int):
    with db() as conn:
        note = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    d = _note_dict(note)
    d["deleted_at"] = note["deleted_at"] if "deleted_at" in note.keys() else None
    return d


@router.put("/notes/{note_id}")
async def update_note(note_id: int, data: dict):
    """Partial update: only fields present in the body are changed."""
    if "type" in data and data["type"] not in NOTE_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid note type '{data['type']}'")

    with db() as conn:
        existing = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Note not found")

        title = data["title"] if "title" in data else existing["title"]
        content = data["content"] if "content" in data else existing["content"]
        note_type = data["type"] if "type" in data else existing["type"]
        mime = data["mime"] if "mime" in data else existing["mime"]
        start_date = data["start_date"] if "start_date" in data else existing["start_date"]
        end_date = data["end_date"] if "end_date" in data else existing["end_date"]

        conn.execute(
            "UPDATE notes SET title=?, content=?, type=?, mime=?, start_date=?, end_date=?, "
            "updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (title, content, note_type, mime, start_date, end_date, note_id),
        )
        row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    return _note_dict(row)


@router.delete("/notes/{note_id}")
async def delete_note(note_id: int):
    """Soft-delete the note and its whole subtree under one delete_id."""
    with db() as conn:
        exists = conn.execute(
            "SELECT id FROM notes WHERE id=? AND deleted_at IS NULL", (note_id,)
        ).fetchone()
        if not exists:
            raise HTTPException(status_code=404, detail="Note not found or already deleted")

        ids = _subtree_ids(conn, note_id)
        delete_id = secrets.token_hex(8)
        now = datetime.utcnow().isoformat(timespec="seconds")
        placeholders = ",".join("?" * len(ids))
        conn.execute(
            f"UPDATE notes SET deleted_at=?, delete_id=? WHERE id IN ({placeholders})",
            [now, delete_id] + ids,
        )
        conn.execute(f"DELETE FROM bookmarks WHERE note_id IN ({placeholders})", ids)
    return {"deleted": True, "count": len(ids), "delete_id": delete_id}


@router.get("/search")
async def search_notes(q: str):
    """FTS5 full-text search; returns id, title, snippet and tree path."""
    with db() as conn:
        try:
            rows = conn.execute(
                "SELECT notes.id, notes.title, notes.content FROM notes_fts "
                "JOIN notes ON notes.id = notes_fts.rowid "
                "WHERE notes_fts MATCH ? AND notes.deleted_at IS NULL",
                (q,),
            ).fetchall()
        except Exception:
            rows = conn.execute(
                "SELECT id, title, content FROM notes "
                "WHERE deleted_at IS NULL AND (title LIKE ? OR content LIKE ?)",
                (f"%{q}%", f"%{q}%"),
            ).fetchall()

        results = []
        for r in rows:
            # Walk up parent chain to build breadcrumb path
            path_parts = []
            nid = r["id"]
            while nid:
                n = conn.execute(
                    "SELECT id, title, parent_id FROM notes WHERE id = ?", (nid,)
                ).fetchone()
                if not n:
                    break
                path_parts.append(n["title"])
                nid = n["parent_id"]
            path_parts.reverse()

            content = r["content"] or ""
            snippet = content[:150] + ("..." if len(content) > 150 else "")
            results.append({"id": r["id"], "title": r["title"], "snippet": snippet, "path": " > ".join(path_parts)})

    return results


@router.get("/calendar")
async def calendar_events(start: str, end: str):
    """Notes whose [start_date, end_date] window intersects the given range
    (inclusive). Feeds the FullCalendar month view."""
    with db() as conn:
        rows = conn.execute(
            """
            SELECT id, title, type, start_date, end_date FROM notes
            WHERE deleted_at IS NULL AND start_date IS NOT NULL
              AND start_date <= ? AND COALESCE(end_date, start_date) >= ?
            ORDER BY start_date
            """,
            (end, start),
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/notes/{note_id}/raw")
async def get_note_raw(note_id: int):
    """Serve a page-note's content as real HTML for the sandboxed preview
    iframe. The iframe's `sandbox` attribute (opaque origin) is the security
    boundary — no sanitization, matching Trilium's render-note approach."""
    with db() as conn:
        row = conn.execute(
            "SELECT content, type FROM notes WHERE id=? AND deleted_at IS NULL",
            (note_id,),
        ).fetchone()
    if not row or row["type"] != "page":
        raise HTTPException(status_code=404, detail="No renderable page")
    return Response(
        content=row["content"] or "",
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )
