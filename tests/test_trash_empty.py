"""Empty trash: physical erasure of soft-deleted subtrees only."""
from app.database.notes_db import db


async def test_empty_erases_all_deleted_notes_physically(client):
    root = (await client.post("/api/notes", json={"title": "R"})).json()
    child = (await client.post("/api/notes", json={"title": "C", "parent_id": root["id"]})).json()
    live = (await client.post("/api/notes", json={"title": "Live"})).json()
    await client.delete(f"/api/notes/{root['id']}")

    body = (await client.post("/api/trash/empty")).json()
    assert body["erased"] == 2

    with db() as conn:
        remaining = {r["id"] for r in conn.execute("SELECT id FROM notes").fetchall()}
    assert remaining == {live["id"]}
    assert (await client.get(f"/api/notes/{root['id']}")).status_code == 404
    assert (await client.get(f"/api/notes/{child['id']}")).status_code == 404
    assert (await client.get("/api/trash")).json() == []


async def test_empty_removes_bookmarks_of_erased(client):
    root = (await client.post("/api/notes", json={"title": "R"})).json()
    await client.post("/api/bookmarks", json={"note_id": root["id"]})
    await client.delete(f"/api/notes/{root['id']}")
    await client.post("/api/trash/empty")
    assert (await client.get("/api/bookmarks")).json() == []


async def test_empty_on_empty_trash(client):
    assert (await client.post("/api/trash/empty")).json() == {"erased": 0}
