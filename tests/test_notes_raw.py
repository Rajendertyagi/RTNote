"""GET /api/notes/{id}/raw — serves page-note HTML for the sandboxed preview
iframe. Intentionally unsanitized (the iframe sandbox is the boundary), so
the contract here matters: right type only, never deleted/missing notes."""
from app.database.notes_db import db


async def test_raw_serves_page_note_content(client):
    note = (
        await client.post(
            "/api/notes",
            json={"title": "P", "type": "page", "content": "<h1>Hello</h1>"},
        )
    ).json()
    r = await client.get(f"/api/notes/{note['id']}/raw")
    assert r.status_code == 200
    assert r.text == "<h1>Hello</h1>"
    assert r.headers["content-type"].startswith("text/html")
    assert r.headers["cache-control"] == "no-store"


async def test_raw_wrong_type_404(client):
    note = (
        await client.post(
            "/api/notes", json={"title": "T", "type": "text", "content": "<p>x</p>"}
        )
    ).json()
    r = await client.get(f"/api/notes/{note['id']}/raw")
    assert r.status_code == 404


async def test_raw_nonexistent_404(client):
    assert (await client.get("/api/notes/999999/raw")).status_code == 404


async def test_raw_deleted_note_404(client):
    """A trashed page must not stay reachable through /raw."""
    note = (
        await client.post(
            "/api/notes", json={"title": "D", "type": "page", "content": "<b>secret</b>"}
        )
    ).json()
    await client.delete(f"/api/notes/{note['id']}")
    r = await client.get(f"/api/notes/{note['id']}/raw")
    assert r.status_code == 404


async def test_raw_empty_content_passthrough(client):
    note = (
        await client.post("/api/notes", json={"title": "E", "type": "page", "content": ""})
    ).json()
    r = await client.get(f"/api/notes/{note['id']}/raw")
    assert r.status_code == 200
    assert r.text == ""
