"""Application wiring: create app, attach lifespan, mount static, include routers."""
import time

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles

from app.config import STATIC_DIR
from app.core.logging import (
    get_logger,
    new_request_id,
    reset_request_id,
    set_request_id,
    setup_logging,
)
from app.lifespan import lifespan
from app.routes import api_router

# Configure logging before anything else imports/uses loggers.
setup_logging()
log = get_logger("rtw.http")

app = FastAPI(title="RTW", lifespan=lifespan)


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    """One correlated log line per HTTP request.

    - Assigns (or honors) X-Request-ID and exposes it on the response.
    - The ID lives in a ContextVar, so every log line emitted anywhere
      inside this request's handling carries it automatically.
    - Bodies are never logged. /static traffic logs at DEBUG to keep the
      application log focused on API operations.
    """
    rid = request.headers.get("x-request-id") or new_request_id()
    token = set_request_id(rid)
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        log.exception(
            "request failed method=%s path=%s duration_ms=%d",
            request.method, request.url.path,
            int((time.perf_counter() - start) * 1000),
        )
        raise
    finally:
        duration_ms = int((time.perf_counter() - start) * 1000)

    # API operations at INFO; static/other traffic at DEBUG to keep the
    # application log focused.
    emit = log.info if request.url.path.startswith("/api") else log.debug
    emit(
        "method=%s path=%s status=%d duration_ms=%d",
        request.method, request.url.path, response.status_code, duration_ms,
    )
    response.headers["X-Request-ID"] = rid
    reset_request_id(token)
    return response


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(api_router)
