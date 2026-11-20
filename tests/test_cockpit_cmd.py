"""Tests for Cockpit v2 CMD stream (Tier A process_registry tap + Tier B tool events)."""

from __future__ import annotations

import queue
from types import SimpleNamespace
from urllib.parse import urlparse

from api.cockpit import cmd as cockpit_cmd
from api.cockpit import routes as cockpit_routes


def test_process_registry_tap_chains_previous_sink_and_drops_oldest() -> None:
    prev_calls: list[tuple[str, str]] = []

    class _FakeRegistry:
        def __init__(self) -> None:
            self.on_output = lambda s, c: prev_calls.append((s.session_id, c))

    reg = _FakeRegistry()
    assert cockpit_cmd.install_process_registry_tap(reg) is True
    # Idempotent re-install must not double-wrap
    assert cockpit_cmd.install_process_registry_tap(reg) is True

    q: queue.Queue = queue.Queue(maxsize=2)
    with cockpit_cmd._LOCK:
        cockpit_cmd._SUBSCRIBERS["sess-tap"] = [q]
    try:
        proc = SimpleNamespace(id="proc_1", session_id="sess-tap", session_key="sess-tap")
        reg.on_output(proc, "line1\n")
        reg.on_output(proc, "line2\n")
        reg.on_output(proc, "line3\n")

        # Previous sink received all 3 chunks untouched
        assert len(prev_calls) == 3
        assert [c for _, c in prev_calls] == ["line1\n", "line2\n", "line3\n"]

        # Bounded queue dropped oldest and kept the 2 newest without blocking
        got = [q.get_nowait()["data"], q.get_nowait()["data"]]
        assert got == ["line2\n", "line3\n"]
    finally:
        with cockpit_cmd._LOCK:
            cockpit_cmd._SUBSCRIBERS.pop("sess-tap", None)


def test_mirror_cmd_tool_event_records_start_and_exit() -> None:
    sid = "sess-cmd-b"
    with cockpit_cmd._LOCK:
        cockpit_cmd._HISTORY.pop(sid, None)

    ev_start = cockpit_cmd.mirror_cmd_tool_event(
        sid,
        "call_1",
        "terminal",
        {"command": "whoami", "workdir": "/tmp"},
        is_start=True,
    )
    assert ev_start is not None
    assert ev_start["t"] == "cmd_start"
    assert ev_start["command"] == "whoami"
    assert ev_start["cwd"] == "/tmp"

    ev_exit = cockpit_cmd.mirror_cmd_tool_event(
        sid,
        "call_1",
        "terminal",
        {"command": "whoami"},
        function_result={"exit_code": 0, "output": "root\n"},
        is_start=False,
    )
    assert ev_exit is not None
    assert ev_exit["t"] == "cmd_exit"
    assert ev_exit["code"] == 0
    assert ev_exit["output_bounded"] == "root\n"
    assert ev_exit["duration_ms"] is not None

    with cockpit_cmd._LOCK:
        hist = list(cockpit_cmd._HISTORY.get(sid, ()))
    assert [e["t"] for e in hist] == ["cmd_start", "cmd_exit"]


def test_cmd_stream_requires_session_id() -> None:
    from tests.test_cockpit_shell import _FakeHandler

    h = _FakeHandler()
    assert cockpit_routes.handle_cockpit_get(h, urlparse("/api/cockpit/cmd/stream")) is True
    assert h.status == 400
