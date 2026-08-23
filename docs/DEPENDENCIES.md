# Dependency Situation (Phase 1 snapshot, 2026-08-23)

Policy for this project phase: **no speculative upgrades**. Versions below are
what is actually installed and tested locally. All requirements use `>=`
floats and there are no lockfiles yet — this is a known medium-term risk
(upstream releases can break CI independently of our changes). Pinning +
lockfiles are planned as their own small change, not mixed into feature work.

## Backend (installed versions)

| Package | Installed | Declared | Notes |
|---|---|---|---|
| fastapi | 0.141.1 | >=0.104.0 | |
| uvicorn | 0.34.0 | >=0.24.0 | |
| jinja2 | 3.1.6 | >=3.1.2 | **unused in code** (pages served via raw HTMLResponse) — removal deferred to the dependency-cleanup change |
| python-multipart | 0.0.32 | >=0.0.6 | needed by UploadFile |
| litellm | 1.97.0 | >=1.0 | effectively unpinned; major-version churn risk |
| aiosqlite | 0.20.0 | >=0.19 | chat DB driver |
| sqlalchemy[asyncio] | 2.0.52 | >=2.0 | chat ORM |
| pydantic | 2.13.4 | (transitive) | imported directly by chat code but not declared |

Dev: pytest 9.1.1, pytest-asyncio 1.4.0, pytest-cov 7.1.0, httpx 0.28.1,
ruff 0.16.4.

## Frontend / E2E

- npm: @playwright/test ^1.49.0 — **no package-lock.json committed**
- CDN libraries (not vendored): wunderbaum 0.14.1, suneditor 3.3.0,
  split.js 1.6.5, fullcalendar 6.1.15, mermaid 11, mind-elixir 4,
  CodeMirror 6 scoped packages via esm.sh

## CI note

GitHub Actions installs with the same floating specifiers on Python 3.14.
Until versions are pinned, a red CI run caused by an upstream release is
possible; check the release diff before assuming a local regression.
