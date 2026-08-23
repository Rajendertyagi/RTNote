"""Centralized paths and settings. Everything derives from BASE_DIR."""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent   # project root
APP_DIR = BASE_DIR / "app"
FRONTEND_DIR = BASE_DIR / "frontend"
TEMPLATES_DIR = FRONTEND_DIR / "templates"
STATIC_DIR = FRONTEND_DIR / "static"
DATA_DIR = BASE_DIR / "data"

DATA_DIR.mkdir(exist_ok=True)

NOTES_DB_PATH = DATA_DIR / "notes.db"
CHAT_DATABASE_URL = f"sqlite+aiosqlite:///{(DATA_DIR / 'chat.db').as_posix()}"

HOST = "0.0.0.0"
PORT = 8000
