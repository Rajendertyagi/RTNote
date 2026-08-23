"""Centralized logging: setup, files, rotation, request IDs, middleware,
exception logging, and the never-crash guarantee."""
import logging

import pytest

from app.core import logging as clog


@pytest.fixture
def fresh_logging(tmp_path, monkeypatch):
    """Re-configure logging against a temp dir; restore afterwards."""
    log_dir = tmp_path / "logs"
    monkeypatch.setattr(clog, "LOG_DIR", log_dir)
    root = logging.getLogger()
    saved = list(root.handlers)
    for h in saved:
        root.removeHandler(h)
    clog._configured = False
    clog.setup_logging(force=True)
    yield log_dir
    # Detach handlers so temp files release on Windows
    for h in root.handlers[:]:
        h.flush()
        h.close()
        root.removeHandler(h)
    for h in saved:
        root.addHandler(h)
    clog._configured = False


def _root_handlers():
    return logging.getLogger().handlers


class TestSetup:
    def test_setup_creates_log_files(self, fresh_logging):
        logging.getLogger("rtw.test").info("hello file")
        for h in _root_handlers():
            h.flush()
        assert (fresh_logging / "app.log").exists()
        assert (fresh_logging / "error.log").exists()

    def test_setup_is_idempotent(self, fresh_logging):
        n = len(_root_handlers())
        clog.setup_logging()  # no force → no duplicate handlers
        assert len(_root_handlers()) == n

    def test_error_log_only_receives_errors(self, fresh_logging):
        logging.getLogger("rtw.test").info("not an error")
        logging.getLogger("rtw.test").error("an error")
        for h in _root_handlers():
            h.flush()
        content = (fresh_logging / "error.log").read_text(encoding="utf-8")
        assert "an error" in content
        assert "not an error" not in content

    def test_unwritable_dir_does_not_crash(self, tmp_path, monkeypatch):
        # A FILE where the log dir should be → mkdir fails → console-only
        blocker = tmp_path / "blocked"
        blocker.write_text("not a dir")
        monkeypatch.setattr(clog, "LOG_DIR", blocker)
        clog._configured = False
        clog.setup_logging(force=True)  # must not raise
        logging.getLogger("rtw.test").info("still works")
        clog._configured = False


class TestRotation:
    def test_rotation_and_retention(self, tmp_path, monkeypatch):
        log_dir = tmp_path / "logs"
        monkeypatch.setattr(clog, "LOG_DIR", log_dir)
        monkeypatch.setattr(clog, "_APP_LOG_BYTES", 500)
        monkeypatch.setattr(clog, "LOG_RETENTION", 2)
        for h in _root_handlers():
            logging.getLogger().removeHandler(h)
        clog._configured = False
        clog.setup_logging(force=True)

        spam = logging.getLogger("rtw.spam")
        for i in range(200):
            spam.info("x" * 100 + str(i))
        for h in _root_handlers():
            h.flush()

        rotations = list(log_dir.glob("app.log.*"))
        assert 1 <= len(rotations) <= 2  # retention bounded

        clog._configured = False


class TestRequestIds:
    def test_new_request_id_shape(self):
        rid = clog.new_request_id()
        assert len(rid) == 8
        int(rid, 16)  # hex

    def test_contextvar_default_and_set(self):
        assert clog.request_id_var.get() == "-"
        token = clog.set_request_id("abc123")
        try:
            assert clog.request_id_var.get() == "abc123"
        finally:
            clog.reset_request_id(token)
        assert clog.request_id_var.get() == "-"

    def test_records_carry_request_id(self, fresh_logging, caplog):
        with caplog.at_level(logging.INFO):
            token = clog.set_request_id("feedface")
            try:
                logging.getLogger("rtw.test").info("with id")
            finally:
                clog.reset_request_id(token)
        rec = caplog.records[0]
        assert rec.request_id == "feedface"


class TestHttpMiddleware:
    async def test_request_gets_id_and_log_line(self, client, caplog):
        with caplog.at_level(logging.INFO, logger="rtw.http"):
            r = await client.get("/api/notes")
        assert r.status_code == 200
        rid = r.headers["x-request-id"]
        assert len(rid) == 8
        line = caplog.records[-1].getMessage()
        assert f"path=/api/notes status=200" in line
        assert "method=GET" in line and "duration_ms=" in line

    async def test_incoming_request_id_is_honored(self, client):
        r = await client.get("/api/notes", headers={"X-Request-ID": "deadbeef"})
        assert r.headers["x-request-id"] == "deadbeef"

    async def test_unhandled_exception_logged_with_id(self, client, caplog):
        from main import app

        @app.get("/__test_boom")
        async def boom():
            raise RuntimeError("exploded on purpose")

        # Contract: log → re-raise. The ASGI transport surfaces the raw
        # exception (a real server converts it to a 500 after this point).
        with pytest.raises(RuntimeError), caplog.at_level(logging.ERROR, logger="rtw.http"):
            await client.get("/__test_boom", headers={"X-Request-ID": "cafe0001"})
        err = [r_ for r_ in caplog.records if r_.name == "rtw.http" and r_.exc_info]
        assert err, "exception must be logged with traceback"
        assert err[0].request_id == "cafe0001"
        assert err[0].exc_info[0] is RuntimeError
        assert "duration_ms=" in err[0].getMessage()


class TestConfig:
    def test_env_overrides(self, monkeypatch, tmp_path):
        # config.py reads env at import; verify the knobs exist and parse
        from app import config

        assert config.LOG_LEVEL in {"DEBUG", "INFO", "WARNING", "ERROR"}
        assert isinstance(config.LOG_RETENTION, int)
        assert config.LOG_DIR.name  # non-empty path
