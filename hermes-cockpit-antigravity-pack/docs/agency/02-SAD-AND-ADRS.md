# Document 02: System Architecture Document (SAD) & ADRs

**System:** Hermes Offensive Security Cockpit  
**Architectural Style:** Modular Monolith (Python `ThreadingHTTPServer`) + Strangler SPA (`static/v2/`)

---

## 1. High-Level System Topology

```text
+-----------------------------------------------------------------------------------+
|                     CLIENT LAYER (Desktop Browser / Mobile PWA)                   |
|                                                                                   |
|  +-----------------------+  +-----------------------+  +-----------------------+  |
|  | Zustand Store         |  | @xterm/xterm          |  | CodeMirror 6          |  |
|  | (6 isolated SSE slices|  | (Direct binary/chunk  |  | (@codemirror/merge    |  |
|  |  + CSRF apiFetch)     |  |  buffer; zero React   |  |  + extension map)     |  |
|  +-----------+-----------+  |  re-renders)          |  +-----------+-----------+  |
|              |              +-----------+-----------+              |              |
|              |                          |                          |              |
|  +-----------v--------------------------v--------------------------v-----------+  |
|  |                     @novnc/novnc Canvas (RFB over WS)                       |  |
|  +--------------------------------------+--------------------------------------+  |
+-----------------------------------------|-----------------------------------------+
                                          | HTTPS / WSS (Tailscale / Reverse Proxy)
+-----------------------------------------v-----------------------------------------+
|               UBUNTU VPS BACKEND (hermes-webui ThreadingHTTPServer)               |
|                                                                                   |
|  [server.py:390] check_auth_or_close()  <-- Global Pre-Dispatch Auth Gate         |
|       |                                                                           |
|       +---> [api/cockpit/routes.py] (New Seam: ~40 lines in api/routes.py)        |
|       |        |-- GET  /v2, /v2/                --> static/v2/index.html + Config|
|       |        |-- GET  /api/cockpit/files/stream --> SSE watchdog (MOVED_TO)     |
|       |        |-- GET  /api/cockpit/traffic      --> Server-side HuntProxy       |
|       |        |-- CRUD /api/cockpit/findings     --> ~/.hermes/hunts/*.md        |
|       |        |-- POST /api/cockpit/kill         --> Protected killpg()          |
|       |        +-- WS   /api/cockpit/vnc          --> RFC6455 <-> x11vnc + Lease  |
|       |                                                                           |
|       +---> [Existing 227 Routes] (Unmodified Upstream Core)                      |
|                |-- /api/sessions, /api/chat, /api/memory, /api/skills, /api/cron  |
|                |-- /api/terminal/* (PTY + 2000-chunk ring buffer + fan-out)       |
|                |-- /api/approval/* (+ Scope Guardrail middleware hook)            |
|                +-- /api/system/health (CPU / RAM / Disk telemetry)                |
+-----------------------------------------------------------------------------------+
```

---

## 2. State Machines

### 2.1. Browser Takeover Lease State Machine (`AGENT` vs. `HUMAN`)
Mirrors `tools/bot_desktop/lease.py` with server-side input gating in the RFC6455 VNC proxy:

```text
                [Click "Take Control"]
  +-----------+ ------------------------> +-----------+
  |   AGENT   |                           |   HUMAN   |
  | (Default) | <------------------------ | (Locked)  |
  +-----------+  [Click "Hand Back" OR    +-----------+
                 Idle Timeout (10 min)]
```

- **AGENT State:** Playwright/bot input events are permitted; VNC client receives framebuffer updates (`FramebufferUpdate`), while pointer/key RFB packets from the browser are dropped server-side (`viewOnly` enforced at protocol level).
- **HUMAN State:** Agent browser tool calls pause on the lease lock; VNC client RFB `PointerEvent` and `KeyEvent` packets pass through to `x11vnc`.

### 2.2. Scope Guardrail & Approval Pipeline
```text
Agent Tool Call --> Scope Evaluator (Active Hunt Regex + glob deny list)
                         |
         +---------------+---------------+
         | (Out of Scope / High Risk)    | (In Scope)
         v                               v
  Auto-Settle `deny` +            Standard Hermes Approval Policy
  Emit `scope.violation` SSE      (`smart` / `always` / `once`)
```

---

## 3. Architecture Decision Records (ADRs)

### ADR-001: Retain `ThreadingHTTPServer` Instead of Migrating to FastAPI
- **Context:** Initial blueprint assumed a FastAPI backend for WebSocket endpoints. Codebase audit confirmed `server.py` uses a custom `ThreadingHTTPServer` with 227 routes, pre-dispatch auth (`check_auth_or_close`), and 1,639 `pytest` tests.
- **Decision:** Keep `ThreadingHTTPServer` untouched; mount `api/cockpit/routes.py` via a 2-line hook in `api/routes.py`.
- **Consequence:** Preserves 100% test coverage and auth inheritance; requires explicit `Content-Length`/chunked framing and `_sse_set_write_deadline` on custom streaming handlers.

### ADR-002: Vite Static SPA (`static/v2/`) Instead of Next.js
- **Context:** The VPS has ~32 GB free disk and serves a single authenticated operator. Next.js requires a persistent Node server process and duplicates routing.
- **Decision:** Build `web/` with Vite + React + TypeScript directly into `static/v2/`, served by Python's `_serve_static` with `__WEBUI_VERSION__` templating.
- **Consequence:** Zero Node runtime memory overhead in production; instant static asset caching.

### ADR-003: CodeMirror 6 Instead of Monaco Editor
- **Context:** Monaco weighs > 2.4 MB plus web workers and exhibits broken touch selection and virtual keyboard jitter on mobile browsers. Hermes's own desktop codebase already standardizes on CodeMirror 6.
- **Decision:** Use `@uiw/react-codemirror` + `@codemirror/merge` with an explicit file-extension language map (`py`, `js`, `ts`, `json`, `sh`, `md`, `yaml`, `html`, `sql`).
- **Consequence:** < 200 KB editor footprint with native mobile touch gestures and hunk-level diff rendering.

### ADR-004: Reuse `/api/terminal/*` SSE + POST Over Custom WebSocket PTY
- **Context:** `api/terminal.py` already implements a full Linux PTY, 2,000-chunk backlog, sequence-number resume, and multi-viewer queue fan-out.
- **Decision:** Bind `@xterm/xterm` directly to existing `/api/terminal/start`, `/output`, `/input`, `/resize`, and `/close` endpoints.
- **Consequence:** Zero backend terminal code required; guaranteed parity with legacy session persistence.

### ADR-005: Strangler Pattern with `COCKPIT_PRIMARY` Environment Toggle
- **Context:** Replacing all 9 legacy frontend JS files in one shot risks blocking active bug-hunting operations if an edge case breaks.
- **Decision:** Freeze legacy `static/*.js` files, mount v2 at `/v2` during development, and use `COCKPIT_PRIMARY=1` to switch `/` to v2 while keeping `/legacy` accessible.
- **Consequence:** Clean monthly `git merge upstream/master` with near-zero merge conflicts and instant rollback.
