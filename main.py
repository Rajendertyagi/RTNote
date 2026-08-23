"""Application wiring: create app, attach lifespan, mount static, include routers."""
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.config import STATIC_DIR
from app.lifespan import lifespan
from app.routes import api_router

app = FastAPI(title="RTW", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.include_router(api_router)
