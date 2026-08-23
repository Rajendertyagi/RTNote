"""Notes CRUD + full-text search routes.

Deletion follows Trilium's model: DELETE is a *soft* delete that marks the
whole subtree with `deleted_at` + a shared `delete_id` (restorable via
/api/trash). Physical erasure happens only through Trash → Empty.

All handlers use `with db() as conn:` — commit/rollback/close guaranteed,
so no failed request can ever leak a lock.
"""
import logging
import secrets
from datetime import datetime

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app.database.notes_db import db

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["notes"])

# Allowed note types — mirrors docs/ROADMAP.md (P0 + P5 + F4)
NOTE_TYPES = {"text", "html", "page", "webview", "mermaid", "mindMap", "code"}

# Curated code-note mimes — subset of Trilium's `codeNotesMimeTypes` option,
# limited to what our CodeMirror 6 loader has a language mode for.
CODE_MIMES = {
    "text/plain",
    "text/x-python",
    "text/javascript",
    "application/typescript",
    "application/json",
    "text/css",
    "text/html",
    "text/x-markdown",
    "text/x-sql",
    "text/xml",
    "text/x-yaml",
    "text/x-sh",
    "text/x-csrc",
    "text/x-c++src",
    "text/x-csharp",
    "text/x-java",
    "text/x-go",
    "text/x-rust",
}


def _validate_mime(note_type: str, mime) -> str | None:
    """Code notes carry a whitelisted mime (default text/plain); other types pass through."""
    if note_type != "code":
        return mime
    if not mime:
        return "text/plain"
    if mime not in CODE_MIMES:
        raise HTTPException(status_code=400, detail=f"Invalid code mime '{mime}'")
    return mime


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
        "position": n["position"] if "position" in keys else None,
    }


def _live_siblings(conn, parent_id, exclude_id=None):
    """Live siblings of a parent (parent_id may be NULL = root), ordered by
    the deterministic sibling order: explicit position, then id."""
    rows = conn.execute(
        "SELECT id, position FROM notes "
        "WHERE parent_id IS ? AND deleted_at IS NULL AND id != ? "
        "ORDER BY COALESCE(position, id), id",
        (parent_id, exclude_id if exclude_id is not None else -1),
    ).fetchall()
    return [r["id"] for r in rows]


def _is_ancestor(conn, ancestor_id, note_id):
    """True when ancestor_id lies on note_id's parent chain."""
    cur = note_id
    guard = 0
    while cur is not None and guard < 10000:
        if cur == ancestor_id:
            return True
        row = conn.execute("SELECT parent_id FROM notes WHERE id=?", (cur,)).fetchone()
        cur = row["parent_id"] if row else None
        guard += 1
    return False


@router.post("/notes/{note_id}/move")
async def move_note(note_id: int, data: dict):
    """Move/reorder a note (GUI-4).

    Body: {"parent_id": int|null, "position": int}
    - parent_id null = root level
    - position = 0-based insert index among the destination's live siblings
      (clamped to range)

    Validates self-parent, cycles, destination existence and deleted
    destination; renumbers affected sibling sets atomically. Subtree moves
    need no child updates — children keep their parent_id pointing at the
    moved note.
    """
    new_parent = data.get("parent_id")
    position = data.get("position")

    if not isinstance(position, int) or isinstance(position, bool) or position < 0:
        raise HTTPException(status_code=400, detail="Invalid position")
    if new_parent is not None and not isinstance(new_parent, int):
        raise HTTPException(status_code=400, detail="Invalid parent_id")

    with db() as conn:
        note = conn.execute(
            "SELECT * FROM notes WHERE id=? AND deleted_at IS NULL", (note_id,)
        ).fetchone()
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")

        old_parent = note["parent_id"]

        if new_parent == note_id:
            raise HTTPException(status_code=400, detail="A note cannot be its own parent")

        if new_parent is not None:
            parent_row = conn.execute(
                "SELECT id FROM notes WHERE id=? AND deleted_at IS NULL", (new_parent,)
            ).fetchone()
            if not parent_row:
                raise HTTPException(status_code=400, detail="Destination parent does not exist or is deleted")
            # Cycle check: walking up from the destination must never reach
            # the note being moved.
            if _is_ancestor(conn, note_id, new_parent):
                raise HTTPException(status_code=400, detail="Cannot move a note into its own subtree")

        if new_parent == old_parent:
            # Reorder within the same parent: remove self, reinsert at index.
            siblings = _live_siblings(conn, old_parent, exclude_id=note_id)
            pos = min(position, len(siblings))
            final = siblings[:pos] + [note_id] + siblings[pos:]
            conn.execute(
                "UPDATE notes SET position=? WHERE id=?", (pos, note_id)
            )
            for i, sid in enumerate(final):
                if sid != note_id:
                    conn.execute("UPDATE notes SET position=? WHERE id=?", (i, sid))
        else:
            old_siblings = _live_siblings(conn, old_parent, exclude_id=note_id)
            new_siblings = _live_siblings(conn, new_parent, exclude_id=None)
            pos = min(position, len(new_siblings))
            final_new = new_siblings[:pos] + [note_id] + new_siblings[pos:]
            conn.execute(
                "UPDATE notes SET parent_id=?, position=? WHERE id=?", (new_parent, pos, note_id)
            )
            for i, sid in enumerate(old_siblings):
                conn.execute("UPDATE notes SET position=? WHERE id=?", (i, sid))
            for i, sid in enumerate(final_new):
                if sid != note_id:
                    conn.execute("UPDATE notes SET position=? WHERE id=?", (i, sid))

        row = conn.execute("SELECT * FROM notes WHERE id=?", (note_id,)).fetchone()

    log.info(
        "note moved id=%s parent=%s->%s position=%s",
        note_id, old_parent, new_parent, position,
    )
    return _note_dict(row)


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
    mime = _validate_mime(note_type, data.get("mime"))
    with db() as conn:
        cursor = conn.execute(
            "INSERT INTO notes (title, content, parent_id, type, mime, start_date, end_date) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                data.get("title", "Untitled"),
                data.get("content", ""),
                data.get("parent_id"),
                note_type,
                mime,
                data.get("start_date"),
                data.get("end_date"),
            ),
        )
        note_id = cursor.lastrowid
        # New notes append after their live siblings (GUI-4 sibling order)
        conn.execute(
            "UPDATE notes SET position="
            "(SELECT COUNT(*) FROM notes c2 WHERE c2.parent_id IS notes.parent_id AND c2.id != notes.id) "
            "WHERE id=?",
            (note_id,),
        )
        row = conn.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    log.info("note created id=%s type=%s", note_id, note_type)
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
            # '(copy)' suffix marks duplicated top-level notes only; nested
            # copies keep their titles (they're disambiguated by position).
            is_dup_root = row["id"] == note_id
            new_title = row["title"] + " (copy)" if (is_dup_root and root["parent_id"] is None) else row["title"]
            cur = conn.execute(
                "INSERT INTO notes (title, content, parent_id, type, mime) VALUES (?, ?, ?, ?, ?)",
                (new_title, row["content"], new_parent, row["type"], row["mime"]),
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
        mime = _validate_mime(note_type, data.get("mime") or existing["mime"])
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
        now = datetime.now().isoformat(timespec="seconds")
        placeholders = ",".join("?" * len(ids))
        conn.execute(
            f"UPDATE notes SET deleted_at=?, delete_id=? WHERE id IN ({placeholders})",
            [now, delete_id] + ids,
        )
        conn.execute(f"DELETE FROM bookmarks WHERE note_id IN ({placeholders})", ids)
    log.info("note soft-deleted id=%s subtree=%d delete_id=%s", note_id, len(ids), delete_id)
    return {"deleted": True, "count": len(ids), "delete_id": delete_id}


@router.get("/search")
async def search_notes(q: str):
    """FTS5 full-text search; returns id, title, match-centered snippet and path."""
    with db() as conn:
        try:
            rows = conn.execute(
                "SELECT notes.id, notes.title, notes.content,"
                "       snippet(notes_fts, -1, '', '', '...', 12) AS snip "
                "FROM notes_fts "
                "JOIN notes ON notes.id = notes_fts.rowid "
                "WHERE notes_fts MATCH ? AND notes.deleted_at IS NULL",
                (q,),
            ).fetchall()
        except Exception:
            # FTS5 MATCH can choke on odd query syntax (unbalanced quotes,
            # bare operators) — fall back to a plain LIKE scan so search
            # degrades instead of erroring.
            log.warning("FTS MATCH failed for query, falling back to LIKE scan")
            rows = conn.execute(
                "SELECT id, title, content, NULL AS snip FROM notes "
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

            if r["snip"]:
                snippet = r["snip"]
            else:
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
