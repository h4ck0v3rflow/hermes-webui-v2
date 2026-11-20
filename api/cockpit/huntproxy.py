"""Cockpit v2 HuntProxy client, per-session project resolution, and traffic SSE passthrough.

HuntProxy API base defaults to http://127.0.0.1:17890/api/v1 (loopback-only, no auth).
All routes degrade gracefully when HuntProxy is unreachable (e.g. PC dev).
"""

from __future__ import annotations

import fnmatch
import http.client
import json
import os
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlencode, urlparse

from api.helpers import bad, j, read_body
from api.sse_chunked import end_sse_headers

DEFAULT_HUNTPROXY_API_URL = "http://127.0.0.1:17890/api/v1"
MAX_BODY_BYTES_CAP = 1_048_576
DEFAULT_BODY_BYTES = 65_536

_LOCK = threading.Lock()
_SESSION_PROJECT_OVERRIDES: dict[str, int] = {}


def get_huntproxy_api_base() -> str:
    raw = (os.environ.get("HERMES_HUNTPROXY_API_URL") or DEFAULT_HUNTPROXY_API_URL).strip()
    return raw.rstrip("/")


def _parse_int_param(raw: str | None, name: str, *, required: bool = False) -> int | None:
    text = str(raw or "").strip()
    if not text:
        if required:
            raise ValueError(f"{name} is required and must be an integer")
        return None
    if not text.isdigit():
        raise ValueError(f"{name} must be a positive integer")
    return int(text)


def _hp_get_json(path: str, *, timeout: float = 3.0) -> tuple[int, dict | list | None]:
    url = f"{get_huntproxy_api_base()}{path}"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        return exc.code, None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return 0, None


def list_projects() -> tuple[bool, list[dict]]:
    """Fetch projects from HuntProxy. Returns (online, projects)."""
    status, data = _hp_get_json("/projects", timeout=2.5)
    if status != 200 or data is None:
        return False, []
    if isinstance(data, list):
        return True, [p for p in data if isinstance(p, dict)]
    if isinstance(data, dict):
        items = data.get("projects") or data.get("items") or []
        return True, [p for p in items if isinstance(p, dict)]
    return True, []


def validate_project_id(raw_project_id: str | int | None) -> tuple[bool, int | None, list[dict]]:
    """Validate project_id as int + membership in GET /api/v1/projects."""
    pid = _parse_int_param(str(raw_project_id) if raw_project_id is not None else "", "project_id", required=True)
    online, projects = list_projects()
    if not online:
        return False, None, []
    valid_ids = {int(p["id"]) for p in projects if "id" in p and str(p["id"]).isdigit()}
    if pid not in valid_ids:
        raise ValueError(f"project_id {pid} not found in HuntProxy")
    return True, pid, projects


def _session_workspace_hint(session_id: str) -> str:
    if not session_id:
        return ""
    try:
        from api.cockpit.files import resolve_session_workspace_root

        return str(resolve_session_workspace_root(session_id)).lower()
    except Exception:
        return ""


def resolve_project_for_session(
    session_id: str,
    explicit_project_id: str | None = None,
) -> dict:
    """Resolve -> persist -> allow override per Hermes session (server-side)."""
    online, projects = list_projects()
    if not online:
        return {
            "online": False,
            "projects": [],
            "project_id": None,
            "reason": "offline",
            "message": "HuntProxy offline (expected on PC dev)",
        }

    valid_ids = {int(p["id"]) for p in projects if "id" in p and str(p["id"]).isdigit()}
    if not projects:
        return {
            "online": True,
            "projects": [],
            "project_id": None,
            "reason": "no_projects",
            "message": "No HuntProxy projects found",
        }

    # 1. Explicit override
    if explicit_project_id:
        pid = _parse_int_param(explicit_project_id, "project_id", required=True)
        if pid not in valid_ids:
            raise ValueError(f"project_id {pid} not found in HuntProxy")
        if session_id:
            with _LOCK:
                _SESSION_PROJECT_OVERRIDES[session_id] = pid
        return {
            "online": True,
            "projects": projects,
            "project_id": pid,
            "reason": "override",
        }

    # 2. Persisted session selection
    if session_id:
        with _LOCK:
            saved = _SESSION_PROJECT_OVERRIDES.get(session_id)
        if saved in valid_ids:
            return {
                "online": True,
                "projects": projects,
                "project_id": saved,
                "reason": "session_persisted",
            }

    # 3. Scope / target_url match against workspace hint
    ws_hint = _session_workspace_hint(session_id)
    if ws_hint:
        for proj in projects:
            pid = int(proj["id"])
            target_url = str(proj.get("target_url") or "")
            host = (urlparse(target_url).hostname or "").lower()
            name = str(proj.get("name") or "").lower()
            scope = proj.get("scope") if isinstance(proj.get("scope"), dict) else {}
            patterns = scope.get("host_patterns") if isinstance(scope.get("host_patterns"), list) else []
            matched = False
            if host and host in ws_hint:
                matched = True
            elif name and len(name) >= 3 and name in ws_hint:
                matched = True
            else:
                for pat in patterns:
                    p_str = str(pat or "").lower().lstrip("*.")
                    if p_str and (p_str in ws_hint or fnmatch.fnmatch(ws_hint, f"*{p_str}*")):
                        matched = True
                        break
            if matched:
                if session_id:
                    with _LOCK:
                        _SESSION_PROJECT_OVERRIDES[session_id] = pid
                return {
                    "online": True,
                    "projects": projects,
                    "project_id": pid,
                    "reason": "scope_match",
                }

    # 4. Newest updated_at
    def _sort_key(p: dict) -> str:
        return str(p.get("updated_at") or p.get("created_at") or "")

    newest = sorted(projects, key=_sort_key, reverse=True)[0]
    newest_id = int(newest["id"])
    if session_id:
        with _LOCK:
            _SESSION_PROJECT_OVERRIDES[session_id] = newest_id
    return {
        "online": True,
        "projects": projects,
        "project_id": newest_id,
        "reason": "latest_updated",
    }


def handle_traffic_projects(handler, parsed) -> bool:
    qs = parse_qs(parsed.query)
    sid = (qs.get("session_id") or [""])[0].strip()
    explicit = (qs.get("project_id") or [""])[0].strip() or None
    try:
        res = resolve_project_for_session(sid, explicit)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    j(handler, res)
    return True


def handle_traffic_select_project(handler) -> bool:
    try:
        body = read_body(handler)
    except Exception as exc:
        bad(handler, str(exc), 400)
        return True
    sid = str(body.get("session_id") or "").strip()
    raw_pid = body.get("project_id")
    if not sid:
        bad(handler, "session_id is required", 400)
        return True
    try:
        res = resolve_project_for_session(sid, str(raw_pid) if raw_pid is not None else "")
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    j(handler, res)
    return True


def handle_traffic_history(handler, parsed) -> bool:
    qs = parse_qs(parsed.query)
    raw_pid = (qs.get("project_id") or [""])[0]
    raw_after = (qs.get("after_sequence") or [""])[0]
    raw_limit = (qs.get("limit") or ["200"])[0]
    try:
        online, pid, _ = validate_project_id(raw_pid)
        after_seq = _parse_int_param(raw_after, "after_sequence")
        limit = _parse_int_param(raw_limit, "limit") or 200
        limit = max(1, min(limit, 500))
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True

    if not online or pid is None:
        j(handler, {"online": False, "entries": [], "message": "HuntProxy offline (expected on PC dev)"})
        return True

    params: dict[str, int] = {"limit": limit}
    if after_seq is not None:
        params["after_sequence"] = after_seq
    status, data = _hp_get_json(f"/projects/{pid}/history?{urlencode(params)}", timeout=5.0)
    if status != 200 or data is None:
        j(handler, {"online": False, "entries": [], "message": "HuntProxy offline (expected on PC dev)"})
        return True

    if isinstance(data, list):
        entries = data
        meta = {}
    else:
        entries = data.get("entries") or data.get("exchanges") or data.get("items") or []
        meta = {
            k: data[k]
            for k in ("runtime_generation", "last_sequence", "next_sequence")
            if k in data
        }
    j(handler, {"online": True, "project_id": pid, "entries": entries, **meta})
    return True


def handle_traffic_exchange(handler, parsed) -> bool:
    qs = parse_qs(parsed.query)
    raw_pid = (qs.get("project_id") or [""])[0]
    raw_eid = (qs.get("exchange_id") or [""])[0]
    side = (qs.get("side") or ["response"])[0].strip().lower()
    if side not in ("request", "response"):
        bad(handler, "side must be request or response", 400)
        return True
    try:
        online, pid, _ = validate_project_id(raw_pid)
        eid = _parse_int_param(raw_eid, "exchange_id", required=True)
        offset = _parse_int_param((qs.get("offset") or ["0"])[0], "offset") or 0
        max_bytes = _parse_int_param((qs.get("max_bytes") or [str(DEFAULT_BODY_BYTES)])[0], "max_bytes") or DEFAULT_BODY_BYTES
        max_bytes = max(1, min(max_bytes, MAX_BODY_BYTES_CAP))
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True

    if not online or pid is None or eid is None:
        j(handler, {"online": False, "exchange": None, "body": None, "message": "HuntProxy offline (expected on PC dev)"})
        return True

    st_detail, detail = _hp_get_json(f"/projects/{pid}/exchanges/{eid}", timeout=5.0)
    if st_detail == 404:
        bad(handler, "Exchange not found", 404)
        return True
    if st_detail != 200:
        j(handler, {"online": False, "exchange": None, "body": None, "message": "HuntProxy unavailable"})
        return True

    body_qs = urlencode({"side": side, "offset": offset, "max_bytes": max_bytes})
    st_body, body_data = _hp_get_json(f"/projects/{pid}/exchanges/{eid}/body?{body_qs}", timeout=5.0)
    j(
        handler,
        {
            "online": True,
            "project_id": pid,
            "exchange_id": eid,
            "exchange": detail,
            "body": body_data if st_body == 200 else None,
        },
    )
    return True


def handle_traffic_stream(handler, parsed) -> bool:
    """Server-side SSE passthrough for HuntProxy GET /api/v1/projects/{id}/events."""
    qs = parse_qs(parsed.query)
    raw_pid = (qs.get("project_id") or [""])[0]
    raw_after = (qs.get("after_sequence") or [""])[0]
    raw_gen = (qs.get("runtime_generation") or [""])[0].strip()
    kinds = (qs.get("kinds") or [""])[0].strip()

    try:
        online, pid, _ = validate_project_id(raw_pid)
        after_seq = _parse_int_param(raw_after, "after_sequence")
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True

    from api.streaming import _sse, _sse_set_write_deadline, _sse_write

    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("X-Accel-Buffering", "no")
    handler.send_header("Connection", "close")
    end_sse_headers(handler)
    _sse_set_write_deadline(handler)

    if not online or pid is None:
        _sse(
            handler,
            "traffic",
            {"t": "offline", "message": "HuntProxy offline (expected on PC dev)", "ts": time.time()},
        )
        return True

    params: dict[str, str | int] = {"wait_ms": 15000}
    if after_seq is not None:
        params["after_sequence"] = after_seq
    if raw_gen:
        params["runtime_generation"] = raw_gen
    if kinds:
        params["kinds"] = kinds

    base = urlparse(get_huntproxy_api_base())
    host = base.hostname or "127.0.0.1"
    port = base.port or (443 if base.scheme == "https" else 80)
    upstream_path = f"{base.path.rstrip('/')}/projects/{pid}/events?{urlencode(params)}"

    conn: http.client.HTTPConnection | None = None
    try:
        conn_cls = http.client.HTTPSConnection if base.scheme == "https" else http.client.HTTPConnection
        conn = conn_cls(host, port, timeout=20.0)
        conn.request("GET", upstream_path, headers={"Accept": "text/event-stream"})
        resp = conn.getresponse()
        if resp.status != 200:
            _sse(
                handler,
                "traffic",
                {"t": "offline", "message": f"HuntProxy events returned {resp.status}", "ts": time.time()},
            )
            return True

        while True:
            try:
                line = resp.readline()
            except TimeoutError:
                _sse_write(handler, b": keepalive\n\n")
                continue
            if not line:
                break
            _sse_write(handler, line)
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
        pass
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
    return True
