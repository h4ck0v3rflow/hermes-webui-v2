"""Tests for Phase 2 Cockpit workspace file tree, reader, and file_delta logic."""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
from urllib.parse import urlparse

import pytest

from api.cockpit import files as cockpit_files
from api.cockpit import routes as cockpit_routes


class _FakeHandler:
    def __init__(self) -> None:
        self.headers: dict[str, str] = {}
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


@pytest.fixture
def workspace_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "exploits").mkdir()
    (ws / "exploits" / "poc.py").write_text("import requests\nprint(1)\n", encoding="utf-8")
    (ws / ".git").mkdir()
    (ws / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")
    (ws / "node_modules").mkdir()
    (ws / "node_modules" / "x.js").write_text("module.exports = 1;\n", encoding="utf-8")

    monkeypatch.setattr(cockpit_files, "resolve_session_workspace_root", lambda sid: ws)
    return ws


def test_files_tree_excludes_ignored_dirs(workspace_root: Path) -> None:
    handler = _FakeHandler()
    handled = cockpit_routes.handle_cockpit_get(
        handler, urlparse("/api/cockpit/files/tree?session_id=s1")
    )
    assert handled is True
    assert handler.status == 200
    payload = json.loads(handler.wfile.getvalue().decode("utf-8"))
    names = {node["name"] for node in payload["tree"]}
    assert "exploits" in names
    assert ".git" not in names
    assert "node_modules" not in names


@pytest.mark.parametrize(
    "bad_path",
    [
        "../outside.txt",
        "/etc/passwd",
        ".git/HEAD",
        "node_modules/x.js",
    ],
)
def test_files_read_rejects_traversal_and_ignored(
    workspace_root: Path, bad_path: str
) -> None:
    handler = _FakeHandler()
    cockpit_routes.handle_cockpit_get(
        handler, urlparse(f"/api/cockpit/files/read?session_id=s1&path={bad_path}")
    )
    assert handler.status == 403


def test_files_read_caps_at_256kb(workspace_root: Path) -> None:
    big = workspace_root / "wordlist.txt"
    big.write_bytes(b"A" * (cockpit_files.MAX_FILE_BYTES + 1024))

    handler = _FakeHandler()
    cockpit_routes.handle_cockpit_get(
        handler, urlparse("/api/cockpit/files/read?session_id=s1&path=wordlist.txt")
    )
    assert handler.status == 200
    payload = json.loads(handler.wfile.getvalue().decode("utf-8"))
    assert payload["truncated"] is True
    assert len(payload["content"].encode("utf-8")) == cockpit_files.MAX_FILE_BYTES


def test_file_delta_tracks_atomic_replace_inserted_lines(workspace_root: Path) -> None:
    cache: dict[str, str] = {}
    target = workspace_root / "exploits" / "poc.py"

    first = cockpit_files.build_file_delta_event(
        workspace_root, "exploits/poc.py", "created", cache
    )
    assert first is not None
    assert first["event"] == "created"
    assert first["language"] == "py"
    assert first["inserted_lines"] == [[1, 2]]

    # Simulate atomic temp-file + os.replace() (EC-02)
    tmp = workspace_root / "exploits" / ".poc.py.tmp"
    tmp.write_text("import requests\nprint(1)\nprint(2)\nprint(3)\n", encoding="utf-8")
    os.replace(tmp, target)

    second = cockpit_files.build_file_delta_event(
        workspace_root, "exploits/poc.py", "modified", cache
    )
    assert second is not None
    assert second["event"] == "modified"
    assert second["inserted_lines"] == [[3, 4]]


def test_fs_list_and_read_allows_parent_navigation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import json
    from urllib.parse import urlparse
    from tests.test_cockpit_shell import _FakeHandler

    parent_dir = tmp_path
    ws_dir = parent_dir / "ws"
    ws_dir.mkdir()
    outside_file = parent_dir / "outside.txt"
    outside_file.write_text("hello outside", encoding="utf-8")

    monkeypatch.setattr(cockpit_files, "resolve_session_workspace_root", lambda sid: ws_dir)

    h1 = _FakeHandler()
    assert cockpit_files.handle_fs_list(h1, urlparse("/api/cockpit/fs/list?session_id=s1")) is True
    assert h1.status == 200
    data1 = json.loads(h1.wfile.getvalue().decode("utf-8"))
    assert Path(data1["parent"]) == parent_dir

    h2 = _FakeHandler()
    assert cockpit_files.handle_fs_list(
        h2, urlparse(f"/api/cockpit/fs/list?session_id=s1&dir={parent_dir}")
    ) is True
    assert h2.status == 200
    data2 = json.loads(h2.wfile.getvalue().decode("utf-8"))
    names = [e["name"] for e in data2["entries"]]
    assert "outside.txt" in names
    assert "ws" in names

    h3 = _FakeHandler()
    assert cockpit_files.handle_fs_read(
        h3, urlparse(f"/api/cockpit/fs/read?session_id=s1&path={outside_file}")
    ) is True
    assert h3.status == 200
    data3 = json.loads(h3.wfile.getvalue().decode("utf-8"))
    assert data3["content"] == "hello outside"

    pdf_file = parent_dir / "sample.pdf"
    pdf_file.write_bytes(b"%PDF-1.4\n%test\n")
    h4 = _FakeHandler()
    assert cockpit_files.handle_fs_raw(
        h4, urlparse(f"/api/cockpit/fs/raw?session_id=s1&path={pdf_file}")
    ) is True
    assert h4.status == 200
    assert h4.sent_headers.get("Content-Type") == "application/pdf"
    assert h4.sent_headers.get("Accept-Ranges") == "bytes"
    assert "inline" in h4.sent_headers.get("Content-Disposition", "")
    assert h4.wfile.getvalue().startswith(b"%PDF-1.4")

    h5 = _FakeHandler(headers={"Range": "bytes=0-3"})
    assert cockpit_files.handle_fs_raw(
        h5, urlparse(f"/api/cockpit/fs/raw?session_id=s1&path={pdf_file}")
    ) is True
    assert h5.status == 206
    _pdf_len = len(b"%PDF-1.4\n%test\n")  # PEP 701 backslash-in-f-string is 3.12+; test.sh supports 3.11
    assert h5.sent_headers.get("Content-Range") == f"bytes 0-3/{_pdf_len}"
    assert h5.wfile.getvalue() == b"%PDF"

    unicode_file = parent_dir / "video ｜ 🐦 test.mp4"
    unicode_file.write_bytes(b"0123456789")
    h6 = _FakeHandler(headers={"Range": "bytes=0-3"})
    assert cockpit_files.handle_fs_raw(
        h6, urlparse(f"/api/cockpit/fs/raw?session_id=s1&path={unicode_file}")
    ) is True
    assert h6.status == 206
    h6.sent_headers["Content-Disposition"].encode("latin-1")
    assert "filename*=UTF-8''" in h6.sent_headers["Content-Disposition"]


def test_fs_raw_inline_html_and_fs_save(tmp_path: Path, monkeypatch):
    ws = tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setattr(cockpit_files, "resolve_session_workspace_root", lambda sid: ws)

    html_file = tmp_path / "page.html"
    html_file.write_text("<h1>Hello</h1>", encoding="utf-8")

    h1 = _FakeHandler()
    assert cockpit_files.handle_fs_raw(
        h1, urlparse(f"/api/cockpit/fs/raw?session_id=s1&path={html_file}&inline=1")
    ) is True
    assert h1.status == 200
    assert h1.sent_headers.get("Content-Type") == "text/html; charset=utf-8"
    assert "sandbox" in h1.sent_headers.get("Content-Security-Policy", "")
    assert h1.wfile.getvalue() == b"<h1>Hello</h1>"

    monkeypatch.setattr(
        cockpit_files,
        "read_body",
        lambda _handler: {
            "session_id": "s1",
            "path": str(html_file),
            "content": "<h1>Updated</h1>",
        },
    )
    h2 = _FakeHandler()
    assert cockpit_files.handle_fs_save(h2) is True
    assert h2.status == 200
    saved_resp = json.loads(h2.wfile.getvalue().decode("utf-8"))
    assert saved_resp["ok"] is True
    assert html_file.read_text(encoding="utf-8") == "<h1>Updated</h1>"

    monkeypatch.setattr(
        cockpit_files,
        "read_body",
        lambda _handler: {
            "session_id": "s1",
            "path": str(tmp_path / "missing.html"),
            "content": "nope",
        },
    )
    h3 = _FakeHandler()
    assert cockpit_files.handle_fs_save(h3) is True
    assert h3.status == 404
