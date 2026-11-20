"""Tests for Phase 0 Cockpit v2 shell route seams (/v2, /v2/)."""

from __future__ import annotations

import io
import json
import re
from pathlib import Path
from urllib.parse import urlparse

import pytest

from api import auth as api_auth
from api import config as api_config
from api import routes as api_routes
from api.cockpit import routes as cockpit_routes


class _FakeHandler:
    """Minimal HTTP handler stub recording status, headers, and response body."""

    def __init__(self, headers: dict[str, str] | None = None) -> None:
        self.headers = headers or {}
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


_SAMPLE_INDEX_HTML = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <script>
      window.__HERMES_CONFIG__ = {
        maxUploadBytes: __MAX_UPLOAD_BYTES__,
        csrfToken: __CSRF_TOKEN_JSON__,
        imgSrcExtra: __CSP_IMG_EXTRA_JSON__
      };
      window.__WEBUI_VERSION__ = "__WEBUI_VERSION__";
    </script>
  </head>
  <body><div id="root"></div></body>
</html>
"""


@pytest.fixture
def cockpit_static_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    static_root = tmp_path / "static"
    v2_dir = static_root / "v2"
    v2_dir.mkdir(parents=True)
    (v2_dir / "index.html").write_text(_SAMPLE_INDEX_HTML, encoding="utf-8")
    monkeypatch.setattr(api_config, "get_static_root", lambda: static_root)
    with cockpit_routes._COCKPIT_SHELL_CACHE_LOCK:
        cockpit_routes._COCKPIT_SHELL_CACHE.clear()
    return static_root


@pytest.mark.parametrize("path", ["/v2", "/v2/", "/v2/session/abc123"])
def test_v2_shell_serves_injected_config_and_content_length(
    cockpit_static_root: Path, monkeypatch: pytest.MonkeyPatch, path: str
) -> None:
    monkeypatch.setattr(api_auth, "is_auth_enabled", lambda: False)
    handler = _FakeHandler()

    handled = cockpit_routes.handle_cockpit_get(handler, urlparse(path))
    assert handled is True
    assert handler.status == 200
    assert handler.sent_headers.get("Cache-Control") == "no-store"
    assert "text/html" in handler.sent_headers.get("Content-Type", "")

    body = handler.wfile.getvalue()
    assert handler.sent_headers.get("Content-Length") == str(len(body))

    html = body.decode("utf-8")
    for placeholder in (
        "__MAX_UPLOAD_BYTES__",
        "__CSRF_TOKEN_JSON__",
        "__CSP_IMG_EXTRA_JSON__",
        "__WEBUI_VERSION__",
    ):
        assert placeholder not in html

    match = re.search(r"csrfToken:\s*(\".*?\")", html)
    assert match is not None
    assert json.loads(match.group(1)) == ""


def test_v2_shell_injects_session_csrf_token_when_auth_enabled(
    cockpit_static_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(api_auth, "is_auth_enabled", lambda: True)
    monkeypatch.setattr(api_auth, "parse_cookie", lambda h: "session-cookie-val")
    monkeypatch.setattr(api_auth, "verify_session", lambda c: c == "session-cookie-val")
    monkeypatch.setattr(
        api_auth, "csrf_token_for_session", lambda c: "csrf-abc-123" if c else ""
    )

    handler = _FakeHandler()
    handled = cockpit_routes.handle_cockpit_get(handler, urlparse("/v2"))
    assert handled is True
    assert handler.status == 200

    html = handler.wfile.getvalue().decode("utf-8")
    match = re.search(r"csrfToken:\s*(\".*?\")", html)
    assert match is not None
    assert json.loads(match.group(1)) == "csrf-abc-123"


def test_v2_shell_escapes_angle_brackets_in_img_src_extra(
    cockpit_static_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(api_auth, "is_auth_enabled", lambda: False)
    monkeypatch.setattr(
        cockpit_routes, "_csp_extra_img_src", lambda: ["https://cdn.example/<tag>"]
    )
    monkeypatch.setattr(
        cockpit_routes, "csp_img_extra_sources", lambda srcs: list(srcs)
    )

    handler = _FakeHandler()
    assert cockpit_routes.handle_cockpit_get(handler, urlparse("/v2")) is True
    html = handler.wfile.getvalue().decode("utf-8")
    assert "<tag>" not in html
    assert "\\u003ctag>" in html


def test_v2_shell_returns_503_when_bundle_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    empty_static = tmp_path / "static"
    empty_static.mkdir(parents=True)
    monkeypatch.setattr(api_config, "get_static_root", lambda: empty_static)
    with cockpit_routes._COCKPIT_SHELL_CACHE_LOCK:
        cockpit_routes._COCKPIT_SHELL_CACHE.clear()

    handler = _FakeHandler()
    assert cockpit_routes.handle_cockpit_get(handler, urlparse("/v2")) is True
    assert handler.status == 503
    body = handler.wfile.getvalue()
    assert handler.sent_headers.get("Content-Length") == str(len(body))
    assert b"npm run build" in body


@pytest.mark.parametrize("path", ["/", "/v2x", "/v2/foo", "/api/sessions"])
def test_cockpit_get_ignores_non_v2_routes(path: str) -> None:
    handler = _FakeHandler()
    assert cockpit_routes.handle_cockpit_get(handler, urlparse(path)) is False


def test_v2_requires_auth_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(api_auth, "is_auth_enabled", lambda: True)
    monkeypatch.setattr(api_auth, "parse_cookie", lambda h: None)
    monkeypatch.setattr(api_auth, "ensure_trusted_auth_session", lambda h: None)

    handler = _FakeHandler()
    allowed = api_auth.check_auth(handler, urlparse("/v2"))
    assert allowed is False
    assert handler.status == 302
    assert handler.sent_headers.get("Location") == "login?next=/v2"


def test_handle_get_dispatches_to_cockpit_hook(
    cockpit_static_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(api_auth, "is_auth_enabled", lambda: False)
    handler = _FakeHandler()
    assert api_routes.handle_get(handler, urlparse("/v2/")) is True
    assert handler.status == 200


@pytest.mark.parametrize(
    "path,expected_static_path",
    [
        ("/v2/session/static/v2/style.min.css", "/static/v2/style.min.css"),
        ("/v2/static/v2/style.min.css", "/static/v2/style.min.css"),
    ],
)
def test_v2_session_static_delegates_to_serve_static(
    monkeypatch: pytest.MonkeyPatch, path: str, expected_static_path: str
) -> None:
    seen: list[str] = []

    def fake_serve_static(handler, parsed) -> bool:
        seen.append(parsed.path)
        return True

    monkeypatch.setattr(api_routes, "_serve_static", fake_serve_static)
    handler = _FakeHandler()
    assert cockpit_routes.handle_cockpit_get(handler, urlparse(path)) is True
    assert seen == [expected_static_path]
