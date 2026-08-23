"""GUI-4 backend: hierarchy move semantics.

Proves the move endpoint's invariants independently of any GUI:
no self-parent, no cycles, parent validity, subtree integrity,
deterministic sibling ordering, content/FTS/bookmark safety.
"""

async def _all_notes(client):
    return (await client.get("/api/notes")).json()


async def _by_title(client, title):
    return [n for n in await _all_notes(client) if n["title"] == title]


async def _seed_three_roots(client, pfx="M"):
    a = (await client.post("/api/notes", json={"title": f"{pfx}A"})).json()
    b = (await client.post("/api/notes", json={"title": f"{pfx}B"})).json()
    c = (await client.post("/api/notes", json={"title": f"{pfx}C"})).json()
    return a, b, c


# ---------- Valid moves ----------
async def test_reorder_within_parent(client):
    a, b, c = await _seed_three_roots(client)
    res = await client.post(f"/api/notes/{c['id']}/move", json={"parent_id": None, "position": 0})
    assert res.status_code == 200
    rows = {n["title"]: n["position"] for n in await _all_notes(client)}
    assert rows[f"{c['title']}"] == 0 and rows[f"{a['title']}"] == 1 and rows[f"{b['title']}"] == 2


async def test_move_down_within_parent(client):
    a, b, c = await _seed_three_roots(client)
    res = await client.post(f"/api/notes/{a['id']}/move", json={"parent_id": None, "position": 2})
    assert res.status_code == 200
    rows = {n["title"]: n["position"] for n in await _all_notes(client)}
    assert rows["MB"] == 0 and rows["MC"] == 1 and rows["MA"] == 2


async def test_reparent_to_another_parent(client):
    x = (await client.post("/api/notes", json={"title": "X"})).json()
    y = (await client.post("/api/notes", json={"title": "Y"})).json()
    z = (await client.post("/api/notes", json={"title": "Z", "parent_id": y["id"]})).json()

    res = await client.post(f"/api/notes/{y['id']}/move", json={"parent_id": x["id"], "position": 0})
    assert res.status_code == 200

    y_row = (await _by_title(client, "Y"))[0]
    assert y_row["parent_id"] == x["id"]
    # Subtree integrity: Z still hangs off Y
    z_row = (await _by_title(client, "Z"))[0]
    assert z_row["parent_id"] == y["id"]
    # Old parent X gained Y as its only child at position 0
    assert y_row["position"] == 0


async def test_position_clamps_to_available_range(client):
    a, b, c = await _seed_three_roots(client)
    res = await client.post(f"/api/notes/{a['id']}/move", json={"parent_id": None, "position": 999})
    assert res.status_code == 200
    rows = {n["title"]: n["position"] for n in await _all_notes(client)}
    assert rows["MA"] == 2  # clamped to last slot


# ---------- Invalid moves ----------
async def test_self_parent_rejected(client):
    a, _, _ = await _seed_three_roots(client)
    res = await client.post(f"/api/notes/{a['id']}/move", json={"parent_id": a["id"], "position": 0})
    assert res.status_code == 400


async def test_cycle_rejected(client):
    a = (await client.post("/api/notes", json={"title": "CA"})).json()
    b = (await client.post("/api/notes", json={"title": "CB", "parent_id": a["id"]})).json()
    c = (await client.post("/api/notes", json={"title": "CC", "parent_id": b["id"]})).json()
    # A cannot move under its own descendant C
    res = await client.post(f"/api/notes/{a['id']}/move", json={"parent_id": c["id"], "position": 0})
    assert res.status_code == 400
    # Hierarchy unchanged
    a_row = (await _by_title(client, "CA"))[0]
    assert a_row["parent_id"] is None


async def test_nonexistent_parent_rejected(client):
    a, _, _ = await _seed_three_roots(client)
    res = await client.post(f"/api/notes/{a['id']}/move", json={"parent_id": 999999, "position": 0})
    assert res.status_code == 400


async def test_deleted_destination_rejected(client):
    dest = (await client.post("/api/notes", json={"title": "Dead Dest"})).json()
    a, _, _ = await _seed_three_roots(client)
    await client.delete(f"/api/notes/{dest['id']}")
    res = await client.post(f"/api/notes/{a['id']}/move", json={"parent_id": dest["id"], "position": 0})
    assert res.status_code == 400


async def test_moving_deleted_note_rejected(client):
    dead = (await client.post("/api/notes", json={"title": "Already Dead"})).json()
    a, _, _ = await _seed_three_roots(client)
    await client.delete(f"/api/notes/{dead['id']}")
    res = await client.post(f"/api/notes/{dead['id']}/move", json={"parent_id": a["id"], "position": 0})
    assert res.status_code == 404


async def test_invalid_position_rejected(client):
    a, _, _ = await _seed_three_roots(client)
    for bad in (-1, "zero", None, True):
        res = await client.post(f"/api/notes/{a['id']}/move", json={"parent_id": None, "position": bad})
        assert res.status_code == 400, f"position={bad!r}"


async def test_missing_note_404(client):
    res = await client.post("/api/notes/999999/move", json={"parent_id": None, "position": 0})
    assert res.status_code == 404


# ---------- Integrity ----------
async def test_move_preserves_content_fts_and_bookmarks(client):
    n = (await client.post("/api/notes", json={
        "title": "Moveable Knowledge",
        "content": "unique-fts-haystack quantum computing notes",
    })).json()
    bm = await client.post("/api/bookmarks", json={"note_id": n["id"]})
    assert bm.status_code == 200

    dest = (await client.post("/api/notes", json={"title": "Dest Parent"})).json()
    res = await client.post(f"/api/notes/{n['id']}/move", json={"parent_id": dest["id"], "position": 0})
    assert res.status_code == 200

    row = (await client.get(f"/api/notes/{n['id']}")).json()
    assert row["content"] == "unique-fts-haystack quantum computing notes"
    assert row["parent_id"] == dest["id"]

    search = (await client.get("/api/search?q=quantum")).json()
    assert any(s["id"] == n["id"] for s in search)

    bookmarks = (await client.get("/api/bookmarks")).json()
    assert any(bm_item["id"] == n["id"] for bm_item in bookmarks)


async def test_sibling_positions_stay_deterministic_after_moves(client):
    a, b, c = await _seed_three_roots(client)
    d = (await client.post("/api/notes", json={"title": "MD"})).json()
    # A series of moves must leave positions a compact 0..n-1 permutation
    await client.post(f"/api/notes/{c['id']}/move", json={"parent_id": None, "position": 0})
    await client.post(f"/api/notes/{d['id']}/move", json={"parent_id": None, "position": 2})
    await client.post(f"/api/notes/{a['id']}/move", json={"parent_id": None, "position": 3})

    roots = sorted(
        (n for n in await _all_notes(client) if n["parent_id"] is None),
        key=lambda n: n["position"],
    )
    order = [n["title"] for n in roots]
    assert order == ["MC", "MD", "MB", "MA"]
    assert [n["position"] for n in roots] == [0, 1, 2, 3]


async def test_new_note_appends_after_siblings(client):
    a, b, _ = await _seed_three_roots(client)
    late = (await client.post("/api/notes", json={"title": "Late"})).json()
    assert late["position"] == 3  # after A(0), B(1), C(2)
