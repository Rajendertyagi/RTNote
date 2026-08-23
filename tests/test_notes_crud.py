"""Notes CRUD: create, list, get, partial update, validation."""
from app.database.notes_db import db


async def test_create_note_defaults(client):
    res = await client.post("/api/notes", json={})
    assert res.status_code == 200
    body = res.json()
    assert body["title"] == "Untitled"
    assert body["content"] == ""
    assert body["type"] == "text"
    assert body["parent_id"] is None
    assert isinstance(body["id"], int)


async def test_create_note_with_all_fields(client):
    payload = {
        "title": "Plan", "content": "<p>hi</p>", "parent_id": None,
        "type": "page", "mime": "text/html",
        "start_date": "2026-01-01", "end_date": "2026-01-05",
    }
    body = (await client.post("/api/notes", json=payload)).json()
    for key, value in payload.items():
        assert body[key] == value


async def test_create_note_invalid_type_400(client):
    res = await client.post("/api/notes", json={"type": "bogus"})
    assert res.status_code == 400
    assert "Invalid note type" in res.json()["detail"]


async def test_list_notes_returns_created_in_order(client):
    first = (await client.post("/api/notes", json={"title": "One"})).json()
    second = (await client.post("/api/notes", json={"title": "Two"})).json()
    listed = (await client.get("/api/notes")).json()
    assert [n["id"] for n in listed] == [first["id"], second["id"]]


async def test_get_note_404(client):
    assert (await client.get("/api/notes/424242")).status_code == 404


async def test_update_partial_keeps_other_fields(client):
    created = (await client.post(
        "/api/notes", json={"title": "T1", "content": "C1", "type": "html"}
    )).json()
    updated = (await client.put(f"/api/notes/{created['id']}", json={"title": "T2"})).json()
    assert updated["title"] == "T2"
    assert updated["content"] == "C1"
    assert updated["type"] == "html"

    with db() as conn:
        row = conn.execute("SELECT updated_at FROM notes WHERE id=?", (created["id"],)).fetchone()
        created_row = conn.execute(
            "SELECT created_at FROM notes WHERE id=?", (created["id"],)).fetchone()
    assert row["updated_at"] >= created_row["created_at"]


async def test_update_invalid_type_400(client):
    created = (await client.post("/api/notes", json={})).json()
    res = await client.put(f"/api/notes/{created['id']}", json={"type": "nope"})
    assert res.status_code == 400


async def test_update_missing_note_404(client):
    assert (await client.put("/api/notes/99999", json={"title": "x"})).status_code == 404
