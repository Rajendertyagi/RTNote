"""Page-serving routes."""
from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from app.config import TEMPLATES_DIR

router = APIRouter(tags=["pages"])


@router.get("/", response_class=HTMLResponse)
async def index():
    html_path = TEMPLATES_DIR / "index.html"
    return HTMLResponse(content=html_path.read_text(encoding="utf-8"))


@router.get("/chat", response_class=HTMLResponse)
async def chat_page():
    html_path = TEMPLATES_DIR / "chat.html"
    return HTMLResponse(content=html_path.read_text(encoding="utf-8"))
