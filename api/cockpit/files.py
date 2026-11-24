"""Cockpit v2 workspace file tree, bounded reader, and live SSE watcher.

Supports:
- GET /api/cockpit/files/tree?session_id=<id>
- GET /api/cockpit/files/read?session_id=<id>&path=<rel>
- GET /api/cockpit/files/stream?session_id=<id>
"""

from __future__ import annotations

import difflib
import json
import os
import queue
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs

from api.helpers import bad, j, read_body
from api.sse_chunked import end_sse_headers

MAX_FILE_BYTES = 262_144  # 256 KB
DEBOUNCE_SECONDS = 0.15

# Extensions that must preview in-app instead of downloading when served raw.
_TEXT_LIKE_SUFFIXES = frozenset({
    # mainstream languages
    ".py", ".pyi", ".pyx", ".js", ".mjs", ".cjs", ".mts", ".cts", ".ts", ".tsx", ".jsx",
    ".vue", ".svelte", ".astro", ".go", ".rs", ".java", ".kt", ".kts", ".scala", ".clj",
    ".cljs", ".groovy", ".gradle", ".rb", ".php", ".pl", ".pm", ".lua", ".r", ".jl",
    ".dart", ".ex", ".exs", ".erl", ".hrl", ".fs", ".fsx", ".vb", ".cs", ".swift", ".m",
    ".mm", ".zig", ".nim", ".v", ".sv", ".vhd", ".pas", ".f90", ".asm", ".s", ".ld",
    ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".csproj", ".sln", ".props",
    ".targets", ".sol", ".move", ".cairo", ".tf", ".tfvars", ".hcl", ".nix", ".bzl",
    ".bazel", ".cmake", ".mk", ".mak", ".proto", ".graphql", ".gql",
    # data / config
    ".json", ".jsonl", ".ndjson", ".json5", ".jsonc", ".webmanifest", ".yml", ".yaml",
    ".toml", ".ini", ".cfg", ".conf", ".config", ".properties", ".plist", ".env",
    ".editorconfig", ".npmrc", ".yarnrc", ".prettierrc", ".eslintrc", ".flake8",
    ".pylintrc", ".coveragerc", ".dockerignore", ".gitignore", ".gitattributes",
    ".gitmodules", ".dockerfile", ".lock", ".sum", ".mod", ".workflow", ".service",
    ".socket", ".timer", ".rules", ".desktop", ".htaccess", ".ovpn", ".pem", ".crt",
    ".key", ".pub", ".csr", ".har", ".http", ".rest",
    # docs / markup / shell
    ".md", ".markdown", ".mdx", ".txt", ".rst", ".adoc", ".org", ".tex", ".sty", ".bib",
    ".pod", ".man", ".html", ".htm", ".xml", ".svg", ".css", ".scss", ".sass", ".less",
    ".ejs", ".hbs", ".mustache", ".twig", ".j2", ".jinja", ".jinja2", ".erb", ".haml",
    ".slim", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd", ".sql", ".csv",
    ".tsv", ".patch", ".diff", ".log", ".out", ".err", ".trace",
})
IGNORED_DIRS = frozenset({".git", "node_modules", "__pycache__", ".venv", ".pytest_cache"})

_EXT_LANGUAGE_MAP: dict[str, str] = {
    ".py": "py",
    ".js": "js",
    ".mjs": "js",
    ".cjs": "js",
    ".jsx": "js",
    ".ts": "ts",
    ".tsx": "ts",
    ".json": "json",
    ".sh": "sh",
    ".bash": "sh",
    ".zsh": "sh",
    ".ps1": "sh",
    ".md": "md",
    ".markdown": "md",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".html": "html",
    ".htm": "html",
    ".sql": "sql",
}


def language_for_path(path: str) -> str:
    ext = Path(path).suffix.lower()
    return _EXT_LANGUAGE_MAP.get(ext, "text")


def resolve_session_workspace_root(session_id: str) -> Path:
    """Resolve and canonicalize the trusted workspace root for session_id."""
    if not session_id:
        raise ValueError("session_id is required")

    from api import routes as api_routes

    session = api_routes.get_session(session_id, metadata_only=True)
    raw_ws = getattr(session, "workspace", "") or ""
    profile = getattr(session, "profile", None)
    resolved = api_routes.resolve_trusted_workspace(raw_ws, profile=profile)
    root = Path(os.path.realpath(str(resolved)))
    if not root.is_dir():
        raise FileNotFoundError("Workspace directory does not exist")
    return root


def _is_ignored_rel(rel_parts: tuple[str, ...]) -> bool:
    return any(part in IGNORED_DIRS for part in rel_parts)


def resolve_contained_file(root: Path, rel_path: str) -> Path:
    """Resolve rel_path strictly inside root, rejecting traversal and symlinks outside root."""
    if not rel_path or rel_path.startswith("/") or rel_path.startswith("\\"):
        raise PermissionError("Invalid relative path")
    root_real = Path(os.path.realpath(str(root)))
    candidate = Path(os.path.realpath(str(root_real / rel_path)))
    try:
        rel = candidate.relative_to(root_real)
    except ValueError as exc:
        raise PermissionError("Path escapes workspace root") from exc
    if _is_ignored_rel(rel.parts):
        raise PermissionError("Path is inside an ignored directory")
    return candidate


def _looks_binary(raw: bytes) -> bool:
    """True for files that must not be rendered as text (mojibake in the preview)."""
    if not raw:
        return False
    head = raw[:8192]
    if b"\x00" in head:
        return True
    try:
        head.decode("utf-8")
        return False
    except UnicodeDecodeError:
        pass
    try:
        raw.decode("utf-8")
        return False
    except UnicodeDecodeError:
        return True


def read_bounded_text_ex(file_path: Path) -> tuple[str, bool, bool]:
    """(content, truncated, binary). Binary files yield empty content, never mojibake."""
    raw = file_path.read_bytes()
    binary = _looks_binary(raw)
    truncated = len(raw) > MAX_FILE_BYTES
    if truncated:
        raw = raw[:MAX_FILE_BYTES]
    if binary:
        return "", truncated, True
    return raw.decode("utf-8", errors="replace"), truncated, False


def read_bounded_text(file_path: Path) -> tuple[str, bool]:
    """Read UTF-8 text from file_path capped at MAX_FILE_BYTES (256 KB)."""
    content, truncated, _binary = read_bounded_text_ex(file_path)
    return content, truncated


def compute_inserted_lines(previous: str, current: str) -> list[list[int]]:
    """Return 1-indexed [startLine, endLine] ranges of newly inserted/replaced lines."""
    prev_lines = previous.splitlines()
    curr_lines = current.splitlines()
    if not curr_lines:
        return []
    matcher = difflib.SequenceMatcher(None, prev_lines, curr_lines)
    ranges: list[list[int]] = []
    for tag, _i1, _i2, j1, j2 in matcher.get_opcodes():
        if tag in ("insert", "replace") and j2 > j1:
            ranges.append([j1 + 1, j2])
    return ranges


def build_file_tree(root: Path, max_entries: int = 800) -> list[dict]:
    """Build a bounded, sorted directory tree rooted at `root`."""
    root_real = Path(os.path.realpath(str(root)))
    count = 0

    def walk(current: Path) -> list[dict]:
        nonlocal count
        nodes: list[dict] = []
        try:
            entries = sorted(
                current.iterdir(),
                key=lambda p: (not p.is_dir(), p.name.lower()),
            )
        except OSError:
            return nodes

        for entry in entries:
            if count >= max_entries:
                break
            if entry.name in IGNORED_DIRS:
                continue
            try:
                real_entry = Path(os.path.realpath(str(entry)))
                rel = real_entry.relative_to(root_real)
            except (OSError, ValueError):
                continue
            if _is_ignored_rel(rel.parts):
                continue

            count += 1
            rel_posix = rel.as_posix()
            if real_entry.is_dir():
                nodes.append(
                    {
                        "name": entry.name,
                        "path": rel_posix,
                        "type": "dir",
                        "children": walk(real_entry),
                    }
                )
            elif real_entry.is_file():
                try:
                    size = real_entry.stat().st_size
                except OSError:
                    size = 0
                nodes.append(
                    {
                        "name": entry.name,
                        "path": rel_posix,
                        "type": "file",
                        "size": size,
                        "language": language_for_path(rel_posix),
                    }
                )
        return nodes

    return walk(root_real)


def build_file_delta_event(
    root: Path,
    rel_posix: str,
    event_kind: str,
    cache: dict[str, str],
) -> dict | None:
    """Build a FileDeltaEvent payload for a created/modified/deleted workspace file."""
    if event_kind == "deleted":
        prev = cache.pop(rel_posix, "")
        return {
            "type": "file_delta",
            "path": rel_posix,
            "event": "deleted",
            "language": language_for_path(rel_posix),
            "previous_content": prev,
            "current_content": "",
            "inserted_lines": [],
            "truncated": False,
            "timestamp": time.time(),
        }

    try:
        target = resolve_contained_file(root, rel_posix)
    except PermissionError:
        return None
    if not target.is_file():
        return None

    try:
        current, truncated = read_bounded_text(target)
    except OSError:
        return None

    previous = cache.get(rel_posix, "")
    if previous == current and rel_posix in cache:
        return None

    kind = "modified" if rel_posix in cache else "created"
    cache[rel_posix] = current
    return {
        "type": "file_delta",
        "path": rel_posix,
        "event": kind,
        "language": language_for_path(rel_posix),
        "previous_content": previous,
        "current_content": current,
        "inserted_lines": compute_inserted_lines(previous, current),
        "truncated": truncated,
        "timestamp": time.time(),
    }


def _snapshot_mtimes(root: Path, max_files: int = 1500) -> dict[str, tuple[int, int]]:
    """Lightweight mtime_ns/size snapshot used when watchdog is unavailable."""
    out: dict[str, tuple[int, int]] = {}
    root_str = str(root)
    stack = [root_str]
    while stack and len(out) < max_files:
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                for entry in it:
                    if entry.name in IGNORED_DIRS:
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            st = entry.stat(follow_symlinks=False)
                            rel = Path(entry.path).relative_to(root).as_posix()
                            out[rel] = (st.st_mtime_ns, st.st_size)
                    except (OSError, ValueError):
                        continue
        except OSError:
            continue
    return out


class _WorkspaceWatcher:
    """Watches a workspace root via watchdog (MODIFIED + MOVED_TO) or polling fallback."""

    def __init__(self, root: Path, out_queue: "queue.Queue[tuple[str, str]]") -> None:
        self.root = root
        self.out_queue = out_queue
        self._stop = threading.Event()
        self._observer = None
        self._thread: threading.Thread | None = None
        self._debounce_lock = threading.Lock()
        self._pending: dict[str, tuple[str, float]] = {}

    def start(self) -> None:
        try:
            from watchdog.events import FileSystemEventHandler
            from watchdog.observers import Observer

            root_real = self.root
            watcher = self

            class _Handler(FileSystemEventHandler):
                def _enqueue(self, abs_path: str, kind: str) -> None:
                    try:
                        real = Path(os.path.realpath(abs_path))
                        rel = real.relative_to(root_real)
                    except (OSError, ValueError):
                        return
                    if _is_ignored_rel(rel.parts):
                        return
                    rel_posix = rel.as_posix()
                    with watcher._debounce_lock:
                        watcher._pending[rel_posix] = (kind, time.monotonic())

                def on_modified(self, event) -> None:
                    if not event.is_directory:
                        self._enqueue(event.src_path, "modified")

                def on_created(self, event) -> None:
                    if not event.is_directory:
                        self._enqueue(event.src_path, "created")

                def on_moved(self, event) -> None:
                    if not event.is_directory:
                        self._enqueue(event.dest_path, "modified")

                def on_deleted(self, event) -> None:
                    if not event.is_directory:
                        self._enqueue(event.src_path, "deleted")

            observer = Observer()
            observer.schedule(_Handler(), str(self.root), recursive=True)
            observer.start()
            self._observer = observer
            self._thread = threading.Thread(target=self._flush_loop, daemon=True)
            self._thread.start()
        except ImportError:
            self._thread = threading.Thread(target=self._poll_loop, daemon=True)
            self._thread.start()

    def _flush_loop(self) -> None:
        while not self._stop.wait(0.05):
            now = time.monotonic()
            ready: list[tuple[str, str]] = []
            with self._debounce_lock:
                for rel_posix, (kind, ts) in list(self._pending.items()):
                    if now - ts >= DEBOUNCE_SECONDS:
                        ready.append((rel_posix, kind))
                        del self._pending[rel_posix]
            for item in ready:
                self.out_queue.put(item)

    def _poll_loop(self) -> None:
        prev = _snapshot_mtimes(self.root)
        while not self._stop.wait(0.35):
            curr = _snapshot_mtimes(self.root)
            for rel, sig in curr.items():
                if rel not in prev:
                    self.out_queue.put((rel, "created"))
                elif prev[rel] != sig:
                    self.out_queue.put((rel, "modified"))
            for rel in prev:
                if rel not in curr:
                    self.out_queue.put((rel, "deleted"))
            prev = curr

    def stop(self) -> None:
        self._stop.set()
        if self._observer is not None:
            try:
                self._observer.stop()
                self._observer.join(timeout=2)
            except Exception:
                pass
        if self._thread is not None:
            self._thread.join(timeout=2)


def handle_files_tree(handler, parsed) -> bool:
    qs = parse_qs(parsed.query)
    sid = qs.get("session_id", [""])[0]
    try:
        root = resolve_session_workspace_root(sid)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    except (KeyError, FileNotFoundError) as exc:
        bad(handler, str(exc), 404)
        return True
    tree = build_file_tree(root)
    j(handler, {"root": str(root), "tree": tree})
    return True


def handle_files_read(handler, parsed) -> bool:
    qs = parse_qs(parsed.query)
    sid = qs.get("session_id", [""])[0]
    rel_path = qs.get("path", [""])[0]
    try:
        root = resolve_session_workspace_root(sid)
        target = resolve_contained_file(root, rel_path)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    except PermissionError as exc:
        bad(handler, str(exc), 403)
        return True
    except (KeyError, FileNotFoundError) as exc:
        bad(handler, str(exc), 404)
        return True

    if not target.is_file():
        bad(handler, "File not found", 404)
        return True

    content, truncated, binary = read_bounded_text_ex(target)
    rel_posix = target.relative_to(root).as_posix()
    j(
        handler,
        {
            "path": rel_posix,
            "language": language_for_path(rel_posix),
            "content": content,
            "truncated": truncated,
            "binary": binary,
            "size": target.stat().st_size,
        },
    )
    return True


def handle_files_stream(handler, parsed) -> bool:
    qs = parse_qs(parsed.query)
    sid = qs.get("session_id", [""])[0]
    try:
        root = resolve_session_workspace_root(sid)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    except (KeyError, FileNotFoundError) as exc:
        bad(handler, str(exc), 404)
        return True

    from api.routes import _SSE_HEARTBEAT_INTERVAL_SECONDS
    from api.streaming import (
        _sse,
        _sse_set_write_deadline,
        _sse_write,
    )

    events_q: queue.Queue[tuple[str, str]] = queue.Queue()
    watcher = _WorkspaceWatcher(root, events_q)
    cache: dict[str, str] = {}
    watcher.start()

    try:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("X-Accel-Buffering", "no")
        handler.send_header("Connection", "close")
        end_sse_headers(handler)
        _sse_set_write_deadline(handler)
        _sse_write(handler, b": cockpit files stream ready\n\n")

        while True:
            try:
                rel_posix, kind = events_q.get(timeout=_SSE_HEARTBEAT_INTERVAL_SECONDS)
            except queue.Empty:
                _sse_write(handler, b": keepalive\n\n")
                continue

            delta = build_file_delta_event(root, rel_posix, kind, cache)
            if delta is not None:
                _sse(handler, "file_delta", delta)
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
        pass
    finally:
        watcher.stop()
    return True


def handle_fs_list(handler, parsed) -> bool:
    """List a directory on the host filesystem (for parent navigation outside workspace)."""
    qs = parse_qs(parsed.query)
    sid = qs.get("session_id", [""])[0]
    raw_dir = (qs.get("dir") or [""])[0].strip()
    if not raw_dir:
        try:
            target = resolve_session_workspace_root(sid)
        except ValueError as exc:
            bad(handler, str(exc), 400)
            return True
        except (KeyError, FileNotFoundError) as exc:
            bad(handler, str(exc), 404)
            return True
    else:
        try:
            target = Path(os.path.realpath(raw_dir))
        except OSError as exc:
            bad(handler, str(exc), 400)
            return True

    if not target.is_dir():
        bad(handler, "Directory not found", 404)
        return True

    entries = []
    try:
        with os.scandir(target) as it:
            for entry in it:
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    st = entry.stat(follow_symlinks=False) if not is_dir else None
                    entries.append(
                        {
                            "name": entry.name,
                            "path": str(Path(entry.path)),
                            "type": "dir" if is_dir else "file",
                            "size": int(st.st_size) if st else 0,
                        }
                    )
                except OSError:
                    continue
                if len(entries) >= 1000:
                    break
    except OSError as exc:
        bad(handler, f"Cannot list directory: {exc}", 403)
        return True

    entries.sort(key=lambda item: (0 if item["type"] == "dir" else 1, item["name"].lower()))
    parent = str(target.parent) if target.parent != target else None
    j(
        handler,
        {
            "path": str(target),
            "parent": parent,
            "entries": entries,
        },
    )
    return True


def handle_fs_read(handler, parsed) -> bool:
    """Read a bounded text file outside the workspace for read-only preview."""
    qs = parse_qs(parsed.query)
    raw_path = (qs.get("path") or [""])[0].strip()
    if not raw_path:
        bad(handler, "path is required", 400)
        return True
    try:
        target = Path(os.path.realpath(raw_path))
    except OSError as exc:
        bad(handler, str(exc), 400)
        return True

    if not target.is_file():
        bad(handler, "File not found", 404)
        return True

    content, truncated, binary = read_bounded_text_ex(target)
    j(
        handler,
        {
            "path": str(target),
            "name": target.name,
            "language": language_for_path(target.name),
            "content": content,
            "truncated": truncated,
            "binary": binary,
            "size": target.stat().st_size,
        },
    )
    return True


def handle_fs_raw(handler, parsed) -> bool:
    """Stream a raw file (PDF, image, media, HTML) in 64 KB chunks with HTTP Range support."""
    import mimetypes
    import re
    from urllib.parse import quote

    qs = parse_qs(parsed.query)
    raw_path = (qs.get("path") or [""])[0].strip()
    download = (qs.get("download") or ["0"])[0] == "1"
    inline = (qs.get("inline") or ["0"])[0] == "1"
    if not raw_path:
        bad(handler, "path is required", 400)
        return True
    try:
        target = Path(os.path.realpath(raw_path))
    except OSError as exc:
        bad(handler, str(exc), 400)
        return True

    if not target.is_file():
        bad(handler, "File not found", 404)
        return True

    mime, _ = mimetypes.guess_type(target.name)
    if not mime:
        mime = "application/octet-stream"
    # Source/config files must render in the preview, not download. Browsers treat
    # text/x-python, application/json, etc. as downloads when navigated to directly,
    # so serve them as plain text and skip the filename disposition.
    suffix = target.suffix.lower()
    html_inline = inline and not download and suffix in {".html", ".htm", ".xhtml"}
    svg_inline = inline and not download and suffix == ".svg"
    text_like = (suffix in _TEXT_LIKE_SUFFIXES or mime.startswith("text/")) and not html_inline and not svg_inline
    if html_inline:
        mime = "text/html; charset=utf-8"
    elif svg_inline:
        mime = "image/svg+xml"
    elif text_like:
        mime = "text/plain; charset=utf-8"
    try:
        size = target.stat().st_size
        range_hdr = (handler.headers.get("Range") or "").strip() if hasattr(handler, "headers") else ""
        start = 0
        end = size - 1
        partial = False
        if range_hdr and size > 0:
            m = re.match(r"^bytes=(\d*)-(\d*)$", range_hdr)
            if m:
                s_str, e_str = m.group(1), m.group(2)
                if s_str == "" and e_str != "":
                    suffix = int(e_str)
                    start = max(0, size - suffix)
                    end = size - 1
                    partial = True
                elif s_str != "":
                    start = int(s_str)
                    end = int(e_str) if e_str != "" else size - 1
                    partial = True
                if partial and (start < 0 or start >= size or end < start):
                    handler.send_response(416)
                    handler.send_header("Content-Range", f"bytes */{size}")
                    handler.send_header("Content-Length", "0")
                    handler.end_headers()
                    return True
                end = min(end, size - 1)

        length = (end - start + 1) if size > 0 else 0
        with target.open("rb") as fh:
            if partial:
                fh.seek(start)
            handler.send_response(206 if partial else 200)
            handler.send_header("Content-Type", mime)
            handler.send_header("Accept-Ranges", "bytes")
            if partial:
                handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            handler.send_header("Content-Length", str(length))
            disp = "attachment" if download else "inline"
            if text_like and not download:
                # No filename parameter: some browsers treat `inline; filename=...` on a
                # non-renderable MIME as a download prompt.
                handler.send_header("Content-Disposition", "inline")
            else:
                ascii_name = target.name.encode("ascii", "replace").decode("ascii").replace('"', "_")
                utf8_name = quote(target.name, safe="")
                handler.send_header(
                    "Content-Disposition",
                    f'{disp}; filename="{ascii_name}"; filename*=UTF-8\'\'{utf8_name}',
                )
            handler.send_header("Cache-Control", "no-store")
            if html_inline or svg_inline:
                handler.send_header(
                    "Content-Security-Policy",
                    "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
                )
                handler.send_header("X-Content-Type-Options", "nosniff")
            handler.end_headers()
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(65536, remaining))
                if not chunk:
                    break
                handler.wfile.write(chunk)
                remaining -= len(chunk)
    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
        pass
    except OSError as exc:
        bad(handler, f"Cannot read file: {exc}", 403)
    return True


def handle_fs_save(handler) -> bool:
    """Save edited UTF-8 text content to a file opened via /api/cockpit/fs/read."""
    try:
        body = read_body(handler)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    sid = str((body or {}).get("session_id") or "").strip()
    raw_path = str((body or {}).get("path") or "").strip()
    if not sid or not raw_path:
        bad(handler, "session_id and path are required", 400)
        return True
    try:
        resolve_session_workspace_root(sid)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    except (KeyError, FileNotFoundError) as exc:
        bad(handler, str(exc), 404)
        return True

    try:
        raw_p = Path(raw_path)
        if raw_p.is_symlink():
            bad(handler, "Cannot save to a symlinked entry", 403)
            return True
        target = Path(os.path.realpath(raw_path))
        if not target.exists():
            bad(handler, "File not found", 404)
            return True
        if not target.is_file():
            bad(handler, "Cannot save: path is not a file", 400)
            return True
        data = str((body or {}).get("content", "")).encode("utf-8")
        target.write_bytes(data)
        j(handler, {"ok": True, "path": str(target), "size": len(data)})
    except OSError as exc:
        bad(handler, f"Cannot save file: {exc}", 403)
    return True
