"""Trash restore: group restore, orphan re-parenting to root."""
from app.database.notes_db import db


async def _make_and_delete_tree(client):
    root = (await client.post("/api/notes", json={"title": "Root"})).json()
    child = (await client.post("/api/notes", json={"title": "C", "parent_id": root["id"]})).json()
    res = await client.delete(f"/api/notes/{root['id']}")
    delete_id = res.json()["delete_id"]
    return root, child, delete_id


async def test_list_trash_shows_deleted_group(client):
    root, child, _ = await _make_and_delete_tree(client)
    trash = (await client.get("/api/trash")).json()
    ids = {t["id"] for t in trash}
    assert ids == {root["id"], child["id"]}
    assert all(t["deleted_at"] and t["delete_id"] for t in trash)


async def test_restore_brings_back_whole_group(client):
    root, child, _ = await _make_and_delete_tree(client)
    body = (await client.post(f"/api/trash/{root['id']}/restore")).json()
    assert body["restored"] is True
    assert body["count"] == 2
    listed = {n["id"] for n in (await client.get("/api/notes")).json()}
    assert listed == {root["id"], child["id"]}
    with db() as conn:
        row = conn.execute("SELECT delete_id FROM notes WHERE id=?", (root["id"],)).fetchone()
    assert row["delete_id"] is None


async def test_restore_reparents_when_ancestor_still_trashed(client):
    top = (await client.post("/api/notes", json={"title": "Top"})).json()
    mid = (await client.post("/api/notes", json={"title": "Mid", "parent_id": top["id"]})).json()
    leaf = (await client.post("/api/notes", json={"title": "Leaf", "parent_id": mid["id"]})).json()

    # Delete the subtree rooted at mid; then delete Top separately.
    await client.delete(f"/api/notes/{mid['id']}")
    await client.delete(f"/api/notes/{top['id']}")

    # Restore only Mid's group — its ancestor Top remains trashed.
    body = (await client.post(f"/api/trash/{mid['id']}/restore")).json()
    assert body["reparented_to_root"] is True

    with db() as conn:
        row = conn.execute("SELECT parent_id FROM notes WHERE id=?", (mid["id"],)).fetchone()
    assert row["parent_id"] is None
    # Leaf came back too, still under Mid
    with db() as conn:
        leaf_row = conn.execute("SELECT parent_id FROM notes WHERE id=?", (leaf["id"],)).fetchone()
    assert leaf_row["parent_id"] == mid["id"]


async def test_restore_keeps_parent_when_ancestor_alive(client):
    root, child, _ = await _make_and_delete_tree(client)
    await client.post(f"/api/trash/{child['id']}/restore")
    with db() as conn:
        row = conn.execute("SELECT parent_id FROM notes WHERE id=?", (child["id"],)).fetchone()
    assert row["parent_id"] == root["id"]


async def test_restore_errors(client):
    root, *_ = await _make_and_delete_tree(client)
    assert (await client.post("/api/trash/99999/restore")).status_code == 404
    live = (await client.post("/api/notes", json={"title": "Live"})).json()
    assert (await client.post(f"/api/trash/{live['id']}/restore")).status_code == 400
