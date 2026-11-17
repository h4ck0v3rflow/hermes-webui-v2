# COCKPIT.md — Codebase Seam Map & Reused Subsystems

## 1. Upstream Files Touched (Keep Minimal for Monthly `git merge upstream/master`)
| File | Seam / Purpose | Line / Scope |
| :--- | :--- | :--- |
| `api/routes.py` | Top-of-dispatch hooks calling `handle_cockpit_get` and `handle_cockpit_post` | 2-line import + 2-line hook in `handle_get` / `handle_post` |
| `server.py` | `_csp_extra_connect_src` / `_csp_extra_frame_src` for VNC/WS (Module 7) | 1–2 lines on handler attributes |
| `api/route_approvals.py` | Optional Scope Guardrail middleware hook on `_gateway_queues` (Module 6) | Minimal hook calling `api/cockpit/scope.py` |

All other new code lives exclusively in `api/cockpit/` (backend) and `web/` (frontend).

## 2. Reused Upstream Subsystems (Do NOT Rewrite)
- **Auth Gate:** `server.py:390` (`check_auth_or_close`) — runs pre-dispatch on all routes.
- **Interactive Terminal (PTY):** `api/terminal.py` (`/api/terminal/start`, `/output?id=&seq=`, `/input`, `/resize`, `/close`) — already provides a real Linux PTY, 2,000-chunk ring buffer, sequence resume, and multi-viewer fan-out.
- **Approvals & Clarify:** `api/route_approvals.py` (`/api/approval/pending`, `/api/approval/respond`) & `api/streaming.py` (`approval.request`, `clarify.request`, `_sse_set_write_deadline`).
- **Chat & Mid-Run Controls:** `/api/chat`, `/api/chat/steer`, `/api/chat/queue`, `/api/chat/interrupt`.
- **Sessions, Memory, Skills, Cron, Profiles, Models:** `/api/sessions`, `/api/memory`, `/api/skills`, `/api/cron`, `/api/profiles`, `/api/models`.
- **System Health & Background Processes:** `api/system_health.py` (`/api/system/health`), `api/background_process.py` (process registry for protected `killpg`).
- **Desktop Lease Semantics:** `tools/bot_desktop/lease.py` (`AGENT` vs `HUMAN` state machine with eviction/timeout).
- **SSE Stream Reference:** `docs/sse-streams.md`.
