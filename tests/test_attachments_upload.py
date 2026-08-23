"""Attachment uploads: metadata, inline vs download routing, limits, errors."""
import io

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 16


def _file(name, data, mime):
    return {"files": {"file": (name, io.BytesIO(data), mime)}}


async def test_upload_image_returns_inline_url(client):
    note = (await client.post("/api/notes", json={"title": "N"})).json()
    res = await client.post(f"/api/notes/{note['id']}/attachments", **_file("pic.png", PNG, "image/png"))
    body = res.json()
    assert res.status_code == 200
    assert body["filename"] == "pic.png"
    assert body["mime"] == "image/png"
    assert body["size"] == len(PNG)
    assert body["inline"] is True
    assert body["url"].endswith("/image")


async def test_upload_non_image_returns_download_url(client):
    note = (await client.post("/api/notes", json={"title": "N"})).json()
    res = await client.post(
        f"/api/notes/{note['id']}/attachments",
        **_file("doc.pdf", b"%PDF-1.4", "application/pdf"))
    body = res.json()
    assert body["inline"] is False
    assert body["url"].endswith("/download")


async def test_upload_to_missing_note_404(client):
    res = await client.post("/api/notes/99999/attachments", **_file("x.txt", b"x", "text/plain"))
    assert res.status_code == 404


async def test_upload_oversize_413(client):
    note = (await client.post("/api/notes", json={"title": "N"})).json()
    big = b"a" * (20 * 1024 * 1024 + 1)
    res = await client.post(
        f"/api/notes/{note['id']}/attachments", **_file("big.bin", big, "application/octet-stream"))
    assert res.status_code == 413


async def test_list_attachments_ordered_by_id(client):
    note = (await client.post("/api/notes", json={"title": "N"})).json()
    one = (await client.post(f"/api/notes/{note['id']}/attachments",
                             **_file("a.png", PNG, "image/png"))).json()
    two = (await client.post(f"/api/notes/{note['id']}/attachments",
                             **_file("b.txt", b"hi", "text/plain"))).json()
    listed = (await client.get(f"/api/notes/{note['id']}/attachments")).json()
    assert [a["id"] for a in listed] == [one["id"], two["id"]]
    assert all({"id", "note_id", "filename", "mime", "size", "created_at"} <= set(a) for a in listed)
