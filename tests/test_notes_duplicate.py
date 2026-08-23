"""Deep duplicate: subtree copy, '(copy)' suffix on root only, parent remapping."""


async def _make_tree(client):
    root = (await client.post("/api/notes", json={"title": "Root", "content": "r"})).json()
    child = (await client.post(
        "/api/notes", json={"title": "Child", "parent_id": root["id"]})).json()
    grandchild = (await client.post(
        "/api/notes", json={"title": "GC", "parent_id": child["id"]})).json()
    return root, child, grandchild


async def test_duplicate_copies_subtree_with_suffix_on_root(client):
    root, child, grandchild = await _make_tree(client)
    copy = (await client.post(f"/api/notes/{root['id']}/duplicate")).json()

    assert copy["title"] == "Root (copy)"
    assert copy["id"] != root["id"]

    all_notes = (await client.get("/api/notes")).json()
    assert len(all_notes) == 6  # 3 original + 3 copies
    listed = {n["title"]: n for n in all_notes}
    copy_child = next(n for t, n in listed.items() if t == "Child" and n["id"] != child["id"])
    copy_gc = next(n for t, n in listed.items() if t == "GC" and n["id"] != grandchild["id"])
    assert copy_child["parent_id"] == copy["id"]
    assert copy_gc["parent_id"] == copy_child["id"]
    # originals untouched
    assert listed["Root"]["id"] == root["id"]


async def test_duplicate_leaf_gets_suffix_and_same_parent(client):
    _, child, _ = await _make_tree(client)
    copy = (await client.post(f"/api/notes/{child['id']}/duplicate")).json()
    assert copy["title"] == "Child"
    root = (await client.get(f"/api/notes/{copy['parent_id']}")).json()
    assert root["title"] == "Root"


async def test_duplicate_missing_404(client):
    assert (await client.post("/api/notes/99999/duplicate")).status_code == 404
