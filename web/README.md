# Hermes Cockpit v2 Frontend (`web/`)

Vite + React + TypeScript + Tailwind CSS v4 + Zustand SPA compiled into `../static/v2/` and served at `/v2` (behind `server.py` auth).

## Development

```bash
# Terminal 1: Python backend (from repo root)
python server.py

# Terminal 2: Vite HMR dev server (proxies /api to http://127.0.0.1:8787)
cd web
npm install
npm run dev
```

## Production Build

```bash
cd web
npx tsc --noEmit
npm run build
```

Output is written to `static/v2/` with `base: '/static/v2/'`. `api/cockpit/routes.py` injects `window.__HERMES_CONFIG__` (`csrfToken`, `maxUploadBytes`, `imgSrcExtra`) and `window.__WEBUI_VERSION__` at request time.

## Rules

- All HTTP calls must use `src/lib/apiFetch.ts` so `X-CSRF-Token` is attached on mutating requests.
- Never import from or modify `../refs/`.
- Never modify frozen legacy `static/*.js` or `static/index.html` files.
