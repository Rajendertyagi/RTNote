"""GET /api/calendar parameter handling.

Contract (unchanged by these tests): start/end are required; unparseable
date strings are compared lexically in SQLite and simply match nothing —
garbage in, empty list out (no 500).
"""


async def test_calendar_missing_params_422(client):
    r = await client.get("/api/calendar")
    assert r.status_code == 422

    r = await client.get("/api/calendar", params={"start": "2026-01-01"})
    assert r.status_code == 422

    r = await client.get("/api/calendar", params={"end": "2026-01-31"})
    assert r.status_code == 422


async def test_calendar_garbage_dates_return_empty_not_error(client):
    r = await client.get("/api/calendar", params={"start": "not-a-date", "end": "also-bad"})
    assert r.status_code == 200
    assert r.json() == []


async def test_calendar_valid_range_still_works(client):
    await client.post(
        "/api/notes",
        json={"title": "Event", "start_date": "2026-03-10", "end_date": "2026-03-12"},
    )
    r = await client.get("/api/calendar", params={"start": "2026-03-01", "end": "2026-03-31"})
    assert r.status_code == 200
    assert any(n["title"] == "Event" for n in r.json())
