---
name: verify-cockpit
description: Build the /v2 frontend, verify zero modifications to frozen legacy files, and run the backend pytest regression suite.
---

# Verify Cockpit Build & Regressions

Run these verification steps in order and inspect the full output before reporting completion:

1. **Check Freeze List Integrity:**
   Run `git diff --name-only` and verify none of these files were modified:
   `static/index.html`, `static/ui.js`, `static/panels.js`, `static/sessions.js`, `static/messages.js`, `static/boot.js`, `static/style.css`, `static/i18n.js`, `static/sw.js`

2. **Typecheck & Build Frontend Bundle:**
   ```bash
   cd web && npx tsc --noEmit && npm run build
   ```
   Confirm `static/v2/index.html` and hashed assets emit cleanly with zero TypeScript errors and stay under `1.5 MB` gzipped.

3. **Run Backend Test Suite:**
   ```bash
   pytest -q
   ```
   Confirm all 1,639+ existing tests and any new `tests/test_cockpit_*.py` tests pass without regressions.

4. **Update Seam Log:**
   If any upstream file outside `web/` or `api/cockpit/` was modified, ensure `COCKPIT.md` documents the exact file, line range, and reason.
