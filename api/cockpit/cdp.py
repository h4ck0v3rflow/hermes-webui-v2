"""Minimal Chrome DevTools Protocol (CDP) bridge for the cockpit Browser pane.

Why this exists
---------------
The pane previously polled PNG screenshots through HuntProxy's ``browser_action``
API. That is a still-image pipeline: ~1 fps, 100-300 KB per frame, no delta
compression, and no way for a human to click anything. Meta-Muse-style agent
browsing instead uses CDP ``Page.startScreencast``: the renderer pushes JPEG
frames only when the page actually changes, and human input is injected as real
browser input events.

This module speaks CDP over a WebSocket implemented on the standard library
(the service runs on ThreadingHTTPServer, so there is no async WS stack
available), exposes the newest frame to SSE subscribers, and forwards input.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import queue
import socket
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

_locks_lock = threading.Lock()
_sessions: dict[int, "CdpSession"] = {}
_sessions_lock = threading.RLock()


class WsError(RuntimeError):
    pass


class WsClient:
    """Blocking RFC6455 client: text frames only, masked outgoing, ping/pong aware."""

    def __init__(self, ws_url: str, timeout: float = 10.0):
        parsed = urllib.parse.urlparse(ws_url)
        if parsed.scheme != "ws":
            raise WsError(f"unsupported ws scheme: {parsed.scheme}")
        self.host = parsed.hostname or "127.0.0.1"
        self.port = parsed.port or 80
        self.path = parsed.path + (("?" + parsed.query) if parsed.query else "")
        self.sock = socket.create_connection((self.host, self.port), timeout=timeout)
        self.sock.settimeout(None)
        self._send_lock = threading.Lock()
        self._handshake()

    def _handshake(self) -> None:
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WsError("handshake closed")
            buf += chunk
            if len(buf) > 65536:
                raise WsError("handshake too large")
        head, _, rest = buf.partition(b"\r\n\r\n")
        status_line = head.split(b"\r\n", 1)[0].decode("latin-1")
        if "101" not in status_line:
            raise WsError(f"handshake failed: {status_line}")
        expect = base64.b64encode(hashlib.sha1((key + _WS_GUID).encode()).digest()).decode()
        if expect.lower() not in head.decode("latin-1").lower():
            raise WsError("bad Sec-WebSocket-Accept")
        self._buf = rest

    # ---- low level -------------------------------------------------
    def _recv_exact(self, n: int) -> bytes:
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise WsError("connection closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def send_text(self, text: str) -> None:
        payload = text.encode()
        header = bytearray([0x81])
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < (1 << 16):
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        masked = bytearray(payload)
        for i in range(n):
            masked[i] ^= mask[i & 3]
        with self._send_lock:
            self.sock.sendall(bytes(header) + bytes(masked))

    def recv_text(self) -> str | None:
        """Return the next text message, or None for control/internal frames."""
        b1, b2 = self._recv_exact(2)
        fin = bool(b1 & 0x80)
        opcode = b1 & 0x0F
        masked = bool(b2 & 0x80)
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._recv_exact(8))[0]
        mask = self._recv_exact(4) if masked else b""
        payload = self._recv_exact(length) if length else b""
        if masked and payload:
            payload = bytes(payload[i] ^ mask[i & 3] for i in range(len(payload)))
        if opcode == 0x8:
            raise WsError("peer closed")
        if opcode == 0x9:  # ping -> pong
            self._send_control(0xA, payload)
            return None
        if opcode == 0xA:
            return None
        if opcode in (0x1, 0x0):
            text = payload.decode("utf-8", errors="replace")
            if fin:
                return text
            parts = [text]
            while True:
                b1b, b2b = self._recv_exact(2)
                ln = b2b & 0x7F
                if ln == 126:
                    ln = struct.unpack(">H", self._recv_exact(2))[0]
                elif ln == 127:
                    ln = struct.unpack(">Q", self._recv_exact(8))[0]
                mk = self._recv_exact(4) if (b2b & 0x80) else b""
                part = self._recv_exact(ln) if ln else b""
                if mk and part:
                    part = bytes(part[i] ^ mk[i & 3] for i in range(len(part)))
                parts.append(part.decode("utf-8", errors="replace"))
                if b1b & 0x80:
                    break
            return "".join(parts)
        return None

    def _send_control(self, opcode: int, payload: bytes) -> None:
        header = bytearray([0x80 | opcode])
        mask = os.urandom(4)
        header.append(0x80 | len(payload))
        header += mask
        masked = bytes(payload[i] ^ mask[i & 3] for i in range(len(payload)))
        with self._send_lock:
            try:
                self.sock.sendall(bytes(header) + masked)
            except OSError:
                pass

    def close(self) -> None:
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


class CdpSession:
    """One screencasting CDP connection per HuntProxy project."""

    def __init__(self, project_id: int, ws_url: str, hp_session_id: int = 0):
        self.project_id = project_id
        self.ws_url = ws_url
        self.hp_session_id = hp_session_id
        self.ws: WsClient | None = None
        self.subs: list[queue.Queue] = []
        self.subs_lock = threading.Lock()
        self.msg_id = 0
        self.id_lock = threading.Lock()
        self.frame_lock = threading.Lock()
        self.latest: dict | None = None
        self.frame_seq = 0
        self.started_at = time.time()
        self._last_fanout = 0.0
        self.last_error = ""
        self.page_url = ""
        self._stop = False
        self.thread: threading.Thread | None = None

    # ---- lifecycle -------------------------------------------------
    def start(self) -> bool:
        try:
            self.ws = WsClient(self.ws_url)
        except Exception as exc:  # noqa: BLE001
            self.last_error = f"ws connect failed: {exc}"
            return False
        self._call("Page.enable")
        self._call("Page.getNavigationHistory")
        self._call(
            "Page.startScreencast",
            {
                "format": "jpeg",
                "quality": 62,
                "maxWidth": 1280,
                "maxHeight": 800,
                "everyNthFrame": 1,
            },
        )
        self.thread = threading.Thread(target=self._loop, name=f"cdp-{self.project_id}", daemon=True)
        self.thread.start()
        return True

    def stop(self) -> None:
        self._stop = True
        try:
            if self.ws:
                self._call("Page.stopScreencast")
        except Exception:  # noqa: BLE001
            pass
        if self.ws:
            self.ws.close()

    def alive(self) -> bool:
        return bool(self.thread and self.thread.is_alive() and not self._stop)

    # ---- cdp -------------------------------------------------------
    def _next_id(self) -> int:
        with self.id_lock:
            self.msg_id += 1
            return self.msg_id

    def _call(self, method: str, params: dict | None = None) -> int:
        if not self.ws:
            raise WsError("not connected")
        mid = self._next_id()
        payload = {"id": mid, "method": method}
        if params:
            payload["params"] = params
        self.ws.send_text(json.dumps(payload))
        return mid

    def _loop(self) -> None:
        while not self._stop:
            try:
                text = self.ws.recv_text() if self.ws else None
            except Exception as exc:  # noqa: BLE001
                if not self._stop:
                    self.last_error = f"recv failed: {exc}"
                break
            if not text:
                continue
            try:
                msg = json.loads(text)
            except ValueError:
                continue
            method = msg.get("method") or ""
            params = msg.get("params") or {}
            if method == "Page.screencastFrame":
                self._on_frame(params)
            elif method in ("Page.frameNavigated", "Page.navigatedWithinDocument"):
                frame = params.get("frame") or {}
                url = str(frame.get("url") or "")
                if url:
                    self.page_url = url
                    self._fanout({"t": "nav", "url": url})
            elif method == "Inspector.targetCrashed":
                self._fanout({"t": "error", "message": "target crashed"})
        self._fanout({"t": "closed", "message": self.last_error or "cdp closed"})

    def _on_frame(self, params: dict) -> None:
        data = params.get("data") or ""
        meta = params.get("metadata") or {}
        session_id = params.get("sessionId") or 0
        try:
            self._call("Page.screencastFrameAck", {"sessionId": session_id})
        except Exception:  # noqa: BLE001
            pass
        with self.frame_lock:
            self.frame_seq += 1
            self.latest = {
                "jpeg_b64": data,
                "w": int(meta.get("deviceWidth") or 0),
                "h": int(meta.get("deviceHeight") or 0),
                "seq": self.frame_seq,
                "ts": meta.get("timestamp") or time.time(),
                "scale": meta.get("pageScaleFactor") or 1,
                "offset_top": meta.get("offsetTop") or 0,
                "scroll_y": meta.get("scrollOffsetY") or 0,
                "scroll_x": meta.get("scrollOffsetX") or 0,
            }
        # Animated pages emit up to ~20 fps; forwarding every frame costs megabytes per
        # second and makes React re-render needlessly. Coalesce to ~10 fps: the newest
        # frame is always kept for late joiners, only the fan-out is rate limited.
        now = time.monotonic()
        if now - self._last_fanout < 0.09:
            return
        self._last_fanout = now
        # Frames are only fanned out with their metadata, never the raw page text.
        self._fanout(
            {
                "t": "frame",
                "seq": self.frame_seq,
                "w": self.latest["w"],
                "h": self.latest["h"],
                "len": len(data),
                "jpeg_b64": data,
            }
        )

    # ---- subscribers ----------------------------------------------
    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=12)
        with self.subs_lock:
            self.subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self.subs_lock:
            if q in self.subs:
                self.subs.remove(q)

    def _fanout(self, payload: dict) -> None:
        with self.subs_lock:
            targets = list(self.subs)
        for q in targets:
            try:
                q.put_nowait(payload)
            except queue.Full:
                # Slow viewer: drop the oldest frame rather than block the CDP loop.
                try:
                    q.get_nowait()
                    q.put_nowait(payload)
                except queue.Empty:
                    pass

    def current_frame(self) -> dict | None:
        with self.frame_lock:
            return dict(self.latest) if self.latest else None

    # ---- input -----------------------------------------------------
    def click(self, x: float, y: float, button: str = "left", clicks: int = 1) -> None:
        base = {"x": x, "y": y, "button": button, "clickCount": clicks, "buttons": 1}
        self._call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "buttons": 0})
        self._call("Input.dispatchMouseEvent", {**base, "type": "mousePressed"})
        self._call("Input.dispatchMouseEvent", {**base, "type": "mouseReleased"})

    def mouse_move(self, x: float, y: float) -> None:
        self._call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "buttons": 0})

    def wheel(self, x: float, y: float, dx: float, dy: float) -> None:
        self._call(
            "Input.dispatchMouseEvent",
            {"type": "mouseWheel", "x": x, "y": y, "deltaX": dx, "deltaY": dy},
        )

    def key(self, key: str, code: str | None = None, text: str | None = None, modifiers: int = 0) -> None:
        vk = _virtual_key(key)
        common = {
            "key": key,
            "code": code or key,
            "windowsVirtualKeyCode": vk,
            "nativeVirtualKeyCode": vk,
            "modifiers": modifiers,
        }
        self._call("Input.dispatchKeyEvent", {**common, "type": "keyDown" if text is None else "keyDown", "text": text or ""})
        if text:
            self._call("Input.dispatchKeyEvent", {**common, "type": "char", "text": text})
        self._call("Input.dispatchKeyEvent", {**common, "type": "keyUp"})

    def insert_text(self, text: str) -> None:
        self._call("Input.insertText", {"text": text})

    def set_device(self, width: int, height: int, mobile: bool = False, scale: float = 1.0) -> None:
        """Emulate a viewport so the site renders ITS responsive layout, not a zoom."""
        self._call(
            "Emulation.setDeviceMetricsOverride",
            {
                "width": int(width),
                "height": int(height),
                "deviceScaleFactor": float(scale),
                "mobile": bool(mobile),
                "screenWidth": int(width),
                "screenHeight": int(height),
                "screenOrientation": {"type": "portraitPrimary", "angle": 0},
            },
        )
        try:
            self._call(
                "Emulation.setTouchEmulationEnabled",
                {"enabled": bool(mobile), "maxTouchPoints": 5 if mobile else 1},
            )
        except Exception:  # noqa: BLE001
            pass

    def clear_device(self) -> None:
        self._call("Emulation.clearDeviceMetricsOverride")
        try:
            self._call("Emulation.setTouchEmulationEnabled", {"enabled": False})
        except Exception:  # noqa: BLE001
            pass


def _virtual_key(key: str) -> int:
    table = {
        "Enter": 13, "Tab": 9, "Escape": 27, "Backspace": 8, "Delete": 46,
        "ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40,
        "Home": 36, "End": 35, "PageUp": 33, "PageDown": 34, " ": 32,
    }
    if key in table:
        return table[key]
    if len(key) == 1:
        return ord(key.upper())
    return 0


# ---------------------------------------------------------------------
# session registry
# ---------------------------------------------------------------------
def _hp_base() -> str:
    return os.environ.get("HERMES_HUNTPROXY_API_URL", "http://127.0.0.1:17890/api/v1").rstrip("/")


def _hp_json(path: str, payload: dict | None = None, timeout: float = 10.0):
    base = _hp_base()
    if payload is None:
        req = urllib.request.Request(f"{base}{path}", method="GET")
    else:
        req = urllib.request.Request(
            f"{base}{path}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode("utf-8", errors="replace") or "{}")
        except Exception:  # noqa: BLE001
            body = None
        return exc.code, body
    except Exception:  # noqa: BLE001
        return 0, None


def _active_browser_session(project_id: int, profile: str = "") -> int:
    """Browser session id for CDP (creating one with `profile` when absent)."""
    _st, data = _hp_json(f"/projects/{project_id}/browser-sessions", timeout=5)
    items = []
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = data.get("sessions") or data.get("browser_sessions") or data.get("items") or []
    if profile:
        for item in items:
            if isinstance(item, dict) and str(item.get("profile") or "") == profile:
                return int(item.get("id") or item.get("session_id") or 0)
    for item in items:
        if isinstance(item, dict) and not profile and (item.get("id") or item.get("session_id")):
            return int(item.get("id") or item.get("session_id"))
    for candidate in ([profile] if profile else []) + ["default", "cockpit"]:
        if not candidate:
            continue
        st, created = _hp_json(
            f"/projects/{project_id}/browser-sessions", {"profile": candidate}, timeout=30.0
        )
        if st in (200, 201) and isinstance(created, dict):
            sid = created.get("id") or created.get("session_id")
            if sid:
                return int(sid)
    return 0


def cdp_endpoint(project_id: int, profile: str = "") -> tuple[str, int] | None:
    """Ask HuntProxy to enable CDP and return the page WebSocket URL."""
    sid = _active_browser_session(project_id, profile)
    if not sid:
        return None
    st, info = _hp_json(
        f"/projects/{project_id}/browser-cdp", {"op": "enable", "session_id": sid}, timeout=20.0
    )
    if st == 429:
        # Only one browser session may hold CDP port 9222. Steal it from whoever has it
        # instead of failing: "CDP port 9222 is already handed off by browser session N".
        import re as _re

        msg = str((info or {}).get("message") or "")
        holder = _re.search(r"session (\d+)", msg)
        if holder:
            _hp_json(
                f"/projects/{project_id}/browser-cdp",
                {"op": "disable", "session_id": int(holder.group(1))},
                timeout=10.0,
            )
            st, info = _hp_json(
                f"/projects/{project_id}/browser-cdp",
                {"op": "enable", "session_id": sid},
                timeout=20.0,
            )
    if st != 200 or not isinstance(info, dict):
        return None
    endpoint = str(info.get("endpoint") or "").rstrip("/")
    if not endpoint:
        return None
    target_sid = int(info.get("session_id") or sid or 0)
    try:
        with urllib.request.urlopen(f"{endpoint}/json/list", timeout=5) as resp:
            targets = json.loads(resp.read().decode("utf-8", errors="replace") or "[]")
    except Exception:  # noqa: BLE001
        return None
    pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
    if not pages:
        return None
    preferred = next((t for t in pages if "chrome-devtools" not in str(t.get("url"))), pages[0])
    return str(preferred["webSocketDebuggerUrl"]), target_sid


def get_session(project_id: int, profile: str = "") -> CdpSession | None:
    """Return a live CDP session for this project/profile, starting one if needed."""
    with _sessions_lock:
        sess = _sessions.get(project_id)
        if sess and sess.alive():
            return sess
        if sess:
            sess.stop()
        target = cdp_endpoint(project_id, profile)
        if not target:
            return None
        ws_url, sid = target
        sess = CdpSession(project_id, ws_url, sid)
        if not sess.start():
            _sessions.pop(project_id, None)
            return None
        _sessions[project_id] = sess
        return sess


def drop_session(project_id: int) -> None:
    with _sessions_lock:
        sess = _sessions.pop(project_id, None)
    if sess:
        sess.stop()
