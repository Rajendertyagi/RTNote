"""Attachments: file/image uploads stored as inline BLOBs.

Trilium equivalent (routes/api/attachments.ts): images return a URL the
editor embeds directly as <img src>; other files are downloadable. We serve
inline for known image mimes, attachment-disposition otherwise.
"""
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import Response

from app.database.notes_db import db

router = APIRouter(prefix="/api", tags=["attachments"])

MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 20 MB
INLINE_MIMES = {
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp",
}


def _meta_dict(r) -> dict:
    return {"id": r["id"], "note_id": r["note_id"], "filename": r["filename"],
            "mime": r["mime"], "size": r["size"], "created_at": r["created_at"]}


@router.get("/notes/{note_id}/attachments")
async def list_attachments(note_id: int):
    with db() as conn:
        rows = conn.execute(
            "SELECT id, note_id, filename, mime, size, created_at FROM attachments "
            "WHERE note_id=? ORDER BY id",
            (note_id,),
        ).fetchall()
    return [_meta_dict(r) for r in rows]


@router.post("/notes/{note_id}/attachments")
async def upload_attachment(note_id: int, file: UploadFile):
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 20 MB)")

    with db() as conn:
        note = conn.execute(
            "SELECT id FROM notes WHERE id=? AND deleted_at IS NULL", (note_id,)
        ).fetchone()
        if not note:
            raise HTTPException(status_code=404, detail="Note not found")

        mime = file.content_type or "application/octet-stream"
        # Browsers/HTTP clients percent-encode special characters in filenames
        # (e.g. '"' -> %22); decode so the stored name is human-readable.
        filename = unquote(file.filename or "unnamed")
        cur = conn.execute(
            "INSERT INTO attachments (note_id, filename, mime, size, content) VALUES (?, ?, ?, ?, ?)",
            (note_id, filename, mime, len(data), data),
        )
        att_id = cur.lastrowid

    inline = mime in INLINE_MIMES
    url = f"/api/attachments/{att_id}/image" if inline else f"/api/attachments/{att_id}/download"
    return {"id": att_id, "filename": filename, "mime": mime,
            "size": len(data), "url": url, "inline": inline}


def _fetch_attachment(att_id: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM attachments WHERE id=?", (att_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    return row


@router.get("/attachments/{attachment_id}/image")
async def serve_image(attachment_id: int):
    """Inline serving for <img> tags."""
    row = _fetch_attachment(attachment_id)
    if not row["mime"].startswith("image/"):
        raise HTTPException(status_code=404, detail="Not an image")
    return Response(
        content=row["content"],
        media_type=row["mime"],
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/attachments/{attachment_id}/download")
async def download(attachment_id: int):
    row = _fetch_attachment(attachment_id)
    quoted = row["filename"].replace('"', "'")
    return Response(
        content=row["content"],
        media_type=row["mime"],
        headers={
            "Content-Disposition": f'attachment; filename="{quoted}"',
            "Cache-Control": "no-store",
        },
    )


@router.delete("/attachments/{attachment_id}")
async def delete_attachment(attachment_id: int):
    with db() as conn:
        conn.execute("DELETE FROM attachments WHERE id=?", (attachment_id,))
    return {"deleted": True}
