"""Day notes (Journal hierarchy), options KV store, index page."""


async def test_day_note_creates_full_hierarchy(client):
    from app.database.notes_db import db

    body = (await client.get("/api/days/2026-08-23")).json()
    assert body["title"] == "2026-08-23"
    assert body["created"] is True

    with db() as conn:
        day = conn.execute("SELECT * FROM notes WHERE id=?", (body["id"],)).fetchone()
        month = conn.execute("SELECT * FROM notes WHERE id=?", (day["parent_id"],)).fetchone()
        year = conn.execute("SELECT * FROM notes WHERE id=?", (month["parent_id"],)).fetchone()
        journal = conn.execute("SELECT * FROM notes WHERE id=?", (year["parent_id"],)).fetchone()
    assert month["title"] == "2026-08"
    assert year["title"] == "2026"
    assert journal["title"] == "Journal" and journal["parent_id"] is None


async def test_day_note_is_found_not_recreated(client):
    first = (await client.get("/api/days/2026-08-23")).json()
    second = (await client.get("/api/days/2026-08-23")).json()
    assert second["id"] == first["id"]
    assert second["created"] is False


async def test_day_note_invalid_date_400(client):
    res = await client.get("/api/days/not-a-date")
    assert res.status_code == 400
    assert "YYYY-MM-DD" in res.json()["detail"]


async def test_options_roundtrip_and_overwrite(client):
    assert (await client.put("/api/options/open-tabs", json={"value": "[1,2]"})).status_code == 200
    got = (await client.get("/api/options/open-tabs")).json()
    assert got == {"key": "open-tabs", "value": "[1,2]"}

    await client.put("/api/options/open-tabs", json={"value": "[]"})
    assert (await client.get("/api/options/open-tabs")).json()["value"] == "[]"


async def test_options_value_coerced_to_str(client):
    await client.put("/api/options/n", json={"value": 42})
    assert (await client.get("/api/options/n")).json()["value"] == "42"


async def test_options_missing_value_400_and_unknown_key_null(client):
    assert (await client.put("/api/options/k", json={})).status_code == 400
    assert (await client.get("/api/options/never-set")).json()["value"] is None


async def test_index_page_served(client):
    res = await client.get("/")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
