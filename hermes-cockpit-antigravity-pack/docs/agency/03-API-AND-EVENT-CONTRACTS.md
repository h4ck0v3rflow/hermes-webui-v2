# Document 03: Interface Control Document (API, SSE & WS Contracts)

**Version:** 1.0  
**Base URL:** `http://127.0.0.1:8787` (proxied via Vite `/api` in dev)

---

## 1. Global Shell & Authentication Contract

### 1.1. HTML Template Injection (`GET /v2`, `GET /v2/`)
`serve_cockpit_shell` in `api/cockpit/routes.py` MUST read `static/v2/index.html` and inject the exact runtime configuration object used by the legacy shell:

```html
<script>
  window.__HERMES_CONFIG__ = {
    csrfToken: "{{CSRF_TOKEN}}",
    maxUploadBytes: {{MAX_UPLOAD_BYTES}},
    imgSrcExtra: "{{IMG_SRC_EXTRA}}"
  };
</script>
```

- **Mandatory HTTP Header on All Mutating Requests (`POST`, `PUT`, `DELETE`):** `X-CSRF-Token: <window.__HERMES_CONFIG__.csrfToken>` (failure to attach results in `403 Forbidden`).
- **Framing Requirement:** Every response MUST include `Content-Length` (for buffered payloads) or `Transfer-Encoding: chunked` / SSE headers (for streams) so HTTP/1.1 keep-alive connections do not stall until `Handler.timeout = 30`.

---

## 2. Reused Upstream Endpoints (Zero Backend Changes)

| Subsystem | Method & Path | Purpose |
| :--- | :--- | :--- |
| **Sessions** | `GET /api/sessions`, `POST /api/sessions`, `DELETE /api/sessions/<id>` | List, create, switch, and delete sessions |
| **Chat & Control** | `POST /api/chat`, `POST /api/chat/steer`, `POST /api/chat/queue`, `POST /api/chat/interrupt` | Send messages and mid-run trajectory overrides |
| **Terminal (PTY)** | `POST /api/terminal/start`, `GET /api/terminal/output?id=&seq=`, `POST /api/terminal/input`, `POST /api/terminal/resize`, `POST /api/terminal/close` | Full bidirectional PTY with 2,000-chunk backlog |
| **Approvals** | `GET /api/approval/pending`, `POST /api/approval/respond` | Resolve tool approvals (`once`, `session`, `always`, `deny`) |
| **Memory & Skills** | `GET/POST /api/memory`, `GET/POST /api/skills`, `GET/POST /api/cron` | Native Hermes memory, skills browser, and cron jobs |
| **Profiles & Models** | `GET /api/models`, `GET/POST /api/profiles` | Model selector and isolated target profile switcher |
| **System Health** | `GET /api/system/health` | Live Ubuntu VPS CPU, RAM, load average, and disk usage |

### 2.1. Approval & Clarify Payload Contracts

```typescript
// POST /api/approval/respond
export interface ApprovalRespondRequest {
  approval_id: string; // MUST fallback to `event.run_id` if `event.approval_id` is empty
  session_id: string;
  decision: "once" | "session" | "always" | "deny";
}

// SSE Event: clarify.request
export interface ClarifyPromptEvent {
  clarify_id: string; // Primary key for Zustand deduplication & dismissal
  session_id: string;
  question: string;
  choices: string[];
  allow_custom: boolean;
}
```

---

## 3. New Cockpit Endpoints (`api/cockpit/routes.py`)

### 3.1. Live File Watcher Stream (`GET /api/cockpit/files/stream?session_id=<id>`)
- **Transport:** Server-Sent Events (`text/event-stream`), utilizing `_sse_set_write_deadline` from `api/streaming.py` every 15 seconds to survive `Handler.timeout = 30`.
- **Filesystem Driver:** `watchdog` observing workspace root (`MODIFIED` + `MOVED_TO` for atomic temp-file renames), debounced at 150ms, ignoring `.git/`, `node_modules/`, and blocked workspace roots.
- **Payload Cap:** Diff/content truncated at `262,144 bytes` (256 KB) with `truncated: true`.

```typescript
export interface FileDeltaEvent {
  type: "file_delta";
  path: string;           // Relative workspace path, e.g., "exploits/idor_poc.py"
  event: "created" | "modified" | "deleted";
  language: string;       // Derived extension hint
  previous_content: string;
  current_content: string;
  inserted_lines: [number, number][]; // [startLine, endLine] 1-indexed ranges for highlight animation
  truncated: boolean;
  timestamp: number;
}
```

### 3.2. HuntProxy Traffic Proxy (`GET /api/cockpit/traffic?project_id=<id>&limit=100&offset=0`)
- **Behavior:** Server-side HTTP proxy to local HuntProxy (`GET /api/v1/projects/<id>/history`) so the frontend avoids CORS and CSP violations.
- **Response (`200 OK`):** JSON array of HTTP exchanges keyed by `exchange_id` (`method`, `host`, `path`, `status_code`, `duration_ms`, `request_headers`, `response_headers`, `body_preview`).

### 3.3. Findings Persistence (`GET/POST/PUT/DELETE /api/cockpit/findings`)
- **Storage:** Filesystem-native Markdown + YAML frontmatter at `~/.hermes/hunts/<program>/findings/<finding_id>.md`.
- **Schema:**

```typescript
export interface HuntFinding {
  id: string;
  program: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  status: "draft" | "verified" | "submitted";
  target_url: string;
  parameter?: string;
  cwe?: string;
  poc_path?: string;
  steps_to_reproduce: string;
  impact: string;
  updated_at: string;
}
```

### 3.4. Protected Process Kill Switch (`POST /api/cockpit/kill`)
- **Request:** `{ "pid": number, "pgid"?: number, "reason": string }`
- **Security Validation:** Verifies target PID/PGID belongs to `api/background_process.py` registry AND is NOT in `PROTECTED_PROCS` (`sshd`, `hermes`, `python3 server.py`, `systemd`, `tailscaled`). Sends `os.killpg(pgid, signal.SIGKILL)`.

### 3.5. Browser VNC & Lease Endpoint (`WS /api/cockpit/vnc` + `POST /api/cockpit/browser/lease`)
- **WS Upgrade:** RFC6455 binary WebSocket tunnel inside dedicated `ThreadingHTTPServer` handler thread bridging browser `@novnc/novnc` to loopback `127.0.0.1:5900` (`x11vnc`).
- **Lease Control (`POST /api/cockpit/browser/lease`):** `{ "holder": "AGENT" | "HUMAN" }` — switches server-side RFB input filter and updates lease state.
