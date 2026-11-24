"""Live interactive browser: CDP screencast down, real input events up.

Replaces the still-image polling path for human takeover. Frames arrive as
JPEG deltas pushed by Chromium only when the page changes, and clicks, wheel,
keys and typed text are injected as genuine browser input events.
"""

from __future__ import annotations

import json
import queue
import time
from urllib.parse import parse_qs

from api.helpers import bad, j, read_body
from api.sse_chunked import end_sse_headers


def _resolve_pid(parsed) -> int | None:
    from api.cockpit import huntproxy as hp

    qs = parse_qs(parsed.query)
    raw_pid = (qs.get("project_id") or [""])[0].strip()
    sid = (qs.get("session_id") or [""])[0].strip()
    if raw_pid:
        _online, pid, _ = hp.validate_project_id(raw_pid)
        return pid
    if sid:
        resolved = hp.resolve_project_for_session(sid)
        pid = resolved.get("project_id")
        return int(pid) if pid else None
    return None


def handle_live_stream(handler, parsed) -> bool:
    """SSE: CDP screencast frames + navigation + control state."""
    from api.cockpit import cdp
    from api.routes import _SSE_HEARTBEAT_INTERVAL_SECONDS
    from api.streaming import _sse, _sse_set_write_deadline, _sse_write

    try:
        pid = _resolve_pid(parsed)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    if pid is None:
        bad(handler, "project_id is required", 400)
        return True

    _sid = (parse_qs(parsed.query).get("session_id") or [""])[0].strip()
    prof = ""
    if _sid:
        from api.cockpit.browser import _session_profile

        prof = _session_profile(_sid)
    sess = cdp.get_session(pid, prof, create_if_missing=False)
    if sess is None:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("Connection", "close")
        end_sse_headers(handler)
        _sse_set_write_deadline(handler)
        _sse(handler, "browser_live", {"t": "offline", "message": "CDP unavailable for this project"})
        return True

    q = sess.subscribe()
    try:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("X-Accel-Buffering", "no")
        handler.send_header("Connection", "close")
        end_sse_headers(handler)
        _sse_set_write_deadline(handler)
        _sse(
            handler,
            "browser_live",
            {"t": "ready", "mode": "cdp-screencast", "project_id": pid, "ts": time.time()},
        )
        # Late joiner: hand over the newest frame immediately.
        frame = sess.current_frame()
        if frame:
            _sse(
                handler,
                "browser_live",
                {
                    "t": "frame",
                    "seq": frame.get("seq"),
                    "w": frame.get("w"),
                    "h": frame.get("h"),
                    "jpeg_b64": frame.get("jpeg_b64"),
                },
            )
        while True:
            try:
                payload = q.get(timeout=_SSE_HEARTBEAT_INTERVAL_SECONDS)
            except queue.Empty:
                _sse_write(handler, b": keepalive\n\n")
                continue
            _sse(handler, "browser_live", payload)
            if payload.get("t") == "closed":
                break
            if not sess.alive():
                break
    except (BrokenPipeError, ConnectionResetError, OSError):
        pass
    finally:
        sess.unsubscribe(q)
    return True


def handle_input(handler) -> bool:
    """POST human input events into the live CDP session."""
    from api.cockpit import cdp

    raw = read_body(handler)
    if isinstance(raw, dict):
        body = raw
    else:
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            bad(handler, "invalid JSON body", 400)
            return True
    if not isinstance(body, dict):
        bad(handler, "body must be an object", 400)
        return True

    try:
        pid = int(body.get("project_id") or 0)
    except (TypeError, ValueError):
        pid = 0
    if not pid:
        bad(handler, "project_id is required", 400)
        return True

    prof = ""
    _sid = str(body.get("session_id") or "").strip()
    if _sid:
        from api.cockpit.browser import _session_profile

        prof = _session_profile(_sid)
    sess = cdp.get_session(pid, prof, create_if_missing=False)
    if sess is None or not sess.alive():
        j(handler, {"ok": False, "offline": True, "message": "CDP session unavailable"})
        return True

    kind = str(body.get("kind") or "").strip().lower()
    try:
        x = float(body.get("x") or 0)
        y = float(body.get("y") or 0)
    except (TypeError, ValueError):
        x = y = 0.0

    try:
        if kind == "click":
            sess.click(x, y, str(body.get("button") or "left"), int(body.get("clicks") or 1))
        elif kind == "move":
            sess.mouse_move(x, y)
        elif kind == "wheel":
            sess.wheel(x, y, float(body.get("deltaX") or 0), float(body.get("deltaY") or 0))
        elif kind == "key":
            sess.key(
                str(body.get("key") or ""),
                body.get("code"),
                body.get("text"),
                int(body.get("modifiers") or 0),
            )
        elif kind == "text":
            sess.insert_text(str(body.get("text") or ""))
        elif kind == "nav":
            sess._call("Page.navigate", {"url": str(body.get("url") or "")})
        elif kind == "device":
            sess.set_device(
                int(body.get("width") or 1280),
                int(body.get("height") or 720),
                bool(body.get("mobile")),
                float(body.get("scale") or 1.0),
            )
        elif kind == "device_reset":
            sess.clear_device()
        elif kind == "back":
            sess._call("Page.navigateToHistoryEntry", {"entryId": int(body.get("entry_id") or 0)})
        elif kind == "reload":
            sess._call("Page.reload", {"ignoreCache": bool(body.get("hard"))})
        else:
            bad(handler, "unknown input kind", 400)
            return True
    except Exception as exc:  # noqa: BLE001
        j(handler, {"ok": False, "message": f"input failed: {exc}"})
        return True

    j(handler, {"ok": True, "kind": kind})
    return True
