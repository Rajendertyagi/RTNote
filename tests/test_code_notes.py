"""F4/F2 — code notes: type acceptance, mime whitelist, defaults."""
import pytest


async def _create(client, **overrides):
    payload = {"title": "script", "type": "code", "content": "print(1)", **overrides}
    return await client.post("/api/notes", json=payload)


class TestCodeNoteCreate:
    async def test_create_code_note(self, client):
        body = (await _create(client)).json()
        assert body["type"] == "code"

    async def test_default_mime_is_plain_text(self, client):
        body = (await _create(client)).json()
        assert body["mime"] == "text/plain"

    async def test_create_with_valid_mime(self, client):
        body = (await _create(client, mime="text/x-python", content="x = 1")).json()
        assert body["mime"] == "text/x-python"

    @pytest.mark.parametrize("mime", ["text/x-bogus", "application/x-msdownload", "image/png"])
    async def test_create_with_unknown_mime_rejected(self, client, mime):
        res = await _create(client, mime=mime)
        assert res.status_code == 400
        assert "Invalid code mime" in res.json()["detail"]

    async def test_mime_free_for_text_notes(self, client):
        """Non-code types keep their free-form mime (no whitelist)."""
        res = await client.post(
            "/api/notes", json={"title": "t", "type": "text", "mime": "text/html"}
        )
        assert res.status_code == 200
        assert res.json()["mime"] == "text/html"


class TestCodeNoteUpdate:
    async def test_update_content_keeps_mime(self, client):
        nid = (await _create(client)).json()["id"]
        body = (await client.put(f"/api/notes/{nid}", json={"content": "x = 2"})).json()
        assert body["content"] == "x = 2"
        assert body["mime"] == "text/plain"

    async def test_update_mime_to_valid(self, client):
        nid = (await _create(client)).json()["id"]
        body = (
            await client.put(f"/api/notes/{nid}", json={"mime": "text/x-markdown"})
        ).json()
        assert body["mime"] == "text/x-markdown"

    async def test_update_mime_to_invalid_rejected(self, client):
        nid = (await _create(client)).json()["id"]
        res = await client.put(f"/api/notes/{nid}", json={"mime": "text/nope"})
        assert res.status_code == 400

    async def test_convert_type_relaxes_whitelist(self, client):
        """Switching away from code accepts a free-form mime again."""
        nid = (await _create(client)).json()["id"]
        res = await client.put(f"/api/notes/{nid}", json={"type": "text", "mime": "text/html"})
        assert res.status_code == 200
        assert res.json()["mime"] == "text/html"


class TestCodeNoteDuplicate:
    async def test_duplicate_preserves_type_and_mime(self, client):
        src = (
            await _create(client, title="orig", mime="text/x-go", content="package main")
        ).json()
        dup = (await client.post(f"/api/notes/{src['id']}/duplicate")).json()
        assert dup["type"] == "code"
        assert dup["mime"] == "text/x-go"
