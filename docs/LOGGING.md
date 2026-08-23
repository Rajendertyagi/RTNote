# Logging

RTNote uses Python's standard `logging` module through one small central
module (`app/core/logging.py`). No external logging infrastructure.

## Where logs live

```
data/logs/app.log     everything (INFO and up), rotated at 2 MB
data/logs/error.log   errors only, rotated at 1 MB
```

`data/` is gitignored — logs never reach GitHub. Rotated files get `.1`, `.2`…
suffixes; the newest is always `app.log`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `LOG_LEVEL` | `INFO` | Minimum level: `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| `LOG_DIR` | `data/logs` | Where log files are written |
| `LOG_RETENTION` | `5` | How many rotated files to keep per log |

Set `LOG_LEVEL=DEBUG` temporarily to see static-file traffic and extra
detail; delete the variable afterwards to return to normal.

If the log directory cannot be created, the app keeps running with console
logging only — logging problems never crash RTNote.

## Request IDs

Every HTTP request gets an 8-character ID (`ab12cd34`). It appears:

- in **every** log line produced while handling that request (routes,
  database, backups, chat) — automatically, no need to pass it around,
- in the `X-Request-ID` response header,
- in the browser: `api.js` remembers the latest ID so frontend logs can
  carry the same `[id]` prefix.

To trace one operation, grep for its ID:

```
findstr ab12cd34 data\logs\app.log
```

## What is intentionally NOT logged

- API keys / provider credentials / passwords
- Note contents or titles' bodies (IDs and types only)
- Chat prompts or assistant responses (model/provider names are fine)
- Attachment contents
- Full request/response bodies

## Log levels used

- **DEBUG** — static file serving, verbose diagnostics
- **INFO** — app started/stopped, note created/deleted, attachment uploaded,
  backup completed, request line (`method= path= status= duration_ms=`)
- **WARNING** — recoverable oddities (FTS search fell back to LIKE scan)
- **ERROR** — failed operations, unhandled exceptions (with traceback)

## Diagnosing common problems

| Symptom | Where to look |
|---|---|
| "Which request changed my data?" | grep the request ID in `app.log`; every line of that request shares it |
| App won't start | last lines of `error.log` |
| Backup concerns | grep `backup` in `app.log` (`started/completed/failed`) |
| Slow requests | look for large `duration_ms=` values in `app.log` |
| Provider/chat failures | grep `chat` or `provider` in `error.log` |

## For developers (and AI agents)

Backend:

```python
from app.core.logging import get_logger

log = get_logger(__name__)          # module top level

log.info("note updated id=%s", note_id)          # IDs/values as args, not f-strings
log.warning("retrying provider=%s", provider)
log.exception("stream failed")                    # ERROR + traceback
```

Frontend:

```js
RTWLog.warn('bookmarks refresh failed', err);     // visible by default
RTWLog.debug('tree reloaded', { nodes: n });      // only with RTW_LOG_LEVEL=debug
localStorage.RTW_LOG_LEVEL = 'debug';             // temporary verbosity
```

Never log private content or secrets; log identifiers and outcomes.
