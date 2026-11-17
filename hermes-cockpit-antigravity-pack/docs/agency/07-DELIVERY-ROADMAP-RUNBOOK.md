# Document 07: Delivery Roadmap & Operations Runbook

---

## 1. Work Breakdown Structure (WBS) & Schedule

| Phase | Scope & Deliverables | Effort | Exit Gate |
| :--- | :--- | :--- | :--- |
| **Phase 0: Foundation** | Private fork remote (`cockpit` branch), `COCKPIT.md`, 3 backend seams (`api/cockpit/routes.py`, `api/routes.py`, `server.py`), Vite/React/TS/Tailwind/Zustand scaffold in `web/`, `window.__HERMES_CONFIG__` injection | 1–2 days | `/v2` loads behind auth, reads CSRF config, renders live sessions; 1,639 `pytest` pass; 0 frozen files touched |
| **Phase 1: Core Chat & HITL** | Chat stream, Muse 3-layer tool cards, Composer + file attachments, **Approvals** (with `run_id` fallback), **Clarify** (`clarify_id` keying), `steer`/`queue`/`interrupt` | 3–4 days | P1–P6 Parity Gate tests pass |
| **Phase 2: Workbench & Parity** | **Module 1:** Interactive `@xterm/xterm` terminal (`/api/terminal/*`). **Module 2:** `watchdog` SSE (`MODIFIED`+`MOVED_TO`) + CodeMirror 6 (`@uiw/react-codemirror` + `@codemirror/merge`) + emerald highlight. Native Memory/Skills/Cron/Profiles drawers | 4–5 days | Full Parity Gate (P1–P9) passes; `COCKPIT_PRIMARY=1` ready |
| **Phase 3: Security Suite** | **Module 3:** Findings Markdown board + HackerOne export. **Module 4:** Server-side HuntProxy traffic pane. **Module 5:** Telemetry bar + Protected Kill Switch. **Module 6:** Scope Guardrail engine | 4–5 days | EC-01..EC-03 pass; out-of-scope commands auto-denied |
| **Phase 4: VNC & Mobile PWA** | **Module 7:** `Xvfb` + `x11vnc` + RFC6455 WS bridge + `@novnc/novnc` with `AGENT`/`HUMAN` lease. **Module 8:** Mobile PWA (`manifest.webmanifest`, `sw-v2.js`, sticky accessory keys, haptics) | 4–5 days | EC-04 & EC-05 pass; mobile PWA installable |

---

## 2. Operations & Maintenance Runbook

### 2.1. Development Workflow
```bash
# Terminal 1: Start Python backend on Ubuntu VPS
cd ~/hermes-webui && python3 server.py

# Terminal 2: Start Vite HMR dev server (proxies /api to :8787)
cd ~/hermes-webui/web && npm run dev
```

### 2.2. Production Build & Feature Flag Flip
```bash
cd ~/hermes-webui/web && npm run build
# Verify bundle size & frozen files
du -sh ../static/v2 && git diff --name-only
# Promote Cockpit v2 to primary '/' route (legacy remains at '/legacy')
export COCKPIT_PRIMARY=1
systemctl restart hermes-webui
```

### 2.3. Instant Emergency Rollback
If an issue is discovered during a live bug hunt, revert to the legacy UI in under 5 seconds without touching Git:
```bash
export COCKPIT_PRIMARY=0
systemctl restart hermes-webui
# Legacy UI is immediately restored at '/', while v2 remains debuggable at '/v2'
```

### 2.4. Monthly Upstream Sync Protocol (`nesquena/hermes-webui`)
```bash
git fetch upstream
git checkout cockpit
git merge upstream/master   # Never rebase; resolve conflicts using COCKPIT.md seam list
cd web && npm run build
cd .. && pytest -q
```
