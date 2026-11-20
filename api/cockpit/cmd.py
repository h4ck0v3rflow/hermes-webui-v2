"""Cockpit v2 live agent command stream (Tier A process_registry tap + Tier B tool events + approvals)."""

from __future__ import annotations

import collections
import json
import queue
import threading
import time
from urllib.parse import parse_qs

from api.helpers import bad
from api.sse_chunked import end_sse_headers

MAX_HISTORY_EVENTS = 60
MAX_QUEUE_SIZE = 256
MAX_OUTPUT_BOUNDED = 16_384
CMD_TOOLS = frozenset({"terminal", "process", "execute_code"})

_LOCK = threading.Lock()
_HISTORY: dict[str, collections.deque] = {}
_SUBSCRIBERS: dict[str, list[queue.Queue]] = {}
_START_TIMES: dict[str, float] = {}
_TAP_INSTALLED = False


def _push_nonblocking(q: queue.Queue, item: dict) -> None:
    try:
        q.put_nowait(item)
    except queue.Full:
        try:
            q.get_nowait()
        except queue.Empty:
            pass
        try:
            q.put_nowait(item)
        except queue.Full:
            pass


def emit_cmd_event(session_id: str, event: dict, *, record_history: bool = True) -> None:
    """Publish a command event to all SSE subscribers for ``session_id``."""
    sid = str(session_id or "").strip()
    if not sid:
        return
    payload = dict(event)
    payload.setdefault("ts", time.time())
    with _LOCK:
        if record_history:
            hist = _HISTORY.get(sid)
            if hist is None:
                hist = collections.deque(maxlen=MAX_HISTORY_EVENTS)
                _HISTORY[sid] = hist
            hist.append(payload)
        subs = list(_SUBSCRIBERS.get(sid, []))
    for q in subs:
        _push_nonblocking(q, payload)


def _broadcast_chunk_to_matching(proc_session, chunk: str) -> None:
    """Forward a live process_registry output chunk without ever blocking."""
    if not chunk:
        return
    proc_id = str(getattr(proc_session, "id", "") or getattr(proc_session, "session_id", "") or "bg")
    candidates = {
        str(getattr(proc_session, attr, "") or "").strip()
        for attr in ("session_key", "task_id", "webui_session_id", "session_id")
    }
    candidates.discard("")
    payload = {
        "t": "cmd_chunk",
        "run_id": proc_id,
        "data": str(chunk),
        "ts": time.time(),
    }
    with _LOCK:
        matched_subs: list[queue.Queue] = []
        for sid, subs in _SUBSCRIBERS.items():
            if not candidates or sid in candidates or any(sid in c for c in candidates):
                matched_subs.extend(subs)
    for q in matched_subs:
        _push_nonblocking(q, payload)


def install_process_registry_tap(registry=None) -> bool:
    """Chain onto ``tools.process_registry.process_registry.on_output`` without clobbering."""
    global _TAP_INSTALLED
    if registry is None:
        with _LOCK:
            if _TAP_INSTALLED:
                return True
        try:
            from tools.process_registry import process_registry as _reg
            registry = _reg
        except Exception:
            return False

    with _LOCK:
        if getattr(registry, "_cockpit_tap_installed", False):
            _TAP_INSTALLED = True
            return True
        prev = getattr(registry, "on_output", None)

        def _chained_sink(proc_session, chunk) -> None:
            if callable(prev):
                try:
                    prev(proc_session, chunk)
                except Exception:
                    pass
            try:
                _broadcast_chunk_to_matching(proc_session, chunk)
            except Exception:
                pass

        registry.on_output = _chained_sink
        setattr(registry, "_cockpit_tap_installed", True)
        _TAP_INSTALLED = True
        return True


def _extract_command_info(name: str, args) -> tuple[str, str]:
    parsed = args
    if isinstance(parsed, str):
        try:
            parsed = json.loads(parsed)
        except ValueError:
            parsed = {"command": parsed}
    if not isinstance(parsed, dict):
        return (name, "")
    if name == "terminal":
        cmd = str(parsed.get("command") or "")
        cwd = str(parsed.get("workdir") or parsed.get("cwd") or "")
        return (cmd, cwd)
    if name == "process":
        action = str(parsed.get("action") or "process")
        sid = str(parsed.get("session_id") or "")
        data = str(parsed.get("data") or "")
        label = f"process:{action}" + (f" {sid}" if sid else "") + (f" ({data[:40]})" if data else "")
        return (label, "")
    if name == "execute_code":
        code = str(parsed.get("code") or "")
        first = code.strip().splitlines()[0] if code.strip() else "execute_code"
        return (f"python: {first[:120]}", "")
    return (name, "")


def _extract_result_exit_and_output(function_result) -> tuple[int | None, str]:
    obj = function_result
    if isinstance(obj, str):
        try:
            obj = json.loads(obj)
        except ValueError:
            return (None, obj[:MAX_OUTPUT_BOUNDED])
    if isinstance(obj, dict):
        code = obj.get("exit_code")
        if code is None:
            code = obj.get("returncode")
        if code is None:
            code = obj.get("code")
        try:
            code_int = int(code) if code is not None else None
        except (TypeError, ValueError):
            code_int = None
        out = obj.get("output")
        if out is None:
            stdout = str(obj.get("stdout") or "")
            stderr = str(obj.get("stderr") or "")
            out = (stdout + ("\n" + stderr if stderr else "")).strip()
        text = str(out or "")
        if len(text) > MAX_OUTPUT_BOUNDED:
            half = MAX_OUTPUT_BOUNDED // 2
            text = text[:half] + "\n...[truncated]...\n" + text[-half:]
        return (code_int, text)
    if obj is None:
        return (None, "")
    text = str(obj)
    return (None, text[:MAX_OUTPUT_BOUNDED])


def mirror_cmd_tool_event(
    session_id: str,
    tool_call_id: str,
    name: str,
    args,
    function_result=None,
    *,
    is_start: bool = False,
) -> dict | None:
    """Mirror Tier B terminal/process/execute_code tool events into the CMD feed."""
    if not session_id or name not in CMD_TOOLS:
        return None
    run_id = str(tool_call_id or f"{name}-{int(time.time() * 1000)}")
    try:
        if is_start:
            cmd, cwd = _extract_command_info(name, args)
            with _LOCK:
                _START_TIMES[run_id] = time.monotonic()
            ev = {
                "t": "cmd_start",
                "run_id": run_id,
                "tool": name,
                "command": cmd,
                "cwd": cwd,
            }
            emit_cmd_event(session_id, ev)
            return ev

        with _LOCK:
            started = _START_TIMES.pop(run_id, None)
        duration_ms = round((time.monotonic() - started) * 1000.0, 1) if started is not None else None
        code, output_bounded = _extract_result_exit_and_output(function_result)
        ev = {
            "t": "cmd_exit",
            "run_id": run_id,
            "tool": name,
            "code": code,
            "duration_ms": duration_ms,
            "output_bounded": output_bounded,
        }
        emit_cmd_event(session_id, ev)
        return ev
    except Exception:
        return None


def _snapshot_pending_approval(session_id: str) -> dict | None:
    try:
        from api.route_approvals import _lock as approval_lock, _pending as approval_pending

        with approval_lock:
            entry = approval_pending.get(session_id)
            if not isinstance(entry, dict):
                return None
            return {
                "t": "approval_pending",
                "run_id": str(entry.get("run_id") or ""),
                "approval_id": str(entry.get("approval_id") or entry.get("id") or ""),
                "mirror_token": str(entry.get("_gateway_mirror_token") or entry.get("mirror_token") or ""),
                "command": str(entry.get("command") or ""),
                "verdict": str(entry.get("description") or entry.get("reason") or "Approval required"),
            }
    except Exception:
        return None


def handle_cmd_stream(handler, parsed) -> bool:
    """SSE stream for live agent commands (Tier A process_registry + Tier B tool events + approvals)."""
    qs = parse_qs(parsed.query)
    sid = (qs.get("session_id") or [""])[0].strip()
    if not sid:
        bad(handler, "session_id is required", 400)
        return True

    from api.routes import _SSE_HEARTBEAT_INTERVAL_SECONDS
    from api.streaming import _sse, _sse_set_write_deadline, _sse_write

    install_process_registry_tap()

    q: queue.Queue = queue.Queue(maxsize=MAX_QUEUE_SIZE)
    with _LOCK:
        _SUBSCRIBERS.setdefault(sid, []).append(q)
        history_snapshot = list(_HISTORY.get(sid, ()))

    last_approval_key = ""
    try:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("X-Accel-Buffering", "no")
        handler.send_header("Connection", "close")
        end_sse_headers(handler)
        _sse_set_write_deadline(handler)
        _sse(handler, "cmd", {"t": "ready", "session_id": sid, "ts": time.time()})

        for item in history_snapshot:
            _sse(handler, "cmd", item)

        pending = _snapshot_pending_approval(sid)
        if pending:
            last_approval_key = f"{pending['run_id']}:{pending['approval_id']}:{pending['command']}"
            _sse(handler, "cmd", pending)

        poll_slice = min(2.0, float(_SSE_HEARTBEAT_INTERVAL_SECONDS))
        last_keepalive = time.monotonic()

        while True:
            try:
                event = q.get(timeout=poll_slice)
                _sse(handler, "cmd", event)
            except queue.Empty:
                cur_pending = _snapshot_pending_approval(sid)
                cur_key = (
                    f"{cur_pending['run_id']}:{cur_pending['approval_id']}:{cur_pending['command']}"
                    if cur_pending
                    else ""
                )
                if cur_key != last_approval_key:
                    last_approval_key = cur_key
                    if cur_pending:
                        _sse(handler, "cmd", cur_pending)
                    else:
                        _sse(handler, "cmd", {"t": "approval_cleared", "session_id": sid, "ts": time.time()})

                now = time.monotonic()
                if now - last_keepalive >= _SSE_HEARTBEAT_INTERVAL_SECONDS:
                    _sse_write(handler, b": keepalive\n\n")
                    last_keepalive = now
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError, OSError):
        pass
    finally:
        with _LOCK:
            subs = _SUBSCRIBERS.get(sid, [])
            if q in subs:
                subs.remove(q)
            if not subs:
                _SUBSCRIBERS.pop(sid, None)
    return True
