"""Centralized application logging (standard library only).

Design:
- One setup function, called once at startup (main.py import time).
- Console handler + rotating app log + rotating error log.
- A ContextVar carries the current request_id so EVERY log line emitted
  while handling a request is correlated automatically — routes, services,
  database code, all of it — without passing IDs around by hand.
- Logging problems must never crash the app: file handlers are attached
  best-effort; if files are unavailable the app runs console-only.

Format:
    2026-08-23 12:00:00 INFO     [ab12cd34] app.database.backup: Backup completed ...

Modules use it like this:

    from app.core.logging import get_logger
    log = get_logger(__name__)
    log.info("note created id=%s", note_id)
"""
import logging
import logging.handlers
import secrets
from contextvars import ContextVar

from app.config import LOG_DIR, LOG_LEVEL, LOG_RETENTION

# "-" shows up in records emitted outside any request (startup, backups).
request_id_var: ContextVar[str] = ContextVar("request_id", default="-")

_APP_LOG_BYTES = 2 * 1024 * 1024   # 2 MB per app.log rotation
_ERR_LOG_BYTES = 1 * 1024 * 1024   # 1 MB per error.log rotation

_FORMAT = "%(asctime)s %(levelname)-8s [%(request_id)s] %(name)s: %(message)s"

_configured = False


class RequestIdFilter(logging.Filter):
    """Injects the current request_id into every LogRecord."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True


def new_request_id() -> str:
    """Short random ID for correlating one HTTP request's log lines."""
    return secrets.token_hex(4)


def get_logger(name: str) -> logging.Logger:
    """Standard-library logger bound to the app's formatter/filter."""
    return logging.getLogger(name)


def set_request_id(rid: str):
    """Set the request ID for the current async context. Returns a token
    for reset — middleware handles that; subsystems rarely need this."""
    return request_id_var.set(rid)


def reset_request_id(token) -> None:
    request_id_var.reset(token)


def setup_logging(force: bool = False) -> None:
    """Configure formatters, handlers and levels. Idempotent unless force=True
    (tests re-configure against temp dirs)."""
    global _configured
    if _configured and not force:
        return

    root = logging.getLogger()

    level = getattr(logging, LOG_LEVEL, logging.INFO)
    root.setLevel(level)

    filt = RequestIdFilter()
    formatter = logging.Formatter(_FORMAT)

    # Console — always available, cannot fail.
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    console.addFilter(filt)
    root.addHandler(console)

    # Rotating files — best effort. If the disk/dir is unavailable the app
    # keeps running with console logging only.
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)

        app_file = logging.handlers.RotatingFileHandler(
            LOG_DIR / "app.log", maxBytes=_APP_LOG_BYTES,
            backupCount=LOG_RETENTION, encoding="utf-8",
        )
        app_file.setFormatter(formatter)
        app_file.addFilter(filt)
        root.addHandler(app_file)

        err_file = logging.handlers.RotatingFileHandler(
            LOG_DIR / "error.log", maxBytes=_ERR_LOG_BYTES,
            backupCount=LOG_RETENTION, encoding="utf-8",
        )
        err_file.setFormatter(formatter)
        err_file.addFilter(filt)
        err_file.setLevel(logging.ERROR)
        root.addHandler(err_file)
    except OSError:
        root.warning("Log files unavailable in %s — running console-only", LOG_DIR)

    # Our HTTP middleware logs every request; uvicorn's own access log would
    # duplicate each line without request IDs. Keep errors from uvicorn.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

    _configured = True
