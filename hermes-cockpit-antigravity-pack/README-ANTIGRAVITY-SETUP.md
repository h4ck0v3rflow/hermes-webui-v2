# Hermes Offensive Security Cockpit — Antigravity Setup Guide

Drop the contents of this archive directly into the root of your cloned `hermes-webui` repository.

## 1. Create Your Fork & `cockpit` Branch
```bash
cd hermes-webui
git remote rename origin upstream
git remote add origin <YOUR_PRIVATE_GITHUB_REPO_URL>
git checkout -b cockpit
```

## 2. Verify Placed Context Files
Your repository root should now contain:
- `GEMINI.md` (Always-on project invariants, freeze list, and codebase traps)
- `COCKPIT.md` (Codebase seam map & reused backend endpoints)
- `.agents/rules/frontend-v2.md` (Auto-loads for `web/**`)
- `.agents/rules/backend-seams.md` (Auto-loads for `api/**`, `server.py`)
- `.agents/skills/verify-cockpit/SKILL.md` (Repeatable build, pytest, and freeze-list verification)
- `docs/agency/01-PRD.md` through `07-DELIVERY-ROADMAP-RUNBOOK.md`

## 3. Kickoff Prompt for Google Antigravity
Open `hermes-webui` in Google Antigravity on branch `cockpit`, start a **fresh conversation** for Phase 0 in `/plan` mode, and paste:

> Read `GEMINI.md`, `COCKPIT.md`, and the engineering package in `docs/agency/01-PRD.md` through `07-DELIVERY-ROADMAP-RUNBOOK.md`. Then create an implementation plan for **Phase 0 (Foundation)** only: wire the 3 backend seams (`api/cockpit/routes.py`, `api/routes.py`, `server.py`), scaffold `web/` with Vite + React + TypeScript + Tailwind + Zustand (defer CodeMirror 6 to Module 2), inject `window.__HERMES_CONFIG__` in `serve_cockpit_shell`, and verify `/v2` renders the live session list without modifying any frozen `static/*.js` file. (Attach/reference your finalized Figma V2 frames via the Figma connector for exact visual fidelity.)
