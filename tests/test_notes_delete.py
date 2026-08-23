"""Soft-delete semantics: subtree marking, shared delete_id, bookmark cleanup."""
from app.database.notes_db import db


async def _make_tree(client):
    root = (await client.post("/api/notes", json={"title": "Root"})).json()
    a = (await client.post("/api/notes", json={"title": "A", "parent_id": root["id"]})).json()
    b = (await client.post("/api/notes", json={"title": "B", "parent_id": a["id"]})).json()
    other = (await client.post("/api/notes", json={"title": "Other"})).json()
    return root, a, b, other


async def test_delete_marks_whole_subtree_with_shared_delete_id(client):
    root, a, b, other = await _make_tree(client)
    res = await client.delete(f"/api/notes/{root['id']}")
    body = res.json()
    assert body["deleted"] is True
    assert body["count"] == 3

    with db() as conn:
        rows = {r["id"]: dict(r) for r in conn.execute(
            "SELECT id, deleted_at, delete_id FROM notes").fetchall()}
    delete_ids = {rows[root["id"]]["delete_id"], rows[a["id"]]["delete_id"], rows[b["id"]]["delete_id"]}
    assert len(delete_ids) == 1 and None not in delete_ids
    assert all(rows[i]["deleted_at"] for i in (root["id"], a["id"], b["id"]))
    assert rows[other["id"]]["deleted_at"] is None


async def test_delete_removes_bookmarks_of_subtree(client):
    root, *_ = await _make_tree(client)
    await client.post("/api/bookmarks", json={"note_id": root["id"]})
    await client.delete(f"/api/notes/{root['id']}")
    assert (await client.get("/api/bookmarks")).json() == []


async def test_deleted_note_hidden_from_list_but_fetchable(client):
    root, a, b, other = await _make_tree(client)
    await client.delete(f"/api/notes/{root['id']}")
    # The deleted subtree vanishes from the list; unrelated notes remain.
    listed = (await client.get("/api/notes")).json()
    assert [n["id"] for n in listed] == [other["id"]]
    body = (await client.get(f"/api/notes/{root['id']}")).json()
    assert body["deleted_at"] is not None


async def test_delete_missing_or_already_deleted_404(client):
    root, *_ = await _make_tree(client)
    assert (await client.delete("/api/notes/99999")).status_code == 404
    await client.delete(f"/api/notes/{root['id']}")
    assert (await client.delete(f"/api/notes/{root['id']}")).status_code == 404


async def test_delete_child_still_counts_descendants(client):
    _, _, b, _ = await _make_tree(client)
    res = await client.delete(f"/api/notes/{b['id']}")
    assert res.json()["count"] == 1
