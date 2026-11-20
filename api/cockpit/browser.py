"""Cockpit v2 live browser snapshot + AGENT/HUMAN lease state & SSE stream."""

from __future__ import annotations

import queue
import threading
import time
from urllib.parse import parse_qs

from api.helpers import bad, j, read_body
from api.sse_chunked import end_sse_headers

_LOCK = threading.Lock()
_BROWSER_STATE: dict[str, dict] = {}
_SUBSCRIBERS: dict[str, list[queue.Queue]] = {}


def _default_state(session_id: str) -> dict:
    return {
        "session_id": session_id,
        "url": "",
        "title": "",
        "last_action": "",
        "screenshot_b64": "",
        "lease_holder": "AGENT",
        "updated_at": 0.0,
        "history": [],
    }


def get_browser_state(session_id: str) -> dict:
    with _LOCK:
        return dict(_BROWSER_STATE.get(session_id) or _default_state(session_id))


def _broadcast_locked(session_id: str, state: dict) -> None:
    subs = list(_SUBSCRIBERS.get(session_id, []))
    payload = dict(state)
    for q in subs:
        try:
            q.put_nowait(payload)
        except queue.Full:
            pass


def update_browser_frame(
    session_id: str,
    url: str = "",
    screenshot_b64: str = "",
    *,
    title: str = "",
    last_action: str = "",
) -> dict:
    with _LOCK:
        cur = dict(_BROWSER_STATE.get(session_id) or _default_state(session_id))
        if url:
            cur["url"] = url
        if title:
            cur["title"] = title
        if last_action:
            cur["last_action"] = last_action
        if screenshot_b64:
            cur["screenshot_b64"] = screenshot_b64
        cur["updated_at"] = time.time()
        history = list(cur.get("history") or [])
        if cur["url"] or cur["screenshot_b64"]:
            entry = {
                "url": cur["url"],
                "title": cur.get("title") or "",
                "action": last_action or cur.get("last_action") or "",
                "screenshot_b64": cur["screenshot_b64"],
                "timestamp": cur["updated_at"],
            }
            if history and history[-1].get("url") == entry["url"] and not screenshot_b64:
                history[-1] = {**history[-1], **entry, "screenshot_b64": history[-1].get("screenshot_b64") or entry["screenshot_b64"]}
            elif not history or history[-1].get("url") != entry["url"] or screenshot_b64:
                history.append(entry)
                history = history[-12:]
        cur["history"] = history
        _BROWSER_STATE[session_id] = cur
        _broadcast_locked(session_id, cur)
        return dict(cur)


def set_browser_lease(session_id: str, holder: str) -> dict:
    norm = (holder or "").strip().upper()
    if norm not in ("AGENT", "HUMAN"):
        raise ValueError("holder must be AGENT or HUMAN")
    with _LOCK:
        cur = dict(_BROWSER_STATE.get(session_id) or _default_state(session_id))
        cur["lease_holder"] = norm
        cur["updated_at"] = time.time()
        _BROWSER_STATE[session_id] = cur
        _broadcast_locked(session_id, cur)
        return dict(cur)


def _read_image_b64(path_str: str, max_bytes: int = 5 * 1024 * 1024) -> str:
    import base64
    from pathlib import Path

    if not path_str:
        return ""
    try:
        p = Path(path_str.strip().strip("\"'"))
        if not p.is_file() or p.stat().st_size > max_bytes:
            return ""
        raw = p.read_bytes()
        b64 = base64.b64encode(raw).decode("ascii")
        ext = p.suffix.lower()
        mime = "image/jpeg" if ext in (".jpg", ".jpeg") else "image/webp" if ext == ".webp" else "image/png"
        return f"data:{mime};base64,{b64}"
    except OSError:
        return ""


def _extract_url_from_text(text: str) -> str:
    import re

    if not text:
        return ""
    m = re.search(r"https?://[^\s\"'<>`)\]]+", text)
    if m:
        return m.group(0).rstrip(".,;:")
    m_nav = re.search(r"(?:navigate|goto|open_url)\(\s*['\"]([^'\"]+)['\"]", text)
    if m_nav:
        candidate = m_nav.group(1).strip()
        if candidate and "://" not in candidate and "." in candidate:
            return f"https://{candidate}"
        return candidate
    return ""


def mirror_browser_tool_event(
    session_id: str,
    name: str,
    args,
    function_result=None,
) -> dict | None:
    """Mirror agent browser_* tool calls/results into Cockpit Browser tab state."""
    if not session_id or not name or not str(name).startswith("browser_"):
        return None
    import json
    import re

    try:
        parsed_args = args
        if isinstance(parsed_args, str):
            try:
                parsed_args = json.loads(parsed_args)
            except ValueError:
                parsed_args = {"raw": parsed_args}
        if not isinstance(parsed_args, dict):
            parsed_args = {}

        url = str(parsed_args.get("url") or "").strip()
        if not url and parsed_args.get("code"):
            url = _extract_url_from_text(str(parsed_args.get("code") or ""))
        if not url and parsed_args.get("raw"):
            url = _extract_url_from_text(str(parsed_args.get("raw") or ""))

        shot_b64 = ""
        res_obj = function_result
        if isinstance(res_obj, str):
            try:
                res_obj = json.loads(res_obj)
            except ValueError:
                pass

        if isinstance(res_obj, dict):
            if not url:
                url = str(res_obj.get("url") or res_obj.get("current_url") or "").strip()
            meta = res_obj.get("meta") if isinstance(res_obj.get("meta"), dict) else {}
            shot_b64 = str(
                res_obj.get("screenshot_b64")
                or res_obj.get("image_b64")
                or res_obj.get("screenshot")
                or ""
            ).strip()
            if not shot_b64:
                shot_path = str(
                    res_obj.get("screenshot_path")
                    or meta.get("screenshot_path")
                    or res_obj.get("path")
                    or ""
                ).strip()
                if shot_path:
                    shot_b64 = _read_image_b64(shot_path)
            if not url and res_obj.get("text_summary"):
                url = _extract_url_from_text(str(res_obj["text_summary"]))
        elif isinstance(res_obj, list):
            for block in res_obj:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "image_url":
                    img_u = (block.get("image_url") or {}).get("url", "")
                    if isinstance(img_u, str) and img_u.startswith("data:image/"):
                        shot_b64 = img_u
                elif block.get("type") == "text" and not url:
                    url = _extract_url_from_text(str(block.get("text") or ""))
        elif isinstance(res_obj, str):
            if not url:
                url = _extract_url_from_text(res_obj)
            m_shot = re.search(
                r"(?:MEDIA:\s*|['\"])?((?:[A-Za-z]:[/\\]|/)[^\s\"'<>|]+\.(?:png|jpe?g|webp))",
                res_obj,
                re.IGNORECASE,
            )
            if m_shot:
                shot_b64 = _read_image_b64(m_shot.group(1))

        if not url and not shot_b64:
            return None
        return update_browser_frame(
            session_id,
            url=url,
            screenshot_b64=shot_b64,
            last_action=str(name),
        )
    except Exception:
        return None


def handle_browser_state(handler, parsed) -> bool:
    qs = parse_qs(parsed.query)
    sid = qs.get("session_id", [""])[0]
    if not sid:
        bad(handler, "session_id is required", 400)
        return True
    j(handler, get_browser_state(sid))
    return True


def handle_browser_frame(handler) -> bool:
    try:
        body = read_body(handler)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    if not isinstance(body, dict):
        bad(handler, "JSON object required", 400)
        return True
    sid = str(body.get("session_id") or "").strip()
    if not sid:
        bad(handler, "session_id is required", 400)
        return True
    state = update_browser_frame(
        sid,
        url=str(body.get("url") or ""),
        screenshot_b64=str(body.get("screenshot_b64") or ""),
    )
    j(handler, {"ok": True, "state": state})
    return True


def handle_browser_lease(handler) -> bool:
    try:
        body = read_body(handler)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    if not isinstance(body, dict):
        bad(handler, "JSON object required", 400)
        return True
    sid = str(body.get("session_id") or "").strip()
    if not sid:
        bad(handler, "session_id is required", 400)
        return True
    try:
        state = set_browser_lease(sid, str(body.get("holder") or ""))
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    j(handler, {"ok": True, "state": state})
    return True


def handle_browser_stream(handler, parsed) -> bool:
    import hashlib
    import json
    import urllib.error
    import urllib.request

    from api.cockpit import huntproxy as hp
    from api.routes import _SSE_HEARTBEAT_INTERVAL_SECONDS
    from api.streaming import _sse, _sse_set_write_deadline, _sse_write

    qs = parse_qs(parsed.query)
    sid = (qs.get("session_id") or [""])[0].strip()
    raw_pid = (qs.get("project_id") or [""])[0].strip()
    if not sid and not raw_pid:
        bad(handler, "session_id or project_id is required", 400)
        return True

    pid: int | None = None
    hp_online = False
    try:
        if raw_pid:
            hp_online, pid, _ = hp.validate_project_id(raw_pid)
        else:
            resolved = hp.resolve_project_for_session(sid)
            hp_online = bool(resolved.get("online"))
            pid = resolved.get("project_id")
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True

    q: queue.Queue = queue.Queue(maxsize=32)
    if sid:
        with _LOCK:
            _SUBSCRIBERS.setdefault(sid, []).append(q)
            initial = dict(_BROWSER_STATE.get(sid) or _default_state(sid))
    else:
        initial = _default_state("")

    try:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("X-Accel-Buffering", "no")
        handler.send_header("Connection", "close")
        end_sse_headers(handler)
        _sse_set_write_deadline(handler)
        if sid:
            _sse(handler, "browser_state", initial)

        if not hp_online or pid is None:
            _sse(
                handler,
                "browser",
                {
                    "t": "offline",
                    "message": "HuntProxy offline (expected on PC dev)",
                    "ts": time.time(),
                },
            )
            while True:
                try:
                    payload = q.get(timeout=_SSE_HEARTBEAT_INTERVAL_SECONDS)
                except queue.Empty:
                    _sse_write(handler, b": keepalive\n\n")
                    continue
                _sse(handler, "browser_state", payload)
        else:
            _sse(
                handler,
                "browser",
                {"t": "ready", "mode": "huntproxy", "project_id": pid, "ts": time.time()},
            )
            last_frame_hash = ""
            last_control_key = ""
            last_pages_key = ""
            seen_events: set[str] = set()
            last_keepalive = time.monotonic()

            while True:
                # Drain any local updates immediately
                while True:
                    try:
                        local_payload = q.get_nowait()
                        _sse(handler, "browser_state", local_payload)
                    except queue.Empty:
                        break

                bs = _hp_get_active_browser_session(pid)
                if bs:
                    bsid = str(bs.get("id") or bs.get("browser_session_id") or "")
                    cur_url = str(bs.get("url") or bs.get("current_url") or "")
                    agent_ctrl = bs.get("agent_control")
                    paused = (agent_ctrl is False) or bool(bs.get("cdp_enabled") or bs.get("paused"))
                    devtools_url = str(bs.get("hosted_devtools_url") or "")
                    ssh_cmd = str(bs.get("ssh_forward_command") or "")
                    ctrl_key = f"{paused}|{devtools_url}|{ssh_cmd}"
                    if ctrl_key != last_control_key:
                        last_control_key = ctrl_key
                        _sse(
                            handler,
                            "browser",
                            {
                                "t": "control",
                                "paused": paused,
                                "hosted_devtools_url": devtools_url,
                                "ssh_forward_command": ssh_cmd,
                                "ts": time.time(),
                            },
                        )

                    # Frame (send on change only, cap ~400 KB)
                    shot_res = _hp_browser_action(
                        pid, bsid, {"action": "screenshot", "format": "jpeg", "max_bytes": 400_000}
                    )
                    if isinstance(shot_res, dict):
                        b64 = str(
                            shot_res.get("jpeg_b64")
                            or shot_res.get("screenshot_b64")
                            or shot_res.get("data")
                            or ""
                        )
                        if b64:
                            digest = hashlib.sha256(b64.encode("ascii", errors="ignore")).hexdigest()
                            if digest != last_frame_hash:
                                last_frame_hash = digest
                                frame_url = str(shot_res.get("url") or cur_url)
                                _sse(
                                    handler,
                                    "browser",
                                    {
                                        "t": "frame",
                                        "jpeg_b64": b64,
                                        "url": frame_url,
                                        "ts": time.time(),
                                    },
                                )

                    # Open tabs (pages)
                    pages_res = _hp_browser_action(pid, bsid, {"action": "pages", "op": "list"})
                    if isinstance(pages_res, dict):
                        pages = pages_res.get("pages") or pages_res.get("tabs") or []
                        if isinstance(pages, list):
                            pk = json.dumps(pages, sort_keys=True)
                            if pk != last_pages_key:
                                last_pages_key = pk
                                _sse(handler, "browser", {"t": "pages", "pages": pages, "ts": time.time()})

                    # Activity timeline events
                    ev_res = _hp_browser_action(pid, bsid, {"action": "events", "limit": 20})
                    if isinstance(ev_res, dict):
                        ev_list = ev_res.get("events") or []
                        if isinstance(ev_list, list):
                            for item in ev_list[-20:]:
                                if not isinstance(item, dict):
                                    continue
                                ev_key = json.dumps(item, sort_keys=True)
                                if ev_key in seen_events:
                                    continue
                                seen_events.add(ev_key)
                                if len(seen_events) > 200:
                                    seen_events.clear()
                                kind = str(item.get("kind") or item.get("type") or "nav").lower()
                                if kind not in ("nav", "dialog", "popup", "console"):
                                    kind = "nav"
                                _sse(handler, "browser", {"t": kind, **item, "ts": time.time()})

                now = time.monotonic()
                if now - last_keepalive >= _SSE_HEARTBEAT_INTERVAL_SECONDS:
                    _sse_write(handler, b": keepalive\n\n")
                    last_keepalive = now
                time.sleep(0.75)
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError, OSError):
        pass
    finally:
        if sid:
            with _LOCK:
                subs = _SUBSCRIBERS.get(sid, [])
                if q in subs:
                    subs.remove(q)
                if not subs:
                    _SUBSCRIBERS.pop(sid, None)
    return True


def _hp_post_json(path: str, payload: dict, *, timeout: float = 4.0) -> tuple[int, dict | None]:
    import json
    import urllib.error
    import urllib.request
    from api.cockpit.huntproxy import get_huntproxy_api_base

    url = f"{get_huntproxy_api_base()}{path}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return 0, None


def _hp_get_active_browser_session(project_id: int) -> dict | None:
    from api.cockpit.huntproxy import _hp_get_json

    status, data = _hp_get_json(f"/projects/{project_id}/browser-sessions", timeout=2.5)
    if status != 200 or data is None:
        return None
    sessions = data if isinstance(data, list) else (data.get("sessions") or data.get("browser_sessions") or data.get("items") or [])
    if not isinstance(sessions, list) or not sessions:
        return None
    for item in sessions:
        if isinstance(item, dict) and item.get("active", True):
            return item
    return sessions[0] if isinstance(sessions[0], dict) else None


def _hp_browser_action(project_id: int, bsid: str, payload: dict) -> dict | None:
    if bsid:
        st, data = _hp_post_json(f"/projects/{project_id}/browser-sessions/{bsid}/action", payload)
        if st == 200 and isinstance(data, dict):
            return data
        if st != 404:
            return None
    st2, data2 = _hp_post_json(f"/projects/{project_id}/browser-action", payload)
    return data2 if st2 == 200 and isinstance(data2, dict) else None


def _hp_browser_cdp(project_id: int, bsid: str, op: str) -> dict | None:
    payload = {"op": op}
    if bsid:
        st, data = _hp_post_json(f"/projects/{project_id}/browser-sessions/{bsid}/cdp", payload)
        if st == 200 and isinstance(data, dict):
            return data
        if st != 404:
            return None
    st2, data2 = _hp_post_json(f"/projects/{project_id}/browser-cdp", {"op": op, "browser_session_id": bsid})
    return data2 if st2 == 200 and isinstance(data2, dict) else None


def handle_browser_action(handler) -> bool:
    """POST /api/cockpit/browser/action -> proxy pages / navigate / browser_cdp to HuntProxy."""
    from api.cockpit import huntproxy as hp

    try:
        body = read_body(handler)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    if not isinstance(body, dict):
        bad(handler, "JSON object required", 400)
        return True

    sid = str(body.get("session_id") or "").strip()
    raw_pid = body.get("project_id")
    action = str(body.get("action") or "").strip().lower()
    if action not in ("navigate", "pages", "screenshot", "events", "cdp"):
        bad(handler, "action must be one of navigate, pages, screenshot, events, cdp", 400)
        return True

    try:
        if raw_pid is not None and str(raw_pid).strip() != "":
            hp_online, pid, _ = hp.validate_project_id(raw_pid)
        else:
            resolved = hp.resolve_project_for_session(sid)
            hp_online = bool(resolved.get("online"))
            pid = resolved.get("project_id")
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True

    if not hp_online or pid is None:
        j(
            handler,
            {
                "ok": False,
                "offline": True,
                "message": "HuntProxy offline (expected on PC dev)",
            },
        )
        return True

    bs = _hp_get_active_browser_session(pid)
    bsid = str((bs or {}).get("id") or (bs or {}).get("browser_session_id") or "")

    if action == "cdp":
        op = str(body.get("op") or "status").strip().lower()
        if op not in ("enable", "disable", "status"):
            bad(handler, "cdp op must be enable, disable, or status", 400)
            return True
        res = _hp_browser_cdp(pid, bsid, op)
        if res is None:
            j(handler, {"ok": False, "offline": True, "message": "HuntProxy browser_cdp unavailable"})
            return True
        paused = op == "enable" if op in ("enable", "disable") else bool(res.get("enabled") or res.get("paused"))
        j(
            handler,
            {
                "ok": True,
                "paused": paused,
                "hosted_devtools_url": str(res.get("hosted_devtools_url") or ""),
                "ssh_forward_command": str(res.get("ssh_forward_command") or ""),
                "raw": res,
            },
        )
        return True

    upstream_payload = {k: v for k, v in body.items() if k not in ("session_id", "project_id")}
    res = _hp_browser_action(pid, bsid, upstream_payload)
    if res is None:
        j(handler, {"ok": False, "offline": True, "message": "HuntProxy browser_action unavailable"})
        return True
    j(handler, {"ok": True, "result": res})
    return True
