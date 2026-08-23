"""FTS5 search: matching, snippets, breadcrumb path, LIKE fallback, exclusions."""


async def _seed(client):
    root = (await client.post("/api/notes", json={"title": "Projects"})).json()
    note = (await client.post(
        "/api/notes",
        json={
            "title": "Quantum Notes",
            "content": "Discussion about " + "quantum " * 40 + "entanglement.",
            "parent_id": root["id"],
        },
    )).json()
    return root, note


async def test_fts_match_returns_snippet_and_path(client):
    root, note = await _seed(client)
    results = (await client.get("/api/search", params={"q": "entanglement"})).json()
    assert len(results) == 1
    hit = results[0]
    assert hit["id"] == note["id"]
    assert hit["title"] == "Quantum Notes"
    assert "entanglement" in hit["snippet"]
    assert hit["snippet"].endswith("...")
    assert hit["path"] == "Projects > Quantum Notes"


async def test_short_content_has_no_ellipsis(client):
    await client.post("/api/notes", json={"title": "Tiny", "content": "zebra words here"})
    results = (await client.get("/api/search", params={"q": "zebra"})).json()
    assert results[0]["snippet"] == "zebra words here"


async def test_deleted_notes_not_searchable(client):
    _, note = await _seed(client)
    await client.delete(f"/api/notes/{note['id']}")
    assert (await client.get("/api/search", params={"q": "entanglement"})).json() == []


async def test_fts_syntax_error_falls_back_to_like(client):
    _, note = await _seed(client)
    # Unbalanced quote makes MATCH raise -> LIKE fallback path
    res = await client.get("/api/search", params={"q": '"unbalanced'})
    assert res.status_code == 200
    # LIKE matches nothing for that token but must not 500
    assert isinstance(res.json(), list)


async def test_no_results_is_empty_list(client):
    await _seed(client)
    assert (await client.get("/api/search", params={"q": "zzznotfound"})).json() == []
