import { defineConfig } from "@playwright/test";
import fs from "fs";
import path from "path";

// E2E server runs against throwaway DBs via env overrides — never data/*.db.
// This config lives in tests/; repo root is one level up (for main.py + frontend).
const root = path.join(__dirname, "..");
const e2eDir = path.join(__dirname, ".tmp-e2e");
// SQLite cannot open a DB file whose parent directory doesn't exist.
fs.mkdirSync(e2eDir, { recursive: true });

export default defineConfig({
  testDir: "./e2e",
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // single shared server DB — keep specs sequential
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:8123",
    trace: "on-first-retry",
  },
  webServer: {
    command: "python -m uvicorn main:app --host 127.0.0.1 --port 8123",
    url: "http://127.0.0.1:8123/api/notes",
    timeout: 60_000,
    reuseExistingServer: false,
    cwd: root,
    env: {
      NOTES_DB_PATH: path.join(e2eDir, "notes.db"),
      CHAT_DATABASE_URL:
        "sqlite+aiosqlite:///" + path.join(e2eDir, "chat.db").replace(/\\/g, "/"),
    },
  },
});
