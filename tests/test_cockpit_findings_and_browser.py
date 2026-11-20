"""Tests for Cockpit v2 Findings Markdown CRUD and Browser state/lease endpoints."""

from __future__ import annotations

import io
import json
from pathlib import Path
from urllib.parse import urlparse

import pytest

from api.cockpit import browser as cockpit_browser
from api.cockpit import findings as cockpit_findings
from api.cockpit import routes as cockpit_routes


class _FakeHandler:
    def __init__(self, body: bytes = b"") -> None:
        self.headers: dict[str, str] = {"Content-Length": str(len(body))}
        self.rfile = io.BytesIO(body)
        self.status: int | None = None
        self.sent_headers: dict[str, str] = {}
        self.wfile = io.BytesIO()
        self.client_address = ("127.0.0.1", 12345)

    def send_response(self, code: int) -> None:
        self.status = code

    def send_header(self, key: str, value: str) -> None:
        self.sent_headers[key] = value

    def end_headers(self) -> None:
        pass


def test_findings_crud_and_traversal_guard(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))

    # Create finding
    payload = {
        "program": "acme",
        "title": "IDOR on /api/v2/users/{id}",
        "severity": "high",
        "status": "verified",
        "target_url": "https://staging.acme.com/api/v2/users/1042",
        "parameter": "id",
        "cwe": "CWE-639",
        "steps_to_reproduce": "1. Swap user id\n2. Observe 200 OK",
        "impact": "Cross-account PII exposure",
    }
    h_post = _FakeHandler(json.dumps(payload).encode("utf-8"))
    assert cockpit_routes.handle_cockpit_post(h_post, urlparse("/api/cockpit/findings")) is True
    assert h_post.status == 200
    created = json.loads(h_post.wfile.getvalue().decode("utf-8"))["finding"]
    fid = created["id"]

    # List findings
    h_get = _FakeHandler()
    assert cockpit_routes.handle_cockpit_get(h_get, urlparse("/api/cockpit/findings?program=acme")) is True
    assert h_get.status == 200
    listed = json.loads(h_get.wfile.getvalue().decode("utf-8"))["findings"]
    assert len(listed) == 1
    assert listed[0]["id"] == fid
    assert listed[0]["cwe"] == "CWE-639"

    # Reject traversal program/id
    h_bad = _FakeHandler()
    cockpit_routes.handle_cockpit_get(
        h_bad, urlparse("/api/cockpit/findings?program=../../etc")
    )
    assert h_bad.status == 400

    # Delete finding
    h_del = _FakeHandler()
    assert (
        cockpit_routes.handle_cockpit_delete(
            h_del, urlparse(f"/api/cockpit/findings?program=acme&id={fid}")
        )
        is True
    )
    assert h_del.status == 200
    assert cockpit_findings.list_findings("acme") == []


def test_browser_frame_and_lease_state_machine() -> None:
    sid = "test-browser-sid"
    h_frame = _FakeHandler(
        json.dumps(
            {
                "session_id": sid,
                "url": "https://staging.acme.com/login",
                "screenshot_b64": "aGVsbG8=",
            }
        ).encode("utf-8")
    )
    assert cockpit_routes.handle_cockpit_post(h_frame, urlparse("/api/cockpit/browser/frame")) is True
    assert h_frame.status == 200

    h_lease = _FakeHandler(
        json.dumps({"session_id": sid, "holder": "HUMAN"}).encode("utf-8")
    )
    assert cockpit_routes.handle_cockpit_post(h_lease, urlparse("/api/cockpit/browser/lease")) is True
    assert h_lease.status == 200

    h_state = _FakeHandler()
    assert (
        cockpit_routes.handle_cockpit_get(
            h_state, urlparse(f"/api/cockpit/browser/state?session_id={sid}")
        )
        is True
    )
    state = json.loads(h_state.wfile.getvalue().decode("utf-8"))
    assert state["url"] == "https://staging.acme.com/login"
    assert state["lease_holder"] == "HUMAN"

    # Invalid holder rejected
    h_bad = _FakeHandler(
        json.dumps({"session_id": sid, "holder": "ROOT"}).encode("utf-8")
    )
    cockpit_routes.handle_cockpit_post(h_bad, urlparse("/api/cockpit/browser/lease"))
    assert h_bad.status == 400


def test_mirror_browser_tool_event_tracks_url_and_screenshot(tmp_path: Path) -> None:
    from api.cockpit import browser as cockpit_browser

    sid = "mirror-browser-test"
    shot = tmp_path / "shot.png"
    shot.write_bytes(b"\x89PNG\r\n\x1a\n")

    st1 = cockpit_browser.mirror_browser_tool_event(
        sid, "browser_navigate", {"url": "https://pretaxpk.com"}
    )
    assert st1 is not None
    assert st1["url"] == "https://pretaxpk.com"

    st2 = cockpit_browser.mirror_browser_tool_event(
        sid,
        "browser_exec",
        {"code": "navigate('https://pretaxpk.com/login'); capture_screenshot()"},
        function_result={"meta": {"screenshot_path": str(shot)}, "text_summary": "ok"},
    )
    assert st2 is not None
    assert st2["url"] == "https://pretaxpk.com/login"
    assert st2["screenshot_b64"].startswith("data:image/png;base64,")


def test_browser_action_cdp_and_offline_degradation(monkeypatch: pytest.MonkeyPatch) -> None:
    from api.cockpit import browser as cockpit_browser
    from api.cockpit import huntproxy as cockpit_hp

    # Invalid action -> 400
    h_inv = _FakeHandler(json.dumps({"session_id": "s1", "action": "drop_db"}).encode("utf-8"))
    assert cockpit_routes.handle_cockpit_post(h_inv, urlparse("/api/cockpit/browser/action")) is True
    assert h_inv.status == 400

    # Offline HuntProxy -> 200 with offline=True (never 500)
    monkeypatch.setattr(cockpit_hp, "list_projects", lambda: (False, []))
    h_off = _FakeHandler(
        json.dumps({"session_id": "s1", "action": "cdp", "op": "enable"}).encode("utf-8")
    )
    assert cockpit_routes.handle_cockpit_post(h_off, urlparse("/api/cockpit/browser/action")) is True
    assert h_off.status == 200
    off_data = json.loads(h_off.wfile.getvalue().decode("utf-8"))
    assert off_data["offline"] is True

    # Online HuntProxy browser_cdp enable -> returns paused=True + DevTools/SSH fields
    monkeypatch.setattr(
        cockpit_hp,
        "list_projects",
        lambda: (True, [{"id": 2, "name": "pretax", "updated_at": "2026-11-20T00:00:00Z"}]),
    )
    monkeypatch.setattr(
        cockpit_browser,
        "_hp_get_active_browser_session",
        lambda pid: {"id": "bs-1", "agent_control": True},
    )
    monkeypatch.setattr(
        cockpit_browser,
        "_hp_browser_cdp",
        lambda pid, bsid, op: {
            "enabled": op == "enable",
            "hosted_devtools_url": "http://127.0.0.1:17892/devtools/bs-1",
            "ssh_forward_command": "ssh -L 9222:127.0.0.1:9222 vps",
        },
    )
    h_cdp = _FakeHandler(
        json.dumps({"session_id": "s1", "project_id": 2, "action": "cdp", "op": "enable"}).encode("utf-8")
    )
    assert cockpit_routes.handle_cockpit_post(h_cdp, urlparse("/api/cockpit/browser/action")) is True
    assert h_cdp.status == 200
    cdp_data = json.loads(h_cdp.wfile.getvalue().decode("utf-8"))
    assert cdp_data["ok"] is True
    assert cdp_data["paused"] is True
    assert "devtools" in cdp_data["hosted_devtools_url"]
    assert cdp_data["ssh_forward_command"].startswith("ssh ")
