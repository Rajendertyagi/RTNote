"""Model catalog endpoint."""
async def test_models_endpoint_returns_catalog(client):
    res = await client.get("/api/chat/models")
    assert res.status_code == 200
    models = res.json()
    assert isinstance(models, list) and len(models) >= 5
    ids = {m["id"] for m in models}
    assert "gpt-4o-mini" in ids  # backwards-compatible default
    assert "anthropic/claude-opus-4-6" in ids


async def test_models_carry_effort_levels(client):
    models = (await client.get("/api/chat/models")).json()
    by_id = {m["id"]: m for m in models}
    opus = by_id["anthropic/claude-opus-4-6"]
    assert opus["efforts"] == ["low", "medium", "high", "max"]
    assert opus["effort_labels"]["max"] == "Max"
    mini = by_id["gpt-4o-mini"]
    assert mini["efforts"] == []  # no reasoning control in UI


async def test_every_effort_has_a_label(client):
    for m in (await client.get("/api/chat/models")).json():
        assert set(m["efforts"]) == set(m["effort_labels"].keys())
