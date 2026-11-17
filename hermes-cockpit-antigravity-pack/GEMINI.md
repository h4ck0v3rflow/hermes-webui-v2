# Hermes Offensive Security Cockpit — Project Rules

## Architecture Facts (Non-Negotiable)
- **Backend:** Hand-rolled Python `ThreadingHTTPServer` (`server.py`) with `handle_get`/`handle_post` dispatch in `api/routes.py`. **NEVER** port to FastAPI, Starlette, or Node.js.
- **Frontend:** Vite + React + TypeScript + Tailwind CSS + Zustand in `web/`, compiled to `static/v2/` and served at `/v2` (or `/` when `COCKPIT_PRIMARY=1`). **NEVER** use Next.js or run a second production Node server.
- **Auth:** `check_auth_or_close` (`server.py:390`) runs before route dispatch. All new `/api/cockpit/*` and `/v2` routes inherit auth automatically — never write a second auth path.

## Freeze List (NEVER Modify)
`static/index.html`, `static/ui.js`, `static/panels.js`, `static/sessions.js`, `static/messages.js`, `static/boot.js`, `static/style.css`, `static/i18n.js`, `static/sw.js`.
All new UI code lives exclusively in `web/`. All new backend logic lives in `api/cockpit/`.

## Critical Codebase Traps
1. **CSRF & Config Injection:** `serve_cockpit_shell` MUST inject `window.__HERMES_CONFIG__` (`csrfToken`, `maxUploadBytes`, `imgSrcExtra`) and `__WEBUI_VERSION__` into `static/v2/index.html` with explicit `Content-Length` framing. Without `csrfToken` in `X-CSRF-Token`, every `POST`/`PUT`/`DELETE` returns `403`.
2. **30-Second HTTP Timeout:** `Handler.timeout = 30` with HTTP/1.1 keep-alive kills naive streaming loops. Always reuse `api/streaming.py`'s `_sse_set_write_deadline` helpers and set explicit `Content-Length` or `Transfer-Encoding: chunked`.
3. **Atomic File Writes:** `watchdog` file monitors must handle `MOVED_TO` (temp-file + `os.replace()`) in addition to `MODIFIED`, debounced and capped at 256 KB.
4. **Service Worker Isolation:** Never register legacy `static/sw.js` on `/v2`. Use a dedicated, scoped `static/v2/sw-v2.js` (`scope: '/v2'`) to prevent stale legacy asset caching.
5. **CSP Headers:** If adding VNC/WebSocket origins, register them via `_csp_extra_connect_src` / `_csp_extra_frame_src` in `server.py`.

## Reference Docs
- Codebase seams & reused routes: `@COCKPIT.md`
- Engineering package: `@docs/agency/01-PRD.md` through `@docs/agency/07-DELIVERY-ROADMAP-RUNBOOK.md`
