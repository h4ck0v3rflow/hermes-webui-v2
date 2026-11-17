---
trigger: glob
globs: "web/**"
description: Frontend architecture, state management, and component rules for the /v2 React cockpit
---

# Frontend Rules (`web/`)

- **Build Config:** Keep `base: '/static/v2/'` and `outDir: '../static/v2'` in `web/vite.config.ts`, with dev proxy `'/api': 'http://127.0.0.1:8787'`. Never use Next.js or SSR.
- **API Client:** All HTTP requests must go through a central `apiFetch()` wrapper that reads `window.__HERMES_CONFIG__.csrfToken` and attaches `X-CSRF-Token` on all mutating requests (`POST`, `PUT`, `DELETE`).
- **Zustand Isolation:** Maintain separate Zustand slices per SSE stream (`chat`, `session`, `approval`, `clarify`, `terminal`, `cron`). Keep the 10k-line `@xterm/xterm` terminal buffer inside xterm's own instance — NEVER store raw terminal streams in React state.
- **Vendor Locally:** Bundle `@xterm/xterm` and `@xterm/addon-fit` via npm rather than CDN `<script>` tags.
- **Editor Choice (Module 2+):** Use **CodeMirror 6** (`@uiw/react-codemirror` + `@codemirror/merge`) with an explicit file-extension language map (`py`, `js`, `ts`, `json`, `sh`, `md`, `yaml`, `html`, `sql`) — NEVER use Monaco Editor. Animate newly inserted `file_delta` lines with `EditorView.scrollIntoView` and a transient emerald highlight (`cm-line-flash`).
- **Approval & Clarify Hygiene:**
  - Support all 4 native approval resolutions (`once`, `session`, `always`, `deny`) and deterministically fall back `approval_id` -> `run_id` when `approval_id` is empty in gateway mode.
  - Key `clarify` option-selection cards strictly by `clarify_id` so answered prompts dismiss immediately even when identical questions repeat.
- **Mobile First Parity:** Every workspace view must work cleanly on mobile viewports (`390x844`) with a sticky bottom navigation bar (`Chat | CMD | Code | Browser`), sticky Terminal Accessory Key Bar (`Ctrl+C`, `Esc`, `Tab`, `|`, `/`, `-`, arrows), and `navigator.vibrate([80, 40, 80])` on approval/clarify/scope-violation events.
