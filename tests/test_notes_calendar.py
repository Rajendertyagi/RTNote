"""Calendar range query: inclusive boundaries, end_date fallback, exclusions."""


def _mk(title, start, end=None):
    return {"title": title, "type": "text", "start_date": start, "end_date": end}


async def test_events_intersecting_range(client):
    inside = (await client.post("/api/notes", json=_mk("In", "2026-03-10", "2026-03-20"))).json()
    before = (await client.post("/api/notes", json=_mk("Before", "2026-02-01", "2026-02-28"))).json()
    after = (await client.post("/api/notes", json=_mk("After", "2026-04-01"))).json()

    events = (await client.get(
        "/api/calendar", params={"start": "2026-03-01", "end": "2026-03-31"})).json()
    ids = {e["id"] for e in events}
    assert ids == {inside["id"]}


async def test_boundaries_are_inclusive(client):
    edge = (await client.post("/api/notes", json=_mk("Edge", "2026-03-01", "2026-03-31"))).json()
    events = (await client.get(
        "/api/calendar", params={"start": "2026-03-01", "end": "2026-03-31"})).json()
    assert [e["id"] for e in events] == [edge["id"]]


async def test_missing_end_date_falls_back_to_start_date(client):
    single = (await client.post("/api/notes", json=_mk("Single", "2026-03-15"))).json()
    events = (await client.get(
        "/api/calendar", params={"start": "2026-03-15", "end": "2026-03-15"})).json()
    assert [e["id"] for e in events] == [single["id"]]
    # day before start: no match
    events = (await client.get(
        "/api/calendar", params={"start": "2026-03-14", "end": "2026-03-14"})).json()
    assert events == []


async def test_notes_without_start_date_and_deleted_are_excluded(client):
    no_date = (await client.post("/api/notes", json={"title": "NoDate"})).json()
    dated = (await client.post("/api/notes", json=_mk("Dated", "2026-03-10"))).json()
    await client.delete(f"/api/notes/{dated['id']}")
    events = (await client.get(
        "/api/calendar", params={"start": "2026-01-01", "end": "2026-12-31"})).json()
    assert all(e["id"] not in (no_date["id"], dated["id"]) for e in events)
