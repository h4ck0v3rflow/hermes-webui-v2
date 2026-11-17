# Document 05: Security Architecture & Threat Model

**Classification:** Internal Engineering Security Specification  
**Primary Risk Domain:** Remote Command Execution Control Plane & Autonomous Target Scope Enforcement

---

## 1. Trust Boundaries & Attack Surface

| Boundary | Threat | Mitigation |
| :--- | :--- | :--- |
| **Network Exposure** | Unauthorized internet access to VPS terminal/VNC | Bind `hermes-webui` to loopback (`127.0.0.1:8787`) behind Tailscale / TLS reverse proxy; inherit `check_auth_or_close` (`server.py:390`) on all routes. |
| **Cross-Site Request Forgery** | Malicious webpage triggering `POST /api/terminal/input` or `/api/cockpit/kill` | Every mutating `/api/*` route validates `X-CSRF-Token` injected via `window.__HERMES_CONFIG__`. |
| **Browser VNC Hijack / CSP Bypass** | Frame injection or unauthorized WS connection to `x11vnc` | `x11vnc` binds strictly to `127.0.0.1:5900`; WS tunnel lives behind `check_auth_or_close`; CSP `_csp_extra_connect_src` / `_csp_extra_frame_src` locked to `'self'`. |
| **Workspace Path Traversal** | Malicious path parameter reading `/etc/shadow` or `~/.ssh/id_rsa` | All file viewer and `watchdog` endpoints canonicalize paths (`os.path.realpath`), enforce workspace root containment, and honor Hermes's blocked roots. |
| **Runaway Kill Switch** | Kill button terminating `sshd`, `tailscaled`, or `hermes-webui` itself | `/api/cockpit/kill` only kills PGIDs registered in `api/background_process.py` and explicitly rejects `PROTECTED_PROCS`. |

---

## 2. Scope Guardrail Engine Specification

Autonomous bug-hunting agents risk violating program Rules of Engagement (RoE) if an open redirect, SSRF payload, or subdomain scan drifts out of scope.

### 2.1. Hunt Scope Configuration (`~/.hermes/hunts/<program>/scope.json`)
```json
{
  "program": "acme-bug-bounty",
  "in_scope_domains": ["^([a-z0-9-]+\\.)*acme\\.com$", "^api\\.acme-staging\\.io$"],
  "out_of_scope_domains": ["^payments\\.acme\\.com$", "^status\\.acme\\.com$"],
  "blocked_command_patterns": ["--risk=3", "rm -rf /", "mkfs", ":(){ :|:& };:"]
}
```

### 2.2. Enforcement Hooks
1. **Approval Queue Interception:** Hook into `api/route_approvals.py` when a tool call enters `_gateway_queues`. Extract URLs/hostnames and command strings:
   - If any target matches `out_of_scope_domains` OR fails to match `in_scope_domains` (when external network target is detected), immediately auto-settle `deny` and broadcast a `scope.violation` SSE alert card.
2. **Defense-in-Depth (`approvals.deny` Globs):** Because `approvals.mode: smart` may auto-approve low-risk commands without queuing, sync `out_of_scope_domains` and `blocked_command_patterns` directly into Hermes's native `approvals.deny` configuration rules per hunt profile.
