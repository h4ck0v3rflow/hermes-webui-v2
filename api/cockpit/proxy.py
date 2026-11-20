"""Cockpit v2 HTTP Proxy capture, repeater, and SSE traffic stream."""

from __future__ import annotations

import collections
import http.server
import json
import queue
import select
import socket
import socketserver
import threading
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import parse_qs, urlparse

from api.helpers import bad, j, read_body
from api.sse_chunked import end_sse_headers
from api.streaming import _sse_set_write_deadline

MAX_ENTRIES = 500
MAX_BODY_PREVIEW = 32_768
DEFAULT_PROXY_PORT = 8081

_LOCK = threading.Lock()
_SESSIONS: dict[str, dict] = {}
_SUBSCRIBERS: dict[str, list[queue.Queue]] = {}


def _session_bucket_locked(session_id: str) -> dict:
    sid = (session_id or "default").strip() or "default"
    bucket = _SESSIONS.get(sid)
    if bucket is None:
        bucket = {
            "session_id": sid,
            "entries": collections.deque(maxlen=MAX_ENTRIES),
            "server": None,
            "thread": None,
            "port": None,
            "running": False,
        }
        _SESSIONS[sid] = bucket
    return bucket


def _broadcast_locked(session_id: str, event_name: str, payload: dict) -> None:
    subs = list(_SUBSCRIBERS.get(session_id, []))
    item = (event_name, payload)
    for q in subs:
        try:
            q.put_nowait(item)
        except queue.Full:
            pass


def _status_payload_locked(bucket: dict) -> dict:
    port = bucket["port"]
    running = bool(bucket["running"] and bucket["server"] is not None and port)
    return {
        "session_id": bucket["session_id"],
        "running": running,
        "host": "127.0.0.1",
        "port": port if running else None,
        "proxy_url": f"http://127.0.0.1:{port}" if running else "",
        "entry_count": len(bucket["entries"]),
    }


def _decode_preview(raw: bytes) -> str:
    if not raw:
        return ""
    clipped = raw[:MAX_BODY_PREVIEW]
    suffix = "\n...[truncated]" if len(raw) > MAX_BODY_PREVIEW else ""
    return clipped.decode("utf-8", errors="replace") + suffix


def record_entry(session_id: str, entry: dict) -> dict:
    """Append a captured HTTP entry to the session ring buffer and notify SSE listeners."""
    sid = (session_id or "default").strip() or "default"
    item = {
        "id": str(entry.get("id") or uuid.uuid4().hex[:12]),
        "method": str(entry.get("method") or "GET").upper(),
        "url": str(entry.get("url") or ""),
        "host": str(entry.get("host") or ""),
        "path": str(entry.get("path") or "/"),
        "status": int(entry.get("status") or 0),
        "duration_ms": round(float(entry.get("duration_ms") or 0.0), 1),
        "req_headers": dict(entry.get("req_headers") or {}),
        "req_body_preview": str(entry.get("req_body_preview") or ""),
        "res_headers": dict(entry.get("res_headers") or {}),
        "res_body_preview": str(entry.get("res_body_preview") or ""),
        "timestamp": float(entry.get("timestamp") or time.time()),
    }
    if not item["host"] and item["url"]:
        parsed = urlparse(item["url"])
        item["host"] = parsed.netloc
        item["path"] = parsed.path or "/"
        if parsed.query:
            item["path"] += f"?{parsed.query}"

    with _LOCK:
        bucket = _session_bucket_locked(sid)
        bucket["entries"].append(item)
        _broadcast_locked(sid, "proxy_entry", item)
    return item


class _ThreadedProxyServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _make_proxy_handler(session_id: str):
    class _CapturingProxyHandler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args) -> None:
            return

        def _forward_http(self) -> None:
            started = time.monotonic()
            target_url = self.path
            if target_url.startswith("/"):
                host = self.headers.get("Host", "")
                target_url = f"http://{host}{target_url}" if host else target_url

            parsed = urlparse(target_url)
            if parsed.scheme not in ("http", "https"):
                self.send_error(400, "Unsupported proxy scheme")
                return

            content_len = int(self.headers.get("Content-Length") or "0")
            req_body = self.rfile.read(content_len) if content_len > 0 else b""
            fwd_headers = {
                k: v
                for k, v in self.headers.items()
                if k.lower() not in ("proxy-connection", "connection", "keep-alive")
            }

            req = urllib.request.Request(
                target_url,
                data=req_body if self.command not in ("GET", "HEAD") else None,
                headers=fwd_headers,
                method=self.command,
            )
            status = 0
            res_headers: dict[str, str] = {}
            res_body = b""
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    status = resp.status
                    res_headers = dict(resp.headers.items())
                    res_body = resp.read()
            except urllib.error.HTTPError as exc:
                status = exc.code
                res_headers = dict(exc.headers.items()) if exc.headers else {}
                res_body = exc.read() if exc.fp else b""
            except Exception as exc:
                status = 502
                res_body = str(exc).encode("utf-8", errors="replace")
                res_headers = {"Content-Type": "text/plain; charset=utf-8"}

            duration_ms = (time.monotonic() - started) * 1000.0
            record_entry(
                session_id,
                {
                    "method": self.command,
                    "url": target_url,
                    "host": parsed.netloc,
                    "path": (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else ""),
                    "status": status,
                    "duration_ms": duration_ms,
                    "req_headers": dict(self.headers.items()),
                    "req_body_preview": _decode_preview(req_body),
                    "res_headers": res_headers,
                    "res_body_preview": _decode_preview(res_body),
                },
            )

            self.send_response(status)
            for k, v in res_headers.items():
                if k.lower() in ("transfer-encoding", "connection", "content-length"):
                    continue
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(res_body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD" and res_body:
                self.wfile.write(res_body)

        def do_CONNECT(self) -> None:
            started = time.monotonic()
            host_port = self.path
            host, _, port_str = host_port.partition(":")
            port = int(port_str or "443")
            try:
                upstream = socket.create_connection((host, port), timeout=10)
            except OSError as exc:
                self.send_error(502, f"CONNECT failed: {exc}")
                return

            self.send_response(200, "Connection Established")
            self.end_headers()

            client_sock = self.connection
            client_sock.setblocking(False)
            upstream.setblocking(False)
            sockets = [client_sock, upstream]
            bytes_tx = 0
            try:
                while True:
                    readable, _, exceptional = select.select(sockets, [], sockets, 30.0)
                    if exceptional or not readable:
                        break
                    for sock in readable:
                        other = upstream if sock is client_sock else client_sock
                        data = sock.recv(16384)
                        if not data:
                            return
                        bytes_tx += len(data)
                        other.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    upstream.close()
                except OSError:
                    pass
                duration_ms = (time.monotonic() - started) * 1000.0
                record_entry(
                    session_id,
                    {
                        "method": "CONNECT",
                        "url": f"https://{host_port}",
                        "host": host_port,
                        "path": "/",
                        "status": 200,
                        "duration_ms": duration_ms,
                        "req_headers": dict(self.headers.items()),
                        "res_body_preview": f"HTTPS tunnel closed ({bytes_tx} bytes relayed)",
                    },
                )

        def do_GET(self) -> None:
            self._forward_http()

        def do_POST(self) -> None:
            self._forward_http()

        def do_PUT(self) -> None:
            self._forward_http()

        def do_PATCH(self) -> None:
            self._forward_http()

        def do_DELETE(self) -> None:
            self._forward_http()

        def do_HEAD(self) -> None:
            self._forward_http()

        def do_OPTIONS(self) -> None:
            self._forward_http()

    return _CapturingProxyHandler


def start_proxy(session_id: str, port: int | None = None) -> dict:
    """Start the local HTTP capture proxy for a session."""
    sid = (session_id or "default").strip() or "default"
    with _LOCK:
        bucket = _session_bucket_locked(sid)
        if bucket["running"] and bucket["server"] is not None:
            return _status_payload_locked(bucket)

    req_port = DEFAULT_PROXY_PORT if port is None else int(port)
    if req_port != 0 and not (1024 <= req_port <= 65535):
        raise ValueError("port must be 0 or between 1024 and 65535")

    handler_cls = _make_proxy_handler(sid)
    try:
        srv = _ThreadedProxyServer(("127.0.0.1", req_port), handler_cls)
    except OSError:
        if port is not None and port != 0:
            raise
        srv = _ThreadedProxyServer(("127.0.0.1", 0), handler_cls)

    bound_port = int(srv.server_address[1])
    thread = threading.Thread(
        target=srv.serve_forever,
        name=f"cockpit-proxy-{sid[:8]}",
        daemon=True,
    )
    thread.start()

    with _LOCK:
        bucket = _session_bucket_locked(sid)
        bucket["server"] = srv
        bucket["thread"] = thread
        bucket["port"] = bound_port
        bucket["running"] = True
        status = _status_payload_locked(bucket)
        _broadcast_locked(sid, "proxy_status", status)
        return status


def stop_proxy(session_id: str) -> dict:
    """Stop the local HTTP capture proxy for a session."""
    sid = (session_id or "default").strip() or "default"
    with _LOCK:
        bucket = _session_bucket_locked(sid)
        srv = bucket.get("server")
        bucket["server"] = None
        bucket["thread"] = None
        bucket["port"] = None
        bucket["running"] = False
        status = _status_payload_locked(bucket)
        _broadcast_locked(sid, "proxy_status", status)

    if srv is not None:
        try:
            srv.shutdown()
            srv.server_close()
        except Exception:
            pass
    return status


def get_proxy_status(session_id: str) -> dict:
    with _LOCK:
        bucket = _session_bucket_locked(session_id)
        return _status_payload_locked(bucket)


def list_entries(session_id: str, query: str = "") -> list[dict]:
    q = (query or "").strip().lower()
    with _LOCK:
        bucket = _session_bucket_locked(session_id)
        items = list(bucket["entries"])
    if not q:
        return items
    return [
        e
        for e in items
        if q in e["url"].lower()
        or q in e["method"].lower()
        or q in str(e["status"])
        or q in e["host"].lower()
    ]


def clear_entries(session_id: str) -> dict:
    sid = (session_id or "default").strip() or "default"
    with _LOCK:
        bucket = _session_bucket_locked(sid)
        bucket["entries"].clear()
        _broadcast_locked(sid, "proxy_cleared", {"session_id": sid})
        return _status_payload_locked(bucket)


def replay_request(session_id: str, payload: dict) -> dict:
    """Replay an HTTP request from the proxy repeater and log its response."""
    method = str(payload.get("method") or "GET").strip().upper()
    url = str(payload.get("url") or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("url must be a valid http:// or https:// URL")

    raw_headers = payload.get("headers") or {}
    if not isinstance(raw_headers, dict):
        raise ValueError("headers must be an object")
    headers = {str(k): str(v) for k, v in raw_headers.items()}
    body_text = str(payload.get("body") or "")
    body_bytes = body_text.encode("utf-8") if body_text and method not in ("GET", "HEAD") else None

    started = time.monotonic()
    req = urllib.request.Request(url, data=body_bytes, headers=headers, method=method)
    status = 0
    res_headers: dict[str, str] = {}
    res_body = b""
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            status = resp.status
            res_headers = dict(resp.headers.items())
            res_body = resp.read()
    except urllib.error.HTTPError as exc:
        status = exc.code
        res_headers = dict(exc.headers.items()) if exc.headers else {}
        res_body = exc.read() if exc.fp else b""
    except Exception as exc:
        status = 502
        res_headers = {"Content-Type": "text/plain; charset=utf-8"}
        res_body = str(exc).encode("utf-8", errors="replace")

    duration_ms = (time.monotonic() - started) * 1000.0
    return record_entry(
        session_id,
        {
            "method": method,
            "url": url,
            "host": parsed.netloc,
            "path": (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else ""),
            "status": status,
            "duration_ms": duration_ms,
            "req_headers": headers,
            "req_body_preview": body_text[:MAX_BODY_PREVIEW],
            "res_headers": res_headers,
            "res_body_preview": _decode_preview(res_body),
        },
    )


def handle_proxy_status(handler, parsed) -> bool:
    qs = parse_qs(parsed.query)
    sid = (qs.get("session_id") or ["default"])[0]
    j(handler, get_proxy_status(sid))
    return True


def handle_proxy_entries(handler, parsed) -> bool:
    qs = parse_qs(parsed.query)
    sid = (qs.get("session_id") or ["default"])[0]
    query = (qs.get("q") or [""])[0]
    j(handler, {"entries": list_entries(sid, query), "status": get_proxy_status(sid)})
    return True


def handle_proxy_start(handler) -> bool:
    try:
        body = read_body(handler)
    except Exception as exc:
        bad(handler, str(exc), 400)
        return True
    sid = str(body.get("session_id") or "default")
    port = body.get("port")
    try:
        status = start_proxy(sid, int(port) if port is not None else None)
    except (ValueError, OSError) as exc:
        bad(handler, str(exc), 400)
        return True
    j(handler, status)
    return True


def handle_proxy_stop(handler) -> bool:
    try:
        body = read_body(handler)
    except Exception as exc:
        bad(handler, str(exc), 400)
        return True
    sid = str(body.get("session_id") or "default")
    j(handler, stop_proxy(sid))
    return True


def handle_proxy_clear(handler) -> bool:
    try:
        body = read_body(handler)
    except Exception as exc:
        bad(handler, str(exc), 400)
        return True
    sid = str(body.get("session_id") or "default")
    j(handler, clear_entries(sid))
    return True


def handle_proxy_ingest(handler) -> bool:
    try:
        body = read_body(handler)
    except Exception as exc:
        bad(handler, str(exc), 400)
        return True
    sid = str(body.get("session_id") or "default")
    if not body.get("url"):
        bad(handler, "url is required", 400)
        return True
    entry = record_entry(sid, body)
    j(handler, {"entry": entry}, 201)
    return True


def handle_proxy_replay(handler) -> bool:
    try:
        body = read_body(handler)
    except Exception as exc:
        bad(handler, str(exc), 400)
        return True
    sid = str(body.get("session_id") or "default")
    try:
        entry = replay_request(sid, body)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    j(handler, {"entry": entry})
    return True


def handle_proxy_stream(handler, parsed) -> bool:
    from api.routes import _SSE_HEARTBEAT_INTERVAL_SECONDS
    from api.streaming import _sse, _sse_write

    qs = parse_qs(parsed.query)
    sid = (qs.get("session_id") or ["default"])[0].strip() or "default"

    q: queue.Queue = queue.Queue(maxsize=256)
    with _LOCK:
        _SUBSCRIBERS.setdefault(sid, []).append(q)
        initial_status = _status_payload_locked(_session_bucket_locked(sid))

    try:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("X-Accel-Buffering", "no")
        handler.send_header("Connection", "close")
        end_sse_headers(handler)
        _sse_set_write_deadline(handler)
        _sse(handler, "proxy_status", initial_status)

        while True:
            try:
                event_name, payload = q.get(timeout=_SSE_HEARTBEAT_INTERVAL_SECONDS)
            except queue.Empty:
                _sse_write(handler, b": keepalive\n\n")
                continue
            _sse(handler, event_name, payload)
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError, OSError):
        pass
    finally:
        with _LOCK:
            subs = _SUBSCRIBERS.get(sid, [])
            if q in subs:
                subs.remove(q)
            if not subs and sid in _SUBSCRIBERS:
                del _SUBSCRIBERS[sid]
    return True
