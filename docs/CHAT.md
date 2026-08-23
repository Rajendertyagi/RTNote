# Chat Subsystem Architecture

One chat system, two surfaces. This document is the map for anyone (human or
AI agent) working on chat code.

## Module boundaries

```
Backend
  app/chat/routes.py        /api/chat endpoints (send, stream SSE, sessions,
                            history, memories) — thin HTTP layer
  app/chat/memory.py        MemoryManager: session persistence, LLM calls,
                            memory extraction/search (FTS5), CHAT_FAKE_LLM hook
  app/chat/models.py        Model catalog for the UI (ids verified against
                            LiteLLM registry 2026-08; effort levels per provider)
  app/chat/connections.py   Provider registry + data/connections.json storage +
                            /api/connections CRUD + test endpoint
  app/chat/db.py            Async engine, FTS5 table/triggers

Frontend
  static/js/chat-core.js    THE shared layer: API client, payloads, state,
                            attachments, canonical message rendering (markdown)
  static/js/chat.js         Full-page adapter (/chat): sessions sidebar,
                            custom models, system-prompt editor, SSE transport
  static/js/ui.js           Mini-panel adapter (index page): blocking /send
                            transport, compact toolbar
  static/css/chat.css       All chat styling (both surfaces)
```

## Data flow

- **Full page:** composer → `ChatCore.buildPayload` → `POST /api/chat/stream`
  → SSE events `meta` / `delta` / `error` / `done` → rAF-buffered rendering.
- **Mini panel:** input → `ChatCore.buildPayload` → `POST /api/chat/send`
  (blocking) → `{session_id, reply, error?}`.
- **Memory:** last user message → FTS5 recall → injected into system prompt →
  reply → background extraction via a cheap model from the *same provider*
  (skipped entirely when that provider is unconfigured).
- **Context window:** only the system prompt + last `CHAT_HISTORY_LIMIT`
  messages (default 20, env-overridable) are sent to the LLM. Full history
  stays in the DB and remains visible in the UI.

## Error contract

LLM failures raise `ChatStreamError`. They are never persisted as assistant
messages. `/send` returns `{reply: "", error: "..."}`; `/stream` emits a
`{"type": "error"}` SSE event. Clients render a distinct red bubble. If the
client disconnects mid-stream, whatever already streamed IS persisted.

## Intentional differences: mini vs full

| Aspect | Mini panel | Full page |
|---|---|---|
| Transport | blocking `/send` | SSE `/stream` with stop button |
| System prompt | fixed note-app persona (`MINI_SYSTEM_PROMPT`) | user-editable, persisted (`LS.sys`) |
| Custom model input | no | yes |
| Effort control | simple select (off/low/medium/high) | segmented control from catalog |
| Sessions UI | none (session id kept in memory) | full sidebar |

Everything else — payload shape, attachment handling, message markup
(`.msg > .avatar + .bubble`), markdown rendering, copy buttons, localStorage
keys (`chatModel`, `chatEffort`) — is shared via chat-core.js.

## Markdown

Assistant bubbles render through marked.js + DOMPurify (CDN), sanitized;
raw text is kept in `bubble.dataset.raw` so Copy copies the source. If the
CDN is unreachable the bubble falls back to escaped plain text.

## Testing

- pytest: `tests/test_chat_*.py`, `tests/test_connections.py` (mocked LLM).
- Playwright: `tests/e2e/chat.spec.ts`, runs against `CHAT_FAKE_LLM=canned`
  (set in `tests/playwright.config.ts`; the hook lives in `memory.py` and is
  never set in production).

## Known limitations

- Memory extraction uses the provider's cheap "test model"; quality varies.
- No auth (personal, localhost-bound app by default).
- Chat FTS triggers use `IF NOT EXISTS` and are not auto-repaired if the
  index corrupts (the notes DB does drop+recreate on startup).
