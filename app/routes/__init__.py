"""Router aggregation — main.py includes everything from here."""
from fastapi import APIRouter

from app.routes import attachments, bookmarks, days, notes, options, pages, trash
from app.chat.routes import router as chat_router
from app.chat.models import router as chat_models_router
from app.chat.connections import router as connections_router

api_router = APIRouter()
api_router.include_router(pages.router)
api_router.include_router(notes.router)
api_router.include_router(attachments.router)
api_router.include_router(trash.router)
api_router.include_router(bookmarks.router)
api_router.include_router(days.router)
api_router.include_router(options.router)
api_router.include_router(chat_router)
api_router.include_router(chat_models_router)
api_router.include_router(connections_router)
