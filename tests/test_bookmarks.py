"""Bookmarks: ordered add, dedupe, validation, removal."""


async def test_add_and_list_in_position_order(client):
    a = (await client.post("/api/notes", json={"title": "A"})).json()
    b = (await client.post("/api/notes", json={"title": "B"})).json()
    assert (await client.post("/api/bookmarks", json={"note_id": b["id"]})).status_code == 200
    assert (await client.post("/api/bookmarks", json={"note_id": a["id"]})).status_code == 200

    listed = (await client.get("/api/bookmarks")).json()
    assert [n["id"] for n in listed] == [b["id"], a["id"]]  # insertion order
    assert {"id", "title", "type", "position"} <= set(listed[0].keys())


async def test_duplicate_bookmark_is_noop(client):
    note = (await client.post("/api/notes", json={"title": "A"})).json()
    first = (await client.post("/api/bookmarks", json={"note_id": note["id"]})).json()
    second = (await client.post("/api/bookmarks", json={"note_id": note["id"]})).json()
    assert first == {"bookmarked": True}
    assert second == {"bookmarked": True, "already": True}
    assert len((await client.get("/api/bookmarks")).json()) == 1


async def test_add_requires_int_note_id(client):
    res = await client.post("/api/bookmarks", json={"note_id": "abc"})
    assert res.status_code == 400
    res = await client.post("/api/bookmarks", json={})
    assert res.status_code == 400


async def test_add_missing_note_404(client):
    assert (await client.post("/api/bookmarks", json={"note_id": 99999})).status_code == 404


async def test_remove_bookmark(client):
    note = (await client.post("/api/notes", json={"title": "A"})).json()
    await client.post("/api/bookmarks", json={"note_id": note["id"]})
    body = (await client.delete(f"/api/bookmarks/{note['id']}")).json()
    assert body == {"bookmarked": False}
    assert (await client.get("/api/bookmarks")).json() == []


async def test_list_excludes_soft_deleted_notes(client):
    note = (await client.post("/api/notes", json={"title": "A"})).json()
    await client.post("/api/bookmarks", json={"note_id": note["id"]})
    await client.delete(f"/api/notes/{note['id']}")
    assert (await client.get("/api/bookmarks")).json() == []
