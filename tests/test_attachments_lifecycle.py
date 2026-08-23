"""Attachments vs the delete lifecycle (audit regression: erased notes used
to leave orphaned attachment BLOBs because FK enforcement is off)."""
import io

from app.database.notes_db import db


async def _upload(client, note_id: int, name: str = "f.txt") -> dict:
    r = await client.post(
        f"/api/notes/{note_id}/attachments",
        files={"file": (name, io.BytesIO(b"hello"), "text/plain")},
    )
    assert r.status_code == 200
    return r.json()


def _attachment_count(note_id: int) -> int:
    with db() as conn:
        return conn.execute(
            "SELECT COUNT(*) FROM attachments WHERE note_id=?", (note_id,)
        ).fetchone()[0]


async def test_attachment_survives_soft_delete_and_restore(client):
    note = (await client.post("/api/notes", json={"title": "N"})).json()
    att = await _upload(client, note["id"])

    await client.delete(f"/api/notes/{note['id']}")
    assert _attachment_count(note["id"]) == 1  # trash keeps data restorable

    await client.post(f"/api/trash/{note['id']}/restore")
    assert _attachment_count(note["id"]) == 1
    # and it still serves
    r = await client.get(f"/api/attachments/{att['id']}/download")
    assert r.status_code == 200


async def test_empty_trash_erases_attachments_of_erased_notes(client):
    """Regression: empty_trash used to delete notes+bookmarks but leave
    attachment rows (and their BLOBs) orphaned forever."""
    doomed = (await client.post("/api/notes", json={"title": "Doomed"})).json()
    survivor = (await client.post("/api/notes", json={"title": "Survivor"})).json()
    await _upload(client, doomed["id"], "gone.txt")
    await _upload(client, doomed["id"], "gone2.txt")
    await _upload(client, survivor["id"], "kept.txt")

    await client.delete(f"/api/notes/{doomed['id']}")
    body = (await client.post("/api/trash/empty")).json()
    assert body["erased"] == 1

    assert _attachment_count(doomed["id"]) == 0      # orphan bug fixed
    assert _attachment_count(survivor["id"]) == 1    # live notes untouched

    with db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM attachments").fetchone()[0]
    assert total == 1
