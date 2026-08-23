"""Attachment serving: inline images, download disposition, delete."""


async def _upload(client, name="pic.png", data=b"\x89PNG-fake", mime="image/png"):
    note = (await client.post("/api/notes", json={"title": "N"})).json()
    att = (await client.post(
        f"/api/notes/{note['id']}/attachments",
        files={"file": (name, io_bytes(data), mime)})).json()
    return att


def io_bytes(data):
    import io
    return io.BytesIO(data)


async def test_serve_image_inline_with_cache_headers(client):
    att = await _upload(client)
    res = await client.get(f"/api/attachments/{att['id']}/image")
    assert res.status_code == 200
    assert res.headers["content-type"] == "image/png"
    assert "immutable" in res.headers["cache-control"]
    assert res.content == b"\x89PNG-fake"


async def test_non_image_via_image_endpoint_404(client):
    att = await _upload(client, "doc.txt", b"hello", "text/plain")
    assert (await client.get(f"/api/attachments/{att['id']}/image")).status_code == 404
    res = await client.get(f"/api/attachments/{att['id']}/download")
    assert res.status_code == 200
    assert res.headers["content-type"] == "text/plain; charset=utf-8"
    assert 'attachment; filename="doc.txt"' in res.headers["content-disposition"]
    assert res.headers["cache-control"] == "no-store"


async def test_download_quotes_filename(client):
    att = await _upload(client, 'weird"name.png', b"x", "image/png")
    res = await client.get(f"/api/attachments/{att['id']}/download")
    assert "'weird\"name.png'" not in res.headers["content-disposition"]
    assert '"weird\'name.png"' in res.headers["content-disposition"]


async def test_fetch_missing_attachment_404(client):
    assert (await client.get("/api/attachments/99999/image")).status_code == 404
    assert (await client.get("/api/attachments/99999/download")).status_code == 404


async def test_delete_attachment_then_404(client):
    att = await _upload(client)
    assert (await client.delete(f"/api/attachments/{att['id']}")).json() == {"deleted": True}
    assert (await client.get(f"/api/attachments/{att['id']}/image")).status_code == 404
