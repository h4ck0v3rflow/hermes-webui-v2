---
trigger: glob
globs: "api/**, server.py"
description: Backend routing, SSE streaming, and upstream merge-safety rules
---

# Backend Rules (`api/` and `server.py`)

- **Minimal Seams Only:** Keep upstream edits limited to the single-line dispatch hooks in `api/routes.py` (`handle_cockpit_get`, `handle_cockpit_post`), CSP attributes in `server.py`, and the optional guardrail hook in `api/route_approvals.py`. Document every touched upstream file and line range in `COCKPIT.md`.
- **Freeze List:** NEVER modify `static/index.html`, `static/ui.js`, `static/panels.js`, `static/sessions.js`, `static/messages.js`, `static/boot.js`, `static/style.css`, `static/i18n.js`, or `static/sw.js`.
- **Reuse Existing Subsystems:**
  - Terminal: Reuse `/api/terminal/*` (`api/terminal.py`) verbatim — do not write a new PTY endpoint.
  - Approvals: Hook custom scope-guardrail blocks into the existing `_pending` approval queue (`api/route_approvals.py`).
  - Browser Takeover: Mirror the `AGENT` / `HUMAN` lease state machine from `tools/bot_desktop/lease.py` with server-side RFB input filtering in the RFC6455 VNC proxy.
  - System Health & Kill Switch: Reuse `/api/system/health` (`api/system_health.py`) and `api/background_process.py` with a strict `PROTECTED_PROCS` allowlist (`sshd`, `hermes`, `server.py`, `systemd`, `tailscaled`).
- **HTTP/1.1 Framing & Timeouts:** Every custom handler must set explicit `Content-Length` or valid `Transfer-Encoding: chunked` / SSE headers so HTTP/1.1 keep-alive does not stall until `Handler.timeout = 30`. All custom SSE streams must call `_sse_set_write_deadline` from `api/streaming.py`.
- **Watchdog File Events:** Observe both `MODIFIED` and `MOVED_TO` (atomic temp-file + `os.replace()`), debounce at 150ms, ignore `.git/` and `node_modules/`, honor workspace blocked roots, and cap payloads at 256 KB.
