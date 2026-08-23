"""Centralized paths and settings. Everything derives from BASE_DIR.

DB locations can be overridden via env vars (NOTES_DB_PATH,
CHAT_DATABASE_URL) so tests/CI can point them at temp files.
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent   # project root
APP_DIR = BASE_DIR / "app"
FRONTEND_DIR = BASE_DIR / "frontend"
TEMPLATES_DIR = FRONTEND_DIR / "templates"
STATIC_DIR = FRONTEND_DIR / "static"
DATA_DIR = BASE_DIR / "data"

DATA_DIR.mkdir(exist_ok=True)

NOTES_DB_PATH = Path(os.getenv("NOTES_DB_PATH", str(DATA_DIR / "notes.db")))
CHAT_DATABASE_URL = os.getenv(
    "CHAT_DATABASE_URL",
    f"sqlite+aiosqlite:///{(DATA_DIR / 'chat.db').as_posix()}",
)
# Provider API keys / base URLs (never committed — data/ is gitignored).
CONNECTIONS_PATH = Path(os.getenv("CONNECTIONS_PATH", str(DATA_DIR / "connections.json")))

# Bind address. 127.0.0.1 = this machine only (safe default for an app with
# no authentication). Override with APP_HOST=0.0.0.0 to serve your LAN —
# start.bat reads the same variable.
HOST = os.getenv("APP_HOST", "127.0.0.1")
PORT = int(os.getenv("APP_PORT", "8000"))
