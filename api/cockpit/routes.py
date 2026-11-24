"""Cockpit v2 HTTP route seams.

All /v2 and /api/cockpit/* routes run behind server.py's pre-dispatch
check_auth_or_close() gate and never implement a second auth path.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from urllib.parse import quote

from api import config as api_config
from api.config import MAX_UPLOAD_BYTES
from api.helpers import _csp_extra_img_src, csp_img_extra_sources, t

_COCKPIT_SHELL_CACHE: dict[str, tuple[tuple[Path, int, int], str]] = {}
_COCKPIT_SHELL_CACHE_LOCK = threading.Lock()


def _cockpit_index_path() -> Path:
    return api_config.get_static_root().resolve() / "v2" / "index.html"


def _render_cockpit_shell_base(index_path: Path) -> str:
    """Return static/v2/index.html with process-constant tokens substituted.

    Cached and invalidated on (path, size, mtime_ns) so rebuilds of web/ are
    picked up without restarting the server. Per-request values (CSRF token and
    validated CSP image allowlist) are applied by the caller.
    """
    from api.updates import WEBUI_VERSION

    st = index_path.stat()
    sig = (index_path, st.st_size, st.st_mtime_ns)
    with _COCKPIT_SHELL_CACHE_LOCK:
        cached = _COCKPIT_SHELL_CACHE.get("base")
        if cached and cached[0] == sig:
            return cached[1]

    version_token = quote(WEBUI_VERSION, safe="")
    base = (
        index_path.read_text(encoding="utf-8")
        .replace("__WEBUI_VERSION__", version_token)
        .replace("__MAX_UPLOAD_BYTES__", str(MAX_UPLOAD_BYTES))
    )
    with _COCKPIT_SHELL_CACHE_LOCK:
        _COCKPIT_SHELL_CACHE["base"] = (sig, base)
    return base


def _resolve_request_csrf_token(handler) -> str:
    try:
        from api.auth import (
            csrf_token_for_session,
            is_auth_enabled,
            parse_cookie,
            verify_session,
        )

        if is_auth_enabled():
            cookie_val = parse_cookie(handler)
            if not cookie_val:
                cookie_val = getattr(
                    handler, "_trusted_auth_session_cookie_value", None
                )
            if cookie_val and verify_session(cookie_val):
                return csrf_token_for_session(cookie_val) or ""
    except Exception:
        return ""
    return ""


def serve_cockpit_shell(handler) -> bool:
    """Serve static/v2/index.html with window.__HERMES_CONFIG__ injected."""
    index_path = _cockpit_index_path()
    if not index_path.is_file():
        t(
            handler,
            "Cockpit v2 bundle not built. Run: cd web && npm run build\n",
            status=503,
            content_type="text/plain; charset=utf-8",
            extra_headers={"Cache-Control": "no-store"},
        )
        return True

    csrf_token = _resolve_request_csrf_token(handler)
    extra_img_src = _csp_extra_img_src()
    handler._csp_extra_img_src_preset = extra_img_src

    from api.extensions import inject_extension_tags

    html = (
        _render_cockpit_shell_base(index_path)
        .replace("__CSRF_TOKEN_JSON__", json.dumps(csrf_token))
        .replace(
            "__CSP_IMG_EXTRA_JSON__",
            json.dumps(csp_img_extra_sources(extra_img_src)).replace("<", "\\u003c"),
        )
    )
    t(
        handler,
        inject_extension_tags(html),
        content_type="text/html; charset=utf-8",
        extra_headers={"Cache-Control": "no-store"},
    )
    return True


def handle_cockpit_get(handler, parsed) -> bool:
    """Dispatch Cockpit v2 GET routes. Returns True if handled."""
    path = parsed.path
    if path.startswith("/v2/session/static/"):
        from api.routes import _serve_static

        _serve_static(handler, parsed._replace(path=path[len("/v2/session"):]))
        return True
    if path.startswith("/v2/static/"):
        from api.routes import _serve_static

        _serve_static(handler, parsed._replace(path=path[len("/v2"):]))
        return True
    if path.startswith("/v2/session/extensions/"):
        from api.extensions import serve_extension_static

        serve_extension_static(handler, parsed._replace(path=path[len("/v2/session"):]))
        return True
    if path.startswith("/v2/extensions/"):
        from api.extensions import serve_extension_static

        serve_extension_static(handler, parsed._replace(path=path[len("/v2"):]))
        return True
    if path in (
        "/v2/manifest.json",
        "/v2/manifest.webmanifest",
        "/v2/session/manifest.json",
        "/v2/session/manifest.webmanifest",
    ):
        from api.routes import _serve_manifest

        _serve_manifest(handler)
        return True
    if path in ("/v2", "/v2/") or path.startswith("/v2/session/"):
        return serve_cockpit_shell(handler)
    if parsed.path == "/api/cockpit/files/tree":
        from api.cockpit.files import handle_files_tree

        return handle_files_tree(handler, parsed)
    if parsed.path == "/api/cockpit/files/read":
        from api.cockpit.files import handle_files_read

        return handle_files_read(handler, parsed)
    if parsed.path == "/api/cockpit/files/stream":
        from api.cockpit.files import handle_files_stream

        return handle_files_stream(handler, parsed)
    if parsed.path == "/api/cockpit/fs/list":
        from api.cockpit.files import handle_fs_list

        return handle_fs_list(handler, parsed)
    if parsed.path == "/api/cockpit/fs/read":
        from api.cockpit.files import handle_fs_read

        return handle_fs_read(handler, parsed)
    if parsed.path == "/api/cockpit/fs/raw":
        from api.cockpit.files import handle_fs_raw

        return handle_fs_raw(handler, parsed)
    if parsed.path == "/api/cockpit/findings":
        from api.cockpit.findings import handle_findings_get

        return handle_findings_get(handler, parsed)
    if parsed.path == "/api/cockpit/browser/state":
        from api.cockpit.browser import handle_browser_state

        return handle_browser_state(handler, parsed)
    if parsed.path == "/api/cockpit/browser/live":
        from api.cockpit.browser_live import handle_live_stream

        return handle_live_stream(handler, parsed)
    if parsed.path == "/api/cockpit/browser/stream":
        from api.cockpit.browser import handle_browser_stream

        return handle_browser_stream(handler, parsed)
    if parsed.path == "/api/cockpit/cmd/stream":
        from api.cockpit.cmd import handle_cmd_stream

        return handle_cmd_stream(handler, parsed)
    if parsed.path == "/api/cockpit/traffic/projects":
        from api.cockpit.huntproxy import handle_traffic_projects

        return handle_traffic_projects(handler, parsed)
    if parsed.path == "/api/cockpit/traffic/history":
        from api.cockpit.huntproxy import handle_traffic_history

        return handle_traffic_history(handler, parsed)
    if parsed.path == "/api/cockpit/traffic/stream":
        from api.cockpit.huntproxy import handle_traffic_stream

        return handle_traffic_stream(handler, parsed)
    if parsed.path == "/api/cockpit/traffic/exchange":
        from api.cockpit.huntproxy import handle_traffic_exchange

        return handle_traffic_exchange(handler, parsed)
    if parsed.path == "/api/cockpit/proxy/status":
        from api.cockpit.proxy import handle_proxy_status

        return handle_proxy_status(handler, parsed)
    if parsed.path == "/api/cockpit/proxy/entries":
        from api.cockpit.proxy import handle_proxy_entries

        return handle_proxy_entries(handler, parsed)
    if parsed.path == "/api/cockpit/proxy/stream":
        from api.cockpit.proxy import handle_proxy_stream

        return handle_proxy_stream(handler, parsed)
    return False


def handle_cockpit_post(handler, parsed) -> bool:
    """Dispatch Cockpit v2 POST routes. Returns True if handled."""
    if parsed.path == "/api/cockpit/findings":
        from api.cockpit.findings import handle_findings_post

        return handle_findings_post(handler)
    if parsed.path == "/api/cockpit/browser/frame":
        from api.cockpit.browser import handle_browser_frame

        return handle_browser_frame(handler)
    if parsed.path == "/api/cockpit/browser/lease":
        from api.cockpit.browser import handle_browser_lease

        return handle_browser_lease(handler)
    if parsed.path == "/api/cockpit/browser/action":
        from api.cockpit.browser import handle_browser_action

        return handle_browser_action(handler)
    if parsed.path == "/api/cockpit/browser/input":
        from api.cockpit.browser_live import handle_input

        return handle_input(handler)
    if parsed.path == "/api/cockpit/proxy/start":
        from api.cockpit.proxy import handle_proxy_start

        return handle_proxy_start(handler)
    if parsed.path == "/api/cockpit/proxy/stop":
        from api.cockpit.proxy import handle_proxy_stop

        return handle_proxy_stop(handler)
    if parsed.path == "/api/cockpit/proxy/clear":
        from api.cockpit.proxy import handle_proxy_clear

        return handle_proxy_clear(handler)
    if parsed.path == "/api/cockpit/proxy/ingest":
        from api.cockpit.proxy import handle_proxy_ingest

        return handle_proxy_ingest(handler)
    if parsed.path == "/api/cockpit/proxy/replay":
        from api.cockpit.proxy import handle_proxy_replay

        return handle_proxy_replay(handler)
    if parsed.path == "/api/cockpit/fs/save":
        from api.cockpit.files import handle_fs_save

        return handle_fs_save(handler)
    if parsed.path == "/api/cockpit/traffic/project":
        from api.cockpit.huntproxy import handle_traffic_select_project

        return handle_traffic_select_project(handler)
    return False


def handle_cockpit_delete(handler, parsed) -> bool:
    """Dispatch Cockpit v2 DELETE routes. Returns True if handled."""
    if parsed.path == "/api/cockpit/findings":
        from api.cockpit.findings import handle_findings_delete

        return handle_findings_delete(handler, parsed)
    return False
