"""Tests for Cockpit v2 HTTP Proxy capture, repeater, and route handlers."""

from __future__ import annotations

import http.server
import threading
import urllib.request
from urllib.parse import urlparse

import pytest

from api import auth as api_auth
from api.cockpit import proxy as cockpit_proxy
from api.cockpit import routes as cockpit_routes


class _TargetHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format: str, *args) -> None:
        return

    def do_GET(self) -> None:
        body = b'{"ok":true,"path":"' + self.path.encode("utf-8") + b'"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def test_proxy_start_capture_filter_and_stop() -> None:
    sid = "proxy-test-session"
    cockpit_proxy.clear_entries(sid)

    target = http.server.HTTPServer(("127.0.0.1", 0), _TargetHandler)
    target_port = target.server_address[1]
    t_thread = threading.Thread(target=target.serve_forever, daemon=True)
    t_thread.start()

    try:
        status = cockpit_proxy.start_proxy(sid, port=0)
        assert status["running"] is True
        assert status["port"] > 0
        proxy_url = status["proxy_url"]

        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy_url})
        )
        with opener.open(f"http://127.0.0.1:{target_port}/hello?x=1", timeout=5) as resp:
            assert resp.status == 200
            assert b'"ok":true' in resp.read()

        entries = cockpit_proxy.list_entries(sid)
        assert len(entries) == 1
        assert entries[0]["method"] == "GET"
        assert entries[0]["status"] == 200
        assert "/hello?x=1" in entries[0]["url"]
        assert '"ok":true' in entries[0]["res_body_preview"]

        assert len(cockpit_proxy.list_entries(sid, "hello")) == 1
        assert len(cockpit_proxy.list_entries(sid, "nomatch")) == 0

        cleared = cockpit_proxy.clear_entries(sid)
        assert cleared["entry_count"] == 0
    finally:
        stopped = cockpit_proxy.stop_proxy(sid)
        assert stopped["running"] is False
        target.shutdown()
        target.server_close()


def test_proxy_replay_validates_scheme_and_records_entry() -> None:
    sid = "proxy-replay-session"
    cockpit_proxy.clear_entries(sid)

    with pytest.raises(ValueError):
        cockpit_proxy.replay_request(sid, {"method": "GET", "url": "file:///etc/passwd"})

    target = http.server.HTTPServer(("127.0.0.1", 0), _TargetHandler)
    target_port = target.server_address[1]
    t_thread = threading.Thread(target=target.serve_forever, daemon=True)
    t_thread.start()
    try:
        entry = cockpit_proxy.replay_request(
            sid,
            {"method": "GET", "url": f"http://127.0.0.1:{target_port}/replay"},
        )
        assert entry["status"] == 200
        assert "/replay" in entry["url"]
        assert len(cockpit_proxy.list_entries(sid)) == 1
    finally:
        target.shutdown()
        target.server_close()
        cockpit_proxy.clear_entries(sid)


def test_proxy_routes_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(api_auth, "is_auth_enabled", lambda: False)
    from tests.test_cockpit_shell import _FakeHandler

    h = _FakeHandler()
    assert cockpit_routes.handle_cockpit_get(
        h, urlparse("/api/cockpit/proxy/status?session_id=s1")
    ) is True
    assert h.status == 200

    h2 = _FakeHandler()
    assert cockpit_routes.handle_cockpit_get(
        h2, urlparse("/api/cockpit/proxy/entries?session_id=s1")
    ) is True
    assert h2.status == 200
