# Document 01: Product Requirements Document (PRD)

**Project:** Hermes Offensive Security Cockpit (`hermes-webui` v2)  
**Target Platform:** Ubuntu VPS (Backend) + Desktop Browser & Mobile Installable PWA (Frontend)  
**Baseline Codebase:** `nesquena/hermes-webui` (`master @ bfe40ff`, branch `cockpit`)

---

## 1. Executive Summary
Standard LLM chat interfaces obscure autonomous tool execution behind opaque loading spinners, while the current vanilla JS `hermes-webui` suffers from DOM rendering lag under high-frequency streams. **Hermes Offensive Security Cockpit** upgrades `hermes-webui` via a **strangler-pattern hybrid fork**: retaining the battle-tested Python `ThreadingHTTPServer` backend (sessions, layered memory, skills, cron, approvals, PTY) while replacing the frontend with a high-performance **Vite + React + TypeScript + Zustand** cockpit modeled after **OpenHands Agent Canvas** and **Meta Muse**.

---

## 2. Target User Persona
- **Role:** Autonomous Bug Bounty Hunter & Offensive Security Operator.
- **Environment:** Runs an autonomous Hermes Agent on a dedicated Ubuntu VPS (`2–4 vCPU`, `4–8 GB RAM`, `~32 GB` free disk) accessed from both desktop browsers and mobile PWA.
- **Core Pain Points:**
  1. Cannot see raw `nmap`, `ffuf`, `nuclei`, or `sqlmap` output live until a command completes or hangs.
  2. Cannot click into the agent's active shell to press `Ctrl+C` or run manual follow-up commands.
  3. Cannot watch exploit scripts or custom wordlists being written live on mobile without UI lag.
  4. Cannot visually take over the agent's headless browser to solve CAPTCHAs or 2FA login flows.
  5. Risks out-of-scope testing or runaway fuzzers without automated scope guardrails and an instant kill switch.

---

## 3. Functional Requirements & Acceptance Criteria

### FR-01: Shared Interactive Terminal (`CMD` Pane)
- **Requirement:** Operator must observe real-time ANSI stdout/stderr from Hermes's shell commands and interactively type or send `Ctrl+C` in the same session.
- **Acceptance Criteria:**
  - **Given** Hermes executes a shell tool command, **When** bytes emit to `/api/terminal/output`, **Then** they render inside `@xterm/xterm` with full ANSI colors and zero React state re-renders.
  - **Given** a scan hangs or requires manual intervention, **When** the operator focuses the terminal and presses `Ctrl+C` (or taps the mobile `Ctrl+C` accessory key), **Then** `POST /api/terminal/input` sends `` to the active PTY.

### FR-02: Real-Time Live Code & File Diff Viewer (`Code` Pane)
- **Requirement:** Operator must see files created or modified by Hermes automatically open in a syntax-highlighted CodeMirror 6 editor with visual highlight animations.
- **Acceptance Criteria:**
  - **Given** Hermes writes or atomically renames (`MOVED_TO`) a file in the workspace, **When** `watchdog` detects the change, **Then** `/api/cockpit/files/stream` emits a `file_delta` SSE event, `@uiw/react-codemirror` opens the file, scrolls to `inserted_lines[0]`, and flashes the new lines.
  - **Given** a large wordlist (`> 256 KB`) is written, **When** the event fires, **Then** the backend caps/truncates the payload with `truncated: true`.

### FR-03: Interactive Browser Viewport & Manual Takeover (`Browser` Pane)
- **Requirement:** Operator must view Hermes's headless Chromium/Playwright session in real time and toggle control ownership (`AGENT` vs `HUMAN`).
- **Acceptance Criteria:**
  - **Given** Hermes navigates a target web app inside `Xvfb`, **When** the `Browser` tab is open, **Then** live frames stream via `@novnc/novnc` over `/api/cockpit/vnc`.
  - **Given** Hermes encounters a CAPTCHA or SSO login, **When** the operator clicks **Take Control**, **Then** server-side lease switches to `HUMAN`, agent browser input pauses, and operator mouse/keyboard events pass through until **Hand Back** or 10-minute idle timeout.

### FR-04: Human-in-the-Loop Approvals & Options (`Clarify`) Cards
- **Requirement:** Preserve and upgrade `hermes-webui`'s native approval gates (`once`, `session`, `always`, `deny`) and interactive `clarify` option-selection cards.
- **Acceptance Criteria:**
  - **Given** an `approval.request` SSE event arrives (including gateway mode where `approval_id` may be empty), **When** the user clicks an action or presses `Y`/`S`/`N`, **Then** the frontend falls back `approval_id` to `run_id` and submits `POST /api/approval/respond`.
  - **Given** a `clarify.request` event arrives, **When** the user selects an option (`1–9` or tap) or submits custom text, **Then** the card dismisses immediately using strict `clarify_id` keying.

### FR-05: Bug-Hunting Security & Observability Modules
- **Scope Guardrail Interceptor:** Evaluates pending tool commands/URLs against active hunt regex scope rules (`~/.hermes/hunts/<program>/scope.json`); auto-denies out-of-scope targets and emits a `scope.violation` SSE card.
- **Findings Tracker Board:** Reads/writes structured Markdown findings with YAML frontmatter in `~/.hermes/hunts/<program>/findings/*.md` with one-click HackerOne/Bugcrowd Markdown export.
- **Live HTTP Traffic Inspector:** Proxies HuntProxy exchange history (`GET /api/v1/projects/<id>/history`) server-side via `/api/cockpit/traffic` to avoid CORS/CSP issues.
- **VPS Telemetry & Emergency Kill Switch:** Displays live CPU/RAM/Disk gauges from `/api/system/health` and provides a protected `POST /api/cockpit/kill` button.

### FR-06: Desktop & Mobile PWA Parity
- **Requirement:** Single codebase delivering a 3-pane cockpit on desktop (`>= 1024px`) and a single-pane bottom-tabbed PWA on mobile (`< 768px`) with sticky terminal accessory keys and haptic alerts.

---

## 4. Non-Functional Requirements (NFRs)
1. **Zero Upstream Breakage:** All 1,639 existing `pytest` tests must pass; all 9 frozen legacy frontend files must remain untouched.
2. **Memory & Disk Footprint:** Frontend build output in `static/v2/` must stay `< 1.5 MB` gzipped; single `web/node_modules` tree only.
3. **UI Responsiveness:** `60 FPS` typing in the chat composer even while `10,000 lines/sec` stream into the terminal buffer.
4. **Backward Compatibility:** `COCKPIT_PRIMARY=0` (default during build) keeps legacy UI at `/` and v2 at `/v2`; `COCKPIT_PRIMARY=1` promotes v2 to `/` while keeping `/legacy` accessible.

---

## 5. Out of Scope (v1)
- Multi-tenant SaaS user registration or RBAC database migrations.
- Rewriting `server.py` to FastAPI, Starlette, or Node.js.
- Modifying core Hermes agent LLM token-streaming internals outside `hermes-webui`.
