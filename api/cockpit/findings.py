"""Cockpit v2 findings persistence (~/.hermes/hunts/<program>/findings/*.md)."""

from __future__ import annotations

import os
import re
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs

from api.helpers import bad, j, read_body

_SAFE_SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_VALID_SEVERITIES = frozenset({"critical", "high", "medium", "low", "info"})
_VALID_STATUSES = frozenset({"draft", "verified", "submitted"})


def _hunts_root() -> Path:
    hermes_home = os.environ.get("HERMES_HOME", "").strip()
    base = Path(hermes_home).expanduser() if hermes_home else Path.home() / ".hermes"
    return (base / "hunts").resolve()


def _sanitize_slug(value: str, fallback: str = "") -> str:
    cleaned = (value or "").strip() or fallback
    if not _SAFE_SLUG_RE.match(cleaned):
        raise ValueError(f"Invalid identifier: {value!r}")
    return cleaned


def _findings_dir(program: str) -> Path:
    prog = _sanitize_slug(program, "default")
    root = _hunts_root()
    target = (root / prog / "findings").resolve()
    target.relative_to(root)
    return target


def _serialize_finding_md(finding: dict) -> str:
    lines = [
        "---",
        f"id: {finding['id']}",
        f"program: {finding['program']}",
        f"title: {json_scalar(finding['title'])}",
        f"severity: {finding['severity']}",
        f"status: {finding['status']}",
        f"target_url: {json_scalar(finding.get('target_url', ''))}",
        f"parameter: {json_scalar(finding.get('parameter', ''))}",
        f"cwe: {json_scalar(finding.get('cwe', ''))}",
        f"poc_path: {json_scalar(finding.get('poc_path', ''))}",
        f"updated_at: {finding['updated_at']}",
        "---",
        "",
        "## Steps to Reproduce",
        finding.get("steps_to_reproduce", "").strip(),
        "",
        "## Impact",
        finding.get("impact", "").strip(),
        "",
    ]
    return "\n".join(lines)


def json_scalar(val: str) -> str:
    import json

    return json.dumps(str(val or ""), ensure_ascii=False)


def _parse_finding_md(path: Path, default_program: str) -> dict:
    import json

    raw = path.read_text(encoding="utf-8", errors="replace")
    meta: dict[str, str] = {}
    body = raw
    if raw.startswith("---\n") or raw.startswith("---\r\n"):
        parts = re.split(r"\r?\n---\r?\n", raw[4:], maxsplit=1)
        if len(parts) == 2:
            fm, body = parts
            for line in fm.splitlines():
                if ":" not in line:
                    continue
                k, v = line.split(":", 1)
                k = k.strip()
                v = v.strip()
                if v.startswith('"') and v.endswith('"'):
                    try:
                        v = json.loads(v)
                    except Exception:
                        v = v[1:-1]
                meta[k] = v

    steps = ""
    impact = ""
    sec_split = re.split(r"(?m)^##\s+", body)
    for sec in sec_split:
        lower = sec.lower()
        if lower.startswith("steps to reproduce"):
            steps = "\n".join(sec.splitlines()[1:]).strip()
        elif lower.startswith("impact"):
            impact = "\n".join(sec.splitlines()[1:]).strip()

    severity = meta.get("severity", "medium").lower()
    if severity not in _VALID_SEVERITIES:
        severity = "medium"
    status = meta.get("status", "draft").lower()
    if status not in _VALID_STATUSES:
        status = "draft"

    return {
        "id": meta.get("id") or path.stem,
        "program": meta.get("program") or default_program,
        "title": meta.get("title") or path.stem,
        "severity": severity,
        "status": status,
        "target_url": meta.get("target_url", ""),
        "parameter": meta.get("parameter", ""),
        "cwe": meta.get("cwe", ""),
        "poc_path": meta.get("poc_path", ""),
        "steps_to_reproduce": steps,
        "impact": impact,
        "updated_at": meta.get("updated_at") or "",
    }


def list_findings(program: str) -> list[dict]:
    fdir = _findings_dir(program)
    if not fdir.is_dir():
        return []
    prog = _sanitize_slug(program, "default")
    items = []
    for p in sorted(fdir.glob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            items.append(_parse_finding_md(p, prog))
        except OSError:
            continue
    return items


def save_finding(payload: dict) -> dict:
    prog = _sanitize_slug(str(payload.get("program") or ""), "default")
    raw_id = str(payload.get("id") or "").strip()
    fid = _sanitize_slug(raw_id, f"f-{uuid.uuid4().hex[:8]}") if raw_id else f"f-{uuid.uuid4().hex[:8]}"

    title = str(payload.get("title") or "").strip()
    if not title:
        raise ValueError("title is required")

    severity = str(payload.get("severity") or "medium").strip().lower()
    if severity not in _VALID_SEVERITIES:
        raise ValueError(f"invalid severity: {severity}")

    status = str(payload.get("status") or "draft").strip().lower()
    if status not in _VALID_STATUSES:
        raise ValueError(f"invalid status: {status}")

    finding = {
        "id": fid,
        "program": prog,
        "title": title,
        "severity": severity,
        "status": status,
        "target_url": str(payload.get("target_url") or "").strip(),
        "parameter": str(payload.get("parameter") or "").strip(),
        "cwe": str(payload.get("cwe") or "").strip(),
        "poc_path": str(payload.get("poc_path") or "").strip(),
        "steps_to_reproduce": str(payload.get("steps_to_reproduce") or ""),
        "impact": str(payload.get("impact") or ""),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    fdir = _findings_dir(prog)
    fdir.mkdir(parents=True, exist_ok=True)
    target = (fdir / f"{fid}.md").resolve()
    target.relative_to(fdir)
    target.write_text(_serialize_finding_md(finding), encoding="utf-8")
    return finding


def delete_finding(program: str, finding_id: str) -> bool:
    fdir = _findings_dir(program)
    fid = _sanitize_slug(finding_id)
    target = (fdir / f"{fid}.md").resolve()
    target.relative_to(fdir)
    if not target.is_file():
        return False
    target.unlink()
    return True


def handle_findings_get(handler, parsed) -> bool:
    qs = parse_qs(parsed.query)
    program = qs.get("program", ["default"])[0]
    try:
        items = list_findings(program)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    j(handler, {"program": program or "default", "findings": items})
    return True


def handle_findings_post(handler, body: dict | None = None) -> bool:
    if body is None:
        try:
            body = read_body(handler)
        except ValueError as exc:
            bad(handler, str(exc), 400)
            return True
    if not isinstance(body, dict):
        bad(handler, "JSON object required", 400)
        return True
    try:
        finding = save_finding(body)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    j(handler, {"ok": True, "finding": finding})
    return True


def handle_findings_delete(handler, parsed) -> bool:
    qs = parse_qs(parsed.query)
    program = qs.get("program", ["default"])[0]
    fid = qs.get("id", [""])[0]
    if not fid:
        bad(handler, "id is required", 400)
        return True
    try:
        deleted = delete_finding(program, fid)
    except ValueError as exc:
        bad(handler, str(exc), 400)
        return True
    if not deleted:
        bad(handler, "Finding not found", 404)
        return True
    j(handler, {"ok": True, "id": fid})
    return True
