# Document 06: QA Strategy, Parity Gate & Test Matrix

---

## 1. Automated CI / Pre-Merge Verification Gate
Every pull request or phase completion on branch `cockpit` must pass 4 automated checks:
1. **Freeze-List Check:** `git diff --name-only` contains zero matches against:
   `static/index.html`, `static/ui.js`, `static/panels.js`, `static/sessions.js`, `static/messages.js`, `static/boot.js`, `static/style.css`, `static/i18n.js`, `static/sw.js`
2. **Backend Regression Suite:** `pytest -q` passes 100% of the 1,639 baseline tests plus new `tests/test_cockpit_*.py` unit/integration tests.
3. **Frontend Type & Build Check:** `cd web && npx tsc --noEmit && npm run build` exits `0` with bundle size `< 1.5 MB` gzipped.
4. **Seam Audit:** Every modified file outside `web/` and `api/cockpit/` is documented in `COCKPIT.md`.

---

## 2. Mandatory Parity Gate (Before Setting `COCKPIT_PRIMARY=1`)

| # | Capability | Verification Test | Pass Criteria |
| :--- | :--- | :--- | :--- |
| P1 | Auth & CSRF | Load `/v2` logged out -> redirect/401; log in -> execute `POST /api/sessions` | `200 OK`, valid session created with `X-CSRF-Token` |
| P2 | Session Lifecycle | Create, rename, switch, and delete sessions | State persists across hard refresh |
| P3 | Chat & Tool Cards | Send prompt triggering bash + file tools | Streaming markdown + collapsible tool cards render cleanly |
| P4 | Approvals (Direct & Gateway) | Trigger command approval with empty `approval_id` (gateway mode) and populated `approval_id` | Both resolve cleanly via `POST /api/approval/respond` |
| P5 | Clarify Cards | Trigger two sequential `clarify` prompts with identical text | First dismisses on answer; second renders cleanly |
| P6 | Mid-Run Controls | Trigger `steer`, `queue`, and `interrupt` during active tool run | Agent trajectory updates or halts cleanly |
| P7 | Interactive Terminal | Run `top` or `ping` in CMD pane; send `Ctrl+C` | Live ANSI output streams; `Ctrl+C` terminates process |
| P8 | Native Panels | Open Memory, Skills, Cron, Model, and Profile drawers | Edits save and persist to backend |
| P9 | Mobile PWA | Test on `390x844` viewport + install manifest | Bottom tabs, accessory keys, and zero horizontal overflow |

---

## 3. Critical Edge-Case Test Matrix

| ID | Edge Case | Expected Behavior |
| :--- | :--- | :--- |
| **EC-01** | SSE connection open `> 45 seconds` idle | `_sse_set_write_deadline` keeps connection alive past `Handler.timeout = 30` |
| **EC-02** | Tool writes file via temp file + `os.replace()` | `watchdog` captures `MOVED_TO` event and pushes `file_delta` to CodeMirror 6 |
| **EC-03** | `ffuf` outputs `10,000 lines` in 2 seconds | `xterm.js` ring buffer absorbs burst without dropping frames or lagging chat composer |
| **EC-04** | User clicks "Take Control" on VNC while agent clicks | Lease switches to `HUMAN`; agent input rejected until "Hand Back" or timeout |
| **EC-05** | Legacy `sw.js` already installed in browser | Visiting `/v2` unregisters root SW for `/v2` scope and registers `sw-v2.js` |
