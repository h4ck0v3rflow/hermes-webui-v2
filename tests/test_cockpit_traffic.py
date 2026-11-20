"""Tests for Cockpit v2 HuntProxy traffic client, project resolution, and SSE degradation."""

from __future__ import annotations

import json
from urllib.parse import urlparse

import pytest

from api.cockpit import huntproxy as cockpit_hp
from api.cockpit import routes as cockpit_routes


def _sample_projects() -> list[dict]:
    return [
        {
            "id": 1,
            "name": "alpha",
            "target_url": "https://alpha.example.com",
            "scope": {"host_patterns": ["*.alpha.example.com"]},
            "updated_at": "2026-11-18T10:00:00Z",
        },
        {
            "id": 2,
            "name": "pretax",
            "target_url": "https://pretaxpk.com",
            "scope": {"host_patterns": ["*.pretaxpk.com"]},
            "updated_at": "2026-11-19T12:00:00Z",
        },
    ]


def test_resolve_project_offline_degrades_gracefully(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cockpit_hp, "list_projects", lambda: (False, []))
    res = cockpit_hp.resolve_project_for_session("s-offline")
    assert res["online"] is False
    assert res["project_id"] is None
    assert res["reason"] == "offline"


def test_resolve_project_scope_match_and_per_session_isolation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with cockpit_hp._LOCK:
        cockpit_hp._SESSION_PROJECT_OVERRIDES.clear()

    monkeypatch.setattr(cockpit_hp, "list_projects", lambda: (True, _sample_projects()))
    monkeypatch.setattr(
        cockpit_hp,
        "_session_workspace_hint",
        lambda sid: "/hunts/alpha.example.com" if sid == "s-alpha" else "/hunts/other",
    )

    r1 = cockpit_hp.resolve_project_for_session("s-alpha")
    assert r1["project_id"] == 1
    assert r1["reason"] == "scope_match"

    # Second session without scope match falls back to newest updated_at (#2)
    r2 = cockpit_hp.resolve_project_for_session("s-other")
    assert r2["project_id"] == 2
    assert r2["reason"] == "latest_updated"

    # Both sessions keep independent server-side persisted IDs
    assert cockpit_hp.resolve_project_for_session("s-alpha")["project_id"] == 1
    assert cockpit_hp.resolve_project_for_session("s-other")["project_id"] == 2


def test_traffic_endpoints_validate_int_ids_and_use_project_scoped_exchange(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tests.test_cockpit_shell import _FakeHandler

    monkeypatch.setattr(cockpit_hp, "list_projects", lambda: (True, _sample_projects()))

    # Non-integer project_id rejected with 400
    h_bad = _FakeHandler()
    assert cockpit_routes.handle_cockpit_get(
        h_bad, urlparse("/api/cockpit/traffic/history?project_id=../etc")
    ) is True
    assert h_bad.status == 400

    # Unknown project_id rejected with 400
    h_unknown = _FakeHandler()
    assert cockpit_routes.handle_cockpit_get(
        h_unknown, urlparse("/api/cockpit/traffic/history?project_id=999")
    ) is True
    assert h_unknown.status == 400

    # Project-scoped exchange detail + body paths verified
    seen_paths: list[str] = []

    def fake_hp_get(path: str, *, timeout: float = 5.0):
        seen_paths.append(path)
        if "/body?" in path:
            return 200, {"text": '{"ok":true}'}
        return 200, {"id": 42, "method": "GET", "status": 200, "response_headers": {"Content-Type": "application/json"}}

    monkeypatch.setattr(cockpit_hp, "_hp_get_json", fake_hp_get)
    h_ex = _FakeHandler()
    assert cockpit_routes.handle_cockpit_get(
        h_ex,
        urlparse("/api/cockpit/traffic/exchange?project_id=2&exchange_id=42&side=response&offset=0&max_bytes=65536"),
    ) is True
    assert h_ex.status == 200
    assert seen_paths[0] == "/projects/2/exchanges/42"
    assert seen_paths[1].startswith("/projects/2/exchanges/42/body?")
    payload = json.loads(h_ex.wfile.getvalue().decode("utf-8"))
    assert payload["exchange"]["id"] == 42
    assert payload["body"]["text"] == '{"ok":true}'


def test_traffic_stream_offline_emits_offline_event_with_200(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tests.test_cockpit_shell import _FakeHandler

    monkeypatch.setattr(cockpit_hp, "list_projects", lambda: (False, []))
    h = _FakeHandler()
    assert cockpit_routes.handle_cockpit_get(
        h, urlparse("/api/cockpit/traffic/stream?project_id=1")
    ) is True
    assert h.status == 200
    raw = h.wfile.getvalue().decode("utf-8", errors="replace")
    assert '"t": "offline"' in raw or '"t":"offline"' in raw
