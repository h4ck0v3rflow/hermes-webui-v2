# Document 04: UI/UX Design System & Interaction Specification

**Design Inspiration:** OpenHands UI (48px icon rail, borderless inline trace, split file-tree + editor) + Hermes WebUI (session filters, `t/s` speed, profile/folder/model/effort composer) + Meta Muse (3-layer progressive disclosure, inline Approval & Clarify cards)  
**Theme:** Restraint-First Offensive Security Dark Mode (`#0D1015` canvas, 92% monochrome + 8% semantic status dots/pills)

---

## 1. Responsive Layout Architecture

### 1.1. Desktop Cockpit (`>= 1024px`) — 4-Column OpenHands + Hermes Grid
```text
+----+----------------+----------------------------------+-------------------------------+
| R  | SESSIONS       | api-v2-idor-probe  [● *.acme.com]| CPU 24% · RAM 41% [Auto] [KILL]|
| A  | Filter...      +----------------------------------+-------------------------------+
| I  | [WebUI][CLI]   |  [User Prompt Pill]              | [>_ CMD][{} Code][Browser]    |
| L  |                |  Hermes 66.7 t/s  Expand/Collapse| [⇄ HTTP 48][◇ Findings 3]     |
| 48 | PINNED         |  > Skill Ready: api-idor-audit   | +---------------------------+ |
| px | ● api-v2-idor  |  v Ran 2 commands, edited 1 file | | tmux: hunt-acme-01  [PTY] | |
|    | ○ auth-sso     |  > Thinking · Comparing auth...  | | $ nuclei -u staging...    | |
| +  |                |  +----------------------------+  | | [200] GET /api/v2/users   | |
| 💬 | TODAY          |  | CLARIFY · Waiting          |  | | [HIGH] IDOR candidate     | |
| 📁 | daily-subfind  |  | [1] Bearer JWT             |  | |                           | |
| 🧩 |                |  | [2] Session Cookie + CSRF  |  | | $ ffuf -w api.txt ...     | |
| 🧠 | -------------- |  | [3] Both in parallel       |  | +---------------------------+ |
| 🕒 | Scope enforced |  +----------------------------+  |                               |
| 🛡 | Tailscale live |  | APPROVAL · High-Risk Flag  |  |                               |
|    |                |  | [Once Y][Session S][Always]|  |                               |
| ⚙  |                |  +----------------------------+  |                               |
|    |                |  [Steer][Queue][Interrupt]       |                               |
|    |                |  [Composer + Profile/Model/Effort]|                              |
+----+----------------+----------------------------------+-------------------------------+
```

### 1.2. Mobile PWA Layout (`< 768px`, `390x844`) — Single-Pane + Sticky Accessory Bar
```text
+-----------------------------------+
| [=] api-v2-idor-probe      [KILL] | <-- Compact Sticky Header (CPU/RAM subline)
+-----------------------------------+
|                                   |
|      Active View Viewport         |
|  (Chat OR CMD OR Code OR Browser) |
|                                   |
+-----------------------------------+
| [Ctrl+C] [Esc] [Tab] [|] [/] [^v] | <-- Sticky Terminal Accessory Row (CMD tab)
+-----------------------------------+
|  [Chat]  [CMD]  [Code]  [Browser] | <-- Bottom Thumb Navigation Bar
+-----------------------------------+
```

---

## 2. Design Tokens & Visual Language (Figma V2 Locked)

| Token | Value | Usage |
| :--- | :--- | :--- |
| `--bg-rail` | `#090B0E` | 48px far-left vertical icon rail |
| `--bg-canvas` | `#0D1015` | Center chat stream, terminal background, code editor canvas |
| `--bg-surface` | `#12151C` | Sessions drawer, right workbench shell, file tree |
| `--bg-elevated` | `#171B24` | Composer box, trace cards, approval/clarify cards, dark pills |
| `--border-subtle` | `rgba(255, 255, 255, 0.06)` | 1px hairlines between rail, panes, and cards |
| `--text-primary` | `#F8FAFC` | Primary headings, chat prose, active tab labels |
| `--text-secondary` | `#94A3B8` | Trace headers, timestamps, inactive tabs, metadata |
| `--accent-primary` | `#10B981` (Emerald 500) | 6px active status dots, primary Send/Once CTA, live code flash |
| `--accent-warn` | `#F59E0B` (Amber 500) | Approval card 2px left bar, HUMAN browser takeover banner |
| `--accent-danger` | `#EF4444` (Red 500) | Scope violations, Kill Switch ghost pill, Critical findings |
| `--accent-info` | `#3B82F6` (Blue 500) | Clarify card 2px left bar, HTTP status highlights |
| `--font-sans` | `Inter, system-ui, sans-serif` | Conversational stream, drawers, forms |
| `--font-mono` | `JetBrains Mono, monospace` | xterm.js terminal, CodeMirror 6, HTTP headers |

---

## 3. Component Interaction Rules

1. **Color Restraint (92% Monochrome / 8% Accent):** Use understated `#171B24` pills with `6px` status dots (`● *.acme.com`, `● PTY Live`, `● Hand Back to Hermes`) rather than heavy solid-green blocks. Reserve solid `#10B981` for primary Send/Approve CTAs.
2. **OpenHands Inline Trace + Muse Disclosure:** Render collapsed steps (`Skill Ready ▸`, `Thinking ▸`) as quiet borderless single-line rows; expand into subtle `#12151C` containers with raw stdout toggle.
3. **Uniform HITL Cards:**
   - **Clarify:** 2px Blue left accent, uniform full-width `[1]`/`[2]`/`[3]` tactile pill rows + custom input.
   - **Approval:** 2px Amber left accent, mono command preview, uniform 34px pill buttons (`Once [Y]`, `Session [S]`, `Always`, `Deny [N]`).
4. **Workbench Tabs:**
   - **CMD:** Clean live ANSI stream (no ASCII banners).
   - **Code:** Split workspace file tree + CodeMirror 6 with `EditorView.scrollIntoView` and emerald `cm-line-flash` (`1200ms`).
   - **Browser:** Dark `#171B24` browser bezel framing the target viewport + `AGENT`/`HUMAN` lease bar.
   - **HTTP:** Filter bar + compact exchange table + side-by-side `Request | Response` split with syntax-highlighted JSON.
   - **Findings:** Compact 16px-padded cards with `SEVERITY · CVSS · CWE` header line and right-aligned `View PoC` / `Copy Report` pills.
5. **Keyboard Shortcuts & Mobile PWA:** `Cmd/Ctrl + 1..5` switches workbench tabs; `Y/S/N` resolves Approval; `1–9` selects Clarify; mobile `navigator.vibrate([80, 40, 80])` on HITL/violation events; scoped `static/v2/sw-v2.js` (`scope: "/v2"`).
