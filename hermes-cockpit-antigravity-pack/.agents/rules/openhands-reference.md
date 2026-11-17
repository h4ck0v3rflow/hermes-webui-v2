---
trigger: glob
globs: "web/**"
description: How to safely adapt battle-tested UI components from refs/OpenHands into web/ without importing OpenHands backend/SDK assumptions
---

# OpenHands Reference Adapter Rule (`refs/OpenHands`)

A read-only clone of `OpenHands/OpenHands` lives at `refs/OpenHands/` inside `hermes-webui-v2/`. Use it as a **UI/UX & widget pattern reference only** when building `web/`.

## 1. Strict Isolation Rules (Non-Negotiable)
- **Read-Only Reference:** NEVER import from `../../refs/OpenHands`, NEVER modify files inside `refs/OpenHands/`, and NEVER run `npm install` inside `refs/OpenHands/`.
- **Exclude from Builds & Tests:** Ensure `refs/` is listed in `.gitignore`, excluded in `web/tsconfig.json` (`"exclude": ["../refs"]`), and ignored by `pytest` (`norecursedirs = refs`).
- **No OpenHands Backend/SDK:** NEVER copy `refs/OpenHands/src/api/*`, `@openhands/typescript-client`, Agent Server URLs, or OpenHands SaaS/auth logic. All data must flow through `web/src/lib/apiFetch.ts` (`window.__HERMES_CONFIG__.csrfToken`) and `hermes-webui` endpoints defined in `docs/agency/03-API-AND-EVENT-CONTRACTS.md`.

## 2. Safe Component Reuse Map (`refs/OpenHands` → `web/src/`)

| Feature | Reference in `refs/OpenHands/src/` | Target in `web/src/` | Hermes Backend Binding |
| :--- | :--- | :--- | :--- |
| **Interactive Terminal** | `components/terminal/` (`@xterm/xterm` fit, resize, copy/paste, ANSI buffer) | `components/workbench/TerminalPane.tsx` | `/api/terminal/start`, `GET /api/terminal/output?id=&seq=`, `POST /api/terminal/input`, `/resize` |
| **File Tree Explorer** | `components/files/` (collapsible tree, file icons, selection state) | `components/workbench/FileTree.tsx` | Workspace file list + `GET /api/cockpit/files/stream` (`watchdog` SSE) |
| **Code Viewer / Editor** | `components/files/` layout patterns (swap any Monaco usage for **CodeMirror 6**) | `components/workbench/CodePane.tsx` | `@uiw/react-codemirror` + `@codemirror/merge` + `file_delta` highlight (`inserted_lines`) |
| **Browser VNC Canvas** | `components/browser/` (viewport scaling, canvas container, toolbar) | `components/workbench/BrowserPane.tsx` | `WS /api/cockpit/vnc` (`@novnc/novnc`) + `POST /api/cockpit/browser/lease` (`AGENT`/`HUMAN`) |
| **Inline Trace Rows** | `components/conversation/` & `components/chat/` (collapsible step pills) | `components/chat/TraceBlock.tsx` | Hermes SSE stream (`thought`, `tool_call`, `tool_result`) + 3-layer Muse disclosure |
| **Zustand Patterns** | `stores/` (isolated UI & stream slices) | `stores/` (6 isolated SSE slices) | One slice per Hermes SSE stream; keep xterm buffer out of React state |

## 3. Adaptation Checklist Before Copying Any Pattern
1. Strip OpenHands i18n keys (`useTranslation`) unless mapped cleanly, or use direct English strings.
2. Replace OpenHands Tailwind tokens with our locked Figma V2 tokens (`#090B0E` rail, `#0D1015` canvas, `#12151C` surface, `#171B24` elevated, `rgba(255,255,255,0.06)` borders).
3. Verify mobile `390x844` responsiveness and run `.agents/skills/verify-cockpit/SKILL.md` (`npx tsc --noEmit`, `npm run build`, `pytest -q`, freeze-list check).
